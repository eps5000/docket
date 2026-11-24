import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import {
  AGENTS_BLOCK_KEY,
  CONNECTION_FILES,
  CONNECTION_KEY,
  isScriptKey,
  scriptNameOf,
  INSTALL_CHECK_STATE_LABELS,
  INSTALL_CLIENT_LABELS,
  fillsProjectKey,
  installLayout,
  installPathOf,
  placeholdersIn,
  agentFileLabel,
  renderAgentsBlock,
  checkCommands,
  type AgentFileDetail,
  type AgentFileLayer,
  type CreateInstallResponse,
  type InstallCheckResponse,
  type InstallClient,
  type InstallStateResponse,
  type InstallRow,
  type InstallTargetKind,
  type PushTargetResponse,
} from '@docket/shared';
import {
  Button,
  Callout,
  Card,
  CardHeader,
  Chip,
  Dialog,
  DialogCancel,
  EmptyState,
  Skeleton,
} from '../../components/kit';
import { QueryState } from '../../app/QueryState';
import { apiClient } from '../../app/queryClient';
import { useBootstrap } from '../../app/useBootstrap';
import { HelpLink } from '../../help/HelpLink';
import { ApiError, queryKeys } from '../../lib/api';
import { formatClock, formatStamp, isoTitle, plural } from '../../lib/format';
import { paths } from '../../lib/paths';
import { runOwnerMutation, showToast } from '../../lib/undo';
import { DiffView } from './DiffView';
import { CopyBlock, errorText, usePushTarget } from './install-common';
import { UninstallButton } from './InstallScope';
import {
  INSTALL_STATE_VIEW,
  insidePushFolder,
  installButtonLabel,
  installStateChip,
  repoMainText,
  possessive,
  pushReady,
  versionLabel,
  connectionSentText,
  worktreeText,
} from './model';

/*
 * Install and check (UI_SPEC §6.7b; FR-124 to FR-127; US13 scenarios 4–5):
 * the Install dialog and the install log with *Check* or the check command.
 * The push folder card is on Settings → General (PushFolderCard.tsx).
 */

const CLIENTS: readonly { key: InstallClient; label: string }[] = [
  { key: 'claude', label: INSTALL_CLIENT_LABELS.claude },
  { key: 'codex', label: INSTALL_CLIENT_LABELS.codex },
];

/** Settings → General, where the push folder card is. */
export const PUSH_SETUP_PATH = `${paths.settings()}#push-folder`;

/** The link to the push folder card, while push isn't configured. */
export function SetUpPushLink() {
  return (
    <Link to={PUSH_SETUP_PATH} data-push-setup-link="">
      Set up one-click install
    </Link>
  );
}

/** Why the install will be a command, in plain words. */
function whyCommand(
  t: PushTargetResponse | undefined,
  path: string,
  forced: boolean,
): { text: string; setup: boolean } {
  if (forced) return { text: 'You’ll get a command to paste in a terminal.', setup: false };
  if (!t?.configured) {
    return {
      text: 'You’ll get a command to paste in a terminal. With a push folder set up, Docket can write the files for you.',
      setup: true,
    };
  }
  if (!t.writable) {
    return {
      text: `The push folder (${t.host_path ?? t.container_path}) isn’t mounted or isn’t writable, so you’ll get a command to paste in a terminal.`,
      setup: true,
    };
  }
  return {
    text: path
      ? `This folder isn’t inside the push folder (${t.host_path ?? t.container_path}), so you’ll get a command to paste in a terminal.`
      : 'You’ll get a command to paste in a terminal.',
    setup: false,
  };
}

// ---- The Install dialog ----

export interface InstallDialogProps {
  /** The project whose files to install into its repo (decision 50: installs are per project). */
  project: string;
  projectName: string | null;
  /** The clients to tick (a state row's *Install*, *Update* or *Reinstall*); else the defaults. */
  initialClients?: readonly InstallClient[];
  onClose: () => void;
}

/** Each client's install state there (decision 34): `GET /api/install-state`. */
export function useInstallState(project: string | null, path?: string) {
  const query = { ...(project ? { project } : {}), ...(path ? { path } : {}) };
  return useQuery({
    queryKey: queryKeys.installState(query),
    queryFn: () => apiClient['installs.state']({ query }),
  });
}

/**
 * *Install into <project>’s repo*, for one client or several in one go
 * (decision 34). Each client is a checkbox with its install state; the defaults are the
 * clients the repo has markers for (or that are installed), else both. The
 * repo folder is prefilled from that project's last install. The method is
 * automatic: push when the push folder is ready and the folder is inside it,
 * otherwise a command; *Copy a command instead* is always there. One
 * *Install* writes every ticked client, then shows one summary.
 */
export function InstallDialog({
  project,
  projectName,
  initialClients,
  onClose,
}: InstallDialogProps) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const pathId = useId();
  const target: InstallTargetKind = 'repo';
  const name = projectName ?? project;
  /** Null until the owner ticks: the defaults (or the row's client) show meanwhile. */
  const [picked, setPicked] = useState<InstallClient[] | null>(
    initialClients ? [...initialClients] : null,
  );
  /** Null until the owner types: the remembered folder shows meanwhile. */
  const [typed, setTyped] = useState<string | null>(null);
  /** The folder the markers were looked for in: the remembered one, then each typed one on blur. */
  const [looked, setLooked] = useState<string | null>(null);
  const [forced, setForced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CreateInstallResponse | null>(null);

  const installs = useQuery({
    queryKey: queryKeys.installs({ project }),
    queryFn: () => apiClient['installs.list']({ query: { project } }),
  });
  const remembered =
    installs.data?.installs.find((r) => r.target_kind === 'repo' && r.path)?.path ?? '';
  const path = (typed ?? remembered).trim();
  const state = useInstallState(project, looked ?? remembered);
  const stateOf = (c: InstallClient) => state.data?.clients.find((x) => x.client === c);
  const clients = picked ?? state.data?.defaults ?? [];
  const ticked = CLIENTS.filter((c) => clients.includes(c.key)).map((c) => c.key);
  const toggle = (c: InstallClient) =>
    setPicked(ticked.includes(c) ? ticked.filter((x) => x !== c) : [...ticked, c]);

  const pushTarget = usePushTarget();
  const pt = pushTarget.data;
  const canPush = pushReady(pt) && (path === '' || insidePushFolder(path, pt));
  const method: 'push' | 'command' = canPush && !forced ? 'push' : 'command';
  const why = whyCommand(pt, path, forced && canPush);

  const filesQuery = { project };
  const files = useQuery({
    queryKey: queryKeys.agentFiles(filesQuery),
    queryFn: () => apiClient['agentFiles.list']({ query: filesQuery }),
  });
  const block = useQuery({
    queryKey: queryKeys.agentFile(AGENTS_BLOCK_KEY, filesQuery),
    queryFn: () =>
      apiClient['agentFiles.get']({ params: { key: AGENTS_BLOCK_KEY }, query: filesQuery }),
  });
  // The warning fires only when a `{{…}}` is actually left; `{{KEY}}` is filled for a repo install.
  const placeholders = useMemo(() => {
    const d = block.data;
    if (!d) return [];
    const content = d.layers[d.effective_layer]?.versions[0]?.content ?? '';
    return placeholdersIn(renderAgentsBlock(content, fillsProjectKey(target, project)));
  }, [block.data, target, project]);

  const where = method === 'push' || path ? 'the repo folder' : 'the folder you run it in';
  const writtenFor = (client: InstallClient) => {
    const layout = installLayout(client, target);
    const out = (files.data?.files ?? [])
      // Only skills and their references (decision 66) are copied: the block goes into the
      // instructions file (listed below), and the onboarding guide is never installed (B30).
      .filter((f) => f.key.startsWith('skill:'))
      .map((f) => layout.display + installPathOf(layout, f.key));
    out.push(layout.display + layout.manifest);
    return { layout, paths: out, instructions: layout.display + layout.instructions };
  };
  const instructionFiles = ticked.map((c) => writtenFor(c).instructions).join(' and ');
  const changed = ticked.filter((c) => stateOf(c)?.state === 'changed');
  // Decision 56: a project takes an update through its own workflow, not from this dialog.
  const updating = ticked.filter((c) => stateOf(c)?.state === 'update_available');
  const reviewChanges = () => {
    onClose();
    void navigate(`${paths.agentFiles({ project })}#drift`);
  };

  const install = async () => {
    setError(null);
    if (ticked.length === 0) {
      setError('Tick at least one client.');
      return;
    }
    if (method === 'push' && path === '') {
      setError(`Give the folder of ${possessive(name)} repo.`);
      document.getElementById(pathId)?.focus();
      return;
    }
    setBusy(true);
    try {
      const out = await apiClient['installs.create']({
        body: {
          clients: ticked,
          target_kind: target,
          method,
          project,
          ...(path ? { path } : {}),
        },
      });
      setResult(out);
      void qc.invalidateQueries({ queryKey: queryKeys.installs() });
      void qc.invalidateQueries({ queryKey: queryKeys.installState() });
      if (out.result) showToast('Installed. The install log has the versions sent.');
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const title = `Install into ${possessive(name)} repo`;
  const actionLabel =
    method === 'push'
      ? installButtonLabel(ticked.map((c) => stateOf(c)?.state))
      : 'Create the command';

  const footer = result ? (
    <Button variant="primary" onClick={onClose}>
      Done
    </Button>
  ) : (
    <>
      <DialogCancel onClick={onClose} />
      {placeholders.length === 0 && updating.length === 0 && (
        <Button
          variant="primary"
          onClick={() => void install()}
          disabled={busy || files.isLoading || ticked.length === 0}
        >
          {busy ? 'Working…' : actionLabel}
        </Button>
      )}
    </>
  );

  return (
    <Dialog title={title} onClose={onClose} footer={footer} className="indlg">
      {result ? (
        <InstallResult result={result} target={target} path={path} />
      ) : (
        <div className="inform" data-install-dialog="" data-method={method}>
          <p className="src" style={{ margin: 0 }}>
            {`Installs the skills and the AGENTS.md block ${possessive(name)} agents use (its copies where you customized a file, the defaults elsewhere), for each client you tick.`}
          </p>
          <fieldset className="inclients" data-install-clients="">
            <legend className="inlabel">Clients</legend>
            {CLIENTS.map((c) => {
              const st = stateOf(c.key);
              const view = st ? INSTALL_STATE_VIEW[st.state] : null;
              return (
                <label key={c.key} className="inclient" data-client={c.key} data-state={st?.state}>
                  <input
                    type="checkbox"
                    checked={ticked.includes(c.key)}
                    onChange={() => toggle(c.key)}
                  />
                  <span className="inclientname">{c.label}</span>
                  {view ? (
                    <Chip kind={view.kind}>{view.label}</Chip>
                  ) : (
                    state.isLoading && <span className="src">Checking…</span>
                  )}
                  {st?.markers && <span className="src">found in the repo</span>}
                </label>
              );
            })}
            {ticked.length === 0 && (
              <span className="src" role="status">
                Tick at least one client.
              </span>
            )}
          </fieldset>
          {changed.length > 0 && (
            <Callout tone="warn" role="status">
              <div data-changed-warning="">
                {changed.map((c) => INSTALL_CLIENT_LABELS[c]).join(' and ')}: files were changed
                outside Docket. Installing puts Docket’s version back; review the changes first to
                adopt them or keep them.
              </div>
              <div className="row" style={{ gap: 8, marginTop: 8 }}>
                <Button size="sm" onClick={reviewChanges}>
                  Review changes
                </Button>
              </div>
            </Callout>
          )}
          {updating.length > 0 && state.data && (
            <Callout role="status">
              <div data-update-guidance="">
                <b>
                  {updating.map((c) => INSTALL_CLIENT_LABELS[c]).join(' and ')}: your project’s
                  coordinator will take this in.
                </b>{' '}
                It runs the command below on its own branch and merges it through your usual PR and
                CI, so Docket doesn’t write it here. Untick {updating.length > 1 ? 'them' : 'it'} to
                install another client.
              </div>
              <UpdateCommand command={state.data.update_command} />
            </Callout>
          )}
          {target === 'repo' && (
            <div className="infield instack">
              <label htmlFor={pathId} className="inlabel">
                Repo folder{method === 'command' && ' (optional)'}
              </label>
              <input
                id={pathId}
                className="input mono"
                value={typed ?? remembered}
                maxLength={1000}
                placeholder={
                  pt?.host_path || pt?.container_path
                    ? `${pt.host_path ?? pt.container_path}/my-repo`
                    : 'C:/Users/you/code/my-repo'
                }
                onChange={(e) => setTyped(e.target.value)}
                onBlur={() => setLooked(path || null)}
              />
              <span className="src">
                {typed === null && remembered
                  ? `From ${possessive(name)} last install.`
                  : method === 'command'
                    ? 'Leave it empty to install wherever you run the command.'
                    : `The repo’s folder on this computer, inside the push folder (${pt?.host_path ?? pt?.container_path}).`}
              </span>
            </div>
          )}
          <div className="inmethod" data-install-method={method} role="status">
            {method === 'push' ? (
              <>
                <span>Docket writes the files into this folder itself.</span>{' '}
                <button type="button" className="linkbtn" onClick={() => setForced(true)}>
                  Copy a command instead
                </button>
              </>
            ) : (
              <>
                <span>
                  {why.text}
                  {ticked.length > 1 && ' One command installs every ticked client.'}
                </span>{' '}
                {forced && canPush ? (
                  <button type="button" className="linkbtn" onClick={() => setForced(false)}>
                    Let Docket write them instead
                  </button>
                ) : (
                  why.setup && <SetUpPushLink />
                )}
              </>
            )}
          </div>
          {ticked.length > 0 && (
            <details className="inwhat" data-install-what="">
              <summary>What will be written</summary>
              {ticked.map((c) => {
                const w = writtenFor(c);
                return (
                  <div key={c} data-install-what-client={c}>
                    <div className="src">
                      {INSTALL_CLIENT_LABELS[c]}, in {where}:
                    </div>
                    <ul className="mono">
                      {w.paths.map((p) => (
                        <li key={p}>{p}</li>
                      ))}
                      <li>
                        {w.instructions} <span className="src">(only its Docket section)</span>
                      </li>
                      {target === 'repo' && (
                        <li data-connection-file={CONNECTION_FILES[c]}>
                          {CONNECTION_FILES[c]}{' '}
                          <span className="src">(only its docket server entry)</span>
                        </li>
                      )}
                    </ul>
                  </div>
                );
              })}
              <div className="src">
                Only the marked Docket section of {instructionFiles} is touched (between{' '}
                <code>{'<!-- docket:begin -->'}</code> and <code>{'<!-- docket:end -->'}</code>);
                everything else stays as it is. Nothing is ever deleted.
                {target === 'repo' && (
                  <>
                    {' '}
                    In the connection file, only the docket server is added or updated; other
                    servers and settings stay as they are, and it never holds a token.
                  </>
                )}
                {target === 'repo' && ticked.includes('claude') && (
                  <span data-import-note="">
                    {' '}
                    If the repo has an AGENTS.md but no CLAUDE.md, the new CLAUDE.md starts with{' '}
                    <code>@AGENTS.md</code>, so Claude Code also reads the project’s own rules.
                  </span>
                )}
              </div>
            </details>
          )}
          {target === 'repo' && ticked.length > 0 && (
            <p className="src" data-connect-note="" style={{ margin: '8px 0 0' }}>
              It also writes each client’s connection file (
              {ticked.map((c) => CONNECTION_FILES[c]).join(', ')}). Then open{' '}
              {ticked.map((c) => INSTALL_CLIENT_LABELS[c]).join(' or ')} in this repo and approve
              Docket when it asks.
            </p>
          )}
          {placeholders.length > 0 && (
            <Callout tone="warn" role="status">
              <div data-placeholder-warning="">
                This block still has {plural(placeholders.length, 'placeholder')}:{' '}
                {placeholders.slice(0, 3).map((p, i) => (
                  <span key={p}>
                    {i > 0 && ', '}
                    <code>{p.length > 48 ? `${p.slice(0, 46)}…}}` : p}</code>
                  </span>
                ))}
                {placeholders.length > 3 && ` and ${placeholders.length - 3} more`}. Fill{' '}
                {placeholders.length === 1 ? 'it' : 'them'} in first, in {possessive(name)}{' '}
                AGENTS.md block.
              </div>
              <div className="row" style={{ gap: 8, marginTop: 8 }}>
                <Button
                  size="sm"
                  onClick={() => {
                    onClose();
                    void navigate(paths.agentFiles({ project, file: AGENTS_BLOCK_KEY }), {
                      state: { mode: 'edit', n: Date.now() },
                    });
                  }}
                >
                  Edit block
                </Button>
                <Button
                  size="sm"
                  onClick={() => void install()}
                  disabled={busy || ticked.length === 0}
                >
                  {busy ? 'Working…' : 'Install anyway'}
                </Button>
              </div>
            </Callout>
          )}
          {error && (
            <Callout tone="bad" role="alert">
              {error}
            </Callout>
          )}
        </div>
      )}
    </Dialog>
  );
}

const CHANGE_LABEL = {
  created: 'Created',
  updated: 'Updated',
  unchanged: 'Unchanged',
  removed: 'Removed (old name)',
  kept_edited: 'Kept (old name, edited locally)',
} as const;

/** A file's extra words in the summary: its note, or which part Docket touched. */
function fileNote(f: { path: string; note?: string }): string | null {
  if (f.note) return f.note;
  if (/(^|\/)(CLAUDE|AGENTS)\.md$/.test(f.path)) return 'its Docket section only';
  if (/(^|\/)(\.mcp\.json|config\.toml)$/.test(f.path)) return 'its docket server entry only';
  return null;
}

/**
 * The one summary after *Install* (decision 34): each client's files, what
 * changed in each (push) or what the command will write, then the command.
 */
function InstallResult({
  result,
  target,
  path,
}: {
  result: CreateInstallResponse;
  target: InstallTargetKind;
  path: string;
}) {
  const push = !!result.result;
  const perClient = (
    <div className="inresult" data-install-summary="">
      {result.clients.map((c) => (
        <section key={c.client} data-install-summary-client={c.client}>
          <h3 className="inresulthead">
            {INSTALL_CLIENT_LABELS[c.client]}{' '}
            <span className="src">
              · {plural(c.files.length, 'file')}
              {push ? ' written' : ' to write'}
            </span>
          </h3>
          <ul className="inchanges" aria-label={`${INSTALL_CLIENT_LABELS[c.client]} files`}>
            {c.files.map((f) => {
              const note = fileNote(f);
              return (
                <li key={f.path}>
                  {f.change && (
                    <>
                      <Chip
                        kind={
                          f.change === 'unchanged'
                            ? 'neutral'
                            : f.change === 'kept_edited'
                              ? 'warn'
                              : 'ok'
                        }
                      >
                        {CHANGE_LABEL[f.change]}
                      </Chip>{' '}
                    </>
                  )}
                  <span className="mono">{f.path}</span>
                  {note && <span className="src"> ({note})</span>}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
  if (push) {
    return (
      <div data-install-result="push" className="inform">
        <Callout tone="ok" role="status">
          Installed {result.clients.map((c) => INSTALL_CLIENT_LABELS[c.client]).join(' and ')}.
          Logged in the install log with every file’s version.
        </Callout>
        {perClient}
      </div>
    );
  }
  return (
    <div data-install-result="command" className="inform">
      {target === 'repo' && !path && (
        <Callout tone="info" role="status">
          <b>Run from the repo folder.</b> Open a terminal in the repo, then paste one command. It
          refuses a folder without <code>.git</code>.
        </Callout>
      )}
      <div className="src">
        Works once, until {result.expires_at ? formatClock(result.expires_at) : 'it expires'} (10
        minutes).{' '}
        {result.clients.length > 1
          ? `It installs ${result.clients.map((c) => INSTALL_CLIENT_LABELS[c.client]).join(' and ')}, checking both first. `
          : ''}
        The install is logged when the command downloads the files.
      </div>
      {result.command && (
        <>
          <CopyBlock
            text={result.command.powershell}
            label="PowerShell (Windows)"
            what="PowerShell command"
          />
          <CopyBlock
            text={result.command.bash}
            label="bash (macOS, Linux, Git Bash)"
            what="bash command"
          />
        </>
      )}
      {perClient}
      <div className="src">
        Later, the install log’s <b>Check command</b> shows whether these files were edited.
      </div>
    </div>
  );
}

// ---- Install state (decision 34) ----

/**
 * Each client's install state, on Agent files (UI_SPEC §6.7b): one row per
 * client with its state and the one action that fits it. *Install* and
 * *Reinstall* open the Install dialog with that client ticked; *Check* runs
 * the push check (or shows the check command); *Review changes* goes to the
 * drift section above. An update is the project's to take (decision 56), so
 * that row says who does it and offers the command to copy.
 */
export function InstallStateCard({
  project,
  projectName,
  onInstall,
}: {
  project: string;
  projectName: string | null;
  onInstall: (client: InstallClient) => void;
}) {
  const state = useInstallState(project);
  return (
    <Card data-install-state="">
      <CardHeader
        title={
          <span className="withhelp">
            {`Installed in ${possessive(projectName ?? project)} repo`}
            <HelpLink anchor="agent-files.install-state" />
          </span>
        }
      />
      <QueryState
        query={state}
        skeleton={
          <div className="pad">
            <Skeleton lines={2} label="Loading what’s installed" />
          </div>
        }
      >
        {(d) => (
          <ul className="instates" aria-label="Install state">
            {d.clients.map((c) => (
              <InstallStateRow
                key={c.client}
                row={c}
                project={project}
                projectName={projectName ?? project}
                onInstall={onInstall}
                updateCommand={d.update_command}
              />
            ))}
          </ul>
        )}
      </QueryState>
    </Card>
  );
}

/** The command a project's coordinator runs to take an update (decision 56). */
function UpdateCommand({ command }: { command: InstallStateResponse['update_command'] }) {
  return (
    <div className="indetail" data-update-command="">
      <div className="src">
        Run one in any checkout of the repo, on a new branch. It changes only Docket’s files, keeps
        anything edited locally, and never commits or pushes.
      </div>
      <CopyBlock text={command.powershell} label="PowerShell" what="PowerShell update command" />
      <CopyBlock text={command.bash} label="bash" what="bash update command" />
    </div>
  );
}

function InstallStateRow({
  row,
  project,
  projectName,
  onInstall,
  updateCommand,
}: {
  row: InstallStateResponse['clients'][number];
  project: string;
  projectName: string;
  onInstall: (client: InstallClient) => void;
  updateCommand: InstallStateResponse['update_command'];
}) {
  const navigate = useNavigate();
  const [check, setCheck] = useState<InstallCheckResponse | null>(null);
  const [checking, setChecking] = useState(false);
  const [showCmd, setShowCmd] = useState(false);
  const [showUpdate, setShowUpdate] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const view = installStateChip(row.state, row.worktree);
  const install = row.install;
  const label = INSTALL_CLIENT_LABELS[row.client];
  const runCheck = async () => {
    if (!install) return;
    if (install.method !== 'push') {
      setShowCmd(!showCmd);
      return;
    }
    setChecking(true);
    setError(null);
    try {
      setCheck(await apiClient['installs.check']({ params: { id: install.id } }));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setChecking(false);
    }
  };
  const review = () => {
    const el = document.getElementById('drift');
    if (el) {
      el.scrollIntoView({ block: 'start' });
      el.focus();
    } else void navigate(`${paths.agentFiles({ project })}#drift`);
  };
  const at = install ? (install.token_used_at ?? install.at) : null;
  const cmds = install
    ? checkCommands({
        client: install.client,
        target_kind: install.target_kind,
        path: install.path,
      })
    : null;
  return (
    <li
      data-install-state-row={row.client}
      data-state={row.state}
      data-worktree={row.worktree?.name}
    >
      <div className="row wrap inrow">
        <span className="instatename">{label}</span>
        <Chip kind={view.kind}>{view.label}</Chip>
        <span className="src">
          {row.state !== 'up_to_date' && row.worktree && `${worktreeText(row.worktree)} · `}
          {row.state === 'update_available' &&
            `${plural(row.outdated.length, 'file')} newer in Docket · `}
          {row.state === 'changed' && `${plural(row.drift_ids.length, 'file')} changed · `}
          {install && at ? (
            <>
              {install.method === 'push' ? 'pushed' : 'installed by command'}{' '}
              <span title={isoTitle(at)}>{formatStamp(at)}</span>
              {install.path && <span className="mono"> {install.path}</span>}
            </>
          ) : (
            'Nothing installed yet'
          )}
        </span>
        <span className="grow" />
        {row.state === 'up_to_date' && (
          <>
            <Button
              size="sm"
              onClick={() => void runCheck()}
              disabled={checking}
              aria-expanded={install?.method === 'push' ? undefined : showCmd}
              aria-label={`Check ${label}`}
            >
              {checking ? 'Checking…' : 'Check'}
            </Button>
            <Button
              size="sm"
              onClick={() => onInstall(row.client)}
              aria-label={`Reinstall ${label}`}
            >
              Reinstall
            </Button>
          </>
        )}
        {row.state === 'update_available' && (
          <Button
            size="sm"
            onClick={() => setShowUpdate(!showUpdate)}
            aria-expanded={showUpdate}
            aria-label={`Show the command to update ${label}`}
          >
            Show the command
          </Button>
        )}
        {row.state === 'changed' && (
          <Button size="sm" onClick={review} aria-label={`Review changes to ${label}`}>
            Review changes
          </Button>
        )}
        {row.state === 'not_installed' && (
          <Button size="sm" onClick={() => onInstall(row.client)} aria-label={`Install ${label}`}>
            Install
          </Button>
        )}
        {install && (
          <UninstallButton row={install} name={`${label} from ${possessive(projectName)} repo`} />
        )}
      </div>
      {row.state === 'update_available' && (
        <div className="src" data-update-guidance="">
          <b>Your project’s coordinator will take this in,</b> as one small PR on its own branch,
          before it dispatches more work.
        </div>
      )}
      {(install || row.update_on_branch) && (
        <div className="src" data-repo-main={row.repo_main.state}>
          {repoMainText(row.repo_main)}
          {row.update_on_branch && (
            <>
              {' '}
              An update was fetched on a branch{' '}
              <span title={isoTitle(row.update_on_branch.at)}>
                {formatStamp(row.update_on_branch.at)}
              </span>
              ; it counts once it reaches the main branch.
            </>
          )}
        </div>
      )}
      {row.state === 'update_available' && showUpdate && <UpdateCommand command={updateCommand} />}
      {showCmd && cmds && (
        <div className="indetail">
          <div className="src">
            Run one where {label}’s files were installed. It lists files edited locally, missing or
            extra, each with the version Docket sent.
          </div>
          <CopyBlock text={cmds.powershell} label="PowerShell" what="PowerShell check command" />
          <CopyBlock text={cmds.bash} label="bash" what="bash check command" />
        </div>
      )}
      {error && (
        <Callout tone="bad" role="alert">
          {error}
        </Callout>
      )}
      {check && install && <CheckResult row={install} check={check} />}
    </li>
  );
}

// ---- The install log ----

function useProjectName() {
  const boot = useBootstrap();
  return (key: string | null) =>
    key ? (boot.data?.projects.find((p) => p.key === key)?.short_name ?? key) : null;
}

const targetLabel = (r: InstallRow, name: string | null) =>
  r.target_kind === 'user'
    ? 'User-wide (no longer supported)'
    : name
      ? `${possessive(name)} repo`
      : 'A repo';

/** Why a file was left in place, in plain words (decision 50). */
const KEPT_REASON = {
  modified: 'changed after Docket wrote it',
  link: 'a link, which uninstall never follows',
  not_a_file: 'not a regular file',
  damaged_markers: 'its Docket markers are damaged',
  other_files: 'it holds other files',
  has_kept_files: 'it still describes the files kept',
} as const;

/** What happened to a removed install, on its log row. */
function RemovalNote({ row }: { row: InstallRow }) {
  const removal = row.removal;
  if (!row.removed_at || !removal) return null;
  const at = <span title={isoTitle(row.removed_at)}>{formatStamp(row.removed_at)}</span>;
  if (removal.how === 'marked') {
    return (
      <div className="indetail" data-install-removal="marked">
        <span className="src">You marked this as removed outside Docket · {at}</span>
      </div>
    );
  }
  return (
    <div className="indetail" data-install-removal="command">
      <span className="src">
        Uninstalled · {at} · {plural(removal.removed.length, 'item')} removed, {removal.kept.length}{' '}
        kept, {removal.gone.length} already gone
      </span>
      {removal.kept.length > 0 && (
        <ul className="inchanges" aria-label="Files kept">
          {removal.kept.map((k) => (
            <li key={k.path}>
              <Chip kind="warn">Kept</Chip> <span className="mono">{k.path}</span>{' '}
              <span className="src">({KEPT_REASON[k.why]})</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The install log (UI_SPEC §6.7b): one project's installs with a project
 * selected, every install with All projects.
 */
export function InstallLog({
  project,
  projectName,
}: {
  project: string | null;
  projectName: string | null;
}) {
  const q = project ? { project } : {};
  const query = useQuery({
    queryKey: queryKeys.installs(q),
    queryFn: () => apiClient['installs.list']({ query: q }),
  });
  return (
    <Card data-install-log="">
      <CardHeader
        title={
          <span className="withhelp">
            Install log{project ? ` · ${projectName ?? project}` : ''}
            <HelpLink anchor="agent-files.install-log" />
          </span>
        }
      />
      <QueryState
        query={query}
        skeleton={
          <div className="pad">
            <Skeleton lines={3} label="Loading the install log" />
          </div>
        }
      >
        {(d) =>
          d.installs.length === 0 ? (
            <EmptyState
              text={`Nothing installed${project ? ` into ${possessive(projectName ?? project)} repo` : ''} yet. Installs show here with every file’s version once they’re written or downloaded.`}
            />
          ) : (
            <ul className="inlog" aria-label="Install log">
              {d.installs.map((r) => (
                <InstallLogRow key={r.id} row={r} />
              ))}
            </ul>
          )
        }
      </QueryState>
    </Card>
  );
}

function InstallLogRow({ row }: { row: InstallRow }) {
  const nameOf = useProjectName();
  const qc = useQueryClient();
  const rowRef = useRef<HTMLLIElement>(null);
  const [marking, setMarking] = useState(false);
  const [check, setCheck] = useState<InstallCheckResponse | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCmd, setShowCmd] = useState(false);
  const [showSent, setShowSent] = useState(false);
  const at = row.token_used_at ?? row.at;

  const runCheck = async () => {
    setChecking(true);
    setError(null);
    try {
      setCheck(await apiClient['installs.check']({ params: { id: row.id } }));
    } catch (err) {
      setError(err instanceof ApiError || err instanceof Error ? err.message : errorText(err));
      setCheck(null);
    } finally {
      setChecking(false);
    }
  };
  const cmds = checkCommands({ client: row.client, target_kind: row.target_kind, path: row.path });
  const removed = row.removed_at !== null;
  const legacy = row.target_kind === 'user';
  const client = INSTALL_CLIENT_LABELS[row.client];
  const uninstallName = legacy
    ? `${client} user-wide install`
    : `${client} from ${targetLabel(row, nameOf(row.project))}`;
  const markRemoved = async () => {
    setMarking(true);
    setError(null);
    try {
      await runOwnerMutation(
        () => apiClient['installs.markRemoved']({ params: { id: row.id }, body: {} }),
        {
          success: 'Marked as removed.',
          refetch: [queryKeys.installs(), queryKeys.agentFiles()],
        },
      );
      await qc.invalidateQueries({ queryKey: [...queryKeys.installs()].slice(0, 2) });
      // The button is gone: keep the keyboard on this row.
      rowRef.current?.focus();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setMarking(false);
    }
  };

  return (
    <li
      ref={rowRef}
      tabIndex={-1}
      data-install-row={row.id}
      data-method={row.method}
      data-target={row.target_kind}
      data-removed={removed ? 'true' : undefined}
    >
      <div className="row wrap inrow">
        <span title={isoTitle(at)}>{formatStamp(at)}</span>
        <span>{INSTALL_CLIENT_LABELS[row.client]}</span>
        <span>
          {targetLabel(row, nameOf(row.project))}
          {row.path && <span className="mono src"> {row.path}</span>}
        </span>
        <Chip kind="neutral">{row.method === 'push' ? 'Push' : 'Command'}</Chip>
        <span className="src">{plural(row.file_count, 'file')}</span>
        <span className="grow" />
        <Button
          size="sm"
          variant="ghost"
          aria-expanded={showSent}
          onClick={() => setShowSent(!showSent)}
        >
          Versions sent
        </Button>
        {removed ? (
          <Chip kind="neutral">
            {row.removal?.how === 'marked' ? 'Marked as removed' : 'Removed'}
          </Chip>
        ) : row.method === 'push' ? (
          <Button size="sm" onClick={() => void runCheck()} disabled={checking}>
            {checking ? 'Checking…' : 'Check'}
          </Button>
        ) : (
          <Button size="sm" aria-expanded={showCmd} onClick={() => setShowCmd(!showCmd)}>
            Check command
          </Button>
        )}
        {legacy && !removed && (
          <Button
            size="sm"
            onClick={() => void markRemoved()}
            disabled={marking}
            aria-label={`Mark as removed: ${uninstallName}`}
          >
            {marking ? 'Working…' : 'Mark as removed'}
          </Button>
        )}
        {(!removed || (row.removal?.how === 'command' && row.removal.kept.length > 0)) && (
          <UninstallButton row={row} name={uninstallName} again={removed} />
        )}
      </div>
      <RemovalNote row={row} />
      {showSent && <SentVersions row={row} projectName={nameOf(row.project)} />}
      {showCmd && (
        <div className="indetail">
          <div className="src">
            Run one where the files were installed
            {row.target_kind === 'repo' && !row.path ? ' (the repo folder)' : ''}. It reads{' '}
            <code>{installLayout(row.client, row.target_kind).manifest}</code> there and lists files
            edited locally, missing or extra, each with the version Docket sent. It downloads
            nothing.
          </div>
          <CopyBlock text={cmds.powershell} label="PowerShell" what="PowerShell check command" />
          <CopyBlock text={cmds.bash} label="bash" what="bash check command" />
        </div>
      )}
      {error && (
        <Callout tone="bad" role="alert">
          {error}
        </Callout>
      )}
      {check && <CheckResult row={row} check={check} />}
    </li>
  );
}

/** Each file's sent version ("Docket’s version v1", "RCP’s copy v2"), linked to its view (SC-016). */
function SentVersions({ row, projectName }: { row: InstallRow; projectName: string | null }) {
  const q = row.project && row.target_kind === 'repo' ? { project: row.project } : {};
  const details = useQueries({
    queries: row.manifest.map((m) => ({
      queryKey: queryKeys.agentFile(m.key, q),
      queryFn: () => apiClient['agentFiles.get']({ params: { key: m.key }, query: q }),
      // The connection file and installed scripts have no stored versions (decisions 32, 40).
      enabled: m.key !== CONNECTION_KEY && !isScriptKey(m.key),
    })),
  });
  return (
    <ul className="indetail insent" aria-label="Versions sent">
      {row.manifest.map((m, i) => {
        const found = findVersion(details[i]?.data, m.version_id);
        if (m.key === CONNECTION_KEY) {
          return (
            <li key={m.key} data-sent={m.key}>
              <span className="mono">{CONNECTION_FILES[row.client]}</span>{' '}
              <span className="src">
                docket server,{' '}
                {m.version_id === 'connection:protected' ? 'protected mode' : 'local trust'}
              </span>
            </li>
          );
        }
        if (isScriptKey(m.key)) {
          return (
            <li key={m.key} data-sent={m.key}>
              <span className="mono">{scriptNameOf(m.key)}</span>{' '}
              <span className="src">Docket script</span>
            </li>
          );
        }
        return (
          <li key={m.key} data-sent={m.key}>
            <Link
              className="mono"
              to={paths.agentFiles({ project: q.project ?? 'all', file: m.key })}
            >
              {agentFileLabel(m.key)}
            </Link>{' '}
            <span className="src">{found ? versionLabel(found, projectName) : m.version_id}</span>
          </li>
        );
      })}
    </ul>
  );
}

function findVersion(
  d: AgentFileDetail | undefined,
  id: string,
): { layer: AgentFileLayer; version_no: number; content: string } | null {
  if (!d) return null;
  for (const layer of ['project', 'service', 'bundled'] as const) {
    const v = d.layers[layer]?.versions.find((x) => x.id === id);
    if (v) return { layer, version_no: v.version_no, content: v.content };
  }
  return null;
}

function CheckResult({ row, check }: { row: InstallRow; check: InstallCheckResponse }) {
  if (check.state === 'up_to_date') {
    return (
      <div className="indetail" data-check-result="up_to_date">
        <Chip kind="ok">Up to date</Chip>{' '}
        <span className="src">
          Every file matches what Docket sent · checked {formatClock(check.checked_at)}
        </span>
      </div>
    );
  }
  return (
    <div className="indetail" data-check-result="differs">
      <div className="src">
        {plural(check.files.length, 'file')} differ from what Docket sent · checked{' '}
        {formatClock(check.checked_at)}
      </div>
      <ul className="inchecks" aria-label="Check result">
        {check.files.map((f) => (
          <CheckFile key={f.path} row={row} file={f} />
        ))}
      </ul>
    </div>
  );
}

function CheckFile({
  row,
  file,
}: {
  row: InstallRow;
  file: InstallCheckResponse['files'][number];
}) {
  const [open, setOpen] = useState(false);
  const sent = row.manifest.find((m) => m.key === file.key);
  const q = row.project && row.target_kind === 'repo' ? { project: row.project } : {};
  const detail = useQuery({
    queryKey: queryKeys.agentFile(file.key ?? '', q),
    queryFn: () => apiClient['agentFiles.get']({ params: { key: file.key! }, query: q }),
    enabled: open && file.key !== null && file.key !== CONNECTION_KEY && !isScriptKey(file.key),
  });
  const version = sent ? findVersion(detail.data, sent.version_id) : null;
  const sentText =
    file.key === CONNECTION_KEY
      ? connectionSentText(row.client, sent?.version_id)
      : version && file.key === AGENTS_BLOCK_KEY
        ? renderAgentsBlock(version.content, fillsProjectKey(row.target_kind, row.project))
        : version?.content;
  return (
    <li data-check-file={file.path} data-state={file.state}>
      <div className="row wrap" style={{ gap: 6 }}>
        <Chip kind={file.state === 'edited' ? 'warn' : file.state === 'missing' ? 'bad' : 'info'}>
          {INSTALL_CHECK_STATE_LABELS[file.state]}
        </Chip>
        <span className="mono">{file.path}</span>
        {file.state === 'missing' && <span className="src">Reinstall to restore it.</span>}
        {file.state === 'extra' && (
          <span className="src">Not part of this install; Docket never deletes it.</span>
        )}
        {file.local_content !== undefined && (
          <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? 'Hide diff' : 'Show diff'}
          </Button>
        )}
      </div>
      {open && file.local_content !== undefined && (
        <div className="indiff">
          {sentText === undefined ? (
            <Skeleton lines={2} label="Loading the version sent" />
          ) : (
            <DiffView
              from={sentText}
              to={file.local_content.replace(/\r/g, '')}
              label={`${file.path}: sent version to the local copy`}
            />
          )}
        </div>
      )}
    </li>
  );
}

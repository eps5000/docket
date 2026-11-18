import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import {
  AGENTS_BLOCK_KEY,
  INSTALL_CHECK_STATE_LABELS,
  INSTALL_CLIENT_LABELS,
  fillsProjectKey,
  installLayout,
  installPathOf,
  placeholdersIn,
  renderAgentsBlock,
  checkCommands,
  type AgentFileDetail,
  type AgentFileLayer,
  type CreateInstallResponse,
  type InstallCheckResponse,
  type InstallClient,
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
  SegmentedControl,
  Skeleton,
} from '../../components/kit';
import { QueryState } from '../../app/QueryState';
import { apiClient } from '../../app/queryClient';
import { useBootstrap } from '../../app/useBootstrap';
import { HelpLink } from '../../help/HelpLink';
import { ApiError, queryKeys } from '../../lib/api';
import { formatClock, formatStamp, isoTitle, plural } from '../../lib/format';
import { paths } from '../../lib/paths';
import { showToast } from '../../lib/undo';
import { DiffView } from './DiffView';
import { CopyBlock, errorText, usePushTarget } from './install-common';
import { insidePushFolder, possessive, pushReady, versionLabel } from './model';

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
      text: 'You’ll get a command to paste in a terminal. With a push folder set up, Task Lite can write the files for you.',
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
  /** The project whose files to install into its repo; null installs the defaults user-wide. */
  project: string | null;
  projectName: string | null;
  onClose: () => void;
}

/**
 * *Install into <project>’s repo* (one project selected) or *Install
 * user-wide* (All projects). The repo folder is prefilled from that
 * project's last install (the install log has the path). The method is
 * automatic: push when the push folder is ready and the folder is inside
 * it, otherwise a command; *Copy a command instead* is always there.
 */
export function InstallDialog({ project, projectName, onClose }: InstallDialogProps) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const pathId = useId();
  const target: InstallTargetKind = project ? 'repo' : 'user';
  const name = projectName ?? project ?? '';
  const [client, setClient] = useState<InstallClient>('claude');
  /** Null until the owner types: the remembered folder shows meanwhile. */
  const [typed, setTyped] = useState<string | null>(null);
  const [forced, setForced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CreateInstallResponse | null>(null);

  const installs = useQuery({
    queryKey: queryKeys.installs(project ? { project } : {}),
    queryFn: () => apiClient['installs.list']({ query: project ? { project } : {} }),
    enabled: project !== null,
  });
  const remembered =
    installs.data?.installs.find((r) => r.target_kind === 'repo' && r.path)?.path ?? '';
  const path = (typed ?? remembered).trim();

  const pushTarget = usePushTarget();
  const pt = pushTarget.data;
  const canPush = target === 'repo' && pushReady(pt) && (path === '' || insidePushFolder(path, pt));
  const method: 'push' | 'command' = canPush && !forced ? 'push' : 'command';
  const why = whyCommand(pt, path, forced && canPush);

  const filesQuery = project ? { project } : {};
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

  const layout = installLayout(client, target);
  const where =
    target === 'user'
      ? 'your home folder'
      : method === 'push'
        ? 'the repo folder'
        : path
          ? 'the repo folder'
          : 'the folder you run it in';
  const written = (files.data?.files ?? [])
    .filter((f) => f.key !== AGENTS_BLOCK_KEY)
    .map((f) => layout.display + installPathOf(layout, f.key));
  written.push(layout.display + layout.manifest);
  const instructions = layout.display + layout.instructions;

  const install = async () => {
    setError(null);
    if (method === 'push' && path === '') {
      setError(`Give the folder of ${possessive(name)} repo.`);
      document.getElementById(pathId)?.focus();
      return;
    }
    setBusy(true);
    try {
      const out = await apiClient['installs.create']({
        body: {
          client,
          target_kind: target,
          method,
          ...(project ? { project } : {}),
          ...(target === 'repo' && path ? { path } : {}),
        },
      });
      setResult(out);
      void qc.invalidateQueries({ queryKey: queryKeys.installs() });
      if (out.result) showToast('Installed. The install log has the versions sent.');
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const title = project ? `Install into ${possessive(name)} repo` : 'Install user-wide';
  const actionLabel = method === 'push' ? 'Install' : 'Create the command';

  const footer = result ? (
    <Button variant="primary" onClick={onClose}>
      Done
    </Button>
  ) : (
    <>
      <DialogCancel onClick={onClose} />
      {placeholders.length === 0 && (
        <Button variant="primary" onClick={() => void install()} disabled={busy || files.isLoading}>
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
            {project
              ? `Installs the skills and the AGENTS.md block ${possessive(name)} agents use (its copies where you customized a file, the defaults elsewhere). The block goes into ${client === 'claude' ? 'CLAUDE.md' : 'AGENTS.md'}.`
              : `Installs the default skills and AGENTS.md block into your home folder, for every project on this computer. A project’s own copies aren’t included: install those into its repo.`}
          </p>
          <div className="infield">
            <span className="inlabel">Client</span>
            <SegmentedControl
              label="Client"
              options={CLIENTS}
              value={client}
              onChange={setClient}
            />
          </div>
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
                <span>Task Lite writes the files into this folder itself.</span>{' '}
                <button type="button" className="linkbtn" onClick={() => setForced(true)}>
                  Copy a command instead
                </button>
              </>
            ) : (
              <>
                <span>{why.text}</span>{' '}
                {forced && canPush ? (
                  <button type="button" className="linkbtn" onClick={() => setForced(false)}>
                    Let Task Lite write them instead
                  </button>
                ) : (
                  why.setup && <SetUpPushLink />
                )}
              </>
            )}
          </div>
          <details className="inwhat" data-install-what="">
            <summary>What will be written</summary>
            <div className="src">In {where}:</div>
            <ul className="mono">
              {written.map((p) => (
                <li key={p}>{p}</li>
              ))}
              <li>
                {instructions} <span className="src">(only its Task Lite section)</span>
              </li>
            </ul>
            <div className="src">
              Only the marked Task Lite section of {instructions} is touched (between{' '}
              <code>{'<!-- tasklite:begin -->'}</code> and <code>{'<!-- tasklite:end -->'}</code>);
              everything else in it stays as it is. Nothing is ever deleted.
            </div>
          </details>
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
                {placeholders.length === 1 ? 'it' : 'them'} in first, in{' '}
                {project ? `${possessive(name)} AGENTS.md block` : 'the default AGENTS.md block'}.
              </div>
              <div className="row" style={{ gap: 8, marginTop: 8 }}>
                <Button
                  size="sm"
                  onClick={() => {
                    onClose();
                    void navigate(
                      paths.agentFiles({ project: project ?? 'all', file: AGENTS_BLOCK_KEY }),
                      { state: { mode: 'edit', n: Date.now() } },
                    );
                  }}
                >
                  Edit block
                </Button>
                <Button size="sm" onClick={() => void install()} disabled={busy}>
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

const CHANGE_LABEL = { created: 'Created', updated: 'Updated', unchanged: 'Unchanged' } as const;

function InstallResult({
  result,
  target,
  path,
}: {
  result: CreateInstallResponse;
  target: InstallTargetKind;
  path: string;
}) {
  if (result.result) {
    return (
      <div data-install-result="push">
        <Callout tone="ok" role="status">
          Installed. Logged in the install log with every file’s version.
        </Callout>
        <ul className="inchanges" aria-label="What changed">
          {result.result.files.map((f) => (
            <li key={f.path}>
              <Chip kind={f.change === 'unchanged' ? 'neutral' : 'ok'}>
                {CHANGE_LABEL[f.change]}
              </Chip>{' '}
              <span className="mono">{f.path}</span>
              {/(^|\/)(CLAUDE|AGENTS)\.md$/.test(f.path) && (
                <span className="src"> (its Task Lite section only)</span>
              )}
            </li>
          ))}
        </ul>
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
        minutes). The install is logged when the command downloads the files.
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
      <div className="src">
        Later, the install log’s <b>Check command</b> shows whether these files were edited.
      </div>
    </div>
  );
}

// ---- The install log ----

function useProjectName() {
  const boot = useBootstrap();
  return (key: string | null) =>
    key ? (boot.data?.projects.find((p) => p.key === key)?.short_name ?? key) : null;
}

const targetLabel = (r: InstallRow, name: string | null) =>
  r.target_kind === 'user' ? 'User-wide' : name ? `${possessive(name)} repo` : 'A repo';

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

  return (
    <li data-install-row={row.id} data-method={row.method}>
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
        {row.method === 'push' ? (
          <Button size="sm" onClick={() => void runCheck()} disabled={checking}>
            {checking ? 'Checking…' : 'Check'}
          </Button>
        ) : (
          <Button size="sm" aria-expanded={showCmd} onClick={() => setShowCmd(!showCmd)}>
            Check command
          </Button>
        )}
      </div>
      {showSent && <SentVersions row={row} projectName={nameOf(row.project)} />}
      {showCmd && (
        <div className="indetail">
          <div className="src">
            Run one where the files were installed
            {row.target_kind === 'repo' && !row.path ? ' (the repo folder)' : ''}. It reads{' '}
            <code>{installLayout(row.client, row.target_kind).manifest}</code> there and lists files
            edited locally, missing or extra, each with the version Task Lite sent. It downloads
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

/** Each file's sent version ("Task Lite’s version v1", "RCP’s copy v2"), linked to its view (SC-016). */
function SentVersions({ row, projectName }: { row: InstallRow; projectName: string | null }) {
  const q = row.project && row.target_kind === 'repo' ? { project: row.project } : {};
  const details = useQueries({
    queries: row.manifest.map((m) => ({
      queryKey: queryKeys.agentFile(m.key, q),
      queryFn: () => apiClient['agentFiles.get']({ params: { key: m.key }, query: q }),
    })),
  });
  return (
    <ul className="indetail insent" aria-label="Versions sent">
      {row.manifest.map((m, i) => {
        const found = findVersion(details[i]?.data, m.version_id);
        return (
          <li key={m.key} data-sent={m.key}>
            <Link
              className="mono"
              to={paths.agentFiles({ project: q.project ?? 'all', file: m.key })}
            >
              {m.key.startsWith('skill:') ? m.key.slice(6) : 'AGENTS.md block'}
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
          Every file matches what Task Lite sent · checked {formatClock(check.checked_at)}
        </span>
      </div>
    );
  }
  return (
    <div className="indetail" data-check-result="differs">
      <div className="src">
        {plural(check.files.length, 'file')} differ from what Task Lite sent · checked{' '}
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
    enabled: open && file.key !== null,
  });
  const version = sent ? findVersion(detail.data, sent.version_id) : null;
  const sentText =
    version && file.key === AGENTS_BLOCK_KEY
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
          <span className="src">Not part of this install; Task Lite never deletes it.</span>
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

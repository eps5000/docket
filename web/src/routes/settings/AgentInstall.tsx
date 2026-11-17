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
} from '@tasklite/shared';
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
import { HelpLink } from '../../help/HelpLink';
import { ApiError, queryKeys } from '../../lib/api';
import { formatClock, formatStamp, isoTitle, plural } from '../../lib/format';
import { paths } from '../../lib/paths';
import { showToast } from '../../lib/undo';
import { AGENT_FILE_LAYER_LABELS } from '@tasklite/shared';
import { DiffView } from './DiffView';

/*
 * Install and check (UI_SPEC §6.7b; FR-124 to FR-127; US13 scenarios 4–5):
 * the Install dialog, the install log with *Check* or the check command, and
 * the push folder card with its plain-language set-up.
 */

const CLIENTS: readonly { key: InstallClient; label: string }[] = [
  { key: 'claude', label: INSTALL_CLIENT_LABELS.claude },
  { key: 'codex', label: INSTALL_CLIENT_LABELS.codex },
];

function copy(text: string, what: string) {
  void navigator.clipboard?.writeText(text).then(
    () => showToast(`Copied the ${what}.`),
    () => showToast('Couldn’t copy. Select the text instead.'),
  );
}

/** A command or snippet with its *Copy* button. */
function CopyBlock({ text, label, what }: { text: string; label: string; what: string }) {
  const id = useId();
  return (
    <div className="incopy">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span id={id} className="src">
          {label}
        </span>
        <Button size="sm" icon="copy" onClick={() => copy(text, what)} aria-describedby={id}>
          Copy
        </Button>
      </div>
      <pre className="code incode" aria-labelledby={id} tabIndex={0}>
        {text}
      </pre>
    </div>
  );
}

const errorText = (err: unknown) =>
  err instanceof Error ? err.message : 'Something went wrong. Try again.';

function usePushTarget() {
  return useQuery({
    queryKey: queryKeys.pushTarget(),
    queryFn: () => apiClient['pushTarget.get']({}),
  });
}

/** Why push isn't offered, in plain words; null when it is. */
function pushUnavailable(t: PushTargetResponse | undefined): string | null {
  if (!t) return 'Checking the push folder…';
  if (!t.configured) {
    return 'No push folder is set up, so Task Lite can’t write the files itself. Use the command below, or set up a push folder (Settings → Agent setup → Push folder).';
  }
  if (!t.writable) {
    return `The push folder (${t.host_path ?? t.container_path}) isn’t mounted or isn’t writable, so Task Lite can’t write the files itself. Use the command below, or fix it under Push folder and click Test.`;
  }
  return null;
}

// ---- The Install dialog ----

export interface InstallDialogProps {
  /** The project whose effective files to install; null for the service-wide set. */
  project: string | null;
  projectName: string | null;
  onClose: () => void;
}

export function InstallDialog({ project, projectName, onClose }: InstallDialogProps) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const pathId = useId();
  const [client, setClient] = useState<InstallClient>('claude');
  const [target, setTarget] = useState<InstallTargetKind>('repo');
  const [method, setMethod] = useState<'push' | 'command' | null>(null);
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CreateInstallResponse | null>(null);

  const pushTarget = usePushTarget();
  const noPush = pushUnavailable(pushTarget.data);
  const chosen: 'push' | 'command' = method ?? (noPush ? 'command' : 'push');
  const effectiveMethod: 'push' | 'command' = noPush ? 'command' : chosen;

  // User-wide installs have no project: they get the service-wide files.
  const installProject = target === 'repo' ? project : null;
  const filesQuery = { ...(installProject ? { project: installProject } : {}) };
  const files = useQuery({
    queryKey: queryKeys.agentFiles(filesQuery),
    queryFn: () => apiClient['agentFiles.list']({ query: filesQuery }),
  });
  const block = useQuery({
    queryKey: queryKeys.agentFile(AGENTS_BLOCK_KEY, filesQuery),
    queryFn: () =>
      apiClient['agentFiles.get']({ params: { key: AGENTS_BLOCK_KEY }, query: filesQuery }),
  });
  const placeholders = useMemo(() => {
    const d = block.data;
    if (!d) return [];
    const content = d.layers[d.effective_layer]?.versions[0]?.content ?? '';
    return placeholdersIn(renderAgentsBlock(content, fillsProjectKey(target, installProject)));
  }, [block.data, target, installProject]);

  const layout = installLayout(client, target);
  const where =
    target === 'user'
      ? 'your home folder'
      : effectiveMethod === 'push'
        ? 'the repo folder below'
        : 'the repo folder you run it in';
  const written = (files.data?.files ?? [])
    .filter((f) => f.key !== AGENTS_BLOCK_KEY)
    .map((f) => layout.display + installPathOf(layout, f.key));
  written.push(layout.display + layout.manifest);
  const instructions = layout.display + layout.instructions;

  const install = async () => {
    setError(null);
    if (effectiveMethod === 'push' && path.trim() === '') {
      setError('Give the repo folder to install into, inside the push folder.');
      document.getElementById(pathId)?.focus();
      return;
    }
    setBusy(true);
    try {
      const out = await apiClient['installs.create']({
        body: {
          client,
          target_kind: target,
          method: effectiveMethod,
          ...(installProject ? { project: installProject } : {}),
          ...(path.trim() ? { path: path.trim() } : {}),
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

  const scope = installProject ? `${projectName ?? installProject}’s` : 'the service-wide';
  const actionLabel = effectiveMethod === 'push' ? 'Install' : 'Create the command';

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
    <Dialog title="Install agent files" onClose={onClose} footer={footer} className="indlg">
      {result ? (
        <InstallResult result={result} target={target} path={path.trim()} />
      ) : (
        <div className="inform" data-install-dialog="">
          <p className="src" style={{ margin: 0 }}>
            Installs {scope} effective agent files: the skills, and the AGENTS.md block in{' '}
            {client === 'claude' ? 'CLAUDE.md' : 'AGENTS.md'}.
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
          <div className="infield">
            <span className="inlabel">Install into</span>
            <SegmentedControl
              label="Install into"
              options={[
                { key: 'repo', label: project ? `${project}’s repo` : 'A repo' },
                { key: 'user', label: 'User-wide' },
              ]}
              value={target}
              onChange={setTarget}
            />
          </div>
          {target === 'user' && project && (
            <div className="src">
              User-wide applies to every project, so it gets the service-wide files, without{' '}
              {project}’s overrides.
            </div>
          )}
          <div className="infield">
            <span className="inlabel">How</span>
            <SegmentedControl
              label="How"
              options={[
                { key: 'push', label: 'Push (Task Lite writes the files)' },
                { key: 'command', label: 'Copy a command' },
              ]}
              value={effectiveMethod}
              onChange={(k) => setMethod(k)}
            />
          </div>
          {noPush && pushTarget.data && (
            <Callout tone="info" role="status">
              {noPush}
            </Callout>
          )}
          {(effectiveMethod === 'push' || target === 'repo') && (
            <div className="infield instack">
              <label htmlFor={pathId} className="inlabel">
                {target === 'repo' ? 'Repo folder' : 'Home folder'}
                {effectiveMethod === 'command' && ' (optional)'}
              </label>
              <input
                id={pathId}
                className="input mono"
                value={path}
                maxLength={1000}
                placeholder={
                  effectiveMethod === 'push'
                    ? `${pushTarget.data?.host_path ?? pushTarget.data?.container_path ?? ''}/my-repo`
                    : 'Leave empty to install where you run the command'
                }
                onChange={(e) => setPath(e.target.value)}
              />
              <span className="src">
                {effectiveMethod === 'push'
                  ? `A folder inside the push folder (${pushTarget.data?.host_path ?? pushTarget.data?.container_path}).`
                  : 'Run the command from the repo folder, or give the folder here.'}
              </span>
            </div>
          )}
          <div className="inwhat" data-install-what="">
            <div className="inlabel">What will be written, in {where}</div>
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
          </div>
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
                {placeholders.length > 3 && ` and ${placeholders.length - 3} more`}. Edit{' '}
                {installProject ? 'this project’s' : 'the service-wide'} AGENTS.md block first.
              </div>
              <div className="row" style={{ gap: 8, marginTop: 8 }}>
                <Button
                  size="sm"
                  onClick={() => {
                    onClose();
                    void navigate(
                      paths.agentSetup({
                        ...(installProject ? { project: installProject } : {}),
                        file: AGENTS_BLOCK_KEY,
                        layer: installProject ? 'project' : 'service',
                      }),
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

const targetLabel = (r: InstallRow) =>
  r.target_kind === 'user' ? 'User-wide' : r.project ? `${r.project}’s repo` : 'A repo';

export function InstallLog({ project }: { project: string | null }) {
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
            Install log{project ? ` · ${project}` : ''}
            <HelpLink anchor="settings.install-log" />
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
            <EmptyState text="Nothing installed yet. Installs show here with every file’s version once they’re written or downloaded." />
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
          {targetLabel(row)}
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
      {showSent && <SentVersions row={row} />}
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

/** Each file's sent version, with its layer and number, linked to its view (SC-016). */
function SentVersions({ row }: { row: InstallRow }) {
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
              to={paths.agentSetup({
                ...(q.project ? { project: q.project } : {}),
                file: m.key,
                ...(found ? { layer: found.layer } : {}),
              })}
            >
              {m.key.startsWith('skill:') ? m.key.slice(6) : 'AGENTS.md block'}
            </Link>{' '}
            <span className="src">
              {found
                ? `${AGENT_FILE_LAYER_LABELS[found.layer]} v${found.version_no}`
                : m.version_id}
            </span>
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

// ---- The push folder card ----

const looksWindows = () =>
  typeof navigator !== 'undefined' && /win/i.test(navigator.platform || navigator.userAgent);

export function PushFolderCard() {
  const query = usePushTarget();
  const qc = useQueryClient();
  const folderId = useId();
  const [folder, setFolder] = useState(looksWindows() ? 'C:/Users/you/code' : '~/code');
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const runTest = async () => {
    setTesting(true);
    try {
      setTest(await apiClient['pushTarget.test']({}));
      void qc.invalidateQueries({ queryKey: queryKeys.pushTarget() });
    } catch (err) {
      setTest({ ok: false, message: errorText(err) });
    } finally {
      setTesting(false);
    }
  };
  const f = folder.trim() || 'C:/Users/you/code';
  const volume = `      - ${f}:/host-code`;
  const env = `TASKLITE_PUSH_ROOT=/host-code\nTASKLITE_PUSH_HOST_PATH=${f}`;
  const override = `services:\n  tasklite:\n    volumes:\n      - ${f}:/host-code\n    environment:\n      TASKLITE_PUSH_ROOT: /host-code\n      TASKLITE_PUSH_HOST_PATH: ${f}`;

  return (
    <Card padded data-card="push-folder">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div className="withhelp">
          <h3 style={{ margin: 0 }}>Push folder</h3>
          <HelpLink anchor="settings.push-folder" />
        </div>
        <QueryState query={query} skeleton={<span />}>
          {(t) =>
            !t.configured ? (
              <Chip kind="neutral">Not set up</Chip>
            ) : t.writable ? (
              <Chip kind="ok">Ready</Chip>
            ) : (
              <Chip kind="bad">Not writable</Chip>
            )
          }
        </QueryState>
      </div>
      <p className="src" style={{ margin: '6px 0 10px' }}>
        Mount your code folder into Task Lite so it can install files for you. Without it, Install
        gives you a command to paste instead; both work.
      </p>
      <QueryState query={query} skeleton={<Skeleton lines={2} label="Loading the push folder" />}>
        {(t) => (
          <div className="inform">
            {t.configured && (
              <dl className="inpaths">
                <dt>On your computer</dt>
                <dd className="mono">
                  {t.host_path ?? '(not given: set TASKLITE_PUSH_HOST_PATH)'}
                </dd>
                <dt>Inside Task Lite</dt>
                <dd className="mono">{t.container_path}</dd>
              </dl>
            )}
            <div className="row" style={{ gap: 8 }}>
              <Button size="sm" onClick={() => void runTest()} disabled={testing}>
                {testing ? 'Testing…' : 'Test'}
              </Button>
              <span className="src">Writes a small test file there and removes it.</span>
            </div>
            {test && (
              <Callout tone={test.ok ? 'ok' : 'bad'} role="status">
                {test.message}
              </Callout>
            )}
            {!t.configured && (
              <div className="inhow" data-push-howto="">
                <h4>Set it up (about 2 minutes)</h4>
                <div className="infield instack">
                  <label htmlFor={folderId} className="inlabel">
                    Your code folder (the one that holds your repos)
                  </label>
                  <input
                    id={folderId}
                    className="input mono"
                    value={folder}
                    onChange={(e) => setFolder(e.target.value)}
                  />
                  <span className="src">The steps below update as you type.</span>
                </div>
                <ol>
                  <li>
                    Open <code>docker/compose.yaml</code> in the folder you installed Task Lite
                    from. Under <code>volumes:</code>, below <code>- tasklite-data:/data</code>, add
                    this line (keep the indentation):
                    <CopyBlock text={volume} label="compose.yaml line" what="volume line" />
                  </li>
                  <li>
                    In the same <code>docker</code> folder, open <code>.env</code> (create it if it
                    isn’t there) and add:
                    <CopyBlock text={env} label=".env lines" what=".env lines" />
                  </li>
                  <li>
                    Restart Task Lite:
                    <CopyBlock
                      text="docker compose -f docker/compose.yaml up -d"
                      label="Terminal, in the Task Lite folder"
                      what="restart command"
                    />
                  </li>
                  <li>Come back here and click Test.</li>
                </ol>
                <details>
                  <summary>Rather not edit compose.yaml? Use an override file instead</summary>
                  <p className="src">
                    Save this as <code>docker/compose.push.yaml</code>, then start Task Lite with
                    both files. Upgrades never touch it.
                  </p>
                  <CopyBlock
                    text={override}
                    label="docker/compose.push.yaml"
                    what="override file"
                  />
                  <CopyBlock
                    text="docker compose -f docker/compose.yaml -f docker/compose.push.yaml up -d"
                    label="Start command"
                    what="start command"
                  />
                </details>
                <p className="src">
                  Task Lite writes there only the skill folders, its manifest and the marked Task
                  Lite section of AGENTS.md or CLAUDE.md, and never deletes anything. On Linux, the
                  folder must be writable by Task Lite’s user (uid 10001), for example{' '}
                  <code>sudo setfacl -R -m u:10001:rwX ~/code</code>.
                </p>
              </div>
            )}
          </div>
        )}
      </QueryState>
    </Card>
  );
}

// ---- The section on Settings → Agent setup ----

/** *Install and check*: the install log and the push folder card. */
export function InstallSection({ project }: { project: string | null }) {
  return (
    <section aria-labelledby="as-install" className="settings-sec" data-install-section="">
      <h2 id="as-install">Install and check</h2>
      <p className="src as-lede">
        Install the agent files into a repo or user-wide, see every install with the exact versions
        sent, and check whether an installed copy was edited by hand.
      </p>
      <div className="ingrid">
        <InstallLog project={project} />
        <PushFolderCard />
      </div>
    </section>
  );
}

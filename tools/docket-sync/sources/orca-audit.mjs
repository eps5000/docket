/** Read-only, bounded Orca dispatch and worktree audit. No command output leaves the host. */
import { execFile } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { orcaExecutable } from './orca-presence.mjs';
import { createGit } from '../lib/git.mjs';

export const name = 'orca-audit';
export const intervalMs = 60_000;
export const batchSize = 16;
export const enabled = (settings) => settings?.enabled === true;

const DISPATCH = /^ctx_[A-Za-z0-9_-]{1,96}$/;
const RUN = /^run_[A-Za-z0-9_-]{1,96}$/;
const LOCAL_PATH = /^[A-Za-z]:[\\/](?![\\/])/;
const workspacePath = (id) =>
  typeof id === 'string' && id.includes('::') ? id.slice(id.indexOf('::') + 2) : null;
const pathKey = (path) =>
  typeof path === 'string' && LOCAL_PATH.test(path) && !/[\x00-\x1f\x7f]/.test(path)
    ? path.replaceAll('/', '\\').replace(/\\+$/, '').toLowerCase()
    : null;

/** Docket's run/dispatch association is checked again at ingest; Orca's runId is a different ID. */
export function verifiedCustody(target, worker) {
  const projection = worker?.projection;
  const dispatch = worker?.dispatch;
  const path = workspacePath(projection?.workspace?.id);
  const expected = pathKey(target?.path);
  if (
    !expected ||
    pathKey(path) !== expected ||
    dispatch?.id !== target.dispatch_id ||
    projection?.id !== target.dispatch_id ||
    projection?.dispatchId !== target.dispatch_id ||
    worker?.worker?.dispatchId !== target.dispatch_id ||
    !dispatch.runId ||
    projection.runId !== dispatch.runId ||
    (worker.worker.worktreeId && pathKey(workspacePath(worker.worker.worktreeId)) !== expected) ||
    (worker.terminalResource?.worktreeId &&
      pathKey(workspacePath(worker.terminalResource.worktreeId)) !== expected)
  )
    return null;
  return path;
}
const orcaEnv = () =>
  Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^ORCA_/i.test(key)));

function call(exe, args, signal, timeout = 15_000, extraEnv = {}) {
  return new Promise((resolve, reject) =>
    execFile(
      exe,
      args,
      {
        shell: false,
        windowsHide: true,
        timeout,
        maxBuffer: 2 * 1024 * 1024,
        env: { ...orcaEnv(), ...extraEnv },
        signal,
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    ),
  );
}

async function orca(exe, args, signal) {
  const response = JSON.parse(await call(exe, [...args, '--json'], signal));
  if (response?.ok !== true) throw new Error('Orca read unavailable');
  return response.result;
}

/** A path through a junction or symlink is not eligible for a host read. */
export function safeLocalPath(path) {
  if (
    typeof path !== 'string' ||
    path.length > 1024 ||
    !LOCAL_PATH.test(path) ||
    /[\x00-\x1f\x7f]/.test(path)
  )
    return false;
  const parts = path.replaceAll('/', '\\').split('\\');
  try {
    let current = parts[0] + '\\';
    for (const part of parts.slice(1)) {
      if (!part || part === '.' || part === '..') return false;
      current += part;
      if (lstatSync(current).isSymbolicLink()) return false;
      current += '\\';
    }
    return true;
  } catch {
    return false;
  }
}

export async function artifacts(path, mainBranch, signal) {
  if (
    !safeLocalPath(path) ||
    typeof mainBranch !== 'string' ||
    !/^[A-Za-z0-9._/-]{1,255}$/.test(mainBranch) ||
    mainBranch.includes('..')
  )
    return 'unknown';
  try {
    const git = createGit();
    const options = { signal, timeoutMs: 12_000 };
    const untracked = await git.read(path, ['ls-files', '--others', '--exclude-standard', '-z'], {
      ...options,
      countNul: 1,
    });
    if (untracked.unknown || untracked.status !== 0) return 'unknown';
    if (untracked.count > 0) return 'dirty';
    for (const args of [
      ['diff', '--quiet', '--no-ext-diff', '--no-textconv'],
      ['diff', '--cached', '--quiet', '--no-ext-diff', '--no-textconv'],
    ]) {
      const result = await git.read(path, args, options);
      if (result.unknown || ![0, 1].includes(result.status)) return 'unknown';
      if (result.status === 1) return 'dirty';
    }
    const commits = await git.read(
      path,
      ['rev-list', '--count', `origin/${mainBranch}..HEAD`],
      options,
    );
    if (commits.unknown || commits.status !== 0 || !/^\d+\s*$/.test(commits.stdout))
      return 'unknown';
    if (Number(commits.stdout) > 0) return 'dirty';
    const ignored = await git.read(
      path,
      ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'],
      { ...options, countNul: 1 },
    );
    return ignored.unknown || ignored.status !== 0
      ? 'unknown'
      : ignored.count > 0
        ? 'private'
        : 'clean';
  } catch {
    return 'unknown';
  }
}

/** Matching a command line is suspicion only; this never proves parentage or stops a process. */
export async function suspectProcesses(path, signal) {
  if (!safeLocalPath(path) || process.platform !== 'win32') return { count: 0, read: false };
  const script =
    '$a=$env:DOCKET_AUDIT_PATH.Replace("/", "\\"); $b=$a.Replace("\\", "/"); $n=@(Get-CimInstance Win32_Process | Where-Object { $c=$_.CommandLine; $c -and $_.ProcessId -ne $PID -and ($c.IndexOf($a, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or $c.IndexOf($b, [StringComparison]::OrdinalIgnoreCase) -ge 0) }).Count; [Console]::Write($n)';
  try {
    const output = await call(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      signal,
      15_000,
      { DOCKET_AUDIT_PATH: path },
    );
    const count = Number(output);
    return Number.isInteger(count) && count >= 0 && count <= 50
      ? { count, read: true }
      : { count: 0, read: false };
  } catch {
    return { count: 0, read: false };
  }
}

export function projectAudit(target, worker, worktree, terminals, processes, artifactState, at) {
  const projection = worker?.projection ?? {};
  const outcome = ['in_progress', 'succeeded', 'failed'].includes(projection.outcome)
    ? projection.outcome
    : 'unknown';
  const liveness = ['live', 'lost'].includes(projection.liveness?.verdict)
    ? projection.liveness.verdict
    : 'unknown';
  const terminal = worker?.terminalResource?.releaseState ?? projection.resource?.terminalState;
  const terminal_state = [
    'active',
    'reclaimable',
    'retained',
    'release_pending',
    'release_unknown',
    'released',
  ].includes(terminal)
    ? terminal
    : 'unknown';
  const agent_state =
    projection.stage?.activity === 'working'
      ? 'working'
      : outcome !== 'in_progress'
        ? 'done'
        : 'unknown';
  return {
    key: target.dispatch_id,
    run_id: target.run_id,
    observed_at: at,
    outcome,
    liveness,
    terminal_state,
    protected_hold: worker?.terminalResource?.retainedReason === 'user_requested',
    agent_state,
    worktree_status: worktree,
    live_terminals: Math.min(50, terminals),
    suspected_processes: processes.count,
    process_read: processes.read,
    artifacts: artifactState,
  };
}

/** Missing or inconsistent Orca identity is unknown, with no host path or process reads. */
export async function collectTarget(target, worker, scan, at) {
  const path = verifiedCustody(target, worker);
  if (!path)
    return projectAudit(target, null, 'unknown', 0, { count: 0, read: false }, 'unknown', at);
  const result = await scan(path, target.main_branch);
  return projectAudit(
    target,
    worker,
    result.worktree,
    result.terminals,
    result.processes,
    result.artifacts,
    at,
  );
}

export async function collect({ signal, settings, state }) {
  const exe = orcaExecutable();
  if (!exe) throw Object.assign(new Error('Orca unavailable'), { code: 'orca_unavailable' });
  const targets = settings.targets;
  if (!Array.isArray(targets) || targets.length > 80 || settings.more === true)
    throw Object.assign(new Error('Audit inventory incomplete'), { code: 'audit_overflow' });
  const valid = targets.filter(
    (t) => RUN.test(t?.run_id ?? '') && DISPATCH.test(t?.dispatch_id ?? ''),
  );
  const start = (state?.cursor ?? 0) % Math.max(1, valid.length);
  const batch = [...valid.slice(start), ...valid.slice(0, start)].slice(0, 16);
  const records = [];
  const deadline = Date.now() + 90_000;
  for (const target of batch) {
    if (Date.now() >= deadline) break;
    let worker = null;
    try {
      worker = await orca(
        exe,
        ['orchestration', 'worker-show', '--dispatch', target.dispatch_id, '--full'],
        signal,
      );
    } catch {
      /* Unknown custody stays unknown. */
    }
    const record = await collectTarget(
      target,
      worker,
      async (path, mainBranch) => {
        let worktree = 'unknown';
        let terminals = 0;
        if (safeLocalPath(path)) {
          try {
            const tree = await orca(
              exe,
              ['worktree', 'show', '--worktree', `path:${path}`],
              signal,
            );
            const status = tree.worktree?.workspaceStatus;
            worktree =
              status === 'completed'
                ? 'completed'
                : status === 'in-progress'
                  ? 'in-progress'
                  : 'unknown';
          } catch {
            worktree = 'missing';
          }
          try {
            const list = await orca(
              exe,
              ['terminal', 'list', '--worktree', `path:${path}`, '--limit', '50'],
              signal,
            );
            terminals =
              list.truncated === false && list.hostScope?.omittedHostIds?.length === 0
                ? Math.min(50, list.totalCount)
                : 50;
          } catch {
            terminals = 50;
          }
        }
        return {
          worktree,
          terminals,
          artifacts: await artifacts(path, mainBranch, signal),
          processes: await suspectProcesses(path, signal),
        };
      },
      new Date().toISOString(),
    );
    records.push(record);
  }
  return { records, state: { cursor: valid.length ? (start + records.length) % valid.length : 0 } };
}

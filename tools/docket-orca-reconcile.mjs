/** Explicit, one-dispatch Orca cleanup. Docket is read-only; Orca owns every action. */
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDocket } from './docket-sync/lib/docket.mjs';
import {
  artifacts,
  safeLocalPath,
  suspectProcesses,
  verifiedCustody,
} from './docket-sync/sources/orca-audit.mjs';
import { orcaExecutable } from './docket-sync/sources/orca-presence.mjs';

const RUN = /^run_[A-Za-z0-9_-]{1,96}$/;
const DISPATCH = /^ctx_[A-Za-z0-9_-]{1,96}$/;
const RETENTION_MS = 2 * 60_000;

const time = (value) => {
  if (typeof value !== 'string') return NaN;
  const iso = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;
  return Date.parse(iso);
};

const hold = (reason, details = {}) => ({ status: 'hold', reason, ...details });

/** This is an admission decision, never authority to infer an OS process from its path. */
export function decide(target, worker, now = Date.now()) {
  if (!target || !['finished', 'failed'].includes(target.state)) return hold('docket_not_ended');
  if (!['released', 'none'].includes(target.lease)) return hold('docket_lease_not_released');
  if (!RUN.test(target.run_id ?? '') || !DISPATCH.test(target.dispatch_id ?? ''))
    return hold('invalid_identity');
  const path = verifiedCustody(target, worker);
  if (!path) return hold('custody_unknown');
  if (worker.dispatch?.hostScope?.kind !== 'local' || worker.projection?.host?.kind !== 'local')
    return hold('host_unknown');
  if (
    !['succeeded', 'failed'].includes(worker.projection?.outcome) ||
    !['succeeded', 'failed'].includes(worker.projection?.stage?.worker) ||
    !['completed', 'failed'].includes(worker.dispatch?.status) ||
    !['succeeded', 'failed'].includes(worker.worker?.state)
  )
    return hold('orca_not_settled');
  const ended = time(target.updated_at);
  const completed = time(worker.dispatch.completedAt);
  if (!Number.isFinite(ended) || !Number.isFinite(completed)) return hold('retention_unknown');
  if (now - Math.max(ended, completed) < RETENTION_MS) return hold('retention_pending');
  const resource = worker.terminalResource;
  if (!resource || resource.ownerDispatchId !== target.dispatch_id)
    return hold('resource_ownership_unknown');
  if (resource.originDispatchId && resource.originDispatchId !== target.dispatch_id)
    return hold('resource_ownership_unknown');
  if (!['released', 'reclaimable', 'retained'].includes(resource.releaseState))
    return hold('resource_state_unknown');
  if (resource.retainedReason) return hold('protected_hold');
  if (resource.worktreeId && resource.worktreeId !== worker.projection.workspace.id)
    return hold('resource_worktree_mismatch');
  const residual = worker.worker?.residualResources;
  if (!Array.isArray(residual)) return hold('helper_inventory_unknown');
  const helpers = residual.some(
    (r) => r.kind === 'helper' || (r.kind === 'terminal' && r.role === 'helper'),
  );
  if (resource.releaseState === 'released' && helpers)
    return hold('released_helper_inventory_conflict');
  return {
    status: 'ready',
    path,
    workspaceId: worker.projection.workspace.id,
    action: resource.releaseState === 'released' ? 'verify' : helpers ? 'stop' : 'release',
  };
}

function targetFrom(source, agents, runId, dispatchId) {
  const configured = source?.settings?.targets;
  if (
    !Array.isArray(configured) ||
    configured.length > 80 ||
    source?.settings?.more === true ||
    !Array.isArray(agents?.rows) ||
    agents.rows.length > 500
  )
    return null;
  const matches = configured.filter(
    (row) => row.run_id === runId && row.dispatch_id === dispatchId,
  );
  const runs = agents.rows.filter((row) => row.row_kind === 'run' && row.run_id === runId);
  if (matches.length !== 1 || runs.length !== 1) return null;
  const run = runs[0];
  if (
    typeof run.item_id !== 'string' ||
    !run.item_id ||
    !Number.isFinite(time(run.at)) ||
    typeof run.lease !== 'string' ||
    !run.lease
  )
    return null;
  return {
    ...matches[0],
    state: run.run_state,
    updated_at: run.at,
    item_id: run.item_id,
    lease: run.lease,
  };
}

const sameTarget = (a, b) =>
  a?.run_id === b?.run_id &&
  a?.dispatch_id === b?.dispatch_id &&
  a?.state === b?.state &&
  a?.updated_at === b?.updated_at &&
  a?.item_id === b?.item_id &&
  a?.lease === b?.lease &&
  a?.path === b?.path &&
  a?.main_branch === b?.main_branch;

async function readTarget(ports, runId, dispatchId) {
  const source = await ports.docketSource();
  const agents = await ports.docketAgents();
  return targetFrom(source, agents, runId, dispatchId);
}

/** Ports make the exact custody and no-action-on-hold rules testable. */
export async function reconcile({
  runId,
  dispatchId,
  execute = false,
  preservePrivate = false,
  now = Date.now(),
  ports,
}) {
  if (!RUN.test(runId ?? '') || !DISPATCH.test(dispatchId ?? '')) return hold('invalid_identity');
  let target = await readTarget(ports, runId, dispatchId);
  if (!target) return hold('docket_target_unavailable');
  let worker = await ports.workerShow(dispatchId);
  let plan = decide(target, worker, now);
  if (plan.status !== 'ready') return plan;
  if (!ports.safePath(plan.path)) return hold('worktree_path_unreadable');
  let artifactState = await ports.artifacts(plan.path, target.main_branch);
  if (!['clean', 'private'].includes(artifactState)) return hold('artifacts_unknown_or_dirty');
  if (artifactState === 'private' && !preservePrivate) return hold('private_artifacts_retained');
  if (!execute)
    return {
      status: 'ready',
      action: plan.action,
      artifacts: artifactState,
      receipt: 'inspection_only',
    };

  // Fresh Docket and Orca reads immediately before the first action; a changed target fails closed.
  const fresh = await readTarget(ports, runId, dispatchId);
  if (!sameTarget(target, fresh)) return hold('docket_target_changed');
  target = fresh;
  worker = await ports.workerShow(dispatchId);
  plan = decide(target, worker, now);
  if (plan.status !== 'ready' || !ports.safePath(plan.path)) return hold('custody_changed');
  const currentArtifacts = await ports.artifacts(plan.path, target.main_branch);
  if (currentArtifacts !== artifactState) return hold('artifacts_changed');

  let processAction = 'none';
  if (plan.action === 'stop') {
    let receipt;
    try {
      receipt = await ports.workerStop(dispatchId);
    } catch {
      return hold('stop_unknown', { action: 'stop' });
    }
    processAction = receipt?.processAction;
    if (processAction === 'stop_unknown') return hold('stop_unknown', { action: 'stop' });
    if (!['closed_agent_terminal', 'no_process_action'].includes(processAction))
      return hold('stop_receipt_unknown', { action: 'stop' });
  } else if (plan.action === 'release') {
    try {
      await ports.workerRelease(dispatchId);
    } catch {
      return hold('release_unknown', { action: 'release' });
    }
  }

  // Never treat a successful command as proof. Read the exact Dispatch again.
  worker = await ports.workerShow(dispatchId);
  if (!verifiedCustody(target, worker)) return hold('custody_after_action_unknown');
  if (worker.terminalResource?.releaseState !== 'released')
    return hold('agent_release_unverified', { action: plan.action });
  if (!Array.isArray(worker.worker?.residualResources)) return hold('helper_inventory_unknown');
  if (
    worker.worker.residualResources.some(
      (r) => r.kind === 'helper' || (r.kind === 'terminal' && r.role === 'helper'),
    )
  )
    return hold('owned_helper_retained');

  let terminals = await ports.terminalList(plan.path);
  if (
    terminals?.truncated !== false ||
    terminals?.hostScope?.omittedHostIds?.length ||
    !Array.isArray(terminals.terminals)
  )
    return hold('terminal_inventory_unknown');
  let exitedTerminalsClosed = 0;
  for (const terminal of terminals.terminals) {
    if (terminal.worktreeId !== plan.workspaceId) return hold('terminal_custody_unknown');
    if (
      processAction === 'closed_agent_terminal' &&
      terminal.handle === worker.terminalResource?.terminalHandle
    )
      return hold('agent_terminal_close_pending');
    if (!(await ports.terminalExited(terminal.handle))) return hold('live_terminal_retained');
    const check = await ports.terminalShow(terminal.handle);
    if (
      check?.terminal?.worktreeId !== plan.workspaceId ||
      !terminal.incarnationId ||
      check.terminal.incarnationId !== terminal.incarnationId ||
      !terminal.ptyId ||
      check.terminal.ptyId !== terminal.ptyId
    )
      return hold('terminal_custody_changed');
    try {
      await ports.terminalClose(terminal.handle);
    } catch {
      return hold('terminal_close_unknown');
    }
    exitedTerminalsClosed += 1;
  }
  terminals = await ports.terminalList(plan.path);
  if (
    terminals?.truncated !== false ||
    terminals?.hostScope?.omittedHostIds?.length ||
    terminals?.totalCount !== 0 ||
    terminals?.terminals?.length !== 0
  )
    return hold('terminals_not_quiescent');
  const processes = await ports.processes(plan.path);
  if (!processes?.read || processes.count !== 0) return hold('unattributed_process_hold');
  artifactState = await ports.artifacts(plan.path, target.main_branch);
  if (
    !['clean', 'private'].includes(artifactState) ||
    (artifactState === 'private' && !preservePrivate)
  )
    return hold('artifacts_after_action_hold');
  const agents = await ports.activeAgents();
  if (
    agents?.truncated !== false ||
    agents?.hostScope?.omittedHostIds?.length ||
    !Array.isArray(agents.agents)
  )
    return hold('agent_inventory_unknown');
  if (agents.agents.some((agent) => agent.worktreeId === plan.workspaceId))
    return hold('other_agent_active');
  const finalTarget = await readTarget(ports, runId, dispatchId);
  if (!sameTarget(target, finalTarget)) return hold('docket_target_changed');
  worker = await ports.workerShow(dispatchId);
  if (!verifiedCustody(target, worker) || worker.terminalResource?.releaseState !== 'released')
    return hold('custody_before_completion_unknown');
  const tree = await ports.worktreeShow(plan.path);
  if (tree?.worktree?.id !== plan.workspaceId) return hold('worktree_custody_changed');
  if (tree.worktree.workspaceStatus === 'in-progress') {
    try {
      await ports.worktreeComplete(plan.path);
    } catch {
      return hold('worktree_completion_unknown');
    }
    const done = await ports.worktreeShow(plan.path);
    if (done?.worktree?.id !== plan.workspaceId || done.worktree.workspaceStatus !== 'completed')
      return hold('worktree_completion_unverified');
  } else if (tree.worktree.workspaceStatus !== 'completed') {
    return hold('worktree_status_unknown');
  }
  return {
    status: 'completed',
    action: plan.action,
    process_action: processAction,
    exited_terminals_closed: exitedTerminalsClosed,
    artifacts: artifactState,
    worktree_status: 'completed',
  };
}

function cliOrca(exe) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^ORCA_/i.test(key)),
  );
  const call = (args) =>
    new Promise((resolve, reject) =>
      execFile(
        exe,
        [...args, '--json'],
        { shell: false, windowsHide: true, timeout: 15_000, maxBuffer: 2 * 1024 * 1024, env },
        (error, stdout) => {
          try {
            const reply = JSON.parse(stdout);
            if (!reply.ok || error) reject(new Error('orca_action_unverified'));
            else resolve(reply.result);
          } catch {
            reject(new Error('orca_read_unavailable'));
          }
        },
      ),
    );
  return {
    workerShow: (id) => call(['orchestration', 'worker-show', '--dispatch', id, '--full']),
    workerStop: (id) => call(['orchestration', 'worker-stop', '--dispatch', id, '--full']),
    workerRelease: (id) => call(['orchestration', 'worker-release', '--dispatch', id, '--full']),
    activeAgents: () => call(['agent', 'list', '--state', 'working']),
    terminalList: (path) =>
      call(['terminal', 'list', '--worktree', `path:${path}`, '--limit', '50']),
    terminalExited: async (handle) => {
      try {
        await call([
          'terminal',
          'wait',
          '--terminal',
          handle,
          '--for',
          'exit',
          '--timeout-ms',
          '100',
        ]);
        return true;
      } catch {
        return false;
      }
    },
    terminalShow: (handle) => call(['terminal', 'show', '--terminal', handle]),
    terminalClose: (handle) => call(['terminal', 'close', '--terminal', handle]),
    worktreeShow: (path) => call(['worktree', 'show', '--worktree', `path:${path}`]),
    worktreeComplete: (path) =>
      call(['worktree', 'set', '--worktree', `path:${path}`, '--workspace-status', 'completed']),
  };
}

async function main() {
  const args = process.argv.slice(2);
  const value = (flag) => args[args.indexOf(flag) + 1];
  const runId = args.includes('--run-id') ? value('--run-id') : null;
  const dispatchId = args.includes('--dispatch-id') ? value('--dispatch-id') : null;
  if (!RUN.test(runId ?? '') || !DISPATCH.test(dispatchId ?? '')) {
    process.stderr.write(
      'Usage: node tools/docket-orca-reconcile.mjs --run-id run_... --dispatch-id ctx_... [--execute] [--preserve-private]\n',
    );
    process.exitCode = 2;
    return;
  }
  const exe = orcaExecutable();
  if (!exe) throw new Error('orca_unavailable');
  const docket = createDocket({ baseUrl: 'http://127.0.0.1:7420' });
  const result = await reconcile({
    runId,
    dispatchId,
    execute: args.includes('--execute'),
    preservePrivate: args.includes('--preserve-private'),
    ports: {
      docketSource: () => docket.readSource('orca-audit'),
      docketAgents: () => docket.reader().get('/api/agents'),
      ...cliOrca(exe),
      safePath: safeLocalPath,
      artifacts: (path, branch) => artifacts(path, branch),
      processes: (path) => suspectProcesses(path),
    },
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status === 'hold') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch(() => {
    process.stderr.write('reconciliation_unavailable\n');
    process.exitCode = 1;
  });

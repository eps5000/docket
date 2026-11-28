/** Scoped, read-only Docket/Orca liveness check. Orca remains the only executor. */
import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createDocket } from './docket-sync/lib/docket.mjs';
import { verifiedCustody } from './docket-sync/sources/orca-audit.mjs';
import { orcaExecutable } from './docket-sync/sources/orca-presence.mjs';

const RUN = /^run_[A-Za-z0-9_-]{1,96}$/;
const DISPATCH = /^ctx_[A-Za-z0-9_-]{1,96}$/;
const ITEM = /^[A-Z][A-Z0-9]*-[0-9]+$/;
const AUTOMATION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_AUDIT_TARGETS = 160;

const hold = (reason) => ({ status: 'hold', reason });
const problem = (reason, observation = null) => ({
  status: 'problem',
  reason,
  ...(observation ? { suggested_observation: observation } : {}),
  next_actor: 'coordinator',
});

function ownerHold(item, runId) {
  const run = item?.item?.runs?.find((entry) => entry.run_id === runId);
  const reason = run?.parked?.reason;
  if (typeof reason !== 'string') return false;
  const cited = new Set(reason.match(/(?<![A-Za-z0-9_])dec_[A-Za-z0-9_-]+(?![A-Za-z0-9_])/g) ?? []);
  return (item?.decisions ?? []).some(
    (decision) =>
      decision.authority === 'owner' && decision.status === 'active' && cited.has(decision.id),
  );
}

function wakeState(waiting, now) {
  if (waiting?.orchestrator !== true) return 'not_coordinator_wait';
  const wake = waiting.wake;
  if (
    !wake ||
    typeof wake.actor !== 'string' ||
    !wake.actor.trim() ||
    typeof wake.event !== 'string' ||
    !wake.event.trim() ||
    typeof wake.due_at !== 'string'
  )
    return 'missing_wake';
  const due = Date.parse(wake.due_at);
  if (!Number.isFinite(due)) return 'missing_wake';
  return due < now ? 'overdue_wake' : 'named_wake';
}

function dispatchState(target, worker) {
  if (!worker || !verifiedCustody(target, worker)) return 'unknown';
  if (worker.dispatch?.hostScope?.kind !== 'local' || worker.projection?.host?.kind !== 'local')
    return 'unknown';
  if (
    worker.dispatch?.status === 'failed' ||
    worker.projection?.outcome === 'failed' ||
    worker.projection?.stage?.worker === 'failed'
  )
    return 'failed';
  if (
    worker.projection?.liveness?.verdict === 'lost' &&
    ['succeeded', 'failed'].includes(worker.worker?.state)
  )
    return 'exited';
  if (
    worker.projection?.outcome === 'in_progress' &&
    worker.projection?.liveness?.verdict === 'live'
  )
    return 'live';
  return 'unknown';
}

function mappedSupervisor(mapping, epicId, automationId, workspaceId) {
  if (mapping?.version !== 1 || !Array.isArray(mapping.entries)) return false;
  if (mapping.entries.length === 0 || mapping.entries.length > 20) return false;
  const epics = new Set();
  const automations = new Set();
  const workspaces = new Set();
  for (const entry of mapping.entries) {
    if (
      !entry ||
      !ITEM.test(entry.epic_id ?? '') ||
      !AUTOMATION.test(entry.automation_id ?? '') ||
      typeof entry.workspace_id !== 'string' ||
      !/^[0-9a-f-]{36}::[A-Za-z]:[\\/]/i.test(entry.workspace_id) ||
      epics.has(entry.epic_id) ||
      automations.has(entry.automation_id) ||
      workspaces.has(entry.workspace_id)
    )
      return false;
    epics.add(entry.epic_id);
    automations.add(entry.automation_id);
    workspaces.add(entry.workspace_id);
  }
  return mapping.entries.some(
    (entry) =>
      entry.epic_id === epicId &&
      entry.automation_id === automationId &&
      entry.workspace_id === workspaceId,
  );
}

export function assess({
  target,
  agent,
  item,
  project,
  worker,
  automation,
  supervisorTree,
  epicId,
  workspaceId,
  now,
}) {
  const early = earlyAssessment({ target, agent, item, project, worker, epicId, now });
  if (early) return early;
  const wake = wakeState(agent.lead_parked.waiting_on, now);
  const dispatch = dispatchState(target, worker);
  const options = { dispatch, wake };
  const supervisorOptions = { ...options, automation_scope: 'operator_selected' };
  const supervisorHold = (reason) => ({ ...hold(reason), automation_scope: 'operator_selected' });
  if (automation === null)
    return {
      ...problem('supervisor_unavailable', 'supervisor_unavailable'),
      ...supervisorOptions,
    };
  if (!automation || automation.id !== automation.expectedId)
    return supervisorHold('supervisor_identity_unknown');
  if (
    automation.executionTargetType !== 'local' ||
    automation.workspaceMode !== 'existing' ||
    automation.workspaceId !== workspaceId
  )
    return supervisorHold('supervisor_scope_unknown');
  if (!automation.enabled)
    return { ...problem('supervisor_disabled', 'supervisor_disabled'), ...supervisorOptions };
  if (supervisorTree === false)
    return {
      ...problem('supervisor_missing_target', 'supervisor_missing_target'),
      ...supervisorOptions,
    };
  if (supervisorTree !== true) return supervisorHold('supervisor_target_unknown');
  if (
    !Number.isSafeInteger(automation.nextRunAt) ||
    automation.nextRunAt <= 0 ||
    (automation.lastRunAt !== null && !Number.isSafeInteger(automation.lastRunAt))
  )
    return supervisorHold('supervisor_schedule_unknown');
  if (automation.nextRunAt < now - 5 * 60_000) {
    if (automation.lastRunAt === null || automation.lastRunAt < automation.nextRunAt)
      return { ...problem('supervisor_overdue'), ...supervisorOptions };
    return supervisorHold('supervisor_schedule_unknown');
  }
  return {
    status: 'parked',
    reason: wake === 'named_wake' ? 'legitimate_wait' : 'parked_without_coordinator_wake',
    dispatch,
    supervisor: 'configured',
    automation_scope: 'operator_selected',
  };
}

function docketScope(target, agent, item, project, epicId) {
  // The sync target is an identity cursor. Only the exact /api/agents run row
  // carries current parked state and lease custody.
  if (!target || !agent || agent.run_id !== target.run_id) return hold('claimed_park_unknown');
  if (
    agent.run_state !== 'parked' ||
    agent.lease !== 'paused' ||
    !agent.lead_parked ||
    item?.item?.id !== agent.item_id ||
    item.item.project !== agent.project ||
    item.item.runs?.filter((run) => run.run_id === target.run_id).length !== 1 ||
    project?.key !== agent.project ||
    !((item.item.type === 'Epic' && item.item.id === epicId) || item.item.epic === epicId)
  )
    return hold('docket_scope_unknown');
  return null;
}

function earlyAssessment({ target, agent, item, project, worker, epicId, now }) {
  const scope = docketScope(target, agent, item, project, epicId);
  if (scope) return scope;
  if (project.paused || ownerHold(item, target.run_id)) return hold('intentional_owner_hold');
  if (
    agent.lead_parked.waiting_on?.person === true ||
    (item.item.open_question && !item.item.open_question.answered_at)
  )
    return hold('person_or_owner_question_hold');
  const wake = wakeState(agent.lead_parked.waiting_on, now);
  const dispatch = dispatchState(target, worker);
  if (dispatch === 'failed' || dispatch === 'exited')
    return { ...problem('dispatch_custody', dispatch), dispatch, wake };
  if (wake === 'missing_wake' || wake === 'overdue_wake') return problem(wake);
  if (dispatch !== 'live') return hold('dispatch_custody_unknown');
  return null;
}

/** No changes to Docket claims, Orca agents, automations, terminals or worktrees. */
export async function inspect({
  runId,
  dispatchId,
  epicId,
  automationId,
  workspaceId,
  mapping,
  now = Date.now(),
  ports,
}) {
  if (
    !RUN.test(runId ?? '') ||
    !DISPATCH.test(dispatchId ?? '') ||
    !ITEM.test(epicId ?? '') ||
    !AUTOMATION.test(automationId ?? '') ||
    typeof workspaceId !== 'string' ||
    !/^[0-9a-f-]{36}::[A-Za-z]:[\\/]/i.test(workspaceId)
  )
    return hold('invalid_identity');
  let source, agents;
  try {
    [source, agents] = await Promise.all([ports.docketSource(), ports.agents()]);
  } catch {
    return hold('docket_read_unknown');
  }
  const targets = source?.settings?.targets;
  const lastSuccess = Date.parse(source?.status?.last_success_at ?? '');
  if (
    source?.settings?.enabled !== true ||
    !Array.isArray(targets) ||
    targets.length > MAX_AUDIT_TARGETS ||
    source.settings.more !== false ||
    source?.status?.stale !== false ||
    source.status.last_error !== null ||
    !Number.isFinite(lastSuccess) ||
    lastSuccess > now + 60_000 ||
    now - lastSuccess > 5 * 60_000
  )
    return hold('docket_inventory_unknown');
  const rows = agents?.rows;
  if (!Array.isArray(rows) || rows.length > 500) return hold('docket_inventory_unknown');
  const selected = targets.filter((t) => t.run_id === runId && t.dispatch_id === dispatchId);
  const matching = rows.filter((r) => r.row_kind === 'run' && r.run_id === runId);
  if (selected.length !== 1 || matching.length !== 1) return hold('docket_custody_unknown');
  const target = selected[0];
  const agent = matching[0];
  if (agent.run_state !== 'parked' || agent.lease !== 'paused') return hold('claimed_park_unknown');
  let item, bootstrap, worker;
  try {
    [item, bootstrap, worker] = await Promise.all([
      ports.item(agent.item_id),
      ports.bootstrap(),
      ports.workerShow(dispatchId).catch(() => null),
    ]);
  } catch {
    return hold('external_read_unknown');
  }
  const projects = bootstrap?.projects;
  if (!Array.isArray(projects) || projects.length > 100) return hold('docket_inventory_unknown');
  const project = projects.find((p) => p.key === agent.project);
  const preflight = earlyAssessment({ target, agent, item, project, worker, epicId, now });
  if (preflight) return preflight;
  if (!mappedSupervisor(mapping, epicId, automationId, workspaceId))
    return hold('supervisor_mapping_unknown');
  let automations;
  try {
    automations = await ports.automations();
  } catch {
    return hold('supervisor_inventory_unknown');
  }
  const entries = automations?.automations;
  if (!Array.isArray(entries) || entries.length > 200) return hold('supervisor_inventory_unknown');
  const found = entries.filter((entry) => entry.id === automationId);
  if (found.length > 1) return hold('supervisor_identity_unknown');
  const automation = found.length === 0 ? null : { ...found[0], expectedId: automationId };
  let supervisorTree = null;
  if (automation?.enabled && automation.workspaceId === workspaceId) {
    try {
      const tree = await ports.worktreeShow(workspaceId);
      supervisorTree = tree?.worktree?.id === workspaceId ? true : null;
    } catch (error) {
      supervisorTree = error?.code === 'not_found' ? false : null;
    }
  }
  return assess({
    target,
    agent,
    item,
    project,
    worker,
    automation,
    supervisorTree,
    epicId,
    workspaceId,
    now,
  });
}

function orcaClient(exe) {
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
          let reply;
          try {
            reply = JSON.parse(stdout);
          } catch {
            reject(new Error('orca_read_unknown'));
            return;
          }
          if (reply?.ok === true && !error) resolve(reply.result);
          else reject(Object.assign(new Error('orca_read_unknown'), { code: reply?.error?.code }));
        },
      ),
    );
  return {
    workerShow: (id) => call(['orchestration', 'worker-show', '--dispatch', id, '--full']),
    automations: () => call(['automations', 'list']),
    worktreeShow: (id) => call(['worktree', 'show', '--worktree', `id:${id}`]),
  };
}

async function main() {
  const args = process.argv.slice(2);
  const value = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : null);
  if (
    args.some(
      (arg) =>
        ![
          '--run-id',
          '--dispatch-id',
          '--epic-id',
          '--automation-id',
          '--workspace-id',
          '--mapping-file',
        ].includes(arg) && arg.startsWith('--'),
    )
  ) {
    process.stderr.write('Unsupported option. This tool is read-only.\n');
    process.exitCode = 2;
    return;
  }
  const exe = orcaExecutable();
  if (!exe) throw new Error('orca_unavailable');
  let mapping = null;
  try {
    const file = value('--mapping-file');
    if (file && (await stat(file)).size <= 16 * 1024)
      mapping = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    // An unavailable or malformed mapping stays a hold in inspect().
  }
  const docket = createDocket({ baseUrl: 'http://127.0.0.1:7420' });
  const result = await inspect({
    runId: value('--run-id'),
    dispatchId: value('--dispatch-id'),
    epicId: value('--epic-id'),
    automationId: value('--automation-id'),
    workspaceId: value('--workspace-id'),
    mapping,
    ports: {
      docketSource: () => docket.readSource('orca-audit'),
      agents: () => docket.reader().get('/api/agents'),
      item: (id) => docket.reader().get(`/api/items/${encodeURIComponent(id)}`),
      bootstrap: () => docket.reader().get('/api/bootstrap'),
      ...orcaClient(exe),
    },
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status === 'hold') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stdout.write(`${JSON.stringify(hold('audit_unavailable'))}\n`);
    process.exitCode = 1;
  });
}

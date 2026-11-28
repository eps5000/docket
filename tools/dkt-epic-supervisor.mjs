/** DKT-12: bounded, read-only observation for one explicitly mapped Docket Epic. */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { orcaExecutable } from './docket-sync/sources/orca-presence.mjs';

const EPIC = 'DKT-3';
const CHILD = 'DKT-12';
// Keep a finite census while allowing historical Orca dispatches to grow.
const MAX_WORKER_PAGES = 200;
const MAX_AUDIT_TARGETS = 128;
const ACTIVE_STATES = new Set(['starting', 'ready', 'start_unknown', 'stopping', 'stop_unknown']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RUN = /^run_[A-Za-z0-9_-]{1,96}$/;
const DISPATCH = /^ctx_[A-Za-z0-9_-]{1,96}$/;
const WORKSPACE = /^[0-9a-f-]{36}::[A-Za-z]:[\\/]/i;

const result = (status, dkt3, dkt12, reason = null) => ({
  status,
  dkt3,
  dkt12,
  ...(reason ? { reason } : {}),
  next_actor: status === 'problem' ? 'dkt-3-producer' : null,
});

export function validMapping(mapping) {
  if (mapping?.version !== 1 || !Array.isArray(mapping.entries) || mapping.entries.length !== 1)
    return false;
  const entry = mapping.entries[0];
  return (
    entry?.epic_id === EPIC &&
    UUID.test(entry.automation_id ?? '') &&
    WORKSPACE.test(entry.workspace_id ?? '') &&
    RUN.test(entry.producer_run_id ?? '') &&
    DISPATCH.test(entry.recorded_dispatch_id ?? '') &&
    DISPATCH.test(entry.current_producer_dispatch_id ?? '') &&
    RUN.test(entry.producer_orca_run_id ?? '') &&
    WORKSPACE.test(entry.producer_workspace_id ?? '') &&
    entry.workspace_id !== entry.producer_workspace_id
  );
}

const active = (worker) => worker?.liveness === 'live' || ACTIVE_STATES.has(worker?.state);

/** Scheduled precheck: unknown or occupied supervisor custody skips this run. */
export function precheckSafe(mapping, inventory) {
  if (!validMapping(mapping) || inventory?.complete !== true || !Array.isArray(inventory.workers))
    return false;
  return !inventory.workers.some(
    (worker) =>
      active(worker) &&
      (!worker.workspace || !worker.host || worker.workspace === mapping.entries[0].workspace_id),
  );
}

function leadRun(item, runId = null) {
  const runs = item?.item?.runs?.filter((run) => run.is_lead);
  if (!Array.isArray(runs) || runs.length !== 1) return null;
  return !runId || runs[0].run_id === runId ? runs[0] : null;
}

function leadAgent(agents, runId) {
  const rows = agents?.rows?.filter((row) => row.row_kind === 'run' && row.run_id === runId);
  return Array.isArray(rows) && rows.length === 1 ? rows[0] : null;
}

function auditComplete(audit, now) {
  const targets = audit?.settings?.targets;
  const last = Date.parse(audit?.status?.last_success_at ?? '');
  return (
    audit?.settings?.enabled === true &&
    Array.isArray(targets) &&
    targets.length <= MAX_AUDIT_TARGETS &&
    audit.settings.more === false &&
    audit?.status?.stale === false &&
    audit.status.last_error === null &&
    Number.isFinite(last) &&
    last <= now + 60_000 &&
    now - last < 5 * 60_000
  );
}

function namedWait(run, now) {
  const waiting = run?.parked?.waiting_on;
  if (
    !waiting ||
    waiting.orchestrator !== true ||
    waiting.person === true ||
    (Array.isArray(waiting.items) && waiting.items.length > 0) ||
    waiting.until
  )
    return 'unknown';
  const wake = waiting.wake;
  const due = Date.parse(wake?.due_at ?? '');
  if (!wake?.actor || !wake?.event || !Number.isFinite(due)) return 'unknown';
  if (due > now) return 'waiting';
  return now - due > 10 * 60_000 ? 'overdue' : 'retry_window';
}

/** Inputs are raw local reads; output is a fixed vocabulary without source text or IDs. */
export function assessSupervisor({
  mapping,
  automation,
  worktree,
  dkt3,
  dkt12,
  agents,
  audit,
  inventory,
  producerWorker,
  peerWorkers,
  relay,
  ready,
  now,
}) {
  if (!validMapping(mapping) || inventory?.complete !== true || !Array.isArray(inventory.workers))
    return result('hold', 'unknown', 'unknown', 'identity_unknown');
  const m = mapping.entries[0];
  if (
    ready?.status !== 'ready' ||
    !auditComplete(audit, now) ||
    automation?.id !== m.automation_id ||
    automation?.workspaceId !== m.workspace_id ||
    automation.workspaceMode !== 'existing' ||
    automation.enabled !== true ||
    automation.agentId !== 'codex' ||
    worktree?.id !== m.workspace_id ||
    relay?.running !== true ||
    relay?.hold !== null ||
    relay?.docket?.connected !== true
  )
    return result('hold', 'unknown', 'unknown', 'source_or_supervisor_unknown');
  const producer = leadRun(dkt3, m.producer_run_id);
  const producerAgent = leadAgent(agents, m.producer_run_id);
  const child = leadRun(dkt12);
  const childAgent = child && leadAgent(agents, child.run_id);
  if (
    !producer ||
    !producerAgent ||
    !child ||
    !childAgent ||
    dkt3?.item?.id !== EPIC ||
    dkt12?.item?.id !== CHILD ||
    dkt12.item.epic !== EPIC ||
    producer.orchestrator?.dispatch_id !== m.recorded_dispatch_id ||
    (producerAgent.lease !== 'held' && producerAgent.lease !== 'paused') ||
    audit.settings.targets.filter(
      (t) => t.run_id === m.producer_run_id && t.dispatch_id === m.recorded_dispatch_id,
    ).length !== 1 ||
    audit.settings.targets.filter(
      (t) => t.run_id === child.run_id && t.dispatch_id === child.orchestrator?.dispatch_id,
    ).length !== 1
  )
    return result('hold', 'unknown', 'unknown', 'docket_custody_unknown');
  const workers = inventory.workers;
  if (workers.some((w) => active(w) && (!w.workspace || !w.host)))
    return result('hold', 'unknown', 'unknown', 'worker_custody_unknown');
  const mapped = workers.filter((w) => w.dispatchId === m.current_producer_dispatch_id);
  if (
    mapped.length !== 1 ||
    mapped[0].host !== 'local' ||
    producerWorker?.dispatchId !== m.current_producer_dispatch_id ||
    producerWorker.runId !== m.producer_orca_run_id ||
    producerWorker.workspace !== m.producer_workspace_id
  )
    return result('hold', 'unknown', 'unknown', 'producer_identity_unknown');
  const peers = workers.filter(
    (w) =>
      w.dispatchId !== m.current_producer_dispatch_id &&
      active(w) &&
      w.workspace === m.producer_workspace_id,
  );
  if (!Array.isArray(peerWorkers) || peerWorkers.length !== peers.length || peers.length > 30)
    return result('hold', 'unknown', 'unknown', 'peer_custody_unknown');
  const competing = peers.some((row) => {
    const full = peerWorkers.find((entry) => entry?.dispatchId === row.dispatchId);
    return (
      !full ||
      full.runId !== m.producer_orca_run_id ||
      full.workspace !== m.producer_workspace_id ||
      row.host !== 'local' ||
      !/^claude(?:\/|$)/.test(row.agent ?? '')
    );
  });
  if (competing) return result('hold', 'unknown', 'unknown', 'competing_producer_possible');
  let parentCategory = 'unknown';
  if (producerAgent.run_state === 'reported' || producerAgent.run_state === 'live') {
    parentCategory = active(producerWorker) && active(mapped[0]) ? 'active' : 'lost_worker';
  } else if (producerAgent.run_state === 'parked' && producerAgent.lease === 'paused') {
    const wake = namedWait(producer, now);
    parentCategory = wake === 'overdue' ? 'stalled' : wake;
  }
  let childCategory = 'unknown';
  if (childAgent.run_state === 'parked' && childAgent.lease === 'paused') {
    childCategory = namedWait(child, now);
  } else if (childAgent.run_state === 'reported' || childAgent.run_state === 'live') {
    const exact = workers.filter((w) => w.dispatchId === child.orchestrator?.dispatch_id);
    childCategory =
      exact.length === 1 && active(exact[0])
        ? 'active'
        : active(producerWorker) && producerWorker.followUpOf === child.orchestrator?.dispatch_id
          ? 'active_followup'
          : 'lost_worker';
  }
  if (parentCategory === 'unknown' || childCategory === 'unknown')
    return result('hold', parentCategory, childCategory, 'state_unknown');
  if (
    parentCategory === 'lost_worker' ||
    parentCategory === 'stalled' ||
    childCategory === 'lost_worker' ||
    childCategory === 'overdue'
  )
    return result('problem', parentCategory, childCategory, 'custody_action_required');
  return result('ok', parentCategory, childCategory);
}

function cleanEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^ORCA_/i.test(key)));
}

function orcaCall(exe, args) {
  return new Promise((resolve, reject) => {
    execFile(
      exe,
      [...args, '--json'],
      {
        env: cleanEnv(),
        shell: false,
        windowsHide: true,
        timeout: 15_000,
        maxBuffer: 2 * 1024 * 1024,
      },
      (error, stdout) => {
        let parsed;
        try {
          parsed = JSON.parse(stdout);
        } catch {
          reject(Error('read_unknown'));
          return;
        }
        if (error || parsed?.ok !== true) reject(Error('read_unknown'));
        else resolve(parsed.result);
      },
    );
  });
}

async function inventory(exe) {
  const workers = [];
  let cursor = null;
  for (let page = 0; page < MAX_WORKER_PAGES; page += 1) {
    const args = [
      'orchestration',
      'worker-list',
      '--limit',
      '100',
      ...(cursor ? ['--cursor', cursor] : []),
    ];
    const response = await orcaCall(exe, args);
    if (response?.scope?.source !== 'all' || !Array.isArray(response.workers))
      throw Error('read_unknown');
    workers.push(...response.workers);
    cursor = response.nextCursor;
    if (!cursor) return { complete: true, workers };
  }
  throw Error('read_unknown');
}

async function localGet(path) {
  const response = await fetch(`http://127.0.0.1:7420${path}`, {
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw Error('read_unknown');
  return response.json();
}

async function relayStatus() {
  const home = process.env.LOCALAPPDATA;
  if (!home) throw Error('read_unknown');
  const script = `${home}\\docket-relay\\app\\docket-relay.mjs`;
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [script, 'status', '--json'],
      {
        shell: false,
        windowsHide: true,
        timeout: 10_000,
        maxBuffer: 256 * 1024,
        env: { ...cleanEnv(), DOCKET_RELAY_HOME: `${home}\\docket-relay` },
      },
      (error, stdout) => {
        let parsed;
        try {
          parsed = JSON.parse(stdout);
        } catch {
          reject(Error('read_unknown'));
          return;
        }
        if (error) reject(Error('read_unknown'));
        else resolve(parsed);
      },
    );
  });
}

async function readMapping(file) {
  const text = await readFile(file, 'utf8');
  if (text.length > 16 * 1024) throw Error('read_unknown');
  return JSON.parse(text);
}

async function main() {
  const args = process.argv.slice(2);
  const precheck = args[0] === '--precheck';
  const file = args[precheck ? 1 : 0];
  if (args.length !== (precheck ? 2 : 1) || !file) throw Error('read_unknown');
  const mapping = await readMapping(file);
  const exe = orcaExecutable();
  if (!exe) throw Error('read_unknown');
  const workers = await inventory(exe);
  if (precheck) {
    const safe = precheckSafe(mapping, workers);
    process.stdout.write(safe ? 'READY\n' : 'HOLD\n');
    process.exitCode = safe ? 0 : 1;
    return;
  }
  if (!validMapping(mapping)) throw Error('read_unknown');
  const m = mapping.entries[0];
  const [automationReply, worktreeReply, producerWorker, ready, dkt3, dkt12, agents, audit, relay] =
    await Promise.all([
      orcaCall(exe, ['automations', 'show', m.automation_id]),
      orcaCall(exe, ['worktree', 'show', '--worktree', `id:${m.workspace_id}`]),
      orcaCall(exe, ['orchestration', 'worker-show', '--dispatch', m.current_producer_dispatch_id]),
      localGet('/readyz'),
      localGet('/api/items/DKT-3'),
      localGet('/api/items/DKT-12'),
      localGet('/api/agents'),
      localGet('/api/sync/orca-audit'),
      relayStatus(),
    ]);
  const peerRows = workers.workers.filter(
    (w) =>
      w.dispatchId !== m.current_producer_dispatch_id &&
      active(w) &&
      w.workspace === m.producer_workspace_id,
  );
  if (peerRows.length > 30) throw Error('read_unknown');
  const peerWorkers = await Promise.all(
    peerRows.map((row) =>
      orcaCall(exe, ['orchestration', 'worker-show', '--dispatch', row.dispatchId]),
    ),
  );
  const output = assessSupervisor({
    mapping,
    automation: automationReply.automation,
    worktree: worktreeReply.worktree,
    ready,
    dkt3,
    dkt12,
    agents,
    audit,
    inventory: workers,
    producerWorker,
    peerWorkers,
    relay,
    now: Date.now(),
  });
  process.stdout.write(`${JSON.stringify({ ...output, observed_at: new Date().toISOString() })}\n`);
  if (output.status === 'hold') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stdout.write('{"status":"hold","reason":"read_unknown","next_actor":null}\n');
    process.exitCode = 1;
  });
}

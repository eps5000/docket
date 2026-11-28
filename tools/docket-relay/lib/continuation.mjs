/**
 * DKT-38: a due coordinator wake is a delivery obligation, including when its
 * original Orca Dispatch has completed. This lane never changes a Docket run.
 * Only explicitly mapped Docket Epic producers can receive a fresh follow-up.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { requestIdFor } from './orca.mjs';

const ID = /^run_[A-Za-z0-9_-]{1,96}$/;
const DISPATCH = /^ctx_[A-Za-z0-9_-]{1,96}$/;
const EPIC = /^DKT-[1-9][0-9]*$/;
const WORKSPACE = /^[0-9a-f-]{36}::[A-Za-z]:[\\/]/i;
const RETRIES_MS = [0, 60_000, 120_000];
const ACK_MS = 5 * 60_000;
const SCAN_MS = 60_000;

const hash = (value) => createHash('sha256').update(value).digest('hex');

export function loadContinuationConfig(home) {
  let text;
  try {
    text = readFileSync(join(home, 'continuation-config.json'), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw new Error('continuation_config_unreadable');
  }
  let config;
  try {
    config = JSON.parse(text);
  } catch {
    throw new Error('continuation_config_invalid');
  }
  if (config?.version !== 1 || !Array.isArray(config.mappings) || config.mappings.length > 4)
    throw new Error('continuation_config_invalid');
  const seen = new Set();
  const seenEpic = new Set();
  for (const row of config.mappings) {
    if (
      !EPIC.test(row?.epic) ||
      !ID.test(row?.docket_run_id) ||
      !DISPATCH.test(row?.dispatch_id) ||
      !ID.test(row?.orca_run_id) ||
      !WORKSPACE.test(row?.workspace_id) ||
      row?.agent !== 'codex' ||
      seen.has(row.docket_run_id) ||
      seenEpic.has(row.epic)
    )
      throw new Error('continuation_config_invalid');
    seen.add(row.docket_run_id);
    seenEpic.add(row.epic);
  }
  return config.mappings;
}

export function continuationProblem(records) {
  if (!records || typeof records !== 'object' || Array.isArray(records))
    return 'continuations_shape';
  for (const [runId, record] of Object.entries(records)) {
    if (
      !ID.test(runId) ||
      typeof record !== 'object' ||
      record === null ||
      !/^[a-f0-9]{64}$/.test(record.key ?? '') ||
      !['intent', 'started', 'acknowledged', 'escalated'].includes(record.state) ||
      !Number.isInteger(record.attempts) ||
      record.attempts < 0 ||
      record.attempts > RETRIES_MS.length ||
      !Number.isFinite(record.next_at) ||
      !Number.isFinite(record.first_at) ||
      (record.dispatch_id !== null &&
        record.dispatch_id !== undefined &&
        !DISPATCH.test(record.dispatch_id))
    )
      return 'continuations_shape';
  }
  return null;
}

function candidate(mapping, agents, now) {
  if (!Array.isArray(agents?.rows) || agents.rows.length > 500) return { hold: 'roster_unknown' };
  const matches = agents.rows.filter(
    (row) => row.row_kind === 'run' && row.run_id === mapping.docket_run_id,
  );
  if (matches.length !== 1) return { hold: 'run_identity_unknown' };
  const row = matches[0];
  if (row.item_id !== mapping.epic || row.project !== 'DKT') return { hold: 'epic_mismatch' };
  if (row.run_state !== 'parked') return { inactive: true };
  if (row.lease !== 'paused' || !row.lead_parked) return { hold: 'claim_unknown' };
  const waiting = row.lead_parked.waiting_on;
  if (waiting?.orchestrator !== true || waiting?.person === true)
    return { hold: 'not_coordinator_wake' };
  if (
    (waiting.items && (!Array.isArray(waiting.items) || waiting.items.length > 0)) ||
    waiting.until
  )
    return { hold: 'additional_wait_conditions' };
  const wake = waiting.wake;
  const due = Date.parse(wake?.due_at ?? '');
  if (!Number.isFinite(due) || !wake?.actor || !wake?.event) return { hold: 'wake_unknown' };
  if (due > now) return { notDue: true };
  return {
    row,
    due,
    key: hash(
      `${mapping.docket_run_id}\0${mapping.dispatch_id}\0${wake.due_at}\0${row.lead_parked.since}`,
    ),
  };
}

function exactItem(mapping, detail) {
  const item = detail?.item;
  if (item?.id !== mapping.epic || item.project !== 'DKT' || item.type !== 'Epic') return false;
  if (item.open_question && !item.open_question.answered_at) return false;
  const runs = item.runs?.filter((run) => run.run_id === mapping.docket_run_id);
  if (runs?.length !== 1) return false;
  const run = runs[0];
  if (run.run_state !== 'parked' || run.is_lead !== true) return false;
  if (
    run.orchestrator?.dispatch_id !== mapping.dispatch_id ||
    (run.orchestrator.run_id && run.orchestrator.run_id !== mapping.orca_run_id)
  )
    return false;
  if (
    run.workspace?.path?.replaceAll('\\', '/').toLowerCase() !==
    mapping.workspace_id.split('::')[1].replaceAll('\\', '/').toLowerCase()
  )
    return false;
  if (
    detail.decisions?.some(
      (decision) => decision.authority === 'owner' && decision.status === 'active',
    )
  )
    return false;
  return true;
}

function exactDispatch(mapping, dispatch) {
  return (
    dispatch?.found === true &&
    dispatch.runId === mapping.orca_run_id &&
    dispatch.status === 'completed' &&
    typeof dispatch.capabilityRevokedAt === 'string' &&
    dispatch.workspaceId === mapping.workspace_id
  );
}

const SETTLED_WORKER = new Set(['succeeded', 'failed', 'stopped', 'abandoned']);
const SETTLED_DISPATCH = new Set(['completed', 'failed', 'stopped', 'abandoned', 'cancelled']);

async function activeProducer(mapping, workers, orca) {
  if (!Array.isArray(workers) || workers.length > 500) return null;
  if (workers.some((worker) => !worker.workspace || !worker.host)) return null;
  const relevant = workers.filter(
    (worker) => worker.workspace === mapping.workspace_id && worker.host === 'local',
  );
  if (
    relevant.some(
      (worker) =>
        worker.outcome === 'in_progress' ||
        worker.liveness === 'live' ||
        !SETTLED_WORKER.has(worker.state),
    )
  )
    return true;
  if (relevant.length > 30) return null;
  for (const worker of relevant) {
    if (worker.liveness === 'exited') continue;
    if (!['unknown', 'unverifiable'].includes(worker.liveness)) return null;
    if (!DISPATCH.test(worker.dispatchId ?? '')) return null;
    const receipt = await orca.showDispatch(worker.dispatchId);
    if (
      !receipt?.found ||
      receipt.runId !== mapping.orca_run_id ||
      receipt.workspaceId !== mapping.workspace_id ||
      !SETTLED_DISPATCH.has(receipt.status) ||
      receipt.workerState !== worker.state ||
      typeof receipt.capabilityRevokedAt !== 'string' ||
      receipt.resourceState !== 'absent' ||
      receipt.terminalAbsent !== true ||
      receipt.terminalResourceAbsent !== true
    )
      return null;
  }
  return false;
}

/** One bounded scan. All ports are read-only except Orca's idempotent follow-up and escalation. */
export async function scanContinuations({
  mappings,
  state,
  save,
  docket,
  orca,
  now = Date.now,
  log = () => {},
}) {
  if (mappings.length === 0) return;
  let agents, paused;
  try {
    [agents, paused] = await Promise.all([docket.readAgents(), docket.readDocketPause()]);
  } catch {
    log('continuation_hold', { reason: 'roster_unavailable' });
    return;
  }
  if (paused !== false) {
    log('continuation_hold', { reason: 'project_paused_or_unknown' });
    return;
  }
  for (const mapping of mappings) {
    const t = now();
    const finding = candidate(mapping, agents, t);
    const prior = state.continuations[mapping.docket_run_id];
    if (finding.inactive) {
      if (prior?.state === 'started') {
        prior.state = 'acknowledged';
        prior.ack_at = t;
        save();
        log('continuation_acknowledged', { item: mapping.epic });
      }
      continue;
    }
    if (finding.notDue || finding.hold) continue;
    if (prior && prior.key !== finding.key && prior.state === 'started') {
      prior.state = 'acknowledged';
      prior.ack_at = t;
      save();
      log('continuation_acknowledged', { item: mapping.epic });
      continue;
    }
    const record =
      prior?.key === finding.key
        ? prior
        : {
            key: finding.key,
            state: 'intent',
            attempts: 0,
            first_at: t,
            next_at: t,
            dispatch_id: null,
            escalation_attempts: 0,
          };
    if (record !== prior) {
      state.continuations[mapping.docket_run_id] = record;
      save();
    }
    if (record.state === 'acknowledged' || t < record.next_at) continue;
    if (record.state === 'started') {
      if (t - record.started_at < ACK_MS) continue;
      record.state = 'escalated';
      save();
    }
    if (record.state === 'intent') {
      try {
        const [detail, dispatch, workers] = await Promise.all([
          docket.readContinuationItem(mapping.epic),
          orca.showDispatch(mapping.dispatch_id),
          orca.listWorkers(mapping.orca_run_id),
        ]);
        if (!exactItem(mapping, detail) || !exactDispatch(mapping, dispatch)) {
          record.state = 'escalated';
          record.reason = 'identity_mismatch';
          save();
        } else {
          const active = await activeProducer(mapping, workers, orca);
          if (active === true) {
            if (t - record.first_at < ACK_MS) continue;
            record.state = 'escalated';
            record.reason = 'active_producer_no_ack';
            save();
          } else if (active === null) {
            record.state = 'escalated';
            record.reason = 'worker_custody_unknown';
            save();
          } else {
            // Docket and Orca cannot share a transaction. Narrow the race at the
            // start boundary, then make the new agent recheck before acting.
            const fresh = candidate(mapping, await docket.readAgents(), now());
            if (fresh.key !== finding.key || fresh.hold || fresh.inactive || fresh.notDue) continue;
            if ((await docket.readDocketPause()) !== false) continue;
            if (!exactItem(mapping, await docket.readContinuationItem(mapping.epic))) continue;
            const freshWorkers = await orca.listWorkers(mapping.orca_run_id);
            if ((await activeProducer(mapping, freshWorkers, orca)) !== false) continue;
            const requestId = requestIdFor('continuation', finding.key);
            const spec = `Docket-only due coordinator wake for ${mapping.epic}, same Docket run ${mapping.docket_run_id}. The prior Orca Dispatch ${mapping.dispatch_id} completed. Verify your exact claim, installed Docket state, producer worktree and current admission before any work. Send a status receipt to your Orca coordinator, then continue only authorized Docket work; if the external gate remains held, report it with a bounded next action. Do not release a claim or resource, start Gameflow work, mutate a host, or treat this wake as owner approval.`;
            record.attempts += 1;
            record.next_at = t + RETRIES_MS[Math.min(record.attempts, RETRIES_MS.length - 1)];
            save();
            const started = await orca.startFollowup({
              runId: mapping.orca_run_id,
              workspaceId: mapping.workspace_id,
              agent: mapping.agent,
              spec,
              requestId,
            });
            if (started?.ok && DISPATCH.test(started.dispatchId ?? '')) {
              const receipt = await orca.showDispatch(started.dispatchId);
              if (
                receipt?.found &&
                receipt.runId === mapping.orca_run_id &&
                receipt.workspaceId === mapping.workspace_id &&
                receipt.status === 'dispatched' &&
                receipt.capabilityRevokedAt === null &&
                receipt.workerState === 'ready'
              ) {
                record.state = 'started';
                record.dispatch_id = started.dispatchId;
                record.started_at = now();
                save();
                log('continuation_started', { item: mapping.epic, dispatch: started.dispatchId });
                continue;
              }
            }
            if (record.attempts >= RETRIES_MS.length) {
              record.state = 'escalated';
              record.reason = 'start_unconfirmed';
              save();
            }
          }
        }
      } catch {
        record.read_failures = (record.read_failures ?? 0) + 1;
        record.next_at = t + 60_000;
        if (record.read_failures >= 3 || record.attempts >= RETRIES_MS.length) {
          record.state = 'escalated';
          record.reason = 'read_or_start_unknown';
        }
        save();
      }
    }
    if (record.state === 'escalated' && (record.escalation_attempts ?? 0) < 3) {
      const to = `run:${mapping.orca_run_id}`;
      const requestId = requestIdFor('continuation-escalation', finding.key);
      record.escalation_attempts = (record.escalation_attempts ?? 0) + 1;
      record.next_at = t + 5 * 60_000;
      save();
      const sent = await orca.send({
        to,
        type: 'escalation',
        subject: `${mapping.epic} producer continuation needs custody review`,
        body: `Docket run ${mapping.docket_run_id} still has a due coordinator wake. Automatic follow-up was not confirmed (${record.reason ?? 'no_ack'}). Recheck exact Docket and Orca custody; keep unknown or protected resources held.`,
        requestId,
      });
      if (sent.ok || sent.code === 'request_mismatch') {
        record.escalated_at = now();
        save();
        log('continuation_escalated', { item: mapping.epic, reason: record.reason ?? 'no_ack' });
      }
    }
  }
}

export async function runContinuationLoop(args, signal, sleep) {
  while (!signal.aborted) {
    try {
      await scanContinuations(args);
    } catch {
      args.log('continuation_hold', { reason: 'unexpected' });
    }
    if (!signal.aborted) await sleep(SCAN_MS, signal);
  }
}

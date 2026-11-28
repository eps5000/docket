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
      !['intent', 'requested', 'started', 'acknowledged', 'escalated'].includes(record.state) ||
      !Number.isInteger(record.attempts) ||
      record.attempts < 0 ||
      record.attempts > RETRIES_MS.length ||
      !Number.isFinite(record.next_at) ||
      !Number.isFinite(record.first_at) ||
      (record.wait_since !== undefined && typeof record.wait_since !== 'string') ||
      (['requested', 'started'].includes(record.state) && !Number.isFinite(record.requested_at)) ||
      (record.state === 'started' && !Number.isFinite(record.started_at)) ||
      (record.dispatch_id !== null &&
        record.dispatch_id !== undefined &&
        !DISPATCH.test(record.dispatch_id)) ||
      (record.current_dispatch_id !== undefined && !DISPATCH.test(record.current_dispatch_id))
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

function utcMillis(value) {
  if (typeof value !== 'string') return NaN;
  return Date.parse(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
}

/** A coordinator-created Dispatch must be recorded on the same Docket run. */
async function verifiedHandoff(mapping, detail, orca, requestedAt) {
  if (
    detail?.item?.id !== mapping.epic ||
    detail.item.project !== 'DKT' ||
    detail.item.type !== 'Epic' ||
    (detail.item.open_question && !detail.item.open_question.answered_at) ||
    detail.decisions?.some(
      (decision) => decision.authority === 'owner' && decision.status === 'active',
    )
  )
    return null;
  const runs = detail.item.runs?.filter((run) => run.run_id === mapping.docket_run_id);
  if (runs?.length !== 1) return null;
  const run = runs[0];
  if (run.is_lead !== true || run.orchestrator?.run_id !== mapping.orca_run_id) return null;
  if (
    run.workspace?.path?.replaceAll('\\', '/').toLowerCase() !==
    mapping.workspace_id.split('::')[1].replaceAll('\\', '/').toLowerCase()
  )
    return null;
  const id = run.orchestrator?.dispatch_id;
  if (!DISPATCH.test(id ?? '') || id === mapping.dispatch_id) return null;
  const dispatch = await orca.showDispatch(id);
  if (
    !dispatch?.found ||
    dispatch.runId !== mapping.orca_run_id ||
    dispatch.workspaceId !== mapping.workspace_id ||
    dispatch.creatorDispatchId !== null ||
    dispatch.agent !== mapping.agent ||
    !Number.isFinite(utcMillis(dispatch.dispatchedAt)) ||
    utcMillis(dispatch.dispatchedAt) < requestedAt ||
    !['dispatched', 'completed'].includes(dispatch.status)
  )
    return null;
  return id;
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

async function sendEscalation(mapping, record, orca, save, now, log, t) {
  if (record.state !== 'escalated' || (record.escalation_attempts ?? 0) >= 3 || t < record.next_at)
    return;
  const requestId = requestIdFor('continuation-escalation', record.key);
  record.escalation_attempts = (record.escalation_attempts ?? 0) + 1;
  record.next_at = t + 5 * 60_000;
  save();
  const sent = await orca.send({
    to: `run:${mapping.orca_run_id}`,
    type: 'escalation',
    subject: `${mapping.epic} producer continuation needs custody review`,
    body: `Docket run ${mapping.docket_run_id} still has a due coordinator wake. The exact coordinator handoff was not confirmed (${record.reason ?? 'no_ack'}). Recheck exact Docket and Orca custody; keep unknown or protected resources held.`,
    requestId,
  });
  if (sent.ok || sent.code === 'request_mismatch') {
    record.escalated_at = now();
    save();
    log('continuation_escalated', { item: mapping.epic, reason: record.reason ?? 'no_ack' });
  }
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
    const prior = state.continuations[mapping.docket_run_id];
    const effective = prior?.current_dispatch_id
      ? { ...mapping, dispatch_id: prior.current_dispatch_id }
      : mapping;
    const finding = candidate(effective, agents, t);
    if (prior && ['requested', 'started'].includes(prior.state)) {
      try {
        const detail = await docket.readContinuationItem(mapping.epic);
        const handoff = await verifiedHandoff(effective, detail, orca, prior.requested_at);
        if (handoff && !prior.dispatch_id) {
          prior.dispatch_id = handoff;
          prior.state = 'started';
          prior.started_at = t;
          save();
          log('continuation_started', { item: mapping.epic, dispatch: handoff });
        }
        const currentRow = agents.rows.find(
          (row) => row.row_kind === 'run' && row.run_id === mapping.docket_run_id,
        );
        const revisedPark =
          typeof currentRow?.lead_parked?.since === 'string' &&
          currentRow.lead_parked.since !== prior.wait_since;
        if (handoff && (finding.inactive || revisedPark)) {
          prior.state = 'acknowledged';
          prior.current_dispatch_id = handoff;
          prior.ack_at = t;
          save();
          log('continuation_acknowledged', { item: mapping.epic });
          continue;
        }
      } catch {
        // An unreadable handoff cannot acknowledge the wake.
      }
      if (t - (prior.started_at ?? prior.requested_at) >= ACK_MS) {
        prior.state = 'escalated';
        prior.reason = prior.dispatch_id ? 'started_no_ack' : 'coordinator_no_handoff';
        save();
      } else continue;
    }
    if (finding.inactive || finding.notDue || finding.hold) {
      if (prior) await sendEscalation(mapping, prior, orca, save, now, log, t);
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
            wait_since: finding.row.lead_parked.since,
            next_at: t,
            dispatch_id: null,
            ...(prior?.current_dispatch_id
              ? { current_dispatch_id: prior.current_dispatch_id }
              : {}),
            escalation_attempts: 0,
          };
    if (record !== prior) {
      state.continuations[mapping.docket_run_id] = record;
      save();
    }
    if (record.state === 'acknowledged' || t < record.next_at) continue;
    if (record.state === 'intent') {
      try {
        const [detail, dispatch, workers] = await Promise.all([
          docket.readContinuationItem(mapping.epic),
          orca.showDispatch(effective.dispatch_id),
          orca.listWorkers(mapping.orca_run_id),
        ]);
        if (!exactItem(effective, detail) || !exactDispatch(effective, dispatch)) {
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
            const fresh = candidate(effective, await docket.readAgents(), now());
            if (fresh.key !== finding.key || fresh.hold || fresh.inactive || fresh.notDue) continue;
            if ((await docket.readDocketPause()) !== false) continue;
            if (!exactItem(effective, await docket.readContinuationItem(mapping.epic))) continue;
            const freshWorkers = await orca.listWorkers(mapping.orca_run_id);
            if ((await activeProducer(mapping, freshWorkers, orca)) !== false) continue;
            const requestId = requestIdFor('continuation', finding.key);
            const body = `ACTIONABLE Docket-only producer wake for ${mapping.epic}: Docket run ${mapping.docket_run_id} has a due coordinator-only wait and prior completed Dispatch ${effective.dispatch_id}. As the verified coordinator of Orca Run ${mapping.orca_run_id}, recheck the exact Docket run, mapped producer worktree, active producer custody, admission, and wait; then start at most one codex follow-up in that same Run/worktree under your own Orca authority. Record the verified new Dispatch as Docket dispatch_observation live and require its heartbeat or new bounded park. This request ${requestId} is idempotent; do not start Gameflow work, release claims/resources, mutate a host, or treat the wake as owner approval. If any gate fails, report the precise hold. The relay will escalate if no exact handoff is observed within five minutes.`;
            record.attempts += 1;
            record.next_at = t + RETRIES_MS[Math.min(record.attempts, RETRIES_MS.length - 1)];
            save();
            const sent = await orca.send({
              to: `run:${mapping.orca_run_id}`,
              type: 'status',
              subject: `${mapping.epic} due producer continuation request`,
              body,
              requestId,
            });
            if (sent?.ok) {
              record.state = 'requested';
              record.requested_at = now();
              record.next_at = record.requested_at + ACK_MS;
              save();
              log('continuation_requested', { item: mapping.epic });
              continue;
            }
            if (record.attempts >= RETRIES_MS.length) {
              record.state = 'escalated';
              record.reason = 'request_unconfirmed';
              record.next_at = t;
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
          record.next_at = t;
        }
        save();
      }
    }
    await sendEscalation(mapping, record, orca, save, now, log, t);
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

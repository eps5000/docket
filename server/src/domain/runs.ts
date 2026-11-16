/**
 * Lead claims, leases, runs and signals (BUILD_SPEC §5.3, §5.4): the `runs` service.
 *
 * US1 (T071) implements claims, release, child runs, heartbeats, finishing,
 * signals and lease expiry. Still stubs: the owner's release and *Return to
 * Ready* (US6, T107), and parking, resources and the recovery fields
 * (US11, T099). Claim and start accept the recovery fields (workspace,
 * orchestrator, brief, external) and ignore them until US11 stores them.
 */
import { ToolError, type ItemSummary, type SignalKind } from '@tasklite/shared';
import {
  notImplemented,
  type In,
  type Out,
  type ReceiptContext,
  type RunSignalInput,
  type RunsService,
  type ServiceDeps,
} from './contracts.js';
import { newId } from './ids.js';
import {
  activeLead,
  actorName,
  assertCallerRun,
  callerName,
  displayRunState,
  getRun,
  isRunOpen,
  isoPlus,
  leaseExpired,
  ms,
  requireItem,
  runEndedError,
  summaryOf,
  utcTime,
  windowsOf,
  type RunRow,
} from './model.js';
import type { WriteContext } from './write.js';

/**
 * A refused claim (§5.3). The refusal is recorded as a `claim.rejected`
 * event the owner sees, but this error rolls the claim's transaction back,
 * so the adapter records it in a write of its own with `recordRejection`
 * (never under the caller's idempotency key: a retry must be refused again).
 */
export class ClaimConflict extends ToolError {
  readonly recordRejection: (w: WriteContext) => void;
  constructor(message: string, current: unknown, record: (w: WriteContext) => void) {
    super('conflict', message, { current });
    this.name = 'ClaimConflict';
    this.recordRejection = record;
  }
}

export function createRunsService(deps: ServiceDeps): RunsService {
  const windows = () => windowsOf(deps.config);
  const summary = (w: { db: WriteContext['db']; now: string }, id: string): ItemSummary =>
    summaryOf({ db: w.db, windows: windows(), now: w.now }, id);

  /** End a run: a terminal state, its end reason, and the claim it held goes with it. */
  function endRun(
    w: WriteContext,
    run: RunRow,
    state: 'finished' | 'failed' | 'interrupted',
    endReason: NonNullable<RunRow['end_reason']>,
    extra: { summary?: string; error?: string } = {},
  ): void {
    w.update('runs', run.id, { state, end_reason: endReason, ...extra });
  }

  /** Move an item, appending `item.status_changed`. */
  function moveItem(
    w: WriteContext,
    itemId: string,
    project: string,
    from: string,
    to: string,
    why: string,
  ) {
    w.update('items', itemId, { status: to });
    w.event({
      type: 'item.status_changed',
      summary: `${itemId} moved from ${from} to ${to}: ${why}`,
      item_id: itemId,
      project_key: project,
      data: { status: { old: from, new: to } },
    });
  }

  /** The sweeper's (and a late claim's) lease expiry: run interrupted, item back to Ready. */
  function expire(w: WriteContext, run: RunRow): void {
    const item = requireItem(w.db, run.item_id);
    endRun(w, run, 'interrupted', 'lease_expired');
    const lead = actorName({ kind: 'agent', client: run.client, label: run.label });
    w.event({
      type: 'claim.released',
      summary: `Lease expired on ${item.id} (${lead}); the run is interrupted and the plan kept`,
      item_id: item.id,
      project_key: item.project_key,
      data: { run_id: run.id, end_reason: 'lease_expired' },
      objects: [{ kind: 'run', id: run.id }],
    });
    if (item.status === 'progress') {
      moveItem(w, item.id, item.project_key, 'progress', 'ready', 'lease expired');
    }
  }

  /** Record a signal on an open run (§5.4); a lead's lease runs LEASE from now. Not an event. */
  function signal(r: ReceiptContext, runId: string, kind: SignalKind): void {
    const run = getRun(r.db, runId);
    // Ended runs stay ended; parked runs resume through US11; an expired lease is not revived.
    if (!run || (run.state !== 'open' && run.state !== 'needs_input') || leaseExpired(run, r.now))
      return;
    r.db.sqlite
      .prepare(
        `UPDATE runs SET last_signal_at = ?, last_signal_kind = ?,
           lease_expires_at = CASE WHEN is_lead = 1 THEN ? ELSE lease_expires_at END
         WHERE id = ? AND state IN ('open', 'needs_input')`,
      )
      .run(r.now, kind, isoPlus(r.now, deps.config.leaseMs), runId);
  }

  function requireRun(db: WriteContext['db'], runId: string): RunRow {
    const run = getRun(db, runId);
    if (!run) {
      throw new ToolError(
        'not_found',
        `No run ${runId}. Use the run_id claim_lead or start_run gave you.`,
      );
    }
    return run;
  }

  /** Only the agent that holds a run may end it (FR-027). */
  function assertOwnRun(w: { actor: WriteContext['actor'] }, run: RunRow): void {
    if (w.actor.kind === 'agent' && w.actor.client !== run.client) {
      const holder = actorName({ kind: 'agent', client: run.client, label: run.label });
      throw new ToolError(
        'forbidden',
        `Run ${run.id} belongs to ${holder}; only that agent can end it. Leave it, or ask the owner to release it.`,
      );
    }
  }

  return {
    claim(w, input: In<'claim_lead'>): Out<'claim_lead'> {
      const item = requireItem(w.db, input.id);
      const lead = activeLead(w.db, item.id);
      if (lead && leaseExpired(lead, w.now)) {
        // The lease ran out before the sweeper got to it: end it now, then claim.
        expire(w, lead);
      } else if (lead) {
        const holder = actorName({ kind: 'agent', client: lead.client, label: lead.label });
        const current = {
          lead_client: lead.client,
          lead_label: lead.label,
          run_id: lead.id,
          last_signal_at: lead.last_signal_at,
          lease_expires_at: lead.lease_expires_at,
        };
        const lease = lead.lease_expires_at
          ? ` (lease until ${utcTime(lead.lease_expires_at, w.now)})`
          : '';
        throw new ClaimConflict(
          `${item.id} is led by ${holder}${lease}. Pick another item.`,
          current,
          (rw) => {
            rw.event({
              type: 'claim.rejected',
              summary: `Lead claim by ${callerName(rw.db, rw.actor)} rejected (lease held by ${holder})`,
              item_id: item.id,
              project_key: item.project_key,
              data: { conflict: current },
            });
          },
        );
      }

      const status = requireItem(w.db, item.id).status;
      if (status === 'ready') {
        const deps2 = summary(w, item.id);
        if (deps2.blocked) {
          throw new ToolError(
            'validation',
            `${item.id} is blocked by ${deps2.blocked_by.join(', ')}. Pick another item from search_items "ready_to_start".`,
            { details: { blocked_by: deps2.blocked_by } },
          );
        }
      } else if (status !== 'progress') {
        throw new ToolError(
          'validation',
          `${item.id} is ${status}; only Ready items, or In progress items with no lead, can be claimed. Pick one from search_items "ready_to_start" or "resumable".`,
          { details: { status, allowed: ['ready', 'progress'] } },
        );
      }

      const runId = newId('run', ms(w.now));
      const label = input.agent_label ?? w.actor.label ?? null;
      const leaseUntil = isoPlus(w.now, deps.config.leaseMs);
      w.insert('runs', {
        id: runId,
        item_id: item.id,
        parent_run_id: null,
        client: w.actor.client ?? w.actor.kind,
        label,
        session_id: w.actor.session_id ?? null,
        is_lead: true,
        state: 'open',
        last_signal_at: w.now,
        // Conservative until the adapter classifies the claiming call (§5.4).
        last_signal_kind: 'report',
        lease_expires_at: leaseUntil,
      });
      const who = actorName({ kind: 'agent', client: w.actor.client, label });
      w.event({
        type: 'claim.granted',
        summary:
          status === 'ready'
            ? `${who} claimed lead (${Math.round(deps.config.leaseMs / 60_000)} min lease)`
            : `${who} claimed lead to resume (${Math.round(deps.config.leaseMs / 60_000)} min lease)`,
        item_id: item.id,
        project_key: item.project_key,
        data: { run_id: runId, lease_expires_at: leaseUntil, resumed: status === 'progress' },
        objects: [{ kind: 'run', id: runId }],
      });
      if (status === 'ready')
        moveItem(w, item.id, item.project_key, 'ready', 'progress', `claimed by ${who}`);
      else w.update('items', item.id, {});
      return { run_id: runId, item: summary(w, item.id), lease_expires_at: leaseUntil };
    },

    release(w, input) {
      const item = requireItem(w.db, input.id);
      const run = requireRun(w.db, input.run_id);
      if (run.item_id !== item.id) {
        throw new ToolError(
          'validation',
          `Run ${run.id} is on ${run.item_id}, not ${item.id}. Pass the run that leads ${item.id}.`,
        );
      }
      assertOwnRun(w, run);
      if (!run.is_lead) {
        throw new ToolError(
          'validation',
          `Run ${run.id} is a child run, not the lead. End it with finish_run.`,
        );
      }
      if (!isRunOpen(run.state) || leaseExpired(run, w.now)) throw runEndedError(w.db, run, w.now);
      endRun(w, run, 'interrupted', 'released');
      w.event({
        type: 'claim.released',
        summary: `${callerName(w.db, w.actor)} released the lead on ${item.id}: ${input.reason}`,
        item_id: item.id,
        project_key: item.project_key,
        data: { run_id: run.id, end_reason: 'released', reason: input.reason },
        objects: [{ kind: 'run', id: run.id }],
      });
      if (item.status === 'progress')
        moveItem(w, item.id, item.project_key, 'progress', 'ready', 'lead released');
      else w.update('items', item.id, {});
      return summary(w, item.id);
    },

    ownerRelease: notImplemented('runs.ownerRelease'),
    returnToReady: notImplemented('runs.returnToReady'),

    startRun(w, input) {
      assertCallerRun(w.db, w.actor, w.now);
      const item = requireItem(w.db, input.id);
      const parent = getRun(w.db, input.parent_run_id);
      if (
        !parent ||
        parent.item_id !== item.id ||
        parent.is_lead !== 1 ||
        !isRunOpen(parent.state) ||
        leaseExpired(parent, w.now)
      ) {
        throw new ToolError(
          'validation',
          `${input.parent_run_id} is not an open lead run on ${item.id}. Pass the run_id your claim_lead on ${item.id} returned.`,
          { details: { parent_run_id: input.parent_run_id } },
        );
      }
      const runId = newId('run', ms(w.now));
      const label = input.agent_label ?? null;
      w.insert('runs', {
        id: runId,
        item_id: item.id,
        parent_run_id: parent.id,
        client: w.actor.client ?? w.actor.kind,
        label,
        session_id: w.actor.session_id ?? null,
        is_lead: false,
        state: 'open',
        last_signal_at: w.now,
        last_signal_kind: 'report',
        lease_expires_at: null,
      });
      w.event({
        type: 'run.started',
        summary: `Child run ${label ?? runId} started under ${parent.label ?? parent.id}`,
        item_id: item.id,
        project_key: item.project_key,
        data: { run_id: runId, parent_run_id: parent.id },
        objects: [{ kind: 'run', id: runId }],
      });
      return { run_id: runId };
    },

    heartbeat(r, input) {
      const run = getRun(r.db, input.run_id);
      if (!run)
        throw new ToolError(
          'not_found',
          `No run ${input.run_id}. Use the run_id claim_lead or start_run gave you.`,
        );
      if (!isRunOpen(run.state) || leaseExpired(run, r.now)) throw runEndedError(r.db, run, r.now);
      if (input.current_step_id) {
        const step = r.db.sqlite
          .prepare('SELECT item_id FROM work_steps WHERE id = ?')
          .get(input.current_step_id) as { item_id: string } | undefined;
        if (!step || step.item_id !== run.item_id) {
          throw new ToolError(
            'validation',
            `${input.current_step_id} is not a work step on ${run.item_id}. Use a step id from get_item.`,
            { details: { current_step_id: input.current_step_id } },
          );
        }
      }
      r.db.sqlite
        .transaction(() => {
          if (input.current_step_id !== undefined || input.note !== undefined) {
            r.db.sqlite
              .prepare(
                'UPDATE runs SET current_step_id = coalesce(?, current_step_id), summary = coalesce(?, summary) WHERE id = ?',
              )
              .run(input.current_step_id ?? null, input.note ?? null, run.id);
          }
          // The MCP signal hook has already recorded this call; another adapter's call can't prove a session.
          const fresh = getRun(r.db, run.id)!;
          if (ms(fresh.last_signal_at) < ms(r.now)) signal(r, run.id, 'report');
        })
        .immediate();
      const after = getRun(r.db, run.id)!;
      const resources = (
        r.db.sqlite
          .prepare(
            'SELECT id, label FROM run_resources WHERE run_id = ? AND released_at IS NULL ORDER BY started_at, id',
          )
          .all(run.id) as { id: string; label: string }[]
      ).map((x) => ({ id: x.id, label: x.label }));
      return {
        run_state: displayRunState(after, windows(), r.now),
        lease_expires_at: after.lease_expires_at,
        resources,
      };
    },

    updateResources: notImplemented('runs.updateResources'),

    finish(w, input) {
      const run = requireRun(w.db, input.run_id);
      assertOwnRun(w, run);
      if (!isRunOpen(run.state) || leaseExpired(run, w.now)) throw runEndedError(w.db, run, w.now);
      const item = requireItem(w.db, run.item_id);
      endRun(w, run, input.result, input.result, {
        summary: input.summary,
        ...(input.error !== undefined ? { error: input.error } : {}),
      });
      w.event({
        type: 'run.ended',
        summary: `${run.is_lead ? 'Lead run' : `Child run ${run.label ?? run.id}`} ${input.result}: ${input.summary}`,
        item_id: item.id,
        project_key: item.project_key,
        data: { run_id: run.id, end_reason: input.result, is_lead: run.is_lead === 1 },
        objects: [{ kind: 'run', id: run.id }],
      });
      return { run_state: input.result };
    },

    park: notImplemented('runs.park'),
    resume: notImplemented('runs.resume'),

    recordSignal(r, input: RunSignalInput) {
      r.db.sqlite.transaction(() => signal(r, input.run_id, input.kind)).immediate();
    },

    expireLeases(w) {
      const due = w.db.sqlite
        .prepare(
          `SELECT * FROM runs WHERE is_lead = 1 AND state IN ('open', 'needs_input')
             AND lease_expires_at IS NOT NULL AND lease_expires_at <= ? ORDER BY lease_expires_at, id`,
        )
        .all(w.now) as RunRow[];
      for (const run of due) expire(w, run);
      return { interrupted: due.map((r) => r.id) };
    },

    interruptOpenRuns(w, input) {
      const open = w.db.sqlite
        .prepare(
          "SELECT * FROM runs WHERE state IN ('open', 'needs_input') ORDER BY created_at, id",
        )
        .all() as RunRow[];
      for (const run of open) {
        const item = requireItem(w.db, run.item_id);
        endRun(w, run, 'interrupted', 'service_restart');
        w.event({
          type: 'run.ended',
          summary: `${run.is_lead ? 'Lead run' : `Child run ${run.label ?? run.id}`} interrupted: ${input.reason}`,
          item_id: item.id,
          project_key: item.project_key,
          data: { run_id: run.id, end_reason: 'service_restart', is_lead: run.is_lead === 1 },
          objects: [{ kind: 'run', id: run.id }],
        });
      }
      return { interrupted: open.map((r) => r.id) };
    },

    openRunSessions(r) {
      return r.db.sqlite
        .prepare(
          "SELECT id AS run_id, session_id FROM runs WHERE state IN ('open', 'needs_input') AND session_id IS NOT NULL ORDER BY created_at, id",
        )
        .all() as { run_id: string; session_id: string }[];
    },
  };
}

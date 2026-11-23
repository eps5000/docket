/**
 * Lead claims, leases, runs and signals (BUILD_SPEC §5.3, §5.4): the `runs` service.
 *
 * US1 (T071) implements claims, release, child runs, heartbeats, finishing,
 * signals and lease expiry. US11 (T099) adds recovery (BUILD_SPEC §5.16):
 * claim and start record the workspace, orchestrator, `external` and the
 * brief (an immutable `brief` document version); heartbeats patch the
 * workspace and declare or release resources; `park_run` suspends the lease
 * and any later call resumes it (the MCP signal hook calls `resume`);
 * `finish_run` warns about unreleased resources and unpushed commits.
 *
 * US6 (T120) adds the owner's *Release lead claim* and *Return to Ready*.
 * Both are undoable, and undo restores the item's status, never the run
 * (BUILD_SPEC §5.1, §5.3). Ending a lead on the owner's behalf is
 * `endLeadForOwner`, which US7's owner cancel reuses with `canceled`.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  RESOURCE_KIND_LABELS,
  ToolError,
  activityText,
  COORDINATOR_PARK,
  jsonBytes,
  LIMITS,
  type ItemSummary,
  type ResourceKind,
  type RunStatusUpdate,
  type SignalKind,
  type WaitingOn,
} from '@docket/shared';
import {
  type In,
  type Out,
  type ReceiptContext,
  type InstructionReportInput,
  type RunSignalInput,
  type RunsService,
  type ServiceDeps,
} from './contracts.js';
import { newId } from './ids.js';
import {
  parkInfo,
  parseJson,
  sameSha,
  storedWorkspace,
  unpushedCount,
  type StoredWorkspace,
} from './recovery-model.js';
import {
  activeLead,
  actorName,
  assertCallerRun,
  callerName,
  coordinatorParkOf,
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
  type ItemRow,
  type RunRow,
} from './model.js';
import { WaitReader } from './wait.js';
import { assertDesignCleared } from './design-review.js';
import { settleClaim } from './shared-changes.js';
import type { InverseOp, WriteContext } from './write.js';
import { claimBranchHint } from './project-git.js';
import { addReportedBranch } from './radar.js';
import {
  producerHold,
  namesCoordinator,
  storedActivity,
  type ActivityFinding,
} from './run-activity.js';

/**
 * End an item's active lead on the owner's behalf: *Release lead claim*
 * (`owner_released`) or the owner's cancel (`canceled`, US7). The run
 * becomes `interrupted` with that `end_reason`, so B10's recovery views
 * count it as an interruption (`recovery_report`, Problems, Workspaces),
 * and a `claim.released` event names it in `data.run_id` (when it ended,
 * for those views). The run's next call gets `conflict` (§5.3).
 *
 * The run is not part of the owner's undo: undo restores the item's
 * status, not the run (BUILD_SPEC §5.1). So this event's inverse only
 * touches the item (a version bump), which keeps the mutation undoable
 * without reviving the run. The caller moves the item, with its own
 * `item.status_changed` event and inverse.
 *
 * Returns the run it ended, or undefined when the item has no lead. Child
 * runs are left as they are, as on lease expiry: they end themselves.
 */
export function endLeadForOwner(
  w: WriteContext,
  item: { id: string; project_key: string },
  endReason: 'owner_released' | 'canceled',
): RunRow | undefined {
  const lead = activeLead(w.db, item.id);
  if (!lead) return undefined;
  w.update('runs', lead.id, { state: 'interrupted', end_reason: endReason });
  const holder = actorName({ kind: 'agent', client: lead.client, label: lead.label });
  const touchItem: InverseOp = { op: 'update', table: 'items', id: item.id, set: {} };
  w.event({
    type: 'claim.released',
    summary:
      endReason === 'owner_released'
        ? `You released ${holder}’s lead claim on ${item.id}; its run is interrupted and the plan kept`
        : `${holder}’s lead run on ${item.id} was interrupted: you canceled the item`,
    item_id: item.id,
    project_key: item.project_key,
    data: { run_id: lead.id, end_reason: endReason, from: lead.state },
    objects: [{ kind: 'run', id: lead.id }],
    inverse: [touchItem],
  });
  return lead;
}

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
    extra: { summary?: string; error?: string; producer_hold_until?: string } = {},
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

  /** Decision 42: how long a story waits for its producer's next worker. */
  const holdUntil = (now: string) => isoPlus(now, deps.config.producerGraceMs);

  /**
   * The sweeper's (and a late claim's) lease expiry: run interrupted, item
   * back to Ready. A worker under a producer leaves the story held for that
   * producer's next worker (decision 42), unless the owner is sending it back.
   */
  function expire(w: WriteContext, run: RunRow, opts: { toReady?: boolean } = {}): void {
    const item = requireItem(w.db, run.item_id);
    const hold = !!run.producer && !opts.toReady && item.status === 'progress';
    endRun(
      w,
      run,
      'interrupted',
      'lease_expired',
      hold ? { producer_hold_until: holdUntil(w.now) } : {},
    );
    const lead = actorName({ kind: 'agent', client: run.client, label: run.label });
    w.event({
      type: 'claim.released',
      summary: hold
        ? `Lease expired on ${item.id} (${lead}); ${run.producer} keeps the story for its next worker`
        : `Lease expired on ${item.id} (${lead}); the run is interrupted and the plan kept`,
      item_id: item.id,
      project_key: item.project_key,
      data: {
        run_id: run.id,
        end_reason: 'lease_expired',
        ...(hold ? { producer: run.producer, handoff: true } : {}),
      },
      objects: [{ kind: 'run', id: run.id }],
    });
    if (item.status === 'progress' && !hold) {
      moveItem(w, item.id, item.project_key, 'progress', 'ready', 'lease expired');
    }
  }

  /** Who a run's status update names: the run's recorded orchestrator, or a registered one. */
  function assertCoordinator(
    w: WriteContext,
    item: { id: string; project_key: string },
    run: RunRow,
    name: string,
  ): void {
    if (namesCoordinator(w.db, item.project_key, run, name)) return;
    throw new ToolError(
      'forbidden',
      `${name} isn't ${item.id}'s coordinator. Only the run's recorded orchestrator, or a coordinator the owner registered for ${item.project_key} in Settings, can update its status.`,
      { details: { coordinator: name } },
    );
  }

  /** The run a finding was read for, unless it has moved on since: the check reads outside a transaction. */
  function currentForActivity(db: WriteContext['db'], f: ActivityFinding): RunRow | null {
    const run = getRun(db, f.run_id);
    if (!run || run.state !== f.state) return null;
    if (run.state === 'parked') {
      const since = storedActivity(run)?.since ?? run.parked_at ?? run.updated_at;
      return since === f.baseline ? run : null;
    }
    return ms(run.last_signal_at) > ms(f.baseline) ? null : run;
  }

  /** `waiting_on.items` must exist and not name the run's own item. */
  function checkWaiting(w: WriteContext, item: { id: string }, waiting: WaitingOn): void {
    const unknown = (waiting.items ?? []).filter(
      (id) =>
        id === item.id ||
        !w.db.sqlite
          .prepare(
            'SELECT 1 FROM items i JOIN projects p ON p.key = i.project_key WHERE i.id = ? AND p.deleted_at IS NULL',
          )
          .get(id),
    );
    if (unknown.length > 0) {
      throw new ToolError(
        'validation',
        unknown.includes(item.id)
          ? `A run can't wait on its own item ${item.id}. Name the items you are waiting for.`
          : `Unknown item ${unknown.join(', ')} in waiting_on.items. Check the IDs with search_items.`,
        { details: { fields: { 'waiting_on.items': 'unknown item' }, items: unknown } },
      );
    }
  }

  /**
   * Parked → running. `by` is a coordinator resuming it (decision 42), who is
   * named as themselves; otherwise the run's own later call resumed it. A
   * coordinator ending their own time-limited park (decision 44) hands back the
   * short lease expiry would, so ending it early can't stretch a dead run's claim.
   */
  function resumeRun(w: WriteContext, run: RunRow, by?: RunStatusUpdate): void {
    const item = requireItem(w.db, run.item_id);
    const asked = w.db.sqlite
      .prepare(
        'SELECT 1 FROM questions WHERE run_id = ? AND answered_at IS NULL AND withdrawn_at IS NULL',
      )
      .get(run.id);
    const since = run.parked_at ?? run.updated_at;
    const ready = parkInfo(w.db, run, w.now).resume_ready;
    w.update('runs', run.id, {
      state: asked ? 'needs_input' : 'open',
      parked_reason: null,
      waiting_on: null,
      parked_at: null,
      lease_expires_at:
        run.is_lead === 1
          ? isoPlus(
              w.now,
              by && activeCoordinatorPark(run) ? deps.config.restartGraceMs : deps.config.leaseMs,
            )
          : null,
      park_activity: null,
      status_update: by ?? null,
      coordinator_park: null,
    });
    const who = by ? `${by.by} (coordinator)` : callerName(w.db, { ...w.actor, run_id: run.id });
    const whose = by
      ? ` ${actorName({ kind: 'agent', client: run.client, label: run.label })}`
      : '';
    w.event({
      type: 'run.resumed',
      summary: `${who} resumed${whose} after ${durationText(ms(w.now) - ms(since))} parked${ready ? '' : ' (before what it waited on cleared)'}`,
      item_id: item.id,
      project_key: item.project_key,
      data: {
        run_id: run.id,
        parked_at: since,
        reason: run.parked_reason,
        waiting_on: parseJson<WaitingOn>(run.waiting_on),
        resume_ready: ready,
        ...(by ? { updated_by: by.by, client: by.client } : {}),
      },
      objects: [{ kind: 'run', id: run.id }],
    });
  }

  /** Decision 44: the coordinator's park holding this run, if any (not one that ran out). */
  function activeCoordinatorPark(run: RunRow) {
    const park = coordinatorParkOf(run);
    return run.state === 'parked' && park && !park.ended_at ? park : null;
  }

  /**
   * Decision 44: the deadline passed. The run goes back to `open` (`needs_input`
   * with a question still open) on a restart-grace lease, so a live agent's next
   * call continues and a dead one loses its claim through `lease_expired`. The
   * claim is never released here. An activity flag stays for the coordinator.
   */
  function endCoordinatorPark(w: WriteContext, run: RunRow): void {
    const park = activeCoordinatorPark(run)!;
    const item = requireItem(w.db, run.item_id);
    const asked = w.db.sqlite
      .prepare(
        'SELECT 1 FROM questions WHERE run_id = ? AND answered_at IS NULL AND withdrawn_at IS NULL',
      )
      .get(run.id);
    const stored = parseJson<Record<string, unknown>>(run.coordinator_park)!;
    const activity = storedActivity(run);
    const ready = parkInfo(w.db, run, w.now).resume_ready;
    const leaseUntil = isoPlus(w.now, deps.config.restartGraceMs);
    w.update('runs', run.id, {
      state: asked ? 'needs_input' : 'open',
      parked_reason: null,
      waiting_on: null,
      parked_at: null,
      lease_expires_at: leaseUntil,
      park_activity: activity?.flag ? activity : null,
      coordinator_park: { ...stored, ended_at: w.now },
    });
    const holder = actorName({ kind: 'agent', client: run.client, label: run.label });
    w.event({
      type: 'run.park_expired',
      summary: `${park.by}'s park on ${item.id} ran out. ${holder} has until ${utcTime(leaseUntil, w.now)} to call, or its lease ends`,
      item_id: item.id,
      project_key: item.project_key,
      data: {
        run_id: run.id,
        parked_by: park.by,
        until: park.until,
        reason: run.parked_reason,
        waiting_on: parseJson<WaitingOn>(run.waiting_on),
        resume_ready: ready,
        lease_expires_at: leaseUntil,
      },
      objects: [{ kind: 'run', id: run.id }],
    });
  }

  /**
   * Decision 44: park the lead for a limited time, or renew a coordinator's
   * park. The run's own park has no limit and stays its own, so it can't be
   * converted. A deadline over a limit is refused, never clamped.
   */
  function parkForCoordinator(
    w: WriteContext,
    item: { id: string; project_key: string },
    run: RunRow,
    input: In<'update_run_status'> & { park_minutes: number },
    stamp: RunStatusUpdate,
  ): string {
    const renewing = !!activeCoordinatorPark(run);
    if (run.state === 'parked' && !renewing) {
      throw new ToolError(
        'validation',
        `${item.id}'s lead run parked itself, so its park has no time limit and stays its own. Change its reason or waiting_on, or resume it.`,
        { details: { fields: { park_minutes: 'the run parked itself' } } },
      );
    }
    if (!renewing && (input.park_reason === undefined || input.waiting_on === undefined)) {
      throw new ToolError(
        'validation',
        `Parking ${item.id}'s lead run needs park_reason and waiting_on, so it's clear what it waits for.`,
        {
          details: {
            fields: {
              ...(input.park_reason === undefined ? { park_reason: 'required to park' } : {}),
              ...(input.waiting_on === undefined ? { waiting_on: 'required to park' } : {}),
            },
          },
        },
      );
    }
    const until = isoPlus(w.now, input.park_minutes * 60_000);
    const totalMs = COORDINATOR_PARK.total_minutes * 60_000;
    if (ms(until) - ms(run.last_signal_at) > totalMs) {
      const left = Math.floor((totalMs - (ms(w.now) - ms(run.last_signal_at))) / 60_000);
      throw new ToolError(
        'validation',
        left >= 1
          ? `${item.id}'s lead run can be parked for at most ${left} more minutes: a coordinator's parks end within ${COORDINATOR_PARK.total_minutes / 60} hours of the run's last own signal.`
          : `${item.id}'s lead run hasn't signalled for ${COORDINATOR_PARK.total_minutes / 60} hours, so it can't be parked again. It has to call in, or its lease ends the run.`,
        {
          details: {
            fields: { park_minutes: `at most ${Math.max(left, 0)}` },
            last_signal_at: run.last_signal_at,
          },
        },
      );
    }
    const waiting = input.waiting_on ?? parseJson<WaitingOn>(run.waiting_on) ?? {};
    const reason = input.park_reason ?? run.parked_reason ?? '';
    w.update('runs', run.id, {
      state: 'parked',
      parked_reason: reason,
      waiting_on: waiting,
      parked_at: renewing && run.parked_at ? run.parked_at : w.now,
      lease_expires_at: null,
      restart_deadline_at: null,
      // Only a new park starts a baseline: renewing must not hide drift (BUILD_SPEC §5.25).
      ...(renewing ? {} : { park_activity: { since: w.now, flag: null } }),
      status_update: stamp,
      coordinator_park: { by: stamp.by, client: stamp.client, at: w.now, until },
      ...(input.current_action !== undefined ? { summary: input.current_action } : {}),
    });
    const holder = actorName({ kind: 'agent', client: run.client, label: run.label });
    const on = waitingText(waiting);
    const data = {
      run_id: run.id,
      reason,
      waiting_on: waiting,
      parked_by: stamp.by,
      client: stamp.client,
      until,
    };
    if (renewing) {
      w.event({
        type: 'run.status_updated',
        summary: `${stamp.by} (coordinator) renewed the park on ${holder} on ${item.id} until ${utcTime(until, w.now)}`,
        item_id: item.id,
        project_key: item.project_key,
        data: { ...data, updated_by: stamp.by, renewed: true },
        objects: [{ kind: 'run', id: run.id }],
      });
    } else {
      w.event({
        type: 'run.parked',
        summary: `${stamp.by} (coordinator) parked ${holder} until ${utcTime(until, w.now)}${on ? `, waiting on ${on}` : ''}: ${reason}`,
        item_id: item.id,
        project_key: item.project_key,
        data: { ...data, from: run.state },
        objects: [{ kind: 'run', id: run.id }],
      });
    }
    return until;
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
           lease_expires_at = CASE WHEN is_lead = 1 THEN ? ELSE lease_expires_at END,
           restart_deadline_at = NULL,
           park_activity = NULL,
           coordinator_park = NULL
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

  // ---- Recovery fields (BUILD_SPEC §5.16; MCP_SPEC §3) ----

  type RecoveryFields = Pick<
    In<'claim_lead'>,
    'workspace' | 'orchestrator' | 'brief' | 'brief_document_version_id' | 'external'
  >;

  /**
   * A brief passed as text: an immutable `brief` document on the item,
   * `brief-<run_id>.md`, stored byte for byte so a restart re-sends it
   * unchanged. The bytes go to the docs volume first, under a new path that
   * nothing overwrites; a rolled-back claim leaves only an unreferenced file.
   */
  function storeBrief(
    w: WriteContext,
    item: { id: string; project_key: string },
    runId: string,
    brief: string,
  ): string {
    const at = ms(w.now);
    const docId = newId('doc', at);
    const versionId = newId('dv', at);
    const name = `brief-${runId}.md`;
    const bytes = Buffer.from(brief, 'utf8');
    const path = `${item.project_key}/${docId}/v1/${name}`;
    const full = join(deps.config.paths.docs, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, bytes, { flag: 'wx' });
    w.insert('documents', {
      id: docId,
      project_key: item.project_key,
      item_id: item.id,
      name,
      kind: 'brief',
    });
    w.insert('document_versions', {
      id: versionId,
      document_id: docId,
      version_no: 1,
      mime: 'text/markdown',
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      path,
      created_by: callerName(w.db, w.actor),
    });
    w.event({
      type: 'document.added',
      summary: `Brief for run ${runId} stored (${name}, ${bytes.length} bytes)`,
      item_id: item.id,
      project_key: item.project_key,
      data: { document_id: docId, document_version_id: versionId, kind: 'brief', run_id: runId },
      objects: [{ kind: 'document', id: docId }],
    });
    return versionId;
  }

  /** An existing document version as the brief: it must be on this item (or its project). */
  function checkBrief(
    w: WriteContext,
    item: { id: string; project_key: string },
    versionId: string,
  ): string {
    const doc = w.db.sqlite
      .prepare(
        'SELECT d.item_id, d.project_key FROM document_versions v JOIN documents d ON d.id = v.document_id WHERE v.id = ?',
      )
      .get(versionId) as { item_id: string | null; project_key: string } | undefined;
    const ok =
      !!doc &&
      (doc.item_id === item.id || (doc.item_id === null && doc.project_key === item.project_key));
    if (!ok) {
      throw new ToolError(
        'validation',
        `No document version ${versionId} on ${item.id}. Pass the brief as text, or the brief_document_version_id a run of ${item.id} was given.`,
        {
          details: { fields: { brief_document_version_id: 'not a document version on this item' } },
        },
      );
    }
    return versionId;
  }

  /** Check an existing brief before anything is written; returns a function that stores the fields. */
  function recoveryColumns(
    w: WriteContext,
    item: { id: string; project_key: string },
    input: RecoveryFields,
  ): (runId: string) => Record<string, unknown> {
    if (input.brief_document_version_id) checkBrief(w, item, input.brief_document_version_id);
    return (runId) => ({
      workspace: input.workspace ? { ...input.workspace, updated_at: w.now } : null,
      orchestrator: input.orchestrator ?? null,
      external: input.external ?? null,
      brief_document_version_id:
        input.brief !== undefined
          ? storeBrief(w, item, runId, input.brief)
          : (input.brief_document_version_id ?? null),
    });
  }

  /** Unreleased resources of a run, oldest first. */
  function unreleasedOf(db: WriteContext['db'], runId: string) {
    return db.sqlite
      .prepare(
        'SELECT id, label FROM run_resources WHERE run_id = ? AND released_at IS NULL ORDER BY started_at, id',
      )
      .all(runId) as { id: string; label: string }[];
  }

  /** What `waiting_on` says, for event summaries: `RCP-12, RCP-13`, `the coordinator`. */
  function waitingText(waiting: WaitingOn): string {
    const parts: string[] = [];
    if (waiting.items?.length) parts.push(waiting.items.join(', '));
    if (waiting.orchestrator) parts.push('the coordinator');
    if (waiting.person) parts.push('a person');
    if (waiting.until) parts.push(`until ${utcTime(waiting.until, waiting.until)}`);
    return parts.join(', ');
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

      // Decision 42: between workers, the story is its producer's. One active lead still holds.
      const hold = producerHold(w.db, item.id);
      if (hold && hold.producer !== (input.producer ?? null)) {
        const current = {
          producer: hold.producer,
          hold_until: hold.until,
          last_worker: hold.last_worker,
        };
        throw new ClaimConflict(
          `${item.id} is held by producer ${hold.producer} for its next worker (until ${utcTime(hold.until, w.now)}). Pick another item.`,
          current,
          (rw) => {
            rw.event({
              type: 'claim.rejected',
              summary: `Lead claim by ${callerName(rw.db, rw.actor)} rejected (held by producer ${hold.producer})`,
              item_id: item.id,
              project_key: item.project_key,
              data: { conflict: current },
            });
          },
        );
      }

      // Decision 39: an unapproved change to an approved design pauses this item, at any claim.
      assertDesignCleared(w.db, item, 'claim');
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
        // Decisions 36 and 39 (FR-160, FR-179): overlaps that can safely run together let the
        // claim go on; the rest refuse it, sequenced by Docket or asked of the owner.
        settleClaim(w, deps.services().links, item);
      } else if (status !== 'progress') {
        throw new ToolError(
          'validation',
          `${item.id} is ${status}; only Ready items, or In progress items with no lead, can be claimed. Pick one from search_items "ready_to_start" or "resumable".`,
          { details: { status, allowed: ['ready', 'progress'] } },
        );
      }

      const recovery = recoveryColumns(w, item, input);
      const runId = newId('run', ms(w.now));
      const label = input.agent_label ?? w.actor.label ?? null;
      const leaseUntil = isoPlus(w.now, deps.config.leaseMs);
      const columns = recovery(runId);
      // Decision 36: the branch the work is on, for the conflict radar (radar.ts reads it
      // from the workspace, or from this claim's event when no workspace was reported).
      if (input.branch && columns.workspace) {
        columns.workspace = { ...(columns.workspace as object), branch: input.branch };
      }
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
        producer: input.producer ?? null,
        ...columns,
      });
      // The hold has done its job: this worker now leads the story.
      if (hold) {
        w.db.sqlite
          .prepare(
            'UPDATE runs SET producer_hold_until = NULL WHERE item_id = ? AND producer_hold_until IS NOT NULL',
          )
          .run(item.id);
      }
      const who = actorName({ kind: 'agent', client: w.actor.client, label });
      const minutes = Math.round(deps.config.leaseMs / 60_000);
      w.event({
        type: 'claim.granted',
        summary: hold
          ? `${who} took over from ${hold.last_worker} under producer ${hold.producer} (${minutes} min lease)`
          : status === 'ready'
            ? `${who} claimed lead (${minutes} min lease)`
            : `${who} claimed lead to resume (${minutes} min lease)`,
        item_id: item.id,
        project_key: item.project_key,
        data: {
          run_id: runId,
          lease_expires_at: leaseUntil,
          resumed: status === 'progress',
          ...(input.branch ? { branch: input.branch } : {}),
          ...(input.producer ? { producer: input.producer } : {}),
          ...(hold ? { handoff: true, from_run_id: hold.run_id } : {}),
        },
        objects: [{ kind: 'run', id: runId }],
      });
      // B41: the claim's branch (or its workspace's) joins the item's reported branches.
      addReportedBranch(w, item.id, input.branch ?? input.workspace?.branch);
      if (status === 'ready')
        moveItem(w, item.id, item.project_key, 'ready', 'progress', `claimed by ${who}`);
      else w.update('items', item.id, {});
      // Decision 30: the installed docket-check report, stored on the run in this
      // write; it raises or updates drift against its install's manifest.
      if (input.instructions) {
        deps.services().drift.recordReport(w, {
          source: 'agent',
          run_id: runId,
          ...(input.instructions.install_id ? { install_id: input.instructions.install_id } : {}),
          project: item.project_key,
          ...(input.workspace?.path ? { location: input.workspace.path } : {}),
          // The adapter may have withheld secret-looking text (`withheld: 'secret'`).
          files: input.instructions.files as InstructionReportInput['files'],
        });
      }
      const hint = claimBranchHint(w.db, item, input.branch ?? input.workspace?.branch);
      return {
        run_id: runId,
        item: summary(w, item.id),
        lease_expires_at: leaseUntil,
        ...(hint ? { branch_hint: hint } : {}),
      };
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
      // Decision 42: a worker under a producer hands the story on; the producer gives it up.
      const handoff = !!run.producer && !input.release_story && item.status === 'progress';
      endRun(
        w,
        run,
        'interrupted',
        'released',
        handoff ? { producer_hold_until: holdUntil(w.now) } : {},
      );
      w.event({
        type: 'claim.released',
        summary: handoff
          ? `${callerName(w.db, w.actor)} handed ${item.id} back to producer ${run.producer}: ${input.reason}`
          : `${callerName(w.db, w.actor)} released the lead on ${item.id}: ${input.reason}`,
        item_id: item.id,
        project_key: item.project_key,
        data: {
          run_id: run.id,
          end_reason: 'released',
          reason: input.reason,
          ...(run.producer ? { producer: run.producer, handoff } : {}),
        },
        objects: [{ kind: 'run', id: run.id }],
      });
      if (handoff) w.update('items', item.id, {});
      else if (item.status === 'progress')
        moveItem(w, item.id, item.project_key, 'progress', 'ready', 'lead released');
      else w.update('items', item.id, {});
      return summary(w, item.id);
    },

    ownerRelease(w, input) {
      const item = w.checkVersion('items', input.id, input.expected_version) as unknown as ItemRow;
      requireItem(w.db, item.id);
      const lead = endLeadForOwner(w, item, 'owner_released');
      if (!lead) {
        throw new ToolError(
          'conflict',
          `${item.id} has no lead claim to release; it may have ended already. Showing the latest.`,
          { current: summary(w, item.id) },
        );
      }
      if (item.status === 'progress') {
        const inverse = w.update('items', item.id, { status: 'ready' });
        w.event({
          type: 'item.status_changed',
          summary: `${item.id} moved from progress to ready: lead claim released by you${input.reason ? ` (${input.reason})` : ''}`,
          item_id: item.id,
          project_key: item.project_key,
          data: { status: { old: 'progress', new: 'ready' }, run_id: lead.id },
          inverse: [inverse],
        });
      }
      return summary(w, item.id);
    },

    returnToReady(w, input) {
      const item = w.checkVersion('items', input.id, input.expected_version) as unknown as ItemRow;
      requireItem(w.db, item.id);
      const lead = activeLead(w.db, item.id);
      if (lead && !leaseExpired(lead, w.now)) {
        const holder = actorName({ kind: 'agent', client: lead.client, label: lead.label });
        throw new ToolError(
          'validation',
          `${holder} leads ${item.id}. Release the lead claim instead, or wait for the run to end.`,
          { details: { run_id: lead.id } },
        );
      }
      if (item.status !== 'progress') {
        throw new ToolError(
          'validation',
          `${item.id} is ${item.status}; only In progress items with no lead can return to Ready.`,
          { details: { status: item.status, allowed: ['progress'] } },
        );
      }
      // A lease that ran out before the sweeper got to it: end it as such first.
      if (lead) expire(w, lead, { toReady: true });
      else {
        const inverse = w.update('items', item.id, { status: 'ready' });
        w.event({
          type: 'item.status_changed',
          summary: `You moved ${item.id} from progress to ready: ${input.reason ?? 'returned to Ready'}`,
          item_id: item.id,
          project_key: item.project_key,
          data: { status: { old: 'progress', new: 'ready' }, reason: input.reason ?? null },
          inverse: [inverse],
        });
      }
      return summary(w, item.id);
    },

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
      const recovery = recoveryColumns(w, item, input);
      const runId = newId('run', ms(w.now));
      const label = input.agent_label ?? null;
      const columns = recovery(runId);
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
        ...columns,
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
      // `external` merges by namespace; the result must still fit (MCP_SPEC §3).
      let external: Record<string, unknown> | null = null;
      if (input.external) {
        external = {
          ...(parseJson<Record<string, unknown>>(run.external) ?? {}),
          ...input.external,
        };
        if (jsonBytes(external) > LIMITS.external_bytes) {
          throw new ToolError(
            'validation',
            `external would be ${jsonBytes(external)} bytes of JSON with your changes; the limit is ${LIMITS.external_bytes}. Send less, or replace a namespace.`,
            { details: { fields: { external: `at most ${LIMITS.external_bytes} bytes` } } },
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
          // Decision 42: the run's own words replace a coordinator's.
          if (input.note !== undefined) {
            r.db.sqlite.prepare('UPDATE runs SET status_update = NULL WHERE id = ?').run(run.id);
          }
          // The workspace patch: what you leave out stays as it is (§5.16).
          if (input.workspace) {
            const current = getRun(r.db, run.id)!;
            const ws: StoredWorkspace = {
              ...(storedWorkspace(current) ?? {}),
              ...input.workspace,
              updated_at: r.now,
            };
            r.db.sqlite
              .prepare('UPDATE runs SET workspace = ? WHERE id = ?')
              .run(JSON.stringify(ws), run.id);
          }
          if (external) {
            r.db.sqlite
              .prepare('UPDATE runs SET external = ? WHERE id = ?')
              .run(JSON.stringify(external), run.id);
          }
          // The MCP signal hook has already recorded this call; another adapter's call can't prove a session.
          const fresh = getRun(r.db, run.id)!;
          // A child inside its restart window must clear its deadline even in the same instant.
          if (ms(fresh.last_signal_at) < ms(r.now) || fresh.restart_deadline_at !== null) {
            signal(r, run.id, 'report');
          }
        })
        .immediate();
      const after = getRun(r.db, run.id)!;
      return {
        run_state: displayRunState(after, windows(), r.now),
        lease_expires_at: after.lease_expires_at,
        resources: unreleasedOf(r.db, run.id),
      };
    },

    updateResources(w, input) {
      const run = requireRun(w.db, input.run_id);
      assertOwnRun(w, run);
      if (!isRunOpen(run.state) || leaseExpired(run, w.now)) throw runEndedError(w.db, run, w.now);
      const item = requireItem(w.db, run.item_id);
      const who = callerName(w.db, w.actor);
      const declared: { id: string; kind: ResourceKind; label: string }[] = [];
      for (const r of input.resources_started ?? []) {
        const id = newId('rsc', ms(w.now));
        w.insert('run_resources', {
          id,
          run_id: run.id,
          kind: r.kind,
          label: r.label,
          locator: r.locator,
          started_at: w.now,
        });
        declared.push({ id, kind: r.kind, label: r.label });
      }
      if (declared.length > 0) {
        w.event({
          type: 'resource.declared',
          summary: `${who} declared ${declared.map((d) => `${RESOURCE_KIND_LABELS[d.kind]} “${d.label}”`).join(', ')}`,
          item_id: item.id,
          project_key: item.project_key,
          data: { run_id: run.id, resources: declared },
          objects: [{ kind: 'run', id: run.id }],
        });
      }
      const released: { id: string; label: string; run_id: string }[] = [];
      for (const rel of input.resources_released ?? []) {
        const row = w.get('run_resources', rel.resource_id) as
          { id: string; run_id: string; label: string; released_at: string | null } | undefined;
        if (!row) {
          throw new ToolError(
            'not_found',
            `No resource ${rel.resource_id}. Use an rsc_ ID that heartbeat or get_item returned.`,
          );
        }
        const owner = getRun(w.db, row.run_id)!;
        // A later run of the same item may release an earlier run's resources (§5.16).
        if (owner.item_id !== item.id) {
          throw new ToolError(
            'forbidden',
            `${row.id} was started for ${owner.item_id}, not ${item.id}. Only a run of ${owner.item_id}, or the owner, can release it.`,
          );
        }
        if (row.released_at) continue; // Already released: nothing to do.
        w.update('run_resources', row.id, {
          released_at: w.now,
          released_by: who,
          release_note: rel.note ?? null,
        });
        released.push({ id: row.id, label: row.label, run_id: row.run_id });
      }
      if (released.length > 0) {
        const others = [...new Set(released.map((x) => x.run_id))].filter((id) => id !== run.id);
        w.event({
          type: 'resource.released',
          summary: `${who} released ${released.map((x) => `“${x.label}”`).join(', ')}`,
          item_id: item.id,
          project_key: item.project_key,
          data: { run_id: run.id, resources: released },
          objects: [
            { kind: 'run', id: run.id },
            ...others.map((id) => ({ kind: 'run' as const, id })),
          ],
        });
      }
      return { resources: unreleasedOf(w.db, run.id) };
    },

    finish(w, input) {
      const run = requireRun(w.db, input.run_id);
      assertOwnRun(w, run);
      if (!isRunOpen(run.state) || leaseExpired(run, w.now)) throw runEndedError(w.db, run, w.now);
      const item = requireItem(w.db, run.item_id);
      // Decision 42: a worker under a producer finishing its part leaves the story held.
      const keep = run.is_lead === 1 && !!run.producer && item.status === 'progress';
      endRun(w, run, input.result, input.result, {
        summary: input.summary,
        ...(input.error !== undefined ? { error: input.error } : {}),
        ...(keep ? { producer_hold_until: holdUntil(w.now) } : {}),
      });
      w.event({
        type: 'run.ended',
        summary: `${run.is_lead ? 'Lead run' : `Child run ${run.label ?? run.id}`} ${input.result}: ${input.summary}`,
        item_id: item.id,
        project_key: item.project_key,
        data: { run_id: run.id, end_reason: input.result, is_lead: run.is_lead === 1 },
        objects: [{ kind: 'run', id: run.id }],
      });
      // Finishing with things left behind succeeds, but says so (MCP_SPEC §5.4).
      const warnings: string[] = [];
      const left = unreleasedOf(w.db, run.id);
      if (left.length > 0) {
        warnings.push(
          `${left.length} ${left.length === 1 ? 'resource' : 'resources'} still declared: ${left.map((x) => x.label).join(', ')}`,
        );
      }
      const ws = storedWorkspace(run);
      if (ws?.head_sha && (!ws.pushed_sha || !sameSha(ws.head_sha, ws.pushed_sha))) {
        const n = unpushedCount(w.db, [run.id], ws.head_sha, ws.pushed_sha) ?? 1;
        warnings.push(`${n} ${n === 1 ? 'commit' : 'commits'} not pushed`);
      }
      // The output schema allows `warnings` on every mutation (mutationOutput); the adapter passes it on.
      const out: Out<'finish_run'> & { warnings?: string[] } = { run_state: input.result };
      if (warnings.length > 0) out.warnings = warnings;
      return out;
    },

    park(w, input) {
      const run = requireRun(w.db, input.run_id);
      assertOwnRun(w, run);
      if (!isRunOpen(run.state) || leaseExpired(run, w.now)) throw runEndedError(w.db, run, w.now);
      const item = requireItem(w.db, run.item_id);
      const waiting: WaitingOn = input.waiting_on ?? {};
      checkWaiting(w, item, waiting);
      // Parking again updates what it waits on; it has been parked since the first time.
      const parkedAt = run.state === 'parked' && run.parked_at ? run.parked_at : w.now;
      w.update('runs', run.id, {
        state: 'parked',
        parked_reason: input.reason,
        waiting_on: waiting,
        parked_at: parkedAt,
        // The lease is suspended: a parked run keeps its claim and never expires (§5.16).
        lease_expires_at: null,
        restart_deadline_at: null,
        // Decision 42: what happens from now on is activity since this park.
        park_activity: { since: w.now, flag: null },
        status_update: null,
        // Decision 44: the run's own park replaces a coordinator's limit, and is its own word.
        coordinator_park: null,
        ...(coordinatorParkOf(run) ? { last_signal_at: w.now } : {}),
      });
      const on = waitingText(waiting);
      w.event({
        type: 'run.parked',
        summary: `${callerName(w.db, { ...w.actor, run_id: run.id })} parked${on ? `, waiting on ${on}` : ''}: ${input.reason}`,
        item_id: item.id,
        project_key: item.project_key,
        data: { run_id: run.id, reason: input.reason, waiting_on: waiting, from: run.state },
        objects: [{ kind: 'run', id: run.id }],
      });
      const parked = getRun(w.db, run.id)!;
      const info = parkInfo(w.db, parked, w.now);
      return {
        run_state: 'parked' as const,
        resume_ready: info.resume_ready,
        // Decision 45: what it waits for, who can move that, and how it resumes.
        wait: new WaitReader(w.db, w.now).card(parked),
      };
    },

    resume(w, input) {
      const run = getRun(w.db, input.run_id);
      if (!run || run.state !== 'parked') return { resumed: false };
      resumeRun(w, run);
      return { resumed: true };
    },

    updateStatus(w, input) {
      const item = requireItem(w.db, input.id);
      const lead = activeLead(w.db, item.id);
      if (!lead) {
        throw new ToolError(
          'validation',
          `${item.id} has no active lead run to update. Check it with get_item.`,
          { details: { id: item.id } },
        );
      }
      assertCoordinator(w, item, lead, input.coordinator);
      if (leaseExpired(lead, w.now)) throw runEndedError(w.db, lead, w.now);
      // Decision 44: a deadline that passed before the sweep is over, whatever this call does.
      const due = activeCoordinatorPark(lead);
      if (due && !input.resume && ms(due.until) <= ms(w.now)) endCoordinatorPark(w, lead);
      const run = getRun(w.db, lead.id)!;
      const parkFields = input.park_reason !== undefined || input.waiting_on !== undefined;
      if (
        (input.resume || (parkFields && input.park_minutes === undefined)) &&
        run.state !== 'parked'
      ) {
        throw new ToolError(
          'validation',
          `${item.id}'s lead run isn't parked, so it has no park to change or resume. To park it, pass park_minutes with park_reason and waiting_on.`,
          { details: { run_state: run.state } },
        );
      }
      if (input.waiting_on) checkWaiting(w, item, input.waiting_on);
      const stamp: RunStatusUpdate = {
        by: input.coordinator,
        client: w.actor.client ?? null,
        at: w.now,
      };
      let parkedUntil: string | undefined;
      if (input.park_minutes !== undefined) {
        parkedUntil = parkForCoordinator(
          w,
          item,
          run,
          { ...input, park_minutes: input.park_minutes },
          stamp,
        );
      } else if (input.resume) {
        resumeRun(w, run, stamp);
        if (input.current_action !== undefined) {
          w.update('runs', run.id, { summary: input.current_action });
        }
      } else {
        w.update('runs', run.id, {
          ...(input.current_action !== undefined ? { summary: input.current_action } : {}),
          ...(input.park_reason !== undefined ? { parked_reason: input.park_reason } : {}),
          ...(input.waiting_on !== undefined ? { waiting_on: input.waiting_on } : {}),
          status_update: stamp,
          // What the coordinator has seen no longer counts as new.
          park_activity: run.state === 'parked' ? { since: w.now, flag: null } : null,
        });
        const changed = [
          input.current_action !== undefined ? `doing: ${input.current_action}` : null,
          input.park_reason !== undefined ? `park reason: ${input.park_reason}` : null,
          input.waiting_on !== undefined
            ? `waiting on ${waitingText(input.waiting_on) || 'nothing named'}`
            : null,
        ].filter(Boolean);
        const holder = actorName({ kind: 'agent', client: run.client, label: run.label });
        w.event({
          type: 'run.status_updated',
          summary: `${input.coordinator} (coordinator) updated ${holder}'s status on ${item.id}: ${changed.join('; ')}`,
          item_id: item.id,
          project_key: item.project_key,
          data: {
            run_id: run.id,
            updated_by: input.coordinator,
            client: stamp.client,
            ...(input.current_action !== undefined ? { current_action: input.current_action } : {}),
            ...(input.park_reason !== undefined ? { park_reason: input.park_reason } : {}),
            ...(input.waiting_on !== undefined ? { waiting_on: input.waiting_on } : {}),
          },
          objects: [{ kind: 'run', id: run.id }],
        });
      }
      const after = getRun(w.db, run.id)!;
      const held = activeCoordinatorPark(after);
      parkedUntil ??= held?.until;
      return {
        id: item.id,
        run_state: displayRunState(after, windows(), w.now),
        updated_by: input.coordinator,
        resume_ready: parkInfo(w.db, after, w.now).resume_ready,
        ...(parkedUntil ? { parked_until: parkedUntil } : {}),
      };
    },

    expireCoordinatorParks(w) {
      const due = w.db.sqlite
        .prepare(
          `SELECT * FROM runs WHERE state = 'parked' AND coordinator_park IS NOT NULL
             AND json_extract(coordinator_park, '$.until') <= ?
           ORDER BY json_extract(coordinator_park, '$.until'), id`,
        )
        .all(w.now) as RunRow[];
      for (const run of due) endCoordinatorPark(w, run);
      return { expired: due.map((r) => r.id) };
    },

    refreshActivity(r, findings) {
      const store = r.db.sqlite.prepare('UPDATE runs SET park_activity = ? WHERE id = ?');
      r.db.sqlite
        .transaction(() => {
          for (const f of findings) {
            const run = currentForActivity(r.db, f);
            // Only a raised flag's counts: raising one is an event, through the write path.
            if (run && storedActivity(run)?.flag) {
              store.run(JSON.stringify({ since: f.baseline, flag: f.activity }), run.id);
            }
          }
        })
        .immediate();
    },

    recordActivity(w, findings) {
      const store = w.db.sqlite.prepare('UPDATE runs SET park_activity = ? WHERE id = ?');
      const raised: string[] = [];
      for (const f of findings) {
        const run = currentForActivity(w.db, f);
        if (!run || storedActivity(run)?.flag) continue;
        store.run(JSON.stringify({ since: f.baseline, flag: f.activity }), run.id);
        const item = requireItem(w.db, run.item_id);
        const holder = actorName({ kind: 'agent', client: run.client, label: run.label });
        w.event({
          type: 'run.activity',
          summary:
            f.activity.kind === 'since_parked'
              ? `${item.id} may be out of date: ${activityText(f.activity)} (${holder} is parked)`
              : `${item.id}: ${activityText(f.activity)}. ${holder} hasn't reported, so its session may not have Docket`,
          item_id: item.id,
          project_key: item.project_key,
          data: { run_id: run.id, activity: f.activity, resume_ready: f.resume_ready },
          objects: [{ kind: 'run', id: run.id }],
        });
        raised.push(run.id);
      }
      return { raised };
    },

    expireProducerHolds(w) {
      const due = w.db.sqlite
        .prepare(
          `SELECT * FROM runs WHERE producer_hold_until IS NOT NULL AND producer_hold_until <= ?
           ORDER BY producer_hold_until, id`,
        )
        .all(w.now) as RunRow[];
      const clear = w.db.sqlite.prepare('UPDATE runs SET producer_hold_until = NULL WHERE id = ?');
      const returned: string[] = [];
      for (const run of due) {
        clear.run(run.id);
        const item = requireItem(w.db, run.item_id);
        if (item.status !== 'progress' || activeLead(w.db, item.id)) continue;
        moveItem(
          w,
          item.id,
          item.project_key,
          'progress',
          'ready',
          `producer ${run.producer}'s hold ran out with no worker on it`,
        );
        returned.push(item.id);
      }
      return { returned };
    },

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

    keepOpenRuns(w, input) {
      const open = w.db.sqlite
        .prepare(
          "SELECT * FROM runs WHERE state IN ('open', 'needs_input') ORDER BY created_at, id",
        )
        .all() as RunRow[];
      if (open.length === 0) return { kept: [] };
      const until = isoPlus(w.now, input.graceMs);
      // Like a signal, these are bookkeeping: no version bump and no event per run.
      const extend = w.db.sqlite.prepare('UPDATE runs SET lease_expires_at = ? WHERE id = ?');
      const deadline = w.db.sqlite.prepare('UPDATE runs SET restart_deadline_at = ? WHERE id = ?');
      for (const run of open) {
        if (run.is_lead !== 1) {
          // Another restart inside the window doesn't move a child's deadline.
          if (run.restart_deadline_at === null) deadline.run(until, run.id);
        } else if (run.lease_expires_at === null || ms(run.lease_expires_at) < ms(until)) {
          extend.run(until, run.id);
        }
      }
      const n = open.length;
      w.event({
        type: 'service.restarted',
        summary: `Docket restarted and kept ${n} open ${n === 1 ? 'run' : 'runs'}. Each agent's next call continues; a run that doesn't return ends when its time runs out.`,
        data: { runs_kept: n, grace_ms: input.graceMs, lease_at_least_until: until },
      });
      return { kept: open.map((r) => r.id) };
    },

    endSilentChildren(w) {
      const due = w.db.sqlite
        .prepare(
          `SELECT * FROM runs WHERE is_lead = 0 AND state IN ('open', 'needs_input')
             AND restart_deadline_at IS NOT NULL AND restart_deadline_at <= ?
           ORDER BY restart_deadline_at, id`,
        )
        .all(w.now) as RunRow[];
      for (const run of due) {
        const item = requireItem(w.db, run.item_id);
        w.update('runs', run.id, {
          state: 'interrupted',
          end_reason: 'service_restart',
          restart_deadline_at: null,
        });
        w.event({
          type: 'run.ended',
          summary: `Child run ${run.label ?? run.id} interrupted: no signal after the Docket restart`,
          item_id: item.id,
          project_key: item.project_key,
          data: { run_id: run.id, end_reason: 'service_restart', is_lead: false },
          objects: [{ kind: 'run', id: run.id }],
        });
      }
      return { ended: due.map((r) => r.id) };
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

/** `40s`, `47m`, `3h`, `2d`: how long a run was parked, for the Activity line. */
function durationText(msValue: number): string {
  const sec = Math.max(0, Math.round(msValue / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

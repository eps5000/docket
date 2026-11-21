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
  jsonBytes,
  LIMITS,
  type ItemSummary,
  type ResourceKind,
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
import { settleClaim } from './shared-changes.js';
import type { InverseOp, WriteContext } from './write.js';
import { addReportedBranch } from './radar.js';

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
        ...columns,
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
        data: {
          run_id: runId,
          lease_expires_at: leaseUntil,
          resumed: status === 'progress',
          ...(input.branch ? { branch: input.branch } : {}),
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
      if (lead) expire(w, lead);
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
          if (ms(fresh.last_signal_at) < ms(r.now)) signal(r, run.id, 'report');
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
      // Parking again updates what it waits on; it has been parked since the first time.
      const parkedAt = run.state === 'parked' && run.parked_at ? run.parked_at : w.now;
      w.update('runs', run.id, {
        state: 'parked',
        parked_reason: input.reason,
        waiting_on: waiting,
        parked_at: parkedAt,
        // The lease is suspended: a parked run keeps its claim and never expires (§5.16).
        lease_expires_at: null,
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
      const info = parkInfo(w.db, getRun(w.db, run.id)!, w.now);
      return { run_state: 'parked' as const, resume_ready: info.resume_ready };
    },

    resume(w, input) {
      const run = getRun(w.db, input.run_id);
      if (!run || run.state !== 'parked') return { resumed: false };
      const item = requireItem(w.db, run.item_id);
      const asked = w.db.sqlite
        .prepare('SELECT 1 FROM questions WHERE run_id = ? AND answered_at IS NULL')
        .get(run.id);
      const since = run.parked_at ?? run.updated_at;
      const ready = parkInfo(w.db, run, w.now).resume_ready;
      w.update('runs', run.id, {
        state: asked ? 'needs_input' : 'open',
        parked_reason: null,
        waiting_on: null,
        parked_at: null,
        lease_expires_at: run.is_lead === 1 ? isoPlus(w.now, deps.config.leaseMs) : null,
      });
      w.event({
        type: 'run.resumed',
        summary: `${callerName(w.db, { ...w.actor, run_id: run.id })} resumed after ${durationText(ms(w.now) - ms(since))} parked${ready ? '' : ' (before what it waited on cleared)'}`,
        item_id: item.id,
        project_key: item.project_key,
        data: {
          run_id: run.id,
          parked_at: since,
          reason: run.parked_reason,
          waiting_on: parseJson<WaitingOn>(run.waiting_on),
          resume_ready: ready,
        },
        objects: [{ kind: 'run', id: run.id }],
      });
      return { resumed: true };
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

/** `40s`, `47m`, `3h`, `2d`: how long a run was parked, for the Activity line. */
function durationText(msValue: number): string {
  const sec = Math.max(0, Math.round(msValue / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

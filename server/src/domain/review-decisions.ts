/**
 * The owner's packet decisions and deferred follow-ups (BUILD_SPEC §5.6): the `reviewDecisions` service.
 *
 * US3 (T093). One atomic call per packet, always by the owner, with a
 * verdict for every `ready` item in it:
 * - approve → `approved`; it carries forward to later rounds.
 * - changes (note required) → back to `declared` with the note, and either
 *   a work step on the ticket (`from_review`, added by the owner, so an
 *   agent's plan keeps it) or a Bug in Ready with the ticket's project,
 *   epic and priority, titled with the note (≤ 70 characters), linked by
 *   `relates`.
 * - approve with a note (owner decision 35): the note is stored on the
 *   verdict and posted as an owner note ("Approved with a note: …") for
 *   the item's agent. With `keep=epic` (the item needs an epic) or
 *   `keep=project`, it also becomes an owner decision in that scope (title
 *   from the note, ≤ 120 characters cut at a word; rationale "From your
 *   review of <ITEM>, round <n>: <finding>"), so agents on future tickets
 *   get it through get_context and get_item. Same transaction: undo reverts
 *   it with the rest.
 * - defer (note optional) → `deferred`; with `follow=ticket`, a Task in
 *   Inbox titled "Verify: …" (the text ≤ 60 characters) carrying a
 *   `declared` copy of the item, linked by `relates`.
 * - Outcome: any changes → In progress. Otherwise Done (closed by the
 *   owner), except that the Done gate still holds: if items declared after
 *   the packet are undecided, or an epic still has open children, the item
 *   goes back to In progress instead (the prototype's "still to come").
 *
 * Every row change returns its inverse, and each event stores the inverses
 * of the changes made since the previous event, so the owner's Undo reverts
 * everything: statuses, steps, Bugs and follow-ups.
 */
import { LIMITS, TEXT_LIMITS, ToolError, type ItemSummary, type ReviewKeep } from '@docket/shared';
import type { ReviewDecisionsService, ServiceDeps } from './contracts.js';
import { hrRows, parseLastDecision, type HrRow } from './human-review.js';
import { allocateItemId, newId } from './ids.js';
import {
  BlockIndex,
  activeLead,
  currentSteps,
  ms,
  planVersion,
  requireItem,
  summaryOf,
  windowsOf,
  type ItemRow,
} from './model.js';
import { openPacketOf } from './packets.js';
import { designHold } from './design-review.js';
import { onItemClosed } from './shared-changes.js';
import { releaseHoldOf } from './finish-line.js';
import type { EventInput, InverseOp, WriteContext } from './write.js';

const BUG_TITLE_MAX = 70;
const VERIFY_TEXT_MAX = 60;
/** The owner note an approval's note posts (owner decision 35). */
export const APPROVED_NOTE_PREFIX = 'Approved with a note: ';

/** `text` cut to `max` characters, the last one an ellipsis when cut. */
export function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

export const bugTitle = (note: string) => truncate(note, BUG_TITLE_MAX);

/**
 * A kept note's decision title (owner decision 35): the note on one line,
 * at most `LIMITS.decision_title` (120) characters, cut at a word boundary
 * with an ellipsis when it's longer.
 */
export function noteTitle(note: string, max: number = LIMITS.decision_title): string {
  const flat = note.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const room = flat.slice(0, max - 1);
  const cut = room.lastIndexOf(' ');
  return `${(cut > 0 ? room.slice(0, cut) : room).replace(/[\s.,;:!?-]+$/, '')}…`;
}

/** `text` at most `max` characters, keeping its line breaks; an ellipsis when cut. */
const clip = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
export const verifyTitle = (text: string) => `Verify: ${truncate(text, VERIFY_TEXT_MAX)}`;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Collects inverses; each event takes the ones recorded since the last. */
class Journal {
  private ops: InverseOp[] = [];
  constructor(private readonly w: WriteContext) {}
  add(op: InverseOp): void {
    this.ops.push(op);
  }
  event(input: Omit<EventInput, 'inverse'>): void {
    if (this.ops.length === 0) throw new Error(`event ${input.type} has no inverse to record`);
    this.w.event({ ...input, inverse: this.ops });
    this.ops = [];
  }
}

export function createReviewDecisionsService(deps: ServiceDeps): ReviewDecisionsService {
  const windows = () => windowsOf(deps.config);

  /** A new item from a review decision: the parent's project, epic and priority. */
  function createFromReview(
    w: WriteContext,
    j: Journal,
    parent: ItemRow,
    opts: {
      type: 'Bug' | 'Task';
      status: 'ready' | 'inbox';
      title: string;
      description: string;
      fromReview: { item_id: string; round: number; hr_item_id: string };
      /** The human review item the new Task carries (a deferred item's copy). */
      carry?: string;
      summary: (id: string) => string;
    },
  ): string {
    const id = allocateItemId(w.db.sqlite, parent.project_key);
    const epic = parent.type === 'Epic' ? null : parent.epic_id;
    j.add(
      w.insert('items', {
        id,
        project_key: parent.project_key,
        type: opts.type,
        title: opts.title,
        description_md: opts.description,
        outcome_md: '',
        status: opts.status,
        priority: parent.priority,
        epic_id: epic,
        from_review: opts.fromReview,
        imported: false,
      }),
    );
    if (opts.carry) {
      j.add(
        w.insert('hr_items', {
          id: newId('hr', ms(w.now)),
          item_id: id,
          position: 0,
          text: opts.carry,
          state: 'declared',
          added_by: 'owner',
          version: 1,
        }),
      );
    }
    j.event({
      type: 'item.created',
      summary: opts.summary(id),
      item_id: id,
      project_key: parent.project_key,
      data: { status: opts.status, from_review: opts.fromReview },
      objects: [{ kind: 'item', id: parent.id }],
    });
    const linkId = newId('lnk', ms(w.now));
    j.add(
      w.insert('links', {
        id: linkId,
        from_id: parent.id,
        to_id: id,
        type: 'relates',
        created_by: 'owner',
      }),
    );
    j.event({
      type: 'link.added',
      summary: `${parent.id} relates to ${id}`,
      item_id: id,
      project_key: parent.project_key,
      data: { link_id: linkId, from: parent.id, to: id, type: 'relates' },
      objects: [
        { kind: 'item', id: parent.id },
        { kind: 'link', id: linkId },
      ],
    });
    return id;
  }

  /** A test ticket for a deferred item: a Task in Inbox carrying a declared copy. */
  function followUpTicket(
    w: WriteContext,
    j: Journal,
    parent: ItemRow,
    h: HrRow,
    round: number,
  ): string {
    return createFromReview(w, j, parent, {
      type: 'Task',
      status: 'inbox',
      title: verifyTitle(h.text),
      description: `Deferred in your human review of ${parent.id} (round ${round}): not verified yet.\n\n> ${h.text}`,
      fromReview: { item_id: parent.id, round, hr_item_id: h.id },
      carry: h.text,
      summary: (id) => `You created test ticket ${id} for a deferred review item of ${parent.id}`,
    });
  }

  return {
    decide(w, input) {
      if (w.actor.kind !== 'owner') {
        throw new ToolError('forbidden', 'Only the owner decides a handoff packet.');
      }
      const item = w.checkVersion('items', input.id) as unknown as ItemRow;
      requireItem(w.db, item.id);
      const packet = openPacketOf(w.db, item.id);
      if (!packet) {
        throw new ToolError(
          'conflict',
          `${item.id} has no open packet; it was already decided or withdrawn. Reload to see the latest.`,
        );
      }
      // Decision 36 (FR-162): a packet held for undeclared shared changes keeps its review
      // gate closed until the owner decides the hold.
      if (packet.held_undeclared) {
        const parts = JSON.parse(packet.held_undeclared) as string[];
        throw new ToolError(
          'conflict',
          `Round ${packet.round} of ${item.id} is held: it changed shared parts it didn't declare (${parts.join(', ')}). Decide that first: Add to the declaration, or Send back.`,
          { details: { held_undeclared: parts } },
        );
      }
      // Decision 39: so does a packet whose item has an unapproved change to an approved design.
      if (designHold(w.db, item.id)) {
        throw new ToolError(
          'conflict',
          `${item.id} changes an approved design. Approve the design change or send it back before deciding this packet.`,
          { details: { design_review: designHold(w.db, item.id)!.review_id } },
        );
      }
      if (packet.round !== input.round) {
        throw new ToolError(
          'conflict',
          `Round ${input.round} is not the open packet on ${item.id}; round ${packet.round} is. Reload to see the latest.`,
          { current: { round: packet.round } },
        );
      }
      const inPacket = new Set(
        (
          w.db.sqlite
            .prepare('SELECT hr_item_id FROM packet_items WHERE packet_id = ?')
            .all(packet.id) as { hr_item_id: string }[]
        ).map((r) => r.hr_item_id),
      );
      const rows = hrRows(w.db, item.id);
      const ready = rows.filter((h) => h.state === 'ready' && inPacket.has(h.id));
      const byId = new Map(input.verdicts.map((v) => [v.hr_item_id, v]));
      if (byId.size !== input.verdicts.length) {
        throw new ToolError('validation', 'Each item takes one verdict; one is listed twice.', {
          details: { fields: { verdicts: 'duplicate hr_item_id' } },
        });
      }
      const extra = input.verdicts.filter((v) => !ready.some((h) => h.id === v.hr_item_id));
      if (extra.length > 0) {
        throw new ToolError(
          'validation',
          `${extra.map((v) => v.hr_item_id).join(', ')} ${extra.length === 1 ? 'is' : 'are'} not in round ${packet.round} of ${item.id}. Decide only the items in the packet.`,
          { details: { fields: { verdicts: 'unknown item' } } },
        );
      }
      const missing = ready.filter((h) => !byId.has(h.id));
      if (missing.length > 0) {
        throw new ToolError(
          'validation',
          `Decide every item first: ${plural(missing.length, 'item has', 'items have')} no verdict (${missing.map((h) => h.id).join(', ')}).`,
          { details: { fields: { verdicts: 'every ready item needs a verdict' } } },
        );
      }
      for (const v of input.verdicts) {
        if (v.kind === 'changes' && !(v.note ?? '').trim()) {
          throw new ToolError(
            'validation',
            `Say what needs to change on ${v.hr_item_id} so the agent can fix it: a note is required.`,
            { details: { fields: { note: 'required for changes' } } },
          );
        }
        const keep = v.kind === 'approve' ? (v.keep ?? 'item') : null;
        if (keep && keep !== 'item' && !(v.note ?? '').trim()) {
          throw new ToolError(
            'validation',
            `Write the note to keep for later on ${v.hr_item_id}, or keep nothing.`,
            { details: { fields: { note: `required to keep a note for the ${keep}` } } },
          );
        }
        if (keep === 'epic' && !item.epic_id) {
          throw new ToolError(
            'validation',
            `${item.id} has no epic, so the note on ${v.hr_item_id} can't be kept for the epic's future tickets. Keep it for this ticket or the whole project.`,
            { details: { fields: { keep: 'the item has no epic' } } },
          );
        }
      }

      const blockedBefore = new BlockIndex(w.db);
      const dependents = (blockedBefore.dependents.get(item.id) ?? []).map((l) => l.to_id);
      const wasBlocked = new Set(dependents.filter((d) => blockedBefore.state(d).blocked));

      const j = new Journal(w);
      const created: { id: string; kind: 'bug' | 'test_ticket' }[] = [];
      const counts = { approve: 0, changes: 0, defer: 0 };
      let stepsAdded = 0;
      /** Notes on approvals (owner decision 35), posted once the verdicts are recorded. */
      const notes: {
        h: HrRow;
        note: string;
        keep: ReviewKeep;
        decisionId: string | null;
      }[] = [];

      for (const h of ready) {
        const v = byId.get(h.id)!;
        counts[v.kind] += 1;
        const note = v.note?.trim() || null;
        let resultRef: string | null = null;
        let state: HrRow['state'] = 'approved';
        if (v.kind === 'changes') {
          state = 'declared';
          if (v.into === 'bug') {
            resultRef = createFromReview(w, j, item, {
              type: 'Bug',
              status: 'ready',
              title: bugTitle(note!),
              description: `${note!}\n\nFrom your human review of ${item.id}, round ${packet.round}:\n\n> ${h.text}`,
              fromReview: { item_id: item.id, round: packet.round, hr_item_id: h.id },
              summary: (id) =>
                `You created bug ${id} from your review of ${item.id}: ${bugTitle(note!)}`,
            });
            created.push({ id: resultRef, kind: 'bug' });
          } else {
            const steps = currentSteps(w.db, item.id);
            resultRef = newId('wst', ms(w.now));
            j.add(
              w.insert('work_steps', {
                id: resultRef,
                item_id: item.id,
                plan_version_no: planVersion(w.db, item.id),
                position: steps.reduce((max, s) => Math.max(max, s.position), -1) + 1,
                text: note!,
                state: 'todo',
                added_by: 'owner',
                from_review: { item_id: item.id, round: packet.round, hr_item_id: h.id },
              }),
            );
            stepsAdded += 1;
          }
        } else if (v.kind === 'defer') {
          state = 'deferred';
          if (v.follow === 'ticket') {
            resultRef = followUpTicket(w, j, item, h, packet.round);
            created.push({ id: resultRef, kind: 'test_ticket' });
          }
        } else if (note) {
          const keep = v.keep ?? 'item';
          const decisionId = keep === 'item' ? null : newId('dec', ms(w.now));
          resultRef = decisionId;
          notes.push({ h, note, keep, decisionId });
        }
        j.add(
          w.insert('review_decisions', {
            id: newId('rd', ms(w.now)),
            packet_id: packet.id,
            hr_item_id: h.id,
            kind: v.kind,
            note,
            into: v.kind === 'changes' ? (v.into ?? 'checklist') : null,
            follow: v.kind === 'defer' ? (v.follow ?? 'none') : null,
            result_ref: resultRef,
            decided_at: w.now,
          }),
        );
        j.add(
          w.update('hr_items', h.id, {
            state,
            last_decision: {
              kind: v.kind,
              note,
              round: packet.round,
              at: w.now,
              result_ref: resultRef,
            },
            ...(v.kind === 'defer' && resultRef ? { follow_up_item_id: resultRef } : {}),
          }),
        );
      }
      j.add(w.update('packets', packet.id, { state: 'decided' }));

      // The outcome, with the Done gate (§5.1) still in force.
      const anyChanges = counts.changes > 0;
      const stillDeclared = hrRows(w.db, item.id).filter(
        (h) => h.state === 'declared' || h.state === 'ready',
      );
      const openChildren =
        item.type === 'Epic'
          ? (
              w.db.sqlite
                .prepare(
                  "SELECT id FROM items WHERE epic_id = ? AND status NOT IN ('done', 'canceled')",
                )
                .all(item.id) as { id: string }[]
            ).map((r) => r.id)
          : [];
      // Decision 64: an epic's finish line isn't closed while bugs in the epic are open.
      const releaseHold = releaseHoldOf(w.db, item);
      const outcome: 'progress' | 'done' =
        anyChanges || stillDeclared.length > 0 || openChildren.length > 0 || releaseHold
          ? 'progress'
          : 'done';

      const kept = notes.filter((n) => n.decisionId !== null);
      const parts = [
        counts.approve
          ? `${counts.approve} approved${notes.length ? ` (${notes.length} with a note)` : ''}`
          : null,
        counts.changes ? `${counts.changes} need${counts.changes === 1 ? 's' : ''} changes` : null,
        counts.defer ? `${counts.defer} deferred, not verified` : null,
      ].filter(Boolean);
      const extraNote = stepsAdded ? ` (${plural(stepsAdded, 'checklist item')} added)` : '';
      j.event({
        type: 'review.decided',
        summary: `You reviewed round ${packet.round} of ${item.id}: ${parts.join(', ')}${extraNote}`,
        item_id: item.id,
        project_key: item.project_key,
        data: {
          packet_id: packet.id,
          round: packet.round,
          verdicts: input.verdicts.map((v) => ({ hr_item_id: v.hr_item_id, kind: v.kind })),
          created,
          outcome,
          ...(kept.length
            ? {
                kept: kept.map((n) => ({
                  decision_id: n.decisionId,
                  scope: n.keep,
                  hr_item_id: n.h.id,
                })),
              }
            : {}),
        },
        objects: [
          { kind: 'packet', id: packet.id },
          ...created.map((c) => ({ kind: 'item' as const, id: c.id })),
          ...kept.map((n) => ({ kind: 'decision' as const, id: n.decisionId! })),
        ],
      });

      // Notes on approvals (owner decision 35): an owner note for the item's
      // agent, and, kept for the epic or project, an owner decision there.
      for (const n of notes) {
        const text = clip(`${APPROVED_NOTE_PREFIX}${n.note}`, TEXT_LIMITS.note);
        const noteId = newId('note', ms(w.now));
        j.add(w.insert('owner_notes', { id: noteId, item_id: item.id, text }));
        j.event({
          type: 'owner_note.added',
          summary: `You approved with a note: ${n.note}`,
          item_id: item.id,
          project_key: item.project_key,
          data: { note_id: noteId, text, hr_item_id: n.h.id, round: packet.round },
        });
        if (!n.decisionId) continue;
        const scopeId = n.keep === 'epic' ? item.epic_id : null;
        const title = noteTitle(n.note);
        j.add(
          w.insert('decision_records', {
            id: n.decisionId,
            project_key: item.project_key,
            scope_kind: n.keep,
            scope_id: scopeId,
            title,
            decision_md: clip(n.note, LIMITS.decision_md),
            rationale_md: clip(
              `From your review of ${item.id}, round ${packet.round}: ${n.h.text}`,
              LIMITS.rationale_md,
            ),
            authority: 'owner',
            author: 'owner',
            status: 'active',
            supersedes_id: null,
            confirmed_at: null,
            version: 1,
          }),
        );
        j.event({
          type: 'decision.published',
          summary: `Owner recorded a decision from the review of ${item.id}: ${truncate(title, 80)}`,
          // Epic records log on the epic, project records on the project (§5.14).
          item_id: scopeId,
          project_key: item.project_key,
          data: {
            decision_id: n.decisionId,
            authority: 'owner',
            scope: { kind: n.keep, id: scopeId },
            from_review: { item_id: item.id, round: packet.round, hr_item_id: n.h.id },
          },
          objects: [
            { kind: 'decision', id: n.decisionId },
            { kind: 'item', id: item.id },
          ],
        });
      }

      const from = item.status;
      if (outcome === 'done') {
        const lead = activeLead(w.db, item.id);
        if (lead) {
          j.add(
            w.update('runs', lead.id, {
              state: 'finished',
              end_reason: 'finished',
              summary: 'Finished: the owner approved the review',
            }),
          );
          j.event({
            type: 'run.ended',
            summary: `Lead run finished: you closed ${item.id}`,
            item_id: item.id,
            project_key: item.project_key,
            data: { run_id: lead.id, end_reason: 'finished' },
            objects: [{ kind: 'run', id: lead.id }],
          });
        }
        j.add(w.update('items', item.id, { status: 'done', closed_by: 'owner', closed_at: w.now }));
        // Decision 36: Done ends the item's leases and its overlaps (not part of the undo).
        onItemClosed(w, item.id, 'done');
      } else if (from !== 'progress') {
        j.add(w.update('items', item.id, { status: 'progress' }));
      }
      if (from !== outcome) {
        const why =
          outcome === 'done'
            ? counts.defer
              ? ` after your review (${plural(counts.defer, 'item')} deferred, not verified)`
              : ' after your review'
            : anyChanges
              ? ': sent back'
              : stillDeclared.length > 0
                ? `: ${plural(stillDeclared.length, 'newer review item')} still to come`
                : releaseHold && openChildren.length === 0
                  ? `: it's ${releaseHold.epic}'s finish line and ${releaseHold.open_bugs.map((b) => b.id).join(', ')} ${releaseHold.open_bugs.length === 1 ? 'is' : 'are'} still open`
                  : `: ${openChildren.join(', ')} still open`;
        j.event({
          type: 'item.status_changed',
          summary: `You moved ${item.id} from ${from} to ${outcome}${why}`,
          item_id: item.id,
          project_key: item.project_key,
          data: { status: { old: from, new: outcome }, packet_id: packet.id },
        });
      }

      const after = new BlockIndex(w.db);
      const unblocked = [...wasBlocked].filter((d) => !after.state(d).blocked);
      return {
        outcome,
        item: summaryOf({ db: w.db, windows: windows(), now: w.now, index: after }, item.id),
        created,
        unblocked,
      };
    },

    createFollowUp(w, input): ItemSummary {
      if (w.actor.kind !== 'owner') {
        throw new ToolError(
          'forbidden',
          'Only the owner creates test tickets from the deferred list.',
        );
      }
      const h = w.get('hr_items', input.hr_item_id) as HrRow | undefined;
      if (!h) {
        throw new ToolError('not_found', `No human review item ${input.hr_item_id}.`);
      }
      const parent = requireItem(w.db, h.item_id);
      if (h.state !== 'deferred') {
        throw new ToolError(
          'validation',
          `${h.id} is ${h.state}, not deferred; only deferred items get a test ticket.`,
          { details: { state: h.state } },
        );
      }
      if (h.follow_up_item_id) {
        throw new ToolError('conflict', `${h.id} already has test ticket ${h.follow_up_item_id}.`, {
          current: { follow_up_item_id: h.follow_up_item_id },
        });
      }
      const last = parseLastDecision(h.last_decision);
      const round = last?.round ?? 0;
      const j = new Journal(w);
      const id = followUpTicket(w, j, parent, h, round);
      j.add(
        w.update('hr_items', h.id, {
          follow_up_item_id: id,
          last_decision: last ? { ...last, result_ref: id } : last,
        }),
      );
      const decision = w.db.sqlite
        .prepare(
          `SELECT rd.id FROM review_decisions rd JOIN packets p ON p.id = rd.packet_id
           WHERE rd.hr_item_id = ? AND rd.kind = 'defer' ORDER BY p.round DESC LIMIT 1`,
        )
        .get(h.id) as { id: string } | undefined;
      if (decision) {
        j.add(w.update('review_decisions', decision.id, { follow: 'ticket', result_ref: id }));
      }
      j.event({
        type: 'human_review.updated',
        summary: `You created test ticket ${id} for a deferred review item of ${parent.id}`,
        item_id: parent.id,
        project_key: parent.project_key,
        data: { hr_item_id: h.id, follow_up_item_id: id },
        objects: [{ kind: 'item', id }],
      });
      return summaryOf({ db: w.db, windows: windows(), now: w.now }, id);
    },
  };
}

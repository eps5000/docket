/**
 * A declared change to an approved design always needs the owner (owner
 * decision 39; BUILD_SPEC §5.21 B46; FR-185).
 *
 * This is separate from overlaps on purpose. An item that declares
 * `design_impact: changes_approved_design` gets one review, with or without
 * an overlap and in every Overlap handling mode. Until the owner approves it,
 * **that item** is paused: `claim_lead` is refused, a close is refused, and a
 * packet is held. Every other item carries on, including one that overlaps it.
 *
 * - **Only the owner decides** (`POST /api/design-reviews/:id/decide`,
 *   undoable). The overlap classifier never reads or changes a review, and an
 *   agent can't clear an open one, even by taking the flag out of its
 *   declaration. After *Send back*, the agent may rework the item so it no
 *   longer changes the design, or declare a materially different change,
 *   which asks again.
 * - **An approval covers what the owner read:** each part, its change and its
 *   design note. It doesn't ask again unless one of those materially changes
 *   (case and spacing in the note don't count). Dropping an approved entry
 *   asks nothing.
 */
import {
  TEXT_LIMITS,
  ToolError,
  type DesignHold,
  type DesignReviewRow,
  type DesignReviewState,
  type SharedChange,
  type Status,
} from '@docket/shared';
import type { Db } from '../db/client.js';
import { newId } from './ids.js';
import { callerName, ms, requireItem } from './model.js';
import { explain, listText } from './problems.js';
import type { InverseOp, WriteContext } from './write.js';

export interface DesignEntry {
  part: string;
  change: SharedChange;
  note: string;
}

interface ReviewRow {
  id: string;
  project_key: string;
  item_id: string;
  entries: string;
  state: DesignReviewState;
  note: string | null;
  requested_by: string;
  decided_by: string | null;
  decided_at: string | null;
  version: number;
  created_at: string;
}

const entriesOf = (r: Pick<ReviewRow, 'entries'>) => JSON.parse(r.entries) as DesignEntry[];

/** What makes two design changes the same: the part, the change and the note's words. */
export const designKey = (e: DesignEntry) =>
  `${e.part}\u0000${e.change}\u0000${e.note.trim().replace(/\s+/g, ' ').toLowerCase()}`;

/** The item's declared changes to an approved design. */
export function currentDesign(db: Db, itemId: string): DesignEntry[] {
  return (
    db.sqlite
      .prepare(
        `SELECT part_key, change, design_note FROM item_shared_changes
         WHERE item_id = ? AND design_impact = 'changes_approved_design' ORDER BY part_key`,
      )
      .all(itemId) as { part_key: string; change: SharedChange; design_note: string | null }[]
  ).map((r) => ({ part: r.part_key, change: r.change, note: r.design_note ?? '' }));
}

const reviewsOf = (db: Db, itemId: string) =>
  db.sqlite
    .prepare('SELECT * FROM design_reviews WHERE item_id = ? ORDER BY created_at DESC, id DESC')
    .all(itemId) as ReviewRow[];

function holdOf(r: ReviewRow): DesignHold {
  const entries = entriesOf(r);
  return {
    review_id: r.id,
    state: r.state,
    parts: entries.map((e) => e.part),
    notes: [...new Set(entries.map((e) => e.note))],
    owner_note: r.note,
  };
}

/** The entries no approval covers yet. */
function unapproved(reviews: readonly ReviewRow[], entries: readonly DesignEntry[]) {
  const approved = new Set(
    reviews.filter((r) => r.state === 'approved').flatMap((r) => entriesOf(r).map(designKey)),
  );
  return entries.filter((e) => !approved.has(designKey(e)));
}

/** The review pausing this item, or null when it may go on. */
export function designHold(db: Db, itemId: string): DesignHold | null {
  const reviews = reviewsOf(db, itemId);
  const open = reviews.find((r) => r.state === 'open');
  if (open) return holdOf(open);
  const left = new Set(unapproved(reviews, currentDesign(db, itemId)).map(designKey));
  if (left.size === 0) return null;
  const sentBack = reviews.find(
    (r) => r.state === 'sent_back' && entriesOf(r).some((e) => left.has(designKey(e))),
  );
  return sentBack ? holdOf(sentBack) : null;
}

/** Of `ids`, the items a design review is pausing (`ready_to_start` leaves them out). */
export function waitingOnDesign(db: Db, ids: readonly string[]): Set<string> {
  const out = new Set<string>();
  if (ids.length === 0) return out;
  const marks = ids.map(() => '?').join(', ');
  const candidates = db.sqlite
    .prepare(
      `SELECT DISTINCT item_id FROM design_reviews
       WHERE state IN ('open', 'sent_back') AND item_id IN (${marks})`,
    )
    .all(...ids) as { item_id: string }[];
  for (const { item_id } of candidates) if (designHold(db, item_id)) out.add(item_id);
  return out;
}

/** Refuse a claim, a start or a close while the owner's design review pauses the item. */
export function assertDesignCleared(
  db: Db,
  item: { id: string },
  doing: 'claim' | 'start' | 'close',
  owner = false,
): void {
  const hold = designHold(db, item.id);
  if (!hold) return;
  const what = listText(hold.notes.length > 0 ? hold.notes : hold.parts);
  const verb = { claim: 'claim', start: 'start', close: 'close' }[doing];
  const message = owner
    ? `${item.id} changes an approved design (${what}). Approve the design change or send it back first.`
    : hold.state === 'sent_back'
      ? `The owner sent back ${item.id}'s change to an approved design${hold.owner_note ? `: ${hold.owner_note}` : ''}. Don't ${verb} it as declared: rework it and declare again, and pick other work meanwhile.`
      : `${item.id} changes an approved design (${what}) and is waiting for the owner. Don't ${verb} it: pause this item's work and pick other work. Other items aren't affected.`;
  throw new ToolError('design_review', message, {
    details: { review_id: hold.review_id, state: hold.state, parts: hold.parts },
  });
}

/**
 * The owner at Docket's UI. In local trust an agent's shell can reach the owner
 * API with no session (decision 32), recorded as `via: script`, so a script
 * can neither decide a review nor withdraw one.
 */
const ownerInPerson = (w: WriteContext) =>
  w.actor.kind === 'owner' && w.actor.via?.via !== 'script';

function raised(w: WriteContext, r: ReviewRow, entries: DesignEntry[], inverse: InverseOp) {
  const notes = listText([...new Set(entries.map((e) => e.note))]);
  w.event({
    type: 'design_review.raised',
    summary: `${r.item_id} changes an approved design: ${notes}. It waits for the owner; other items continue`,
    item_id: r.item_id,
    project_key: r.project_key,
    data: { review_id: r.id, parts: entries.map((e) => e.part), notes },
    objects: [{ kind: 'design_review', id: r.id }],
    inverse: [inverse],
  });
}

/**
 * Bring the item's review in line with its declaration. A new or materially
 * changed design change opens a review. An unchanged one that was sent back
 * stays sent back. Only the owner's own edit can withdraw an open review.
 */
export function syncDesignReview(w: WriteContext, item: { id: string; project_key: string }): void {
  const reviews = reviewsOf(w.db, item.id);
  const open = reviews.find((r) => r.state === 'open');
  const left = unapproved(reviews, currentDesign(w.db, item.id));
  if (left.length === 0) {
    if (open && ownerInPerson(w)) withdraw(w, open, 'You took it out of the declaration');
    return;
  }
  const keys = left.map(designKey).sort();
  if (open) {
    const had = entriesOf(open).map(designKey).sort();
    if (JSON.stringify(had) === JSON.stringify(keys)) return;
    raised(w, open, left, w.update('design_reviews', open.id, { entries: left }));
    return;
  }
  const sentBack = reviews.find((r) => r.state === 'sent_back');
  if (sentBack) {
    const was = new Set(entriesOf(sentBack).map(designKey));
    if (keys.every((k) => was.has(k))) return;
  }
  const id = newId('drv', ms(w.now));
  const inverse = w.insert('design_reviews', {
    id,
    project_key: item.project_key,
    item_id: item.id,
    entries: left,
    state: 'open',
    note: null,
    requested_by: callerName(w.db, w.actor),
    decided_by: null,
    decided_at: null,
  });
  raised(w, { ...reviewRowFor(w.db, id) }, left, inverse);
}

const reviewRowFor = (db: Db, id: string) =>
  db.sqlite.prepare('SELECT * FROM design_reviews WHERE id = ?').get(id) as ReviewRow;

function withdraw(w: WriteContext, r: ReviewRow, why: string): void {
  const inverse = w.update('design_reviews', r.id, { state: 'withdrawn' });
  w.event({
    type: 'design_review.decided',
    summary: `Design review of ${r.item_id} withdrawn: ${why}`,
    item_id: r.item_id,
    project_key: r.project_key,
    data: { review_id: r.id, decision: 'withdrawn' },
    objects: [{ kind: 'design_review', id: r.id }],
    inverse: [inverse],
  });
}

/** A canceled item has nothing left to approve. */
export function withdrawDesignReviews(w: WriteContext, itemId: string): void {
  const open = reviewsOf(w.db, itemId).find((r) => r.state === 'open');
  if (open) withdraw(w, open, `${itemId} was canceled`);
}

function clip(text: string): string {
  return text.length > TEXT_LIMITS.note ? `${text.slice(0, TEXT_LIMITS.note - 1)}…` : text;
}

/**
 * *Approve the design change* or *Send back* (owner only; undoable). Each
 * reaches the item's lead as an owner note and in `get_context`. Send back
 * also withdraws a held packet and returns the item to In progress.
 */
export function decideDesignReview(
  w: WriteContext,
  input: {
    id: string;
    expected_version: number;
    decision: 'approve' | 'send_back';
    note?: string;
  },
): DesignReviewRow {
  if (!ownerInPerson(w)) {
    throw new ToolError(
      'forbidden',
      'Only the owner decides a change to an approved design, on its card in Docket. An agent or a script can not.',
    );
  }
  const row = w.checkVersion(
    'design_reviews',
    input.id,
    input.expected_version,
  ) as unknown as ReviewRow;
  if (row.state !== 'open') {
    throw new ToolError('conflict', 'This design change was already decided. Showing the latest.', {
      current: designReviewRow(w.db, row),
    });
  }
  const note = input.note?.trim() || null;
  if (input.decision === 'send_back' && !note) {
    throw new ToolError('validation', 'Say what the agent should do instead.', {
      details: { fields: { note: 'required to send it back' } },
    });
  }
  const item = requireItem(w.db, row.item_id);
  const entries = entriesOf(row);
  const notes = listText([...new Set(entries.map((e) => e.note))]);
  const inverses: InverseOp[] = [
    w.update('design_reviews', row.id, {
      state: input.decision === 'approve' ? 'approved' : 'sent_back',
      note,
      decided_by: 'owner',
      decided_at: w.now,
    }),
  ];
  const text = clip(
    input.decision === 'approve'
      ? `Approved your change to an approved design (${notes}). Go ahead.${note ? ` ${note}` : ''}`
      : `Your change to an approved design (${notes}) was sent back: ${note}. Keep this item paused until you've reworked it, then declare again.`,
  );
  const noteId = newId('note', ms(w.now));
  inverses.push(w.insert('owner_notes', { id: noteId, item_id: item.id, text }));
  w.event({
    type: 'design_review.decided',
    summary:
      input.decision === 'approve'
        ? `You approved ${item.id}'s design change: ${notes}`
        : `You sent back ${item.id}'s design change: ${note}`,
    item_id: item.id,
    project_key: item.project_key,
    data: {
      review_id: row.id,
      decision: input.decision,
      parts: entries.map((e) => e.part),
      notes,
      note,
      note_id: noteId,
    },
    objects: [{ kind: 'design_review', id: row.id }],
    inverse: inverses,
  });
  if (input.decision === 'send_back') returnToProgress(w, item);
  return designReviewRow(w.db, reviewRowFor(w.db, row.id));
}

/** Send back takes a held packet with it, undoably. */
function returnToProgress(
  w: WriteContext,
  item: { id: string; project_key: string; status: Status },
): void {
  const packet = w.db.sqlite
    .prepare("SELECT id, round FROM packets WHERE item_id = ? AND state = 'open'")
    .get(item.id) as { id: string; round: number } | undefined;
  if (packet) {
    const inverse = [w.update('packets', packet.id, { state: 'withdrawn' })];
    for (const hr of w.db.sqlite
      .prepare("SELECT id FROM hr_items WHERE item_id = ? AND state = 'ready'")
      .all(item.id) as { id: string }[]) {
      inverse.push(w.update('hr_items', hr.id, { state: 'declared' }));
    }
    w.event({
      type: 'packet.withdrawn',
      summary: `Packet round ${packet.round} withdrawn: its design change was sent back`,
      item_id: item.id,
      project_key: item.project_key,
      data: { packet_id: packet.id },
      objects: [{ kind: 'packet', id: packet.id }],
      inverse,
    });
  }
  if (item.status === 'review') {
    const inverse = w.update('items', item.id, { status: 'progress' });
    w.event({
      type: 'item.status_changed',
      summary: `You sent ${item.id} back to progress: its design change was sent back`,
      item_id: item.id,
      project_key: item.project_key,
      data: { status: { old: 'review', new: 'progress' } },
      inverse: [inverse],
    });
  }
}

export function designReviewRow(db: Db, r: ReviewRow): DesignReviewRow {
  const item = db.sqlite
    .prepare('SELECT id, title, status FROM items WHERE id = ?')
    .get(r.item_id) as {
    id: string;
    title: string;
    status: Status;
  };
  const entries = entriesOf(r);
  return {
    id: r.id,
    project: r.project_key,
    item,
    entries,
    state: r.state,
    note: r.note,
    requested_by: r.requested_by,
    created_at: r.created_at,
    decided_by: r.decided_by,
    decided_at: r.decided_at,
    version: r.version,
    explanation: explain.design_review({
      item: item.id,
      notes: listText([...new Set(entries.map((e) => e.note))]),
    }),
  };
}

/** The item's reviews, newest first, without withdrawn ones. */
export function itemDesignReviews(db: Db, itemId: string): DesignReviewRow[] {
  return reviewsOf(db, itemId)
    .filter((r) => r.state !== 'withdrawn')
    .map((r) => designReviewRow(db, r));
}

/** The open reviews in scope, oldest first: a Needs you card each. */
export function openDesignReviews(db: Db, scope: 'all' | string): DesignReviewRow[] {
  const rows = db.sqlite
    .prepare(
      `SELECT d.* FROM design_reviews d JOIN projects p ON p.key = d.project_key
       WHERE d.state = 'open' AND p.deleted_at IS NULL
       ${scope === 'all' ? '' : 'AND p.key = @scope'} ORDER BY d.created_at, d.id`,
    )
    .all(scope === 'all' ? {} : { scope }) as ReviewRow[];
  return rows.map((r) => designReviewRow(db, r));
}

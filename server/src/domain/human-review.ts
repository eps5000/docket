/**
 * Human review items (BUILD_SPEC §5.5): the `humanReview` service.
 *
 * US3 (T091).
 * - Agents and the owner add items. While an item is `declared`, its author
 *   edits or removes it; the owner may also change agent-added items, but
 *   agents get `forbidden` on owner-added ones.
 * - Items in the current open packet (`ready`) are locked (`forbidden`).
 * - Items added while a packet is open stay `declared` and go into the next round.
 * - Re-declaring (spec resolution, B9): declaring the exact text of a
 *   `deferred` item on the same ticket re-declares that item (back to
 *   `declared`, its last decision kept) instead of adding a duplicate. This
 *   is how "a deferred item clears when the owner or an agent re-declares
 *   it and it later gets approved" (§5.6) happens.
 * - An item that was in an earlier packet round can be edited but not
 *   removed: removing it would delete that round's record (FR-054).
 */
import { ToolError, type HumanReviewItem } from '@tasklite/shared';
import type { Db } from '../db/client.js';
import type { HumanReviewService, ServiceDeps } from './contracts.js';
import { newId } from './ids.js';
import { addedBy, assertCallerRun, callerName, ms, requireItem, type ItemRow } from './model.js';
import type { InverseOp, WriteContext } from './write.js';

export interface HrRow {
  id: string;
  item_id: string;
  position: number;
  text: string;
  state: 'declared' | 'ready' | 'approved' | 'deferred';
  added_by: string;
  last_decision: string | null;
  follow_up_item_id: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface LastDecision {
  kind: 'approve' | 'changes' | 'defer';
  note: string | null;
  round: number;
  at: string;
  result_ref: string | null;
}

export function parseLastDecision(text: string | null): LastDecision | null {
  if (!text) return null;
  try {
    const last = JSON.parse(text) as Record<string, unknown>;
    return {
      kind: last.kind as LastDecision['kind'],
      note: (last.note as string | null | undefined) ?? null,
      round: Number(last.round ?? 0),
      at: String(last.at ?? ''),
      result_ref: (last.result_ref as string | null | undefined) ?? null,
    };
  } catch {
    return null;
  }
}

export function hrRows(db: Db, itemId: string): HrRow[] {
  return db.sqlite
    .prepare('SELECT * FROM hr_items WHERE item_id = ? ORDER BY position, id')
    .all(itemId) as HrRow[];
}

/** A human review item as agents and the owner see it (MCP_SPEC §4 HumanReviewItem). */
export function hrView(h: HrRow): HumanReviewItem {
  return {
    id: h.id,
    text: h.text,
    state: h.state,
    added_by: addedBy(h.added_by),
    added_by_client: h.added_by === 'owner' ? null : h.added_by.split(' · ')[0]!,
    locked: h.state === 'ready',
    version: h.version,
    last_decision: parseLastDecision(h.last_decision),
    follow_up_item_id: h.follow_up_item_id,
  };
}

export const hrList = (db: Db, itemId: string): HumanReviewItem[] => hrRows(db, itemId).map(hrView);

const quote = (text: string) => `“${text.length > 60 ? `${text.slice(0, 59)}…` : text}”`;

function openForReview(item: ItemRow): void {
  if (item.status === 'done' || item.status === 'canceled') {
    throw new ToolError(
      'validation',
      `${item.id} is ${item.status}; human review can only be declared on open items. Reopen it first if it needs more work.`,
      { details: { status: item.status } },
    );
  }
}

function requireHr(w: WriteContext, itemId: string, hrId: string, expected?: number): HrRow {
  const row = w.get('hr_items', hrId) as HrRow | undefined;
  if (!row || row.item_id !== itemId) {
    throw new ToolError(
      'not_found',
      `No human review item ${hrId} on ${itemId}. Use an id from get_item.`,
    );
  }
  return w.checkVersion('hr_items', hrId, expected) as unknown as HrRow;
}

function lockedError(h: HrRow): ToolError {
  return new ToolError(
    'forbidden',
    `${h.id} is in the open packet and locked until the owner decides it. Declare a new item instead; it goes into the next round.`,
    { details: { state: h.state } },
  );
}

/** Approved and deferred items are decided; they aren't edited (only re-declared, by declaring their text). */
function decidedError(h: HrRow): ToolError {
  return new ToolError(
    'validation',
    `${h.id} is already ${h.state}; only declared items can be changed. Declare a new item if something else needs checking.`,
    { details: { state: h.state } },
  );
}

function hasHistory(w: WriteContext, hrId: string): boolean {
  return (
    w.db.sqlite.prepare('SELECT 1 FROM packet_items WHERE hr_item_id = ? LIMIT 1').get(hrId) !==
    undefined
  );
}

function historyError(h: HrRow): ToolError {
  return new ToolError(
    'validation',
    `${h.id} was in an earlier packet round, so removing it would erase that round's record. Edit its text instead.`,
  );
}

/**
 * Add items as `added_by` (or re-declare matching deferred ones). Returns
 * the IDs touched. Records one `human_review.declared` event.
 */
function addItems(w: WriteContext, item: ItemRow, texts: string[], by: string): string[] {
  openForReview(item);
  const rows = hrRows(w.db, item.id);
  let position = rows.reduce((max, r) => Math.max(max, r.position), -1);
  const ops: InverseOp[] = [];
  const added: string[] = [];
  const redeclared: string[] = [];
  for (const raw of texts) {
    const text = raw.trim();
    const deferred = rows.find(
      (r) => r.state === 'deferred' && r.text.trim() === text && !redeclared.includes(r.id),
    );
    if (deferred) {
      ops.push(w.update('hr_items', deferred.id, { state: 'declared' }));
      redeclared.push(deferred.id);
      continue;
    }
    const id = newId('hr', ms(w.now));
    position += 1;
    ops.push(
      w.insert('hr_items', {
        id,
        item_id: item.id,
        position,
        text,
        state: 'declared',
        added_by: by,
        version: 1,
      }),
    );
    added.push(id);
  }
  const who = by === 'owner' ? 'You' : by;
  const parts = [
    added.length > 0
      ? `declared ${added.length === 1 ? `human review ${quote(texts[0]!.trim())}` : `${added.length} human review items`}`
      : null,
    redeclared.length > 0
      ? `re-declared ${redeclared.length} deferred item${redeclared.length === 1 ? '' : 's'}`
      : null,
  ].filter(Boolean);
  w.event({
    type: 'human_review.declared',
    summary: `${who} ${parts.join(' and ')} on ${item.id}`,
    item_id: item.id,
    project_key: item.project_key,
    data: { added, redeclared },
    inverse: ops,
  });
  return [...added, ...redeclared];
}

function editText(w: WriteContext, item: ItemRow, h: HrRow, text: string, who: string): void {
  const inverse = w.update('hr_items', h.id, { text });
  w.event({
    type: 'human_review.updated',
    summary: `${who} edited human review ${quote(h.text)} on ${item.id}`,
    item_id: item.id,
    project_key: item.project_key,
    data: { hr_item_id: h.id, text: { old: h.text, new: text } },
    inverse: [inverse],
  });
}

function removeItem(w: WriteContext, item: ItemRow, h: HrRow, who: string): void {
  if (hasHistory(w, h.id)) throw historyError(h);
  const inverse = w.remove('hr_items', h.id);
  w.event({
    type: 'human_review.removed',
    summary: `${who} removed human review ${quote(h.text)} from ${item.id}`,
    item_id: item.id,
    project_key: item.project_key,
    data: { hr_item_id: h.id, text: h.text },
    inverse: [inverse],
  });
}

export function createHumanReviewService(_deps: ServiceDeps): HumanReviewService {
  return {
    declare(w, input) {
      assertCallerRun(w.db, w.actor, w.now);
      const item = requireItem(w.db, input.id);
      addItems(w, item, input.items, callerName(w.db, w.actor));
      return hrList(w.db, item.id);
    },

    update(w, input) {
      assertCallerRun(w.db, w.actor, w.now);
      const item = requireItem(w.db, input.id);
      const h = requireHr(w, item.id, input.hr_item_id, input.expected_version);
      if (h.added_by === 'owner') {
        throw new ToolError(
          'forbidden',
          `${h.id} was added by the owner; only the owner can change it.`,
        );
      }
      if (h.state === 'ready') throw lockedError(h);
      const author = h.added_by.split(' · ')[0];
      if (w.actor.kind === 'agent' && author !== w.actor.client) {
        throw new ToolError(
          'forbidden',
          `${h.id} was declared by ${author}; only its author or the owner can change it. Leave a note instead.`,
        );
      }
      if (h.state !== 'declared') throw decidedError(h);
      const who = callerName(w.db, w.actor);
      if (input.remove) removeItem(w, item, h, who);
      else editText(w, item, h, input.text!.trim(), who);
      return hrList(w.db, item.id);
    },

    ownerAdd(w, input) {
      const item = requireItem(w.db, input.id);
      const [id] = addItems(w, item, [input.text], 'owner');
      return hrView(w.require('hr_items', id!) as unknown as HrRow);
    },

    ownerUpdate(w, input) {
      const item = requireItem(w.db, input.id);
      const h = requireHr(w, item.id, input.hrId, input.expected_version);
      if (h.state === 'ready') throw lockedError(h);
      if (h.state !== 'declared') throw decidedError(h);
      editText(w, item, h, input.text.trim(), 'You');
      return hrView(w.require('hr_items', h.id) as unknown as HrRow);
    },

    ownerRemove(w, input) {
      const item = requireItem(w.db, input.id);
      const h = requireHr(w, item.id, input.hrId, input.expected_version);
      if (h.state === 'ready') throw lockedError(h);
      if (h.state !== 'declared') throw decidedError(h);
      removeItem(w, item, h, 'You');
    },
  };
}

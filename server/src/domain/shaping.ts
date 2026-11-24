/**
 * Tickets agents create arrive shaped or ask for a planner (owner decision 65;
 * BUILD_SPEC §5.42).
 *
 * **Shaped** is an outcome, at least one acceptance criterion and the shared
 * changes declared (parts, or none). An agent's `create_item` (or split) that
 * leaves any of them out stores who asked for shaping in `items.shaping`; so
 * does the owner's *Ask a planner to shape this* on a refused Move to Ready.
 * The ticket **needs shaping** while that is set, it is in Inbox or Planning,
 * not archived, and something is still missing. Shaping it, or moving it to
 * Ready, ends it: nothing has to clear the flag by hand.
 *
 * It adds no gate. The Ready gate (decision 36) still asks only for the
 * declaration, and its refusal now lists everything missing.
 */
import {
  SHAPING_NOTE_MAX,
  ToolError,
  missingText,
  type NeedsShaping,
  type ShapingAsker,
  type ShapingPart,
} from '@docket/shared';
import type { Db } from '../db/client.js';
import { callerName, requireItem, type ItemRow } from './model.js';
import type { WriteContext } from './write.js';

/** What `items.shaping` holds. */
export interface StoredShaping {
  asked_by: ShapingAsker;
  by: string;
  at: string;
  note: string | null;
}

/** The stored value, from the raw column (JSON text) or an already parsed one. */
export function storedShaping(raw: unknown): StoredShaping | null {
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object') return null;
  const v = value as Partial<StoredShaping>;
  if (v.asked_by !== 'agent' && v.asked_by !== 'owner') return null;
  return {
    asked_by: v.asked_by,
    by: typeof v.by === 'string' ? v.by : v.asked_by,
    at: typeof v.at === 'string' ? v.at : '',
    note: typeof v.note === 'string' ? v.note : null,
  };
}

interface ShapeFacts {
  id: string;
  outcome_md: string;
  criteria: number;
  declared: number;
}

const missingOf = (f: ShapeFacts): ShapingPart[] => [
  ...(f.outcome_md.trim() === '' ? (['outcome'] as const) : []),
  ...(f.criteria === 0 ? (['acceptance'] as const) : []),
  ...(f.declared === 0 ? (['shared_changes'] as const) : []),
];

const FACTS_SQL = `SELECT i.id, i.outcome_md,
    (SELECT count(*) FROM acceptance_criteria a WHERE a.item_id = i.id) AS criteria,
    (CASE WHEN i.shared_none_at IS NOT NULL THEN 1
      ELSE (SELECT count(*) FROM item_shared_changes c WHERE c.item_id = i.id) END) AS declared
  FROM items i`;

/** What the ticket still lacks to be shaped, in the order the words list them. */
export function shapingMissing(db: Db, id: string): ShapingPart[] {
  const row = db.sqlite.prepare(`${FACTS_SQL} WHERE i.id = ?`).get(id) as ShapeFacts | undefined;
  return row ? missingOf(row) : [];
}

type ShapingRow = Pick<ItemRow, 'id' | 'type' | 'status' | 'archived_at'> & {
  shaping?: string | null;
};

/** Whether a ticket in this state can need shaping at all. */
const mayNeed = (row: ShapingRow) =>
  row.type !== 'Epic' &&
  (row.status === 'inbox' || row.status === 'planning') &&
  row.archived_at === null;

/**
 * Each row that needs shaping, by ID: one query for the rows that have the
 * column set and could need it, none for the rest.
 */
export function needsShapingOf(db: Db, rows: readonly ShapingRow[]): Map<string, NeedsShaping> {
  const out = new Map<string, NeedsShaping>();
  const asked = new Map<string, StoredShaping>();
  for (const row of rows) {
    if (!row.shaping || !mayNeed(row)) continue;
    const s = storedShaping(row.shaping);
    if (s) asked.set(row.id, s);
  }
  if (asked.size === 0) return out;
  const facts = db.sqlite
    .prepare(`${FACTS_SQL} WHERE i.id IN (SELECT value FROM json_each(?))`)
    .all(JSON.stringify([...asked.keys()])) as ShapeFacts[];
  for (const f of facts) {
    const missing = missingOf(f);
    const s = asked.get(f.id)!;
    if (missing.length > 0) out.set(f.id, { missing, ...s });
  }
  return out;
}

/** One ticket's Needs shaping, or undefined. */
export function needsShaping(db: Db, id: string): NeedsShaping | undefined {
  const row = db.sqlite
    .prepare('SELECT id, type, status, archived_at, shaping FROM items WHERE id = ?')
    .get(id) as ShapingRow | undefined;
  return row ? needsShapingOf(db, [row]).get(id) : undefined;
}

/**
 * Every ticket in the project that needs shaping, highest priority first: the
 * producer's `get_digest` section.
 */
export function projectNeedsShaping(
  db: Db,
  project: string,
): (NeedsShaping & { id: string; title: string; epic: string | null })[] {
  const rows = db.sqlite
    .prepare(
      `SELECT id, type, status, archived_at, shaping, title, epic_id, priority FROM items
       WHERE project_key = ? AND shaping IS NOT NULL AND archived_at IS NULL
         AND status IN ('inbox', 'planning') AND type <> 'Epic'
       ORDER BY priority, CAST(substr(id, instr(id, '-') + 1) AS INTEGER)`,
    )
    .all(project) as (ShapingRow & { title: string; epic_id: string | null })[];
  const by = needsShapingOf(db, rows);
  return rows.flatMap((r) => {
    const n = by.get(r.id);
    return n ? [{ id: r.id, title: r.title, epic: r.epic_id, ...n }] : [];
  });
}

/**
 * After an agent's `create_item` or split: an Epic, or a ticket created
 * shaped, stays as it is; anything else is marked Needs shaping, by its agent.
 * The owner's own tickets are never marked here.
 */
export function markIfUnshaped(w: WriteContext, id: string): ShapingPart[] {
  if (w.actor.kind !== 'agent') return [];
  const row = requireItem(w.db, id);
  if (row.type === 'Epic') return [];
  const missing = shapingMissing(w.db, id);
  if (missing.length === 0) return [];
  // Written in the same transaction as the insert, so the new ticket's version stays 1.
  w.db.sqlite.prepare('UPDATE items SET shaping = ? WHERE id = ?').run(
    JSON.stringify({
      asked_by: 'agent',
      by: callerName(w.db, w.actor),
      at: w.now,
      note: null,
    } satisfies StoredShaping),
    id,
  );
  return missing;
}

/**
 * The owner's *Ask a planner to shape this*: the `shaping` value to set, for
 * the caller's update. Only on an Inbox or Planning ticket that isn't shaped.
 */
export function ownerShapingRequest(
  db: Db,
  item: ItemRow,
  note: string | undefined,
  now: string,
): { set: { shaping: StoredShaping }; missing: ShapingPart[] } {
  if (item.type === 'Epic') {
    throw new ToolError('validation', 'An epic is shaped by its tickets. Ask for one of them.');
  }
  if (item.status !== 'inbox' && item.status !== 'planning') {
    throw new ToolError(
      'validation',
      `${item.id} is past Planning; a planner shapes Inbox and Planning tickets.`,
    );
  }
  const missing = shapingMissing(db, item.id);
  if (missing.length === 0) {
    throw new ToolError(
      'validation',
      `${item.id} is already shaped: it has an outcome, acceptance criteria and its shared changes declared. Move it to Ready.`,
    );
  }
  const trimmed = note?.trim().slice(0, SHAPING_NOTE_MAX) || null;
  return {
    set: { shaping: { asked_by: 'owner', by: 'owner', at: now, note: trimmed } },
    missing,
  };
}

/** The `shaping` column cleared when a ticket reaches Ready; empty when it holds nothing. */
export function clearShaping(db: Db, id: string): { shaping?: null } {
  const row = db.sqlite.prepare('SELECT shaping FROM items WHERE id = ?').get(id) as
    { shaping: string | null } | undefined;
  return row?.shaping ? { shaping: null } : {};
}

/** "It also has no outcome and no acceptance criteria." for a refusal; empty when nothing else. */
export function alsoMissing(missing: readonly ShapingPart[]): string {
  const rest = missing.filter((m) => m !== 'shared_changes');
  return rest.length > 0 ? ` It also has ${missingText(rest)}.` : '';
}

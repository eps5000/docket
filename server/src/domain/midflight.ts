/**
 * Tickets added to an epic after it started (owner decision 62; BUILD_SPEC
 * §5.45).
 *
 * An epic *started* when work on it began: the later of its first move to
 * In progress (its first `item.status_changed` to `progress`, or its creation
 * for an import) and its first ticket's. A ticket *joined* the epic when
 * it was created in it, or at its latest `update_item epic` into it, as its
 * events record; one with no such event (imported or seeded) never counts. A
 * ticket that joined after the epic started was **added mid-flight**. A split
 * keeps its original's place, so it isn't new work. Worked out from the
 * events on read: no migration.
 *
 * New tickets land in Inbox, so one still in Inbox is **untriaged**. The
 * producer triages it (a bug to Ready in this epic, or to the epic it belongs
 * in; a story to the owner: add, defer or drop). Until then:
 * - `get_digest` lists "Added since this epic started: N untriaged";
 * - epic cards, the epic page and the map mark the tickets added mid-flight;
 * - the epic can't move to Done (`assertEpicTriaged`).
 */
import { ToolError, type EpicMidflight, type MidflightTicket } from '@docket/shared';
import type { Db } from '../db/client.js';
import type { ItemRow } from './model.js';

/**
 * Open epics where work has begun, with when: the later of the epic's first
 * move to In progress (or its creation, for an import) and its first ticket's.
 * An epic none of whose tickets has started yet has nothing mid-flight, so an
 * old-style breakdown (claim the epic, then create its tickets) isn't new work.
 */
function startedEpics(db: Db, epicIds?: readonly string[]): Map<string, string> {
  const rows = db.sqlite
    .prepare(
      `SELECT ep.id, coalesce(
         (SELECT min(e.at) FROM events e WHERE e.item_id = ep.id AND e.type = 'item.status_changed'
            AND json_extract(e.data, '$.status.new') = 'progress'),
         ep.created_at) AS epic_at,
         (SELECT min(e.at) FROM events e JOIN items t ON t.id = e.item_id
          WHERE t.epic_id = ep.id AND e.type = 'item.status_changed'
            AND json_extract(e.data, '$.status.new') = 'progress') AS ticket_at
       FROM items ep
       WHERE ep.type = 'Epic' AND ep.status IN ('progress', 'review') AND ep.archived_at IS NULL
         ${epicIds ? 'AND ep.id IN (SELECT value FROM json_each(?))' : ''}`,
    )
    .all(...(epicIds ? [JSON.stringify(epicIds)] : [])) as {
    id: string;
    epic_at: string;
    ticket_at: string | null;
  }[];
  return new Map(
    rows
      .filter((r) => r.ticket_at !== null)
      .map((r) => [r.id, r.ticket_at! > r.epic_at ? r.ticket_at! : r.epic_at]),
  );
}

/** Each started epic's tickets added after it started, oldest addition first. */
export function midflightByEpic(db: Db, epicIds?: readonly string[]): Map<string, EpicMidflight> {
  const out = new Map<string, EpicMidflight>();
  if (epicIds && epicIds.length === 0) return out;
  const started = startedEpics(db, epicIds);
  if (started.size === 0) return out;
  const rows = db.sqlite
    .prepare(
      `SELECT i.id, i.title, i.type, i.status, i.epic_id,
         (SELECT max(e.at) FROM events e WHERE e.item_id = i.id AND (e.type = 'item.created'
            OR (e.type = 'item.updated' AND json_extract(e.data, '$.changed.epic_id.new') = i.epic_id))
         ) AS added_at
       FROM items i
       WHERE i.epic_id IN (SELECT value FROM json_each(?)) AND i.type <> 'Epic'
         AND i.archived_at IS NULL AND i.status <> 'canceled' AND i.split_from IS NULL`,
    )
    .all(JSON.stringify([...started.keys()])) as (Omit<
    MidflightTicket,
    'untriaged' | 'added_at'
  > & {
    epic_id: string;
    added_at: string | null;
  })[];
  for (const r of rows) {
    const since = started.get(r.epic_id)!;
    const added = r.added_at;
    if (added === null || added <= since) continue;
    const m = out.get(r.epic_id) ?? { started_at: since, added: [], untriaged: 0 };
    const untriaged = r.status === 'inbox';
    m.added.push({
      id: r.id,
      title: r.title,
      type: r.type,
      status: r.status,
      added_at: added,
      untriaged,
    });
    if (untriaged) m.untriaged += 1;
    out.set(r.epic_id, m);
  }
  for (const m of out.values()) {
    m.added.sort((a, b) => a.added_at.localeCompare(b.added_at) || a.id.localeCompare(b.id));
  }
  return out;
}

/** One epic's, or null when it hasn't started or nothing was added. */
export function epicMidflight(db: Db, epic: Pick<ItemRow, 'id' | 'type'>): EpicMidflight | null {
  if (epic.type !== 'Epic') return null;
  return midflightByEpic(db, [epic.id]).get(epic.id) ?? null;
}

/**
 * Refuse moving an epic to Done while it holds untriaged tickets added
 * mid-flight, listing them and how to triage each.
 */
export function assertEpicTriaged(db: Db, item: Pick<ItemRow, 'id' | 'type'>): void {
  const m = epicMidflight(db, item);
  const open = m?.added.filter((t) => t.untriaged) ?? [];
  if (open.length === 0) return;
  const n = open.length;
  const shown = open
    .slice(0, 5)
    .map((t) => `${t.id} (${t.type.toLowerCase()})`)
    .join(', ');
  const more = n > 5 ? ` and ${n - 5} more` : '';
  throw new ToolError(
    'validation',
    `Can't close epic ${item.id}: ${n} ${n === 1 ? 'ticket was' : 'tickets were'} added after it started and ${n === 1 ? "hasn't" : "haven't"} been triaged: ${shown}${more}. Triage each one: a bug that belongs here goes to Ready (or to the epic it belongs in, or the owner decides whether to close it if it can't be reproduced); a story needs the owner (add it to this epic, defer it to a follow-up, or drop it).`,
    {
      details: {
        reason: 'untriaged tickets added after the epic started',
        untriaged: open.map((t) => ({ id: t.id, title: t.title, type: t.type })),
      },
    },
  );
}

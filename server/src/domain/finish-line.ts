/**
 * Open bugs hold back an epic's release (owner decision 64; BUILD_SPEC §5.42).
 *
 * **The finish line.** An epic's release ticket: a ticket in the epic that
 * depends on (is blocked by) another ticket in the epic, and that no other
 * ticket in the epic depends on. Bugs and canceled tickets are never the
 * finish line, and a canceled dependent doesn't count; a done one does, so the
 * finish line stays put once the work behind it is done. With exactly one such
 * ticket, that's it. With several or none, the producer or the owner marks one
 * (`items.finish_line` on the epic); until then the epic has "No finish line".
 * A mark stops counting once its ticket leaves the epic, is canceled or turns
 * into a bug, and detection takes over again.
 *
 * **Bugs hold it.** Every open bug in the epic (not Done or canceled, not
 * archived) blocks the finish line with no link: it can't move to Review
 * (`submit_packet`) or Done (`set_status`, or the owner's review) while one is
 * open, with `bugs_open` listing them and the ways forward. Bugs outside the
 * epic don't count. A bug that's also a real dependency keeps its links.
 */
import {
  OPEN_STATUSES,
  RELEASE_WAYS_FORWARD,
  ToolError,
  bugCount,
  type FinishLine,
  type ReleaseBug,
  type ReleaseHold,
  type Status,
} from '@docket/shared';
import type { Db } from '../db/client.js';
import type { ItemRow } from './model.js';

interface TicketRow {
  id: string;
  title: string;
  status: Status;
  type: ItemRow['type'];
  epic_id: string;
}

const OPEN: ReadonlySet<Status> = new Set(OPEN_STATUSES);

/** GF-2 before GF-10. */
export function compareKeys(a: string, b: string): number {
  const [pa, na] = splitKey(a);
  const [pb, nb] = splitKey(b);
  return pa.localeCompare(pb) || na - nb || a.localeCompare(b);
}
function splitKey(id: string): [string, number] {
  const m = /^(.*?)-(\d+)$/.exec(id);
  return m ? [m[1]!, Number(m[2])] : [id, 0];
}

const inJson = (ids: readonly string[]) => JSON.stringify(ids);

/** Whether a ticket can be (or stay) an epic's finish line. */
const canFinish = (t: Pick<TicketRow, 'type' | 'status'>) =>
  t.type !== 'Bug' && t.type !== 'Epic' && t.status !== 'canceled';

/**
 * The finish line of each epic in `epicIds`, with its open bugs. Every epic
 * asked about gets an entry, even one with no tickets.
 */
export function finishLines(db: Db, epicIds: readonly string[]): Map<string, FinishLine> {
  const out = new Map<string, FinishLine>();
  if (epicIds.length === 0) return out;
  const marks = new Map(
    (
      db.sqlite
        .prepare('SELECT id, finish_line FROM items WHERE id IN (SELECT value FROM json_each(?))')
        .all(inJson(epicIds)) as { id: string; finish_line: string | null }[]
    ).map((r) => [r.id, r.finish_line]),
  );
  const tickets = db.sqlite
    .prepare(
      `SELECT id, title, status, type, epic_id FROM items
       WHERE epic_id IN (SELECT value FROM json_each(?)) AND archived_at IS NULL AND type <> 'Epic'`,
    )
    .all(inJson(epicIds)) as TicketRow[];
  const links = db.sqlite
    .prepare(
      `SELECT l.from_id, l.to_id FROM links l
       JOIN items a ON a.id = l.from_id JOIN items b ON b.id = l.to_id
       WHERE l.type = 'blocks' AND a.epic_id = b.epic_id
         AND a.epic_id IN (SELECT value FROM json_each(?))`,
    )
    .all(inJson(epicIds)) as { from_id: string; to_id: string }[];

  const byEpic = new Map<string, TicketRow[]>();
  for (const t of tickets) {
    const list = byEpic.get(t.epic_id) ?? [];
    list.push(t);
    byEpic.set(t.epic_id, list);
  }
  const byId = new Map(tickets.map((t) => [t.id, t]));
  // Within one epic, ignoring canceled tickets on either end.
  const dependsOnSome = new Set<string>();
  const dependedOn = new Set<string>();
  for (const l of links) {
    const from = byId.get(l.from_id);
    const to = byId.get(l.to_id);
    if (!from || !to || from.status === 'canceled' || to.status === 'canceled') continue;
    dependsOnSome.add(to.id);
    // A bug waiting on a ticket doesn't make that ticket "not last": bugs never are the finish line.
    if (to.type !== 'Bug') dependedOn.add(from.id);
  }

  for (const epic of epicIds) {
    const list = (byEpic.get(epic) ?? []).sort((a, b) => compareKeys(a.id, b.id));
    const open_bugs: ReleaseBug[] = list
      .filter((t) => t.type === 'Bug' && OPEN.has(t.status))
      .map((t) => ({ id: t.id, title: t.title, status: t.status as ReleaseBug['status'] }));
    const mark = marks.get(epic) ?? null;
    const marked = mark ? list.find((t) => t.id === mark && canFinish(t)) : undefined;
    if (marked) {
      out.set(epic, { id: marked.id, how: 'explicit', candidates: [], open_bugs });
      continue;
    }
    const candidates = list
      .filter((t) => canFinish(t) && dependsOnSome.has(t.id) && !dependedOn.has(t.id))
      .map((t) => t.id);
    out.set(
      epic,
      candidates.length === 1
        ? { id: candidates[0]!, how: 'detected', candidates: [], open_bugs }
        : { id: null, how: null, candidates, open_bugs },
    );
  }
  return out;
}

export function finishLineOf(db: Db, epicId: string): FinishLine {
  return finishLines(db, [epicId]).get(epicId)!;
}

/** On a ticket that is its epic's finish line, while bugs in the epic are open; else null. */
export function releaseHoldOf(
  db: Db,
  item: Pick<ItemRow, 'id' | 'epic_id' | 'type'>,
): ReleaseHold | null {
  if (!item.epic_id || item.type === 'Bug' || item.type === 'Epic') return null;
  const line = finishLineOf(db, item.epic_id);
  if (line.id !== item.id || line.open_bugs.length === 0) return null;
  return { epic: item.epic_id, open_bugs: line.open_bugs };
}

const STATUS_WORD: Record<ReleaseBug['status'], string> = {
  inbox: 'Inbox',
  planning: 'Planning',
  ready: 'Ready',
  progress: 'In progress',
  review: 'Review',
};

/** The `bugs_open` refusal: which bugs, and the three ways forward. */
export function bugsOpenError(
  item: Pick<ItemRow, 'id'>,
  hold: ReleaseHold,
  to: 'review' | 'done',
): ToolError {
  const n = hold.open_bugs.length;
  const shown = hold.open_bugs
    .slice(0, 5)
    .map((b) => `${b.id} (${STATUS_WORD[b.status]})`)
    .join(', ');
  const more = n > 5 ? ` and ${n - 5} more` : '';
  return new ToolError(
    'bugs_open',
    `${item.id} is the finish line of epic ${hold.epic}, so it can't move to ${to === 'review' ? 'Review' : 'Done'} while ${n === 1 ? 'a bug in the epic is' : `${bugCount(n)} in the epic are`} open: ${shown}${more}. For each one: ${RELEASE_WAYS_FORWARD.join('; or ')}.`,
    {
      details: {
        epic: hold.epic,
        finish_line: item.id,
        open_bugs: hold.open_bugs.map((b) => ({ id: b.id, title: b.title, status: b.status })),
        ways_forward: ['fix', 'move', 'cancel'],
      },
    },
  );
}

/** Throw `bugs_open` when the finish line would move to Review or Done with bugs open. */
export function assertReleaseClear(
  db: Db,
  item: Pick<ItemRow, 'id' | 'epic_id' | 'type'>,
  to: 'review' | 'done',
): void {
  const hold = releaseHoldOf(db, item);
  if (hold) throw bugsOpenError(item, hold, to);
}

/**
 * Validate marking `ticket` as `epic`'s finish line: a ticket in the epic that
 * isn't a bug or canceled. Returns the value to store (null clears the mark).
 */
export function checkFinishLine(
  db: Db,
  epic: Pick<ItemRow, 'id' | 'type'>,
  ticket: string | null,
): string | null {
  if (epic.type !== 'Epic') {
    throw new ToolError(
      'validation',
      `${epic.id} isn't an epic: only an epic has a finish line. Pass finish_line on its epic.`,
      { details: { fields: { finish_line: 'is only for epics' } } },
    );
  }
  if (ticket === null) return null;
  const row = db.sqlite
    .prepare('SELECT id, type, status, epic_id FROM items WHERE id = ? AND archived_at IS NULL')
    .get(ticket) as Pick<ItemRow, 'id' | 'type' | 'status' | 'epic_id'> | undefined;
  if (!row || row.epic_id !== epic.id) {
    throw new ToolError(
      'validation',
      `${ticket} isn't a ticket in epic ${epic.id}. The finish line is the epic's release ticket: pick one of its tickets.`,
      { details: { fields: { finish_line: `is not in ${epic.id}` } } },
    );
  }
  if (!canFinish(row)) {
    throw new ToolError(
      'validation',
      row.type === 'Bug'
        ? `${ticket} is a bug: bugs hold the finish line, they can't be it. Pick the epic's release ticket.`
        : `${ticket} is canceled, so it can't be the finish line. Pick the epic's release ticket.`,
      { details: { fields: { finish_line: row.type === 'Bug' ? 'is a bug' : 'is canceled' } } },
    );
  }
  return row.id;
}

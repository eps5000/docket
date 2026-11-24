/**
 * A true Ready and "start this next" (owner decision 48; BUILD_SPEC §5.30).
 *
 * - **Startable** is the rule `search_items` `ready_to_start` uses: Ready,
 *   unblocked, unclaimed, and not waiting on the owner's overlap or design
 *   review. Everything else in Ready is **Waiting**, and says on what. The
 *   stored status never changes.
 * - **Next work** ranks what can start by priority, then how many open tickets
 *   it transitively unlocks, then age.
 * - **Bottlenecks** are unowned Inbox or Planning tickets holding up real work.
 *
 * Read-only and advisory: nothing here gates a claim. Walks visit each item
 * once per start, so a dependency cycle ends the walk.
 */
import { waitedText, type Digest, type ItemSummary, type Status } from '@docket/shared';
import type { Db } from '../db/client.js';
import { waitingOnDesign } from './design-review.js';
import {
  OPEN_STORED_SQL,
  actorName,
  leaseExpired,
  ms,
  type BlockIndex,
  type RunRow,
} from './model.js';
import { projectPauses } from './project-pause.js';
import { waitingOnOverlap } from './shared-changes.js';

export interface ReadyState {
  startable: boolean;
  /** What it waits on, in words; null when it can start. */
  waiting_on: string | null;
}

const BLOCKERS_SHOWN = 3;

function blockerWords(ids: readonly string[]): string {
  const shown = ids.slice(0, BLOCKERS_SHOWN).join(', ');
  return ids.length > BLOCKERS_SHOWN ? `${shown} and ${ids.length - BLOCKERS_SHOWN} more` : shown;
}

/**
 * Startable or Waiting, for each of these Ready items. `ignorePause` is for
 * Pick next epic (decision 54), which shows what could start once resumed.
 */
export function readyStates(
  db: Db,
  index: BlockIndex,
  ids: readonly string[],
  opts: { ignorePause?: boolean } = {},
): Map<string, ReadyState> {
  const out = new Map<string, ReadyState>();
  if (ids.length === 0) return out;
  const leads = new Map(
    (
      db.sqlite
        .prepare(
          `SELECT item_id, client, label FROM runs WHERE is_lead = 1 AND state IN ${OPEN_STORED_SQL}
           AND item_id IN (SELECT value FROM json_each(?))`,
        )
        .all(JSON.stringify(ids)) as { item_id: string; client: string; label: string | null }[]
    ).map((l) => [l.item_id, l]),
  );
  const overlap = waitingOnOverlap(db, [...ids]);
  const design = waitingOnDesign(db, ids);
  // Decision 53: nothing in a paused project can start, so none of it counts as Startable.
  const paused = opts.ignorePause ? new Map() : projectPauses(db);
  for (const id of ids) {
    const blockedBy = index.state(id).blocked_by;
    const lead = leads.get(id);
    const waiting_on = paused.has(index.project(id) ?? '')
      ? 'you to resume the project'
      : blockedBy.length > 0
        ? blockerWords(blockedBy)
        : lead
          ? `its lead, ${actorName({ kind: 'agent', client: lead.client, label: lead.label })}`
          : overlap.has(id)
            ? 'your overlap decision'
            : design.has(id)
              ? 'your design review'
              : null;
    out.set(id, { startable: waiting_on === null, waiting_on });
  }
  return out;
}

/** The open tickets `id` unlocks, directly or further down. Each is counted once. */
export function transitiveUnlocks(
  index: BlockIndex,
  id: string,
  isTicket: (id: string) => boolean,
): number {
  const seen = new Set([id]);
  const stack = [id];
  let count = 0;
  while (stack.length > 0) {
    for (const next of index.unblocks(stack.pop()!)) {
      if (seen.has(next)) continue;
      seen.add(next);
      if (isTicket(next)) count += 1;
      stack.push(next);
    }
  }
  return count;
}

interface ProjectRow {
  id: string;
  title: string;
  type: string;
  status: Status;
  priority: 1 | 2 | 3;
  created_at: string;
  archived_at: string | null;
}

/** Work a bottleneck holds up: someone could be doing it if the bottleneck moved. */
const REAL_WORK: ReadonlySet<Status> = new Set<Status>(['ready', 'progress', 'review']);

function holdsRealWork(
  index: BlockIndex,
  id: string,
  rows: ReadonlyMap<string, ProjectRow>,
): boolean {
  const seen = new Set([id]);
  const stack = [id];
  while (stack.length > 0) {
    for (const next of index.unblocks(stack.pop()!)) {
      if (seen.has(next)) continue;
      seen.add(next);
      // Decision 67: a Release waiting for its epic is expected, not work held up.
      if (index.type(next) === 'Release') continue;
      const status = rows.get(next)?.status ?? index.status(next);
      if (status && REAL_WORK.has(status)) return true;
      stack.push(next);
    }
  }
  return false;
}

const ticketWord = (n: number) => (n === 1 ? 'ticket' : 'tickets');

export interface NextWork {
  next_work: Digest['next_work']['rows'];
  bottlenecks: Digest['bottlenecks']['rows'];
}

/** The digest's two ranked lists, over what can start and the project's items. */
export function nextWorkOf(
  db: Db,
  index: BlockIndex,
  project: string,
  startable: readonly ItemSummary[],
  now: string,
): NextWork {
  const rows = new Map(
    (
      db.sqlite
        .prepare(
          `SELECT id, title, type, status, priority, created_at, archived_at FROM items
           WHERE project_key = ?`,
        )
        .all(project) as ProjectRow[]
    ).map((r) => [r.id, r]),
  );
  const epics = new Set(
    (db.sqlite.prepare("SELECT id FROM items WHERE type = 'Epic'").all() as { id: string }[]).map(
      (e) => e.id,
    ),
  );
  const isTicket = (id: string) => !epics.has(id);
  const unlocks = new Map<string, number>();
  const unlocksOf = (id: string) => {
    let n = unlocks.get(id);
    if (n === undefined) {
      n = transitiveUnlocks(index, id, isTicket);
      unlocks.set(id, n);
    }
    return n;
  };
  const age = (id: string) => ms(rows.get(id)?.created_at ?? now);
  const nowDate = new Date(now);

  const next_work = startable
    .filter((x) => x.type !== 'Epic')
    .map((x) => ({ x, n: unlocksOf(x.id) }))
    .sort(
      (a, b) =>
        a.x.priority - b.x.priority ||
        b.n - a.n ||
        age(a.x.id) - age(b.x.id) ||
        a.x.id.localeCompare(b.x.id),
    )
    .map(({ x, n }) => ({
      id: x.id,
      title: x.title,
      priority: x.priority,
      unlocks: n,
      reason: [
        `Priority ${x.priority}`,
        n > 0 ? `unlocks ${n} ${ticketWord(n)}` : 'unlocks nothing else',
        `open ${waitedText(rows.get(x.id)?.created_at ?? now, nowDate)}`,
      ].join(', '),
    }));

  const led = new Set(
    (
      db.sqlite
        .prepare(
          `SELECT r.* FROM runs r JOIN items i ON i.id = r.item_id
           WHERE i.project_key = ? AND r.is_lead = 1 AND r.state IN ${OPEN_STORED_SQL}`,
        )
        .all(project) as RunRow[]
    )
      .filter((r) => !leaseExpired(r, now))
      .map((r) => r.item_id),
  );
  const bottlenecks = [...rows.values()]
    .filter(
      (r) =>
        r.type !== 'Epic' &&
        r.archived_at === null &&
        (r.status === 'inbox' || r.status === 'planning') &&
        !led.has(r.id) &&
        index.unblocks(r.id).length > 0 &&
        holdsRealWork(index, r.id, rows),
    )
    .map((r) => ({ r, n: unlocksOf(r.id) }))
    .sort(
      (a, b) =>
        b.n - a.n ||
        a.r.priority - b.r.priority ||
        ms(a.r.created_at) - ms(b.r.created_at) ||
        a.r.id.localeCompare(b.r.id),
    )
    .map(({ r, n }) => ({
      id: r.id,
      title: r.title,
      status: r.status as 'inbox' | 'planning',
      unlocks: n,
      next: 'shape it or assign it',
    }));
  return { next_work, bottlenecks };
}

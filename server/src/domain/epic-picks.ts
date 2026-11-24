/**
 * Pick next epic (owner decision 54; BUILD_SPEC §5.38): which open epic a new
 * agent can take without parking on someone else's work. Read-only and
 * advisory, and built on the one blocker evaluator (`BlockIndex`), B58's one
 * Startable rule (`readyStates`) and B60's walk (`upstreamOf`).
 *
 * **The chain.** An item's open hard blockers, plus two rules that make a link
 * on an epic mean what the critical path takes it to mean:
 * - a blocker on an epic holds up every ticket in that epic;
 * - waiting on an epic means waiting on its open tickets.
 *
 * Each walk visits an item once, so a dependency cycle ends it.
 */
import {
  OPEN_STATUSES,
  ToolError,
  type EpicPick,
  type EpicWait,
  type PickEpicResponse,
  type Status,
} from '@docket/shared';
import type { Db } from '../db/client.js';
import { upstreamOf } from './critical-path.js';
import { compareIds } from './links.js';
import { BlockIndex, OPEN_STORED_SQL, actorName, leaseExpired, ms, type RunRow } from './model.js';
import { readyStates } from './next-work.js';
import { waitKindsOf } from './wait-kind.js';
import { projectPause } from './project-pause.js';
import { readinessOf, unshapedByEpic } from './epic-readiness.js';
import { finishLines } from './finish-line.js';

/** How many startable tickets a row names. */
const FIRST_SHOWN = 3;

interface Node {
  id: string;
  project_key: string;
  type: string;
  title: string;
  status: Status;
  priority: number;
  epic_id: string | null;
  archived_at: string | null;
}

const isOpen = (status: Status) => (OPEN_STATUSES as readonly string[]).includes(status);
const ticketWord = (n: number) => (n === 1 ? 'ticket' : 'tickets');

/** Every item and its chain, read once per request. */
export class EpicGraph {
  readonly nodes = new Map<string, Node>();
  private readonly openTickets = new Map<string, string[]>();
  /** Children that can still clear a link: everything but canceled. */
  private readonly members = new Map<string, string[]>();
  private readonly memo = new Map<string, readonly string[]>();
  private waitedOnBy: Map<string, string[]> | null = null;

  constructor(
    db: Db,
    readonly index: BlockIndex,
  ) {
    for (const n of db.sqlite
      .prepare(
        `SELECT i.id, i.project_key, i.type, i.title, i.status, i.priority, i.epic_id, i.archived_at
         FROM items i JOIN projects p ON p.key = i.project_key WHERE p.deleted_at IS NULL`,
      )
      .all() as Node[]) {
      this.nodes.set(n.id, n);
      if (n.type === 'Epic' || !n.epic_id) continue;
      if (n.status !== 'canceled') push(this.members, n.epic_id, n.id);
      if (isOpen(n.status) && n.archived_at === null) push(this.openTickets, n.epic_id, n.id);
    }
  }

  /** The epic's open, non-archived tickets. */
  tickets(epic: string): readonly string[] {
    return this.openTickets.get(epic) ?? [];
  }

  /** What this item directly waits on. */
  chain = (id: string): readonly string[] => {
    let out = this.memo.get(id);
    if (out) return out;
    const n = this.nodes.get(id);
    const next = new Set(this.index.state(id).blocked_by);
    if (n?.type === 'Epic') {
      if (isOpen(n.status)) for (const t of this.tickets(id)) next.add(t);
    } else if (n?.epic_id && isOpen(n.status)) {
      for (const b of this.index.state(n.epic_id).blocked_by) next.add(b);
    }
    next.delete(id);
    out = [...next];
    this.memo.set(id, out);
    return out;
  };

  /** The epic an item counts under: itself for an epic; null for "no epic". */
  private group(id: string): string | null {
    const n = this.nodes.get(id);
    if (!n) return null;
    return n.type === 'Epic' ? n.id : n.epic_id;
  }

  /** How many of the epic's tickets stay inside it, and what the rest wait on. */
  outside(epic: string): { self_contained: number; waits_on: EpicWait[] } {
    const tickets = this.tickets(epic);
    const upstream = upstreamOf(tickets, this.chain);
    const outsiders = [...upstream].filter((x) => this.group(x) !== epic);

    // Everything in the walk that reaches an outsider can't finish on its own.
    const back = new Map<string, string[]>();
    for (const x of upstream) for (const b of this.chain(x)) push(back, b, x);
    const held = new Set(outsiders);
    const stack = [...outsiders];
    while (stack.length > 0) {
      for (const x of back.get(stack.pop()!) ?? []) {
        if (held.has(x)) continue;
        held.add(x);
        stack.push(x);
      }
    }

    const counts = new Map<string | null, number>();
    for (const x of outsiders) {
      const key = this.group(x);
      const isEpic = this.nodes.get(x)?.type === 'Epic';
      counts.set(key, (counts.get(key) ?? 0) + (isEpic ? 0 : 1));
    }
    const waits_on = [...counts]
      .map(([key, n]) => ({
        epic: key,
        title: key ? (this.nodes.get(key)?.title ?? null) : null,
        // A canceled or empty epic has no open tickets, but it still holds this one up.
        tickets: Math.max(n, 1),
      }))
      .sort(
        (a, b) =>
          Number(a.epic === null) - Number(b.epic === null) ||
          b.tickets - a.tickets ||
          compareIds(a.epic ?? '', b.epic ?? ''),
      );
    return {
      self_contained: tickets.filter((t) => !held.has(t)).length,
      waits_on,
    };
  }

  /** Distinct open tickets in other epics that transitively wait on this epic. */
  unblocksElsewhere(epic: string): number {
    if (!this.waitedOnBy) {
      this.waitedOnBy = new Map();
      for (const id of this.nodes.keys()) {
        for (const b of this.chain(id)) push(this.waitedOnBy, b, id);
      }
    }
    const start = [epic, ...(this.members.get(epic) ?? [])];
    const seen = new Set(start);
    const stack = [...start];
    let count = 0;
    while (stack.length > 0) {
      for (const x of this.waitedOnBy.get(stack.pop()!) ?? []) {
        if (seen.has(x)) continue;
        seen.add(x);
        stack.push(x);
        const n = this.nodes.get(x);
        if (
          n &&
          n.type !== 'Epic' &&
          isOpen(n.status) &&
          n.archived_at === null &&
          n.epic_id !== null &&
          n.epic_id !== epic
        ) {
          count += 1;
        }
      }
    }
    return count;
  }
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/**
 * What each of these epics waits on, for the indicator on epic cards and the
 * epic page. Only open epics with open tickets have an entry.
 */
export function epicWaits(
  db: Db,
  index: BlockIndex,
  epics: readonly string[],
): Map<string, EpicWait[]> {
  const out = new Map<string, EpicWait[]>();
  if (epics.length === 0) return out;
  const graph = new EpicGraph(db, index);
  for (const id of epics) {
    const n = graph.nodes.get(id);
    if (!n || !isOpen(n.status) || graph.tickets(id).length === 0) continue;
    out.set(id, graph.outside(id).waits_on);
  }
  return out;
}

// ---- Who holds it ----

interface Holder {
  who: string;
  role: 'lead' | 'producer';
}

/** Live leads and producers by item: open leases, parked leads and unexpired producer holds. */
function holdersByItem(db: Db, graph: EpicGraph, now: string): Map<string, Holder> {
  const out = new Map<string, Holder>();
  for (const run of db.sqlite
    .prepare(
      `SELECT * FROM runs WHERE is_lead = 1
       AND (state IN ${OPEN_STORED_SQL} OR producer_hold_until IS NOT NULL)
       ORDER BY created_at, id`,
    )
    .all() as RunRow[]) {
    const active = ['open', 'needs_input', 'parked'].includes(run.state);
    const live = active
      ? !leaseExpired(run, now)
      : graph.nodes.get(run.item_id)?.status === 'progress' &&
        ms(run.producer_hold_until!) > ms(now);
    if (!live) continue;
    out.set(
      run.item_id,
      run.producer
        ? { who: run.producer, role: 'producer' }
        : {
            who: actorName({ kind: 'agent', client: run.client, label: run.label }),
            role: 'lead',
          },
    );
  }
  return out;
}

function workedBy(
  ids: readonly string[],
  holders: ReadonlyMap<string, Holder>,
): EpicPick['worked_by'] {
  const out = new Map<string, EpicPick['worked_by'][number]>();
  for (const id of ids) {
    const h = holders.get(id);
    if (!h) continue;
    const key = `${h.role}:${h.who}`;
    const row = out.get(key);
    if (row) row.items.push(id);
    else out.set(key, { ...h, items: [id] });
  }
  return [...out.values()];
}

// ---- Fit and order ----

type Facts = Pick<EpicPick, 'open' | 'self_contained' | 'not_shaped'> & { canStart: number };

/** Why a new agent would likely park here, or null. */
export function parkReason(p: Facts): string | null {
  const waiting = p.open - p.self_contained;
  if (p.canStart === 0) {
    if (waiting > 0) {
      return `Nothing can start: ${waiting} of ${p.open} ${ticketWord(p.open)} ${waiting === 1 ? 'waits' : 'wait'} on work outside this epic.`;
    }
    if (p.not_shaped > 0) {
      return `Nothing can start: ${p.not_shaped} of ${p.open} ${ticketWord(p.open)} still ${p.not_shaped === 1 ? 'needs' : 'need'} shaping.`;
    }
    return 'Nothing can start: its open tickets are already moving or waiting on you.';
  }
  if (waiting * 2 > p.open) {
    return `Most tickets wait on other work: ${waiting} of ${p.open} depend on something outside this epic.`;
  }
  return null;
}

/** Fully self-contained, then mostly, then the rest. */
const containedTier = (p: EpicPick) =>
  p.self_contained === p.open ? 0 : p.self_contained * 2 >= p.open ? 1 : 2;

/** The default order: free, can start, self-contained, then what it unblocks elsewhere. */
export function compareEpicPicks(a: EpicPick, b: EpicPick): number {
  return (
    Number(a.worked_by.length > 0) - Number(b.worked_by.length > 0) ||
    Number(a.can_start.count === 0) - Number(b.can_start.count === 0) ||
    containedTier(a) - containedTier(b) ||
    b.unblocks_elsewhere - a.unblocks_elsewhere ||
    b.self_contained / b.open - a.self_contained / a.open ||
    a.priority - b.priority ||
    compareIds(a.id, b.id)
  );
}

/** The one-line reason on the Best next row. */
export function bestReason(p: EpicPick, paused: boolean): string {
  const n = p.unblocks_elsewhere;
  const finishing = n > 0 ? `finishing it unblocks ${n} ${ticketWord(n)}` : null;
  const start = p.can_start.count;
  const starting = `${start} ${ticketWord(start)} can start ${paused ? 'once you resume the project' : 'now'}`;
  if (p.self_contained === p.open) {
    return `Nothing outside this epic blocks it, and ${finishing ?? starting}.`;
  }
  return `${p.self_contained} of ${p.open} tickets can finish without other work, and ${finishing ?? starting}.`;
}

// ---- The read ----

export function pickEpics(
  ctx: { db: Db; now: string; parkMaxMs: number },
  project: string,
): PickEpicResponse {
  const { db, now } = ctx;
  const exists = db.sqlite
    .prepare('SELECT 1 FROM projects WHERE key = ? AND deleted_at IS NULL')
    .get(project);
  if (!exists) {
    throw new ToolError('not_found', `No project ${project}. Check the key in Settings.`);
  }
  const paused = projectPause(db, project) !== null;
  const index = new BlockIndex(db);
  const graph = new EpicGraph(db, index);
  const epics = [...graph.nodes.values()].filter(
    (n) =>
      n.project_key === project &&
      n.type === 'Epic' &&
      n.archived_at === null &&
      isOpen(n.status) &&
      graph.tickets(n.id).length > 0,
  );
  const readyIds = epics.flatMap((e) =>
    graph.tickets(e.id).filter((t) => graph.nodes.get(t)?.status === 'ready'),
  );
  // Decision 54: a pause doesn't make an epic look empty, so it's left out here.
  const ready = readyStates(db, index, readyIds, { ignorePause: true });
  const holders = holdersByItem(db, graph, now);
  const kinds = waitKindsOf(db, now, index, ctx);
  // Decision 58: an epic not yet started with Inbox or Planning tickets can't start.
  const unshaped = unshapedByEpic(
    db,
    epics.map((e) => e.id),
  );
  // Decision 64: each epic's finish line and open bugs.
  const lines = finishLines(
    db,
    epics.map((e) => e.id),
  );

  const rows = epics
    .map((e): EpicPick => {
      const tickets = graph.tickets(e.id).map((t) => graph.nodes.get(t)!);
      const { self_contained, waits_on } = graph.outside(e.id);
      const startable = tickets
        .filter((t) => ready.get(t.id)?.startable === true)
        .sort((a, b) => a.priority - b.priority || compareIds(a.id, b.id));
      const not_shaped = tickets.filter(
        (t) => t.status === 'inbox' || t.status === 'planning',
      ).length;
      const worked_by = workedBy([e.id, ...tickets.map((t) => t.id)], holders);
      const waits = kinds.counts(tickets.map((t) => t.id));
      const park_reason = parkReason({
        open: tickets.length,
        self_contained,
        not_shaped,
        canStart: startable.length,
      });
      const readiness = readinessOf(e, unshaped.get(e.id));
      const notReady = readiness?.state === 'not_ready';
      return {
        id: e.id,
        title: e.title,
        status: e.status,
        priority: e.priority,
        open: tickets.length,
        self_contained,
        can_start: {
          count: startable.length,
          first: startable.slice(0, FIRST_SHOWN).map((t) => ({ id: t.id, title: t.title })),
        },
        waits_on,
        unblocks_elsewhere: graph.unblocksElsewhere(e.id),
        not_shaped,
        waiting: { queued: waits.queued, blocked: waits.blocked },
        worked_by,
        fit:
          worked_by.length > 0
            ? 'being_worked'
            : notReady
              ? 'not_ready'
              : park_reason
                ? 'likely_parks'
                : 'available',
        park_reason: worked_by.length > 0 || notReady ? null : park_reason,
        ...(readiness ? { readiness } : {}),
        release: {
          finish_line: lines.get(e.id)?.id ?? null,
          open_bugs: lines.get(e.id)?.open_bugs.length ?? 0,
        },
      };
    })
    .sort(compareEpicPicks);

  const top = rows.find((r) => r.fit === 'available');
  return {
    project,
    paused,
    epics: rows,
    best: top ? { id: top.id, reason: bestReason(top, paused) } : null,
  };
}

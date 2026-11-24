/**
 * The critical path to a goal (owner decision 48; BUILD_SPEC §5.31): the
 * longest chain of unresolved `blocks` links into a ticket or epic, and the
 * one ticket to move next. Read-only, advisory, and built on the one blocker
 * evaluator (`BlockIndex`), so it agrees with every other blocked state.
 *
 * - **Cycle-safe.** Blockers are condensed into strongly connected components
 *   first, so the longest path is over a DAG. A loop counts as all its members.
 * - **Ties** go to the chain whose first ticket can start now (B58's one
 *   Startable rule, `readyStates`), then the higher priority, then the lower
 *   ID, so the answer is stable between reads. Unlock counts stay in B58's ranking.
 * - **Iterative**, so a very deep chain can't overflow the stack.
 */
import type {
  CriticalNextReason,
  CriticalPathResponse,
  ItemSummary,
  LinkEdge,
  WaitingOn,
} from '@docket/shared';
import type { Db } from '../db/client.js';
import { compareIds } from './links.js';
import { BlockIndex, requireItem, summarize, type ItemRow, type RunWindows } from './model.js';
import { readyStates } from './next-work.js';
import { waitKindsOf } from './wait-kind.js';
import { parseJson } from './recovery-model.js';

export interface ChainInput {
  /** The goal's tickets. The chain ends at one of them. */
  targets: readonly string[];
  /** Unresolved blockers of an item. */
  blockersOf: (id: string) => readonly string[];
  /** Below 0 when a chain starting at `a` beats an equally long one starting at `b`. */
  better: (a: string, b: string) => number;
}

export interface Chain {
  /** First = furthest from the goal. A loop's members are next to each other. */
  ids: string[];
  /** Members of a loop on the chain. */
  inCycle: ReadonlySet<string>;
  /** Every loop upstream of the targets, each sorted by ID. */
  cycles: string[][];
  /** Everything upstream of the targets, the targets included. */
  upstream: ReadonlySet<string>;
}

/** All items the targets wait on, directly or not, the targets included. */
export function upstreamOf(
  targets: readonly string[],
  blockersOf: (id: string) => readonly string[],
): Set<string> {
  const seen = new Set(targets);
  const stack = [...seen];
  while (stack.length > 0) {
    for (const b of blockersOf(stack.pop()!)) {
      if (seen.has(b)) continue;
      seen.add(b);
      stack.push(b);
    }
  }
  return seen;
}

/**
 * Strongly connected components over `next` (Tarjan, iterative). A component
 * is emitted only after every component it can reach, so with `next` = "its
 * blockers", blockers always come first.
 */
function components(nodes: Iterable<string>, next: (id: string) => readonly string[]): string[][] {
  const order = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const out: string[][] = [];
  let counter = 0;
  for (const root of nodes) {
    if (order.has(root)) continue;
    const work: { id: string; edges: readonly string[]; i: number }[] = [];
    const visit = (id: string) => {
      order.set(id, counter);
      low.set(id, counter);
      counter += 1;
      stack.push(id);
      onStack.add(id);
      work.push({ id, edges: next(id), i: 0 });
    };
    visit(root);
    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      if (frame.i < frame.edges.length) {
        const to = frame.edges[frame.i++]!;
        if (!order.has(to)) visit(to);
        else if (onStack.has(to)) low.set(frame.id, Math.min(low.get(frame.id)!, order.get(to)!));
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) low.set(parent.id, Math.min(low.get(parent.id)!, low.get(frame.id)!));
      if (low.get(frame.id) === order.get(frame.id)) {
        const component: string[] = [];
        for (;;) {
          const x = stack.pop()!;
          onStack.delete(x);
          component.push(x);
          if (x === frame.id) break;
        }
        out.push(component.sort(compareIds));
      }
    }
  }
  return out;
}

/** The longest chain of blockers into any target; empty with no targets. */
export function longestChain({ targets, blockersOf, better }: ChainInput): Chain {
  const upstream = upstreamOf(targets, blockersOf);
  const comps = components(upstream, blockersOf);
  const compOf = new Map<string, number>();
  comps.forEach((members, c) => members.forEach((id) => compOf.set(id, c)));

  interface Best {
    length: number;
    head: string;
    prev: number | null;
  }
  const first = (members: readonly string[]) =>
    [...members].sort((a, b) => better(a, b) || compareIds(a, b))[0]!;
  const wins = (a: Best, aKey: string, b: Best, bKey: string) =>
    a.length !== b.length
      ? a.length > b.length
      : (better(a.head, b.head) || compareIds(a.head, b.head) || compareIds(aKey, bKey)) < 0;

  const best: Best[] = [];
  comps.forEach((members, c) => {
    let top: Best = { length: members.length, head: first(members), prev: null };
    let topKey = '';
    const preds = new Set<number>();
    for (const id of members) {
      for (const b of blockersOf(id)) {
        const p = compOf.get(b)!;
        if (p !== c) preds.add(p);
      }
    }
    for (const p of preds) {
      const via: Best = { length: best[p]!.length + members.length, head: best[p]!.head, prev: p };
      const key = comps[p]![0]!;
      if (top.prev === null || wins(via, key, top, topKey)) {
        top = via;
        topKey = key;
      }
    }
    best[c] = top;
  });

  let end: number | null = null;
  for (const t of targets) {
    const c = compOf.get(t)!;
    if (end === null || wins(best[c]!, comps[c]![0]!, best[end]!, comps[end]![0]!)) end = c;
  }
  const ids: string[] = [];
  const inCycle = new Set<string>();
  for (let c = end; c !== null; c = best[c]!.prev) {
    const members = comps[c]!;
    if (members.length > 1) members.forEach((id) => inCycle.add(id));
    // The ticket to move leads its loop; the rest keep ID order.
    const lead = best[c]!.prev === null ? best[c]!.head : members[0]!;
    ids.unshift(lead, ...members.filter((id) => id !== lead));
  }
  return {
    ids,
    inCycle,
    cycles: comps.filter((m) => m.length > 1),
    upstream,
  };
}

// ---- Why this ticket ----

/** What a parked agent is waiting on, in words. */
function parkedOn(waiting: WaitingOn | null): string {
  const parts: string[] = [];
  if (waiting?.orchestrator) parts.push('its coordinator');
  if (waiting?.person) parts.push('a person');
  if (waiting?.items?.length) parts.push(waiting.items.join(', '));
  if (waiting?.until) parts.push('a set time');
  return parts.length > 0 ? parts.join(' and ') : 'something it hasn’t named';
}

export function nextReason(input: {
  item: ItemSummary;
  inCycle: readonly string[];
  /** What the next ticket's link waits for, when this one is done. */
  waitingFor: 'done' | 'merge' | 'verification' | null;
  /** The ticket it directly holds up, if any. */
  holds: string | null;
  openQuestion: boolean;
  /** Why a Ready ticket can't start, from `readyStates`; null when it can. */
  readyWait?: string | null;
  parkedOn: WaitingOn | null;
}): { reason: CriticalNextReason; why: string } {
  const { item, inCycle, waitingFor, holds, openQuestion } = input;
  if (inCycle.length > 0) {
    return {
      reason: 'cycle',
      why: `${inCycle.join(', ')} block each other, so none can start. Remove one of those links.`,
    };
  }
  if (item.status === 'canceled') {
    return {
      reason: 'canceled',
      why: `It was canceled but still blocks ${holds ?? 'this work'}. Remove the link or reopen it.`,
    };
  }
  if (item.status === 'done') {
    return waitingFor === 'verification'
      ? { reason: 'waiting_on_owner', why: 'It’s done and waiting for you to verify it.' }
      : { reason: 'waiting_merge', why: 'It’s done, but its pull request hasn’t merged yet.' };
  }
  if (openQuestion) {
    return { reason: 'waiting_on_owner', why: 'It’s waiting for your answer to a question.' };
  }
  if (item.status === 'review' && item.human_review.ready > 0) {
    return { reason: 'waiting_on_owner', why: 'Its review packet is ready for you.' };
  }
  if (item.lead?.run_state === 'parked') {
    return {
      reason: 'parked',
      why: `Its agent is parked, waiting on ${parkedOn(input.parkedOn)}.`,
    };
  }
  if (item.lead) {
    return item.lead.run_state === 'stale'
      ? { reason: 'active', why: 'Its agent has gone quiet. Check on it.' }
      : { reason: 'active', why: 'An agent is working on it.' };
  }
  if (item.status === 'ready' && input.readyWait) {
    // With no blocker and no lead, only the owner's overlap or design review is left.
    return { reason: 'waiting_on_owner', why: `It’s waiting on ${input.readyWait}.` };
  }
  if (item.status === 'ready') {
    return {
      reason: 'startable',
      why: 'It’s ready, nothing blocks it and nobody has started it. Start it next.',
    };
  }
  return item.status === 'inbox' || item.status === 'planning'
    ? { reason: 'unowned', why: 'Nobody owns it yet. Shape it or assign it.' }
    : { reason: 'unowned', why: 'Nobody is working on it now. Assign it.' };
}

// ---- The read ----

const isClosed = (status: string) => status === 'done' || status === 'canceled';

export function criticalPath(
  ctx: { db: Db; windows: RunWindows; now: string; parkMaxMs: number },
  id: string,
): CriticalPathResponse {
  const { db } = ctx;
  const goalRow = requireItem(db, id);
  const kind = goalRow.type === 'Epic' ? ('epic' as const) : ('ticket' as const);
  const goal = { id: goalRow.id, title: goalRow.title, kind };
  const empty = { goal, chain: [], links: [], next: null, cycles: [], open_blockers: 0 };
  if (isClosed(goalRow.status)) return { ...empty, state: 'finished' };

  const index = new BlockIndex(db);
  const memo = new Map<string, readonly string[]>();
  const blockersOf = (x: string) => {
    let b = memo.get(x);
    if (!b) memo.set(x, (b = index.state(x).blocked_by));
    return b;
  };
  let targets: string[] = [goalRow.id];
  if (kind === 'epic') {
    const children = (
      db.sqlite
        .prepare(`SELECT id FROM items WHERE epic_id = ? AND status NOT IN ('done', 'canceled')`)
        .all(goalRow.id) as { id: string }[]
    ).map((c) => c.id);
    targets = blockersOf(goalRow.id).length > 0 ? [goalRow.id, ...children] : children;
    if (targets.length === 0) return { ...empty, state: 'clear' };
  }

  const upstream = [...upstreamOf(targets, blockersOf)];
  const json = JSON.stringify(upstream);
  const rows = new Map(
    (
      db.sqlite
        .prepare('SELECT * FROM items WHERE id IN (SELECT value FROM json_each(?))')
        .all(json) as ItemRow[]
    ).map((r) => [r.id, r]),
  );
  const ready = readyStates(
    db,
    index,
    upstream.filter((x) => rows.get(x)?.status === 'ready'),
  );
  const startable = (x: string) => ready.get(x)?.startable === true;
  const better = (a: string, b: string) =>
    Number(startable(b)) - Number(startable(a)) ||
    (rows.get(a)?.priority ?? 9) - (rows.get(b)?.priority ?? 9);

  const chain = longestChain({ targets, blockersOf, better });
  const present = chain.ids.filter((x) => rows.has(x));
  const summaries = new Map(
    summarize(
      { ...ctx, index },
      present.map((x) => rows.get(x)!),
    ).map((s) => [s.id, s]),
  );
  // Decision 57: each step's Queued, Blocked or Held, by the one classification.
  const kinds = waitKindsOf(db, ctx.now, index, ctx);
  const steps = present.map((x) => {
    const wait = kinds.of(x);
    return { item: summaries.get(x)!, in_cycle: chain.inCycle.has(x), ...(wait ? { wait } : {}) };
  });

  const links: LinkEdge[] = [];
  for (let i = 1; i < present.length; i += 1) {
    const link = index.blockers.get(present[i]!)?.find((l) => l.from_id === present[i - 1]);
    if (!link) continue;
    links.push({
      link_id: link.id,
      from: link.from_id,
      to: link.to_id,
      type: 'blocks',
      satisfied_when: link.satisfied_when,
      cleared: false,
    });
  }

  const head = steps[0]?.item ?? null;
  let next: CriticalPathResponse['next'] = null;
  if (head) {
    const holds = present[1] ?? null;
    const link = holds ? index.blockers.get(holds)?.find((l) => l.from_id === head.id) : undefined;
    const question = db.sqlite
      .prepare(
        'SELECT 1 FROM questions WHERE item_id = ? AND answered_at IS NULL AND withdrawn_at IS NULL LIMIT 1',
      )
      .get(head.id);
    const run = head.lead
      ? (db.sqlite.prepare('SELECT waiting_on FROM runs WHERE id = ?').get(head.lead.run_id) as
          { waiting_on: string | null } | undefined)
      : undefined;
    const loop = chain.inCycle.has(head.id)
      ? (chain.cycles.find((c) => c.includes(head.id)) ?? [])
      : [];
    next = {
      id: head.id,
      ...nextReason({
        item: head,
        inCycle: loop,
        waitingFor: link ? index.waitingFor(link) : null,
        holds,
        openQuestion: !!question,
        readyWait: ready.get(head.id)?.waiting_on ?? null,
        parkedOn: parseJson<WaitingOn>(run?.waiting_on),
      }),
    };
  }

  // Anything that blocks something here, so one child of an epic can block another.
  const open_blockers = new Set(upstream.flatMap((x) => blockersOf(x))).size;
  return {
    goal,
    state: open_blockers > 0 ? 'blocked' : 'clear',
    chain: steps,
    links,
    next,
    cycles: chain.cycles,
    open_blockers,
  };
}

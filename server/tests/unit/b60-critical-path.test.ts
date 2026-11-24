/**
 * B60 (owner decision 48): which chain is the critical path, how ties break,
 * what a cycle does, and why a ticket is the one to move next. Uses the real
 * blocker evaluator for the read, and made-up tickets only.
 */
import type { ItemSummary } from '@docket/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { criticalPath, longestChain, nextReason } from '../../src/domain/critical-path.js';
import { windowsOf } from '../../src/domain/model.js';
import type { Actor } from '../../src/domain/write.js';
import { startDomain, withoutRelease, type Domain } from '../us1-helpers.js';

/** `edges` as blocker → blocked. */
function graph(edges: [string, string][]) {
  const up = new Map<string, string[]>();
  for (const [from, to] of edges) up.set(to, [...(up.get(to) ?? []), from]);
  return (id: string) => up.get(id) ?? [];
}
const byId = () => 0;

describe('longestChain', () => {
  it('picks the longest of two chains, first ticket first', () => {
    const blockersOf = graph([
      ['T-1', 'T-2'],
      ['T-2', 'T-3'],
      ['T-3', 'G-1'],
      ['T-9', 'G-1'],
    ]);
    const { ids } = longestChain({ targets: ['G-1'], blockersOf, better: byId });
    expect(ids).toEqual(['T-1', 'T-2', 'T-3', 'G-1']);
  });

  it('returns just the goal when nothing blocks it', () => {
    const { ids, cycles } = longestChain({ targets: ['G-1'], blockersOf: () => [], better: byId });
    expect(ids).toEqual(['G-1']);
    expect(cycles).toEqual([]);
  });

  it('breaks a tie with `better`, then the lower ID', () => {
    const blockersOf = graph([
      ['T-5', 'G-1'],
      ['T-2', 'G-1'],
    ]);
    expect(longestChain({ targets: ['G-1'], blockersOf, better: byId }).ids[0]).toBe('T-2');
    const preferFive = (a: string, b: string) => Number(b === 'T-5') - Number(a === 'T-5');
    expect(longestChain({ targets: ['G-1'], blockersOf, better: preferFive }).ids[0]).toBe('T-5');
  });

  it('gives the same answer whatever order the links come in', () => {
    const edges: [string, string][] = [
      ['T-1', 'T-3'],
      ['T-2', 'T-3'],
      ['T-3', 'G-1'],
      ['T-4', 'G-1'],
    ];
    const a = longestChain({ targets: ['G-1'], blockersOf: graph(edges), better: byId });
    const b = longestChain({
      targets: ['G-1'],
      blockersOf: graph([...edges].reverse()),
      better: byId,
    });
    expect(a.ids).toEqual(b.ids);
  });

  it('survives a cycle, counts its members and reports it', () => {
    const blockersOf = graph([
      ['T-1', 'T-2'],
      ['T-2', 'T-1'],
      ['T-2', 'G-1'],
      ['T-7', 'G-1'],
    ]);
    const chain = longestChain({ targets: ['G-1'], blockersOf, better: byId });
    expect(chain.ids).toEqual(['T-1', 'T-2', 'G-1']);
    expect([...chain.inCycle].sort()).toEqual(['T-1', 'T-2']);
    expect(chain.cycles).toEqual([['T-1', 'T-2']]);
  });

  it('handles a goal inside a cycle', () => {
    const blockersOf = graph([
      ['G-1', 'T-1'],
      ['T-1', 'G-1'],
    ]);
    const chain = longestChain({ targets: ['G-1'], blockersOf, better: byId });
    expect(new Set(chain.ids)).toEqual(new Set(['G-1', 'T-1']));
  });

  it('walks a chain far deeper than the call stack, quickly', () => {
    const edges: [string, string][] = [];
    for (let i = 1; i < 20_000; i += 1) edges.push([`T-${i}`, `T-${i + 1}`]);
    const started = performance.now();
    const { ids } = longestChain({
      targets: ['T-20000'],
      blockersOf: graph(edges),
      better: byId,
    });
    expect(ids).toHaveLength(20_000);
    expect(ids[0]).toBe('T-1');
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe('nextReason', () => {
  const item = (over: Partial<ItemSummary>): ItemSummary =>
    ({
      id: 'T-1',
      status: 'ready',
      lead: null,
      human_review: { declared: 0, ready: 0, approved: 0, deferred: 0 },
      ...over,
    }) as ItemSummary;
  const base = {
    inCycle: [] as string[],
    waitingFor: null,
    holds: 'T-2',
    openQuestion: false,
    parkedOn: null,
  };
  const lead = (run_state: string) =>
    ({ client: 'claude', label: null, run_id: 'run_1', run_state }) as ItemSummary['lead'];

  it.each([
    ['ready and free', item({}), base, 'startable'],
    ['inbox', item({ status: 'inbox' }), base, 'unowned'],
    ['planning', item({ status: 'planning' }), base, 'unowned'],
    ['in progress with nobody on it', item({ status: 'progress' }), base, 'unowned'],
    ['an agent on it', item({ status: 'progress', lead: lead('live') }), base, 'active'],
    ['parked', item({ status: 'progress', lead: lead('parked') }), base, 'parked'],
    [
      'an open question',
      item({ status: 'progress' }),
      { ...base, openQuestion: true },
      'waiting_on_owner',
    ],
    [
      'a packet ready',
      item({
        status: 'review',
        human_review: { declared: 0, ready: 1, approved: 0, deferred: 0 },
      }),
      base,
      'waiting_on_owner',
    ],
    [
      'done, needs verification',
      item({ status: 'done' }),
      { ...base, waitingFor: 'verification' as const },
      'waiting_on_owner',
    ],
    [
      'done, needs a merge',
      item({ status: 'done' }),
      { ...base, waitingFor: 'merge' as const },
      'waiting_merge',
    ],
    ['canceled', item({ status: 'canceled' }), base, 'canceled'],
    ['in a cycle', item({}), { ...base, inCycle: ['T-1', 'T-2'] }, 'cycle'],
  ])('%s', (_name, it_, input, reason) => {
    const out = nextReason({ item: it_, ...input });
    expect(out.reason).toBe(reason);
    expect(out.why).toMatch(/[.]$/);
  });

  it.each(['your overlap decision', 'your design review'])(
    'a Ready ticket held by %s waits on the owner, and is not startable',
    (readyWait) => {
      const out = nextReason({ item: item({}), ...base, readyWait });
      expect(out.reason).toBe('waiting_on_owner');
      expect(out.why).toBe(`It’s waiting on ${readyWait}.`);
    },
  );

  it('says what a parked agent is waiting on, in words', () => {
    const out = nextReason({
      item: item({ status: 'progress', lead: lead('parked') }),
      ...base,
      parkedOn: { orchestrator: true },
    });
    expect(out.why).toBe('Its agent is parked, waiting on its coordinator.');
  });
});

describe('the read', () => {
  let d: Domain;
  const planner: Actor = {
    kind: 'agent',
    client: 'claude',
    label: 'planner',
    session_id: 'sess-planner',
    run_id: null,
  };
  beforeEach(() => {
    d = startDomain();
  });
  afterEach(() => d.cleanup());

  const make = (type: 'Epic' | 'Task', title: string, epic?: string, priority: 1 | 2 | 3 = 2) => {
    const id = d.write(planner, (w, s) =>
      s.items.create(w, {
        project: 'RCP',
        type,
        title,
        priority,
        status: 'planning',
        ...(epic ? { epic } : {}),
      }),
    ).id;
    // Decision 67: these tests count tickets as before every epic had a Release.
    if (type === 'Epic') withoutRelease(d, id);
    return id;
  };
  const blocks = (from: string, to: string) =>
    d.write(planner, (w, s) => s.links.link(w, { from, to, type: 'blocks' }));
  const setStatus = (id: string, status: string) =>
    d.sql.prepare('UPDATE items SET status = ? WHERE id = ?').run(status, id);
  const read = (id: string) =>
    criticalPath(
      {
        db: d.server.runtime.db,
        windows: windowsOf(d.server.runtime.config),
        now: d.clock.now().toISOString(),
        parkMaxMs: d.server.runtime.config.parkMaxMs,
      },
      id,
    );

  it('finds the chain to a ticket and names the first as next', () => {
    const [a, b, c] = [make('Task', 'First'), make('Task', 'Second'), make('Task', 'Goal')];
    blocks(a, b);
    blocks(b, c);
    setStatus(a, 'ready');
    const out = read(c);
    expect(out.state).toBe('blocked');
    expect(out.chain.map((s) => s.item.id)).toEqual([a, b, c]);
    expect(out.links.map((l) => [l.from, l.to])).toEqual([
      [a, b],
      [b, c],
    ]);
    expect(out.next).toMatchObject({ id: a, reason: 'startable' });
    expect(out.open_blockers).toBe(2);
  });

  it('prefers a chain that can start now, then the higher priority', () => {
    const goal = make('Task', 'Goal');
    const low = make('Task', 'Can start, low priority', undefined, 3);
    const high = make('Task', 'Can start, high priority', undefined, 1);
    const shaped = make('Task', 'Not shaped yet', undefined, 1);
    for (const x of [low, high, shaped]) blocks(x, goal);
    setStatus(low, 'ready');
    setStatus(high, 'ready');
    expect(read(goal).next?.id).toBe(high);
  });

  it('skips a blocker that already cleared', () => {
    const [a, b, c] = [make('Task', 'Done'), make('Task', 'Open'), make('Task', 'Goal')];
    blocks(a, b);
    blocks(b, c);
    setStatus(a, 'done');
    setStatus(b, 'ready');
    expect(read(c).chain.map((s) => s.item.id)).toEqual([b, c]);
  });

  it('follows a canceled blocker, which never clears', () => {
    const [a, b] = [make('Task', 'Canceled'), make('Task', 'Goal')];
    blocks(a, b);
    setStatus(a, 'canceled');
    expect(read(b).next).toMatchObject({ id: a, reason: 'canceled' });
  });

  it('reads an epic through its open children', () => {
    const epic = make('Epic', 'Goal epic');
    const child = make('Task', 'Child', epic);
    const blocker = make('Task', 'Outside blocker');
    const finished = make('Task', 'Finished child', epic);
    blocks(blocker, child);
    setStatus(blocker, 'ready');
    setStatus(finished, 'done');
    const out = read(epic);
    expect(out.goal.kind).toBe('epic');
    expect(out.chain.map((s) => s.item.id)).toEqual([blocker, child]);
    expect(out.next?.id).toBe(blocker);
  });

  it('counts one child of an epic blocking another as blocked', () => {
    const epic = make('Epic', 'Goal epic');
    const first = make('Task', 'First child', epic);
    const second = make('Task', 'Second child', epic);
    blocks(first, second);
    setStatus(first, 'ready');
    const out = read(epic);
    expect(out.state).toBe('blocked');
    expect(out.open_blockers).toBe(1);
    expect(out.chain.map((s) => s.item.id)).toEqual([first, second]);
  });

  it('says a finished goal needs nothing, and an open one with no blockers is clear', () => {
    const done = make('Task', 'Done');
    setStatus(done, 'done');
    expect(read(done)).toMatchObject({ state: 'finished', chain: [], next: null });
    const free = make('Task', 'Free');
    setStatus(free, 'ready');
    expect(read(free)).toMatchObject({ state: 'clear', next: { id: free, reason: 'startable' } });
  });

  it('writes nothing', () => {
    const [a, b] = [make('Task', 'A'), make('Task', 'B')];
    blocks(a, b);
    const events = () =>
      (d.sql.prepare('SELECT count(*) AS n FROM events').get() as { n: number }).n;
    const before = events();
    read(b);
    expect(events()).toBe(before);
  });
});

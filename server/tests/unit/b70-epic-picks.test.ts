/**
 * B70 (owner decision 54): Pick next epic. Each number on the real blocker
 * evaluator, then the order and the Best next reason. Synthetic tickets only.
 */
import { join } from 'node:path';
import type { EpicPick } from '@docket/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadSampleSeed } from '../../src/db/seed/loader.js';
import {
  bestReason,
  compareEpicPicks,
  epicWaits,
  parkReason,
  pickEpics,
} from '../../src/domain/epic-picks.js';
import { BlockIndex } from '../../src/domain/model.js';
import { readyStates } from '../../src/domain/next-work.js';
import type { Actor } from '../../src/domain/write.js';
import {
  addProject,
  forceStatus,
  startDomain,
  withoutRelease,
  type Domain,
} from '../us1-helpers.js';

const OWNER: Actor = { kind: 'owner', client: null, label: null, session_id: null, run_id: null };

let d: Domain;
let planner: Actor;

beforeEach(() => {
  d = startDomain({ seed: false, now: new Date('2026-11-24T08:00:00.000Z') });
  addProject(d, 'TST');
  planner = d.agent('codex', { label: 'planner' });
});
afterEach(() => d.cleanup());

const make = (type: 'Epic' | 'Task', title: string, epic?: string, status = 'ready') => {
  const { id } = d.write(planner, (w, s) =>
    s.items.create(w, {
      project: 'TST',
      type,
      title,
      priority: 2,
      status: 'planning',
      ...(epic ? { epic } : {}),
    }),
  );
  if (status !== 'planning') forceStatus(d, id, status);
  // Decision 67: these tests count tickets as before every epic had a Release.
  if (type === 'Epic') withoutRelease(d, id);
  return id;
};
const epic = (title: string) => make('Epic', title, undefined, 'progress');
const blocks = (from: string, to: string) =>
  d.write(planner, (w, s) => s.links.link(w, { from, to, type: 'blocks' }));
/** A link the service would refuse, for a loop that got in some other way. */
const forceBlocks = (from: string, to: string) => {
  const at = d.clock.now().toISOString();
  d.sql
    .prepare(
      `INSERT INTO links (id, from_id, to_id, type, created_by, created_at, updated_at)
       VALUES (?, ?, ?, 'blocks', 'test', ?, ?)`,
    )
    .run(`lnk_${from}_${to}`, from, to, at, at);
};
const read = (project = 'TST') =>
  pickEpics(
    { db: d.server.runtime.db, now: d.clock.now().toISOString(), parkMaxMs: 24 * 3_600_000 },
    project,
  );
const row = (id: string, project = 'TST') => read(project).epics.find((e) => e.id === id)!;

describe('can finish on its own', () => {
  it('counts every ticket when the whole chain stays inside the epic', () => {
    const e = epic('Inside');
    const [a, b, c] = [make('Task', 'A', e), make('Task', 'B', e), make('Task', 'C', e)];
    blocks(a, b);
    blocks(b, c);
    expect(row(e)).toMatchObject({ open: 3, self_contained: 3, waits_on: [] });
  });

  it('follows a chain through this epic to a blocker outside it', () => {
    const [e, other] = [epic('Mine'), epic('Other')];
    const outside = make('Task', 'Outside', other);
    const [a, b, free] = [make('Task', 'A', e), make('Task', 'B', e), make('Task', 'Free', e)];
    blocks(outside, a);
    blocks(a, b);
    expect(row(e).self_contained).toBe(1);
    expect(row(e).waits_on).toEqual([{ epic: other, title: 'Other', tickets: 1 }]);
    expect(free).toBeTruthy();
  });

  it('follows a transitive chain across epics, counting each ticket once', () => {
    const [e, mid, far] = [epic('Mine'), epic('Middle'), epic('Far')];
    const [x, y] = [make('Task', 'Far one', far), make('Task', 'Far two', far)];
    const m = make('Task', 'Middle one', mid);
    const [a, b] = [make('Task', 'A', e), make('Task', 'B', e)];
    blocks(x, m);
    blocks(y, m);
    blocks(m, a);
    blocks(m, b);
    expect(row(e).self_contained).toBe(0);
    expect(row(e).waits_on).toEqual([
      { epic: far, title: 'Far', tickets: 2 },
      { epic: mid, title: 'Middle', tickets: 1 },
    ]);
  });

  it('lists blockers with no epic last, as "no epic"', () => {
    const [e, other] = [epic('Mine'), epic('Other')];
    const a = make('Task', 'A', e);
    blocks(make('Task', 'Loose', undefined), a);
    blocks(make('Task', 'In other', other), a);
    expect(row(e).waits_on).toEqual([
      { epic: other, title: 'Other', tickets: 1 },
      { epic: null, title: null, tickets: 1 },
    ]);
  });

  it('ignores a cleared blocker', () => {
    const [e, other] = [epic('Mine'), epic('Other')];
    const done = make('Task', 'Done', other, 'done');
    blocks(done, make('Task', 'A', e));
    expect(row(e)).toMatchObject({ self_contained: 1, waits_on: [] });
  });

  it('counts a canceled blocker, which never clears', () => {
    const [e, other] = [epic('Mine'), epic('Other')];
    const canceled = make('Task', 'Canceled', other);
    blocks(canceled, make('Task', 'A', e));
    forceStatus(d, canceled, 'canceled');
    expect(row(e).self_contained).toBe(0);
    expect(row(e).waits_on).toEqual([{ epic: other, title: 'Other', tickets: 1 }]);
  });

  it('counts a done blocker whose link still needs its merge', () => {
    const [e, other] = [epic('Mine'), epic('Other')];
    const done = make('Task', 'Unmerged', other);
    const a = make('Task', 'A', e);
    d.write(planner, (w, s) =>
      s.links.link(w, { from: done, to: a, type: 'blocks', satisfied_when: 'merged' }),
    );
    forceStatus(d, done, 'done');
    expect(row(e).self_contained).toBe(0);
  });

  it('treats a blocker on the epic as holding every ticket in it', () => {
    const [e, other] = [epic('Mine'), epic('Other')];
    make('Task', 'A', e);
    make('Task', 'B', e);
    const blocker = make('Task', 'Prerequisite', other);
    blocks(blocker, e);
    expect(row(e).self_contained).toBe(0);
    expect(row(e).waits_on).toEqual([{ epic: other, title: 'Other', tickets: 1 }]);
  });

  it('reads waiting on an epic as waiting on its open tickets', () => {
    const [e, other] = [epic('Mine'), epic('Other')];
    make('Task', 'A', e);
    make('Task', 'One', other);
    make('Task', 'Two', other);
    make('Task', 'Finished', other, 'done');
    blocks(other, e);
    expect(row(e).waits_on).toEqual([{ epic: other, title: 'Other', tickets: 2 }]);
  });

  it('survives a cycle inside an epic, and one across epics', () => {
    const [e, other] = [epic('Mine'), epic('Other')];
    const [a, b] = [make('Task', 'A', e), make('Task', 'B', e)];
    blocks(a, b);
    forceBlocks(b, a);
    expect(row(e)).toMatchObject({ self_contained: 2, waits_on: [] });
    const o = make('Task', 'O', other);
    blocks(o, a);
    forceBlocks(a, o);
    expect(row(e).self_contained).toBe(0);
    expect(row(other).self_contained).toBe(0);
    expect(row(e).unblocks_elsewhere).toBe(1);
    expect(row(other).unblocks_elsewhere).toBe(2);
  });
});

describe('can start now', () => {
  it('lists Ready tickets with no open blocker, and the first few only', () => {
    const e = epic('Mine');
    const tickets = ['A', 'B', 'C', 'D'].map((t) => make('Task', t, e));
    const blocked = make('Task', 'Blocked', e);
    blocks(tickets[0]!, blocked);
    make('Task', 'Inbox', e, 'inbox');
    const out = row(e);
    expect(out.can_start.count).toBe(4);
    expect(out.can_start.first.map((t) => t.id)).toEqual(tickets.slice(0, 3));
  });

  it('uses the same Startable rule as Work: a claimed ticket can’t start', () => {
    const e = epic('Mine');
    const a = make('Task', 'A', e);
    make('Task', 'B', e);
    d.write(d.agent('claude', { label: 'worker' }), (w, s) => s.runs.claim(w, { id: a }));
    expect(row(e).can_start.count).toBe(1);
  });

  it('still counts from dependencies in a paused project, unlike Work', () => {
    const e = epic('Mine');
    const a = make('Task', 'A', e);
    d.write(OWNER, (w, s) => s.projects.pause(w, { key: 'TST', reason: 'A synthetic pause.' }));
    const out = read();
    expect(out.paused).toBe(true);
    expect(out.epics[0]!.can_start.count).toBe(1);
    expect(out.best?.reason).toContain('once you resume the project');
    // Work's own Startable answer doesn't change.
    const db = d.server.runtime.db;
    expect(readyStates(db, new BlockIndex(db), [a]).get(a)?.startable).toBe(false);
  });
});

describe('unblocks elsewhere', () => {
  it('counts distinct open tickets in other epics, directly or further down', () => {
    const [e, x, y] = [epic('Mine'), epic('X'), epic('Y')];
    const a = make('Task', 'A', e);
    const [x1, y1] = [make('Task', 'X one', x), make('Task', 'Y one', y)];
    blocks(a, x1);
    blocks(x1, y1);
    blocks(a, y1);
    make('Task', 'Unrelated', y);
    expect(row(e).unblocks_elsewhere).toBe(2);
  });

  it('walks through a ticket with no epic, without counting it', () => {
    const [e, x] = [epic('Mine'), epic('X')];
    const a = make('Task', 'A', e);
    const loose = make('Task', 'Loose');
    blocks(a, loose);
    blocks(loose, make('Task', 'X one', x));
    expect(row(e).unblocks_elsewhere).toBe(1);
  });

  it('leaves out its own tickets, closed tickets and a canceled source', () => {
    const [e, x] = [epic('Mine'), epic('X')];
    const a = make('Task', 'A', e);
    blocks(a, make('Task', 'Sibling', e));
    const closed = make('Task', 'Closed', x);
    blocks(a, closed);
    forceStatus(d, closed, 'done');
    const dropped = make('Task', 'Dropped', e);
    blocks(dropped, make('Task', 'Waits on the canceled ticket', x));
    forceStatus(d, dropped, 'canceled');
    expect(row(e).unblocks_elsewhere).toBe(0);
  });
});

describe('a closed ticket', () => {
  it('doesn’t pass its epic’s blocker on to what still waits for its merge', () => {
    const [e, f, g] = [epic('Mine'), epic('Blocked epic'), epic('Downstream')];
    const a = make('Task', 'A', e);
    const closed = make('Task', 'Done, unmerged', f);
    const later = make('Task', 'Waits for the merge', g);
    blocks(a, f);
    d.write(planner, (w, s) =>
      s.links.link(w, { from: closed, to: later, type: 'blocks', satisfied_when: 'merged' }),
    );
    forceStatus(d, closed, 'done');
    expect(row(e).unblocks_elsewhere).toBe(0);
  });
});

describe('not shaped and being worked', () => {
  it('counts Inbox and Planning tickets', () => {
    const e = epic('Mine');
    make('Task', 'A', e, 'inbox');
    make('Task', 'B', e, 'planning');
    make('Task', 'C', e);
    expect(row(e).not_shaped).toBe(2);
  });

  it('names a live lead on one of its tickets', () => {
    const e = epic('Mine');
    const a = make('Task', 'A', e);
    make('Task', 'B', e);
    d.write(d.agent('claude', { label: 'worker' }), (w, s) => s.runs.claim(w, { id: a }));
    expect(row(e)).toMatchObject({
      fit: 'being_worked',
      worked_by: [{ who: 'claude · worker', role: 'lead', items: [a] }],
    });
  });

  it('names the producer when the lead has one', () => {
    const e = epic('Mine');
    const a = make('Task', 'A', e);
    d.write(d.agent('claude', { label: 'worker' }), (w, s) =>
      s.runs.claim(w, { id: a, producer: 'producer-7' }),
    );
    expect(row(e).worked_by).toEqual([{ who: 'producer-7', role: 'producer', items: [a] }]);
  });

  it('counts a producer holding a ticket between workers, until the hold ends', () => {
    const e = epic('Mine');
    const a = make('Task', 'A', e);
    make('Task', 'B', e);
    d.write(d.agent('claude', { label: 'worker' }), (w, s) =>
      s.runs.claim(w, { id: a, producer: 'producer-7' }),
    );
    const until = new Date(d.clock.now().getTime() + 60_000).toISOString();
    d.sql
      .prepare("UPDATE runs SET state = 'finished', producer_hold_until = ? WHERE item_id = ?")
      .run(until, a);
    forceStatus(d, a, 'progress');
    expect(row(e).worked_by).toEqual([{ who: 'producer-7', role: 'producer', items: [a] }]);
    d.sql
      .prepare('UPDATE runs SET producer_hold_until = ? WHERE item_id = ?')
      .run('2026-11-24T07:00:00.000Z', a);
    expect(row(e).worked_by).toEqual([]);
  });

  it('doesn’t count a lead whose lease ran out', () => {
    const e = epic('Mine');
    const a = make('Task', 'A', e);
    make('Task', 'B', e);
    d.write(d.agent('claude', { label: 'worker' }), (w, s) => s.runs.claim(w, { id: a }));
    d.sql
      .prepare('UPDATE runs SET lease_expires_at = ? WHERE item_id = ?')
      .run('2026-11-24T07:00:00.000Z', a);
    expect(row(e).worked_by).toEqual([]);
  });
});

describe('the list', () => {
  it('leaves out closed, archived and empty epics, and other projects', () => {
    const live = epic('Live');
    make('Task', 'A', live);
    epic('Empty');
    const closed = epic('Closed');
    make('Task', 'B', closed);
    forceStatus(d, closed, 'done');
    const archived = epic('Archived');
    make('Task', 'C', archived);
    d.sql.prepare('UPDATE items SET archived_at = ? WHERE id = ?').run('2026-11-01', archived);
    addProject(d, 'OTH');
    expect(read().epics.map((e) => e.id)).toEqual([live]);
    expect(read('OTH')).toMatchObject({ epics: [], best: null });
  });

  it('leaves archived tickets out of the counts', () => {
    const e = epic('Mine');
    make('Task', 'A', e);
    const old = make('Task', 'Old', e);
    d.sql.prepare('UPDATE items SET archived_at = ? WHERE id = ?').run('2026-11-01', old);
    expect(row(e).open).toBe(1);
  });

  it('refuses an unknown project', () => {
    expect(() => read('NOPE')).toThrow(/No project NOPE/);
  });

  it('stays fast on the 300-item stress project', () => {
    const big = startDomain({ seed: false, now: new Date('2026-11-24T08:00:00.000Z') });
    try {
      const { db, config } = big.server.runtime;
      loadSampleSeed(db, {
        now: big.clock.now(),
        docsDir: join(config.paths.docs),
        stress: true,
      });
      const started = performance.now();
      const out = pickEpics(
        { db, now: big.clock.now().toISOString(), parkMaxMs: 24 * 3_600_000 },
        'STR',
      );
      expect(performance.now() - started).toBeLessThan(1000);
      expect(out.epics.length).toBeGreaterThan(0);
      for (const e of out.epics) {
        expect(e.self_contained).toBeLessThanOrEqual(e.open);
        expect(e.can_start.count).toBeLessThanOrEqual(e.open);
      }
    } finally {
      big.cleanup();
    }
  });
});

describe('order, fit and the Best next reason', () => {
  const pick = (over: Partial<EpicPick>): EpicPick => ({
    id: 'E-1',
    title: 'Epic',
    status: 'progress',
    priority: 2,
    open: 4,
    self_contained: 4,
    can_start: { count: 1, first: [] },
    waits_on: [],
    unblocks_elsewhere: 0,
    not_shaped: 0,
    waiting: { queued: 0, blocked: 0 },
    worked_by: [],
    fit: 'available',
    park_reason: null,
    ...over,
  });
  const order = (...rows: EpicPick[]) => [...rows].sort(compareEpicPicks).map((r) => r.id);

  it('puts an epic nobody holds first', () => {
    const held = pick({
      id: 'E-1',
      unblocks_elsewhere: 9,
      worked_by: [{ who: 'x', role: 'lead', items: [] }],
    });
    expect(order(held, pick({ id: 'E-2' }))).toEqual(['E-2', 'E-1']);
  });

  it('then one with something to start', () => {
    const none = pick({ id: 'E-1', can_start: { count: 0, first: [] }, unblocks_elsewhere: 9 });
    expect(order(none, pick({ id: 'E-2' }))).toEqual(['E-2', 'E-1']);
  });

  it('then fully, then mostly self-contained', () => {
    const full = pick({ id: 'E-3' });
    const mostly = pick({ id: 'E-2', self_contained: 3, unblocks_elsewhere: 9 });
    const little = pick({ id: 'E-1', self_contained: 1, unblocks_elsewhere: 20 });
    expect(order(little, mostly, full)).toEqual(['E-3', 'E-2', 'E-1']);
  });

  it('then the most unblocked elsewhere, then priority and ID', () => {
    const more = pick({ id: 'E-3', unblocks_elsewhere: 5 });
    const high = pick({ id: 'E-2', priority: 1 });
    const low = pick({ id: 'E-1', priority: 3 });
    expect(order(low, high, more)).toEqual(['E-3', 'E-2', 'E-1']);
  });

  it('says why an epic would park', () => {
    const base = { open: 4, self_contained: 4, not_shaped: 0, canStart: 2 };
    expect(parkReason(base)).toBeNull();
    expect(parkReason({ ...base, self_contained: 2 })).toBeNull();
    expect(parkReason({ ...base, self_contained: 1 })).toBe(
      'Most tickets wait on other work: 3 of 4 depend on something outside this epic.',
    );
    expect(parkReason({ ...base, canStart: 0, self_contained: 3 })).toBe(
      'Nothing can start: 1 of 4 tickets waits on work outside this epic.',
    );
    expect(parkReason({ ...base, canStart: 0, not_shaped: 3 })).toBe(
      'Nothing can start: 3 of 4 tickets still need shaping.',
    );
    expect(parkReason({ ...base, canStart: 0 })).toMatch(/already moving or waiting on you/);
  });

  it('words the reason from what is true', () => {
    expect(bestReason(pick({ unblocks_elsewhere: 27 }), false)).toBe(
      'Nothing outside this epic blocks it, and finishing it unblocks 27 tickets.',
    );
    expect(bestReason(pick({ unblocks_elsewhere: 1 }), false)).toBe(
      'Nothing outside this epic blocks it, and finishing it unblocks 1 ticket.',
    );
    expect(bestReason(pick({ can_start: { count: 3, first: [] } }), false)).toBe(
      'Nothing outside this epic blocks it, and 3 tickets can start now.',
    );
    expect(bestReason(pick({ self_contained: 3, unblocks_elsewhere: 2 }), false)).toBe(
      '3 of 4 tickets can finish without other work, and finishing it unblocks 2 tickets.',
    );
  });

  it('marks the top available epic, skipping held and parking ones', () => {
    const [held, parks, good] = [epic('Held'), epic('Parks'), epic('Good')];
    const h = make('Task', 'H', held);
    make('Task', 'H2', held);
    make('Task', 'P', parks, 'inbox');
    make('Task', 'G', good);
    d.write(d.agent('claude', { label: 'worker' }), (w, s) => s.runs.claim(w, { id: h }));
    const out = read();
    expect(out.best?.id).toBe(good);
    // Nobody holds the one that parks, so it sorts above the held one; the page groups them.
    expect(out.epics.map((e) => e.fit)).toEqual(['available', 'likely_parks', 'being_worked']);
    expect(out.epics[1]!.park_reason).toContain('still needs shaping');
  });

  it('has no Best next when no epic qualifies', () => {
    make('Task', 'Waiting', epic('Parks'), 'inbox');
    expect(read().best).toBeNull();
  });
});

describe('the indicator', () => {
  it('is on open epics with open tickets only', () => {
    const [clear, waits, empty, closed] = [
      epic('Clear'),
      epic('Waits'),
      epic('Empty'),
      epic('Closed'),
    ];
    make('Task', 'A', clear);
    const b = make('Task', 'B', waits);
    blocks(make('Task', 'Elsewhere', clear), b);
    make('Task', 'C', closed);
    forceStatus(d, closed, 'done');
    const db = d.server.runtime.db;
    const out = epicWaits(db, new BlockIndex(db), [clear, waits, empty, closed]);
    expect(out.get(clear)).toEqual([]);
    expect(out.get(waits)).toEqual([{ epic: clear, title: 'Clear', tickets: 1 }]);
    expect(out.has(empty)).toBe(false);
    expect(out.has(closed)).toBe(false);
  });

  it('reaches the Work response and the epic page', () => {
    const [e, other] = [epic('Mine'), epic('Other')];
    const a = make('Task', 'A', e);
    blocks(make('Task', 'O', other), a);
    const r = d.read(OWNER);
    const work = d.services.views.work(r, {
      scope: 'TST',
      layout: 'board',
    } as Parameters<typeof d.services.views.work>[1]);
    expect(work.epics.find((x) => x.id === e)?.waits_on).toEqual([
      { epic: other, title: 'Other', tickets: 1 },
    ]);
    expect(d.services.views.itemDetail(r, { id: e }).epic_waits).toEqual([
      { epic: other, title: 'Other', tickets: 1 },
    ]);
    expect(d.services.views.itemDetail(r, { id: a }).epic_waits).toBeUndefined();
  });
});

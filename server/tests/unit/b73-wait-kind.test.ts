/**
 * Queued instead of Blocked (owner decision 57; BUILD_SPEC §5.39): each
 * Blocked reason against Queued, chains, loops, canceled blockers, a held
 * decision, a paused project, the nearest-blocker text, and the counts every
 * view shows agreeing. Display only: claiming still refuses an open blocker.
 * All content is synthetic.
 */
import { renderContext, renderResult, type ItemWait } from '@docket/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BlockIndex } from '../../src/domain/model.js';
import { WaitKinds } from '../../src/domain/wait-kind.js';
import { OWNER_ACTOR, type Actor } from '../../src/domain/write.js';
import { askForm } from '../helpers.js';
import { addProject, forceStatus, minutes, startDomain, type Domain } from '../us1-helpers.js';

const PENDING = 'This needs an owner decision on the scope.';
const HOUR = 60 * minutes(1);

let d: Domain;
let worker: Actor;
let planner: Actor;

beforeEach(() => {
  d = startDomain({ seed: false });
  addProject(d, 'TST');
  worker = d.agent('claude', { label: 'worker' });
  planner = d.agent('codex', { label: 'planner' });
});
afterEach(() => d.cleanup());

type Status = 'inbox' | 'planning' | 'ready' | 'progress' | 'review' | 'done' | 'canceled';
const ticket = (title: string, status: Status = 'ready', description_md?: string) => {
  const { id } = d.write(planner, (w, s) =>
    s.items.create(w, {
      project: 'TST',
      type: 'Task',
      title,
      status: 'planning',
      ...(description_md ? { description_md } : {}),
    }),
  );
  if (status !== 'planning') forceStatus(d, id, status);
  return id;
};
const blocks = (from: string, to: string) =>
  d.write(planner, (w, s) => s.links.link(w, { from, to, type: 'blocks' }));
const claim = (id: string) =>
  d.write(worker, (w, s) =>
    s.runs.claim(w, { id, agent_label: 'worker', orchestrator: { name: 'orca' } }),
  ).run_id;
const park = (run_id: string, reason = 'Waiting on a person.') =>
  d.write({ ...worker, run_id }, (w, s) =>
    s.runs.park(w, { run_id, reason, waiting_on: { person: true } }),
  );
const pastGrace = () => d.clock.advance(minutes(20));
const kinds = () =>
  new WaitKinds(
    d.server.runtime.db,
    d.clock.now().toISOString(),
    new BlockIndex(d.server.runtime.db),
    d.server.runtime.config.parkMaxMs,
  );
const waitOf = (id: string): ItemWait | null => kinds().of(id);

describe('Queued', () => {
  it('waits behind a blocker that is being worked, with the nearest blocker named', () => {
    const blocker = ticket('A synthetic blocker');
    claim(blocker);
    const waiter = ticket('A synthetic waiter');
    blocks(blocker, waiter);
    pastGrace();
    expect(waitOf(waiter)).toEqual({
      kind: 'queued',
      reason: null,
      after: blocker,
      more: 0,
      on: null,
      text: `Starts after ${blocker}`,
    });
  });

  it('a Ready blocker, or a Queued one, is waiting its turn too, however long', () => {
    const first = ticket('First in line');
    claim(first);
    const second = ticket('Second in line');
    const third = ticket('Third in line');
    blocks(first, second);
    blocks(second, third);
    const fresh = ticket('Behind a Ready ticket');
    const ready = ticket('A Ready blocker nobody has started');
    blocks(ready, fresh);
    pastGrace();
    expect(waitOf(second)?.kind).toBe('queued');
    expect(waitOf(third)).toMatchObject({ kind: 'queued', text: `Starts after ${second}` });
    expect(waitOf(fresh)?.kind).toBe('queued');
  });

  it('names the blocker likeliest to clear first, and how many more', () => {
    const planning = ticket('Still in planning', 'planning');
    const review = ticket('In review', 'review');
    const ready = ticket('Ready');
    const waiter = ticket('Waits on three');
    for (const b of [planning, review, ready]) blocks(b, waiter);
    expect(waitOf(waiter)).toMatchObject({
      kind: 'queued',
      after: review,
      more: 2,
      text: `Starts after ${review} and 2 more`,
    });
  });

  it('has no wait without an open blocker, and claiming is unchanged', () => {
    const blocker = ticket('A synthetic blocker');
    claim(blocker);
    const waiter = ticket('A synthetic waiter');
    expect(waitOf(waiter)).toBeNull();
    blocks(blocker, waiter);
    expect(waitOf(waiter)?.kind).toBe('queued');
    // Display only: a Queued ticket still can't be claimed.
    const refused = d.fails(
      planner,
      (w, s) => s.runs.claim(w, { id: waiter, agent_label: 'p' }),
      'validation',
    );
    expect(refused.message).toContain(`is blocked by ${blocker}`);
    forceStatus(d, blocker, 'done');
    expect(waitOf(waiter)).toBeNull();
  });
});

describe('Blocked, and why', () => {
  it('no next step: an unowned Planning blocker nothing has moved for the grace period', () => {
    const blocker = ticket('Nobody shaped this', 'planning');
    const waiter = ticket('A synthetic waiter');
    blocks(blocker, waiter);
    // Just created: still moving.
    expect(waitOf(waiter)?.kind).toBe('queued');
    pastGrace();
    expect(waitOf(waiter)).toMatchObject({
      kind: 'blocked',
      reason: 'no_next_step',
      on: blocker,
      text: `${blocker} has no next step: nobody has shaped or assigned it`,
    });
    // Someone takes it: Queued again.
    forceStatus(d, blocker, 'ready');
    claim(blocker);
    expect(waitOf(waiter)?.kind).toBe('queued');
  });

  it('no next step anywhere in the chain, even with no run parked', () => {
    const root = ticket('Deep in the chain', 'inbox');
    const middle = ticket('Ready, but blocked itself');
    const waiter = ticket('The waiter');
    blocks(root, middle);
    blocks(middle, waiter);
    pastGrace();
    expect(waitOf(waiter)).toMatchObject({ kind: 'blocked', reason: 'no_next_step', on: root });
    expect(waitOf(middle)).toMatchObject({ kind: 'blocked', reason: 'no_next_step', on: root });
  });

  it('an owner decision is pending and was never asked; asking clears it', () => {
    const blocker = ticket('Scope to settle', 'ready', PENDING);
    const waiter = ticket('A synthetic waiter');
    blocks(blocker, waiter);
    pastGrace();
    expect(waitOf(waiter)).toMatchObject({
      kind: 'blocked',
      reason: 'owner_unasked',
      on: blocker,
      text: `${blocker} needs an owner decision nobody has asked for`,
    });
    d.write(planner, (w, s) =>
      s.messages.askOwner(w, { id: blocker, ...askForm('Which synthetic scope ships?') }),
    );
    expect(waitOf(waiter)?.kind).toBe('queued');
  });

  it('a cited decision is settled, so the same text never counts', () => {
    const blocker = ticket('Scope settled', 'ready', 'Follows the owner decision dec_01abc.');
    const waiter = ticket('A synthetic waiter');
    blocks(blocker, waiter);
    pastGrace();
    expect(waitOf(waiter)?.kind).toBe('queued');
  });

  it('a canceled blocker never clears', () => {
    const blocker = ticket('Dropped work');
    const waiter = ticket('A synthetic waiter');
    blocks(blocker, waiter);
    forceStatus(d, blocker, 'canceled');
    expect(waitOf(waiter)).toMatchObject({
      kind: 'blocked',
      reason: 'canceled',
      on: blocker,
      text: `${blocker} was canceled, so it never clears`,
    });
  });

  it('a loop in the chain, reached through a blocker outside it', () => {
    const a = ticket('Loop A');
    const b = ticket('Loop B');
    const waiter = ticket('Behind the loop');
    blocks(a, waiter);
    blocks(a, b);
    // `link_items` refuses a loop, as imports can bring one in.
    d.sql
      .prepare(
        `INSERT INTO links (id, from_id, to_id, type, satisfied_when, created_by, version, created_at, updated_at)
         VALUES ('lnk_loop', ?, ?, 'blocks', NULL, 'owner', 1, ?, ?)`,
      )
      .run(b, a, d.clock.now().toISOString(), d.clock.now().toISOString());
    for (const id of [a, b, waiter]) {
      expect(waitOf(id)).toMatchObject({ kind: 'blocked', reason: 'cycle' });
    }
    expect(waitOf(waiter)!.text).toMatch(/loop back through/);
  });

  it("a blocker's lead parked past the stall threshold", () => {
    const blocker = ticket('Parked work');
    const run = claim(blocker);
    park(run);
    const waiter = ticket('A synthetic waiter');
    blocks(blocker, waiter);
    expect(waitOf(waiter)?.kind).toBe('queued');
    d.clock.advance(d.server.runtime.config.parkMaxMs + HOUR);
    expect(waitOf(waiter)).toMatchObject({ kind: 'blocked', reason: 'stalled', on: blocker });
    expect(waitOf(waiter)!.text).toBe(`${blocker}'s agent has been parked for 25h`);
  });

  it('the most pressing reason wins, named by the nearest blocker with it', () => {
    const canceled = ticket('Dropped');
    const unshaped = ticket('Unshaped', 'planning');
    const waiter = ticket('Waits on both');
    blocks(canceled, waiter);
    blocks(unshaped, waiter);
    forceStatus(d, canceled, 'canceled');
    pastGrace();
    expect(waitOf(waiter)).toMatchObject({ reason: 'canceled', on: canceled });
  });
});

describe('Held', () => {
  it("an owner decision holding a blocker's parked lead is neither Queued nor Blocked", () => {
    const hold = d.write(OWNER_ACTOR, (w, s) =>
      s.decisions.publish(w, {
        project: 'TST',
        scope: { kind: 'project' },
        title: 'Wait for the synthetic vendor',
        decision: 'Synthetic decision text.',
      }),
    );
    const blocker = ticket('Held work');
    park(claim(blocker), `Held by ${hold.id}.`);
    const waiter = ticket('A synthetic waiter');
    blocks(blocker, waiter);
    d.clock.advance(d.server.runtime.config.parkMaxMs + HOUR);
    expect(waitOf(waiter)).toMatchObject({
      kind: 'held',
      reason: 'decision',
      on: blocker,
      text: 'Held by your decision “Wait for the synthetic vendor”',
    });
  });

  it('a paused project holds everything in it, even a canceled blocker', () => {
    const blocker = ticket('Dropped');
    const waiter = ticket('A synthetic waiter');
    blocks(blocker, waiter);
    forceStatus(d, blocker, 'canceled');
    d.write(OWNER_ACTOR, (w, s) =>
      s.projects.pause(w, { key: 'TST', reason: 'A synthetic pause' }),
    );
    expect(waitOf(waiter)).toMatchObject({ kind: 'held', reason: 'paused', on: null });
    expect(waitOf(waiter)!.text).toMatch(/^Held by your decision “/);
  });
});

describe('every view agrees', () => {
  const setup = () => {
    const live = ticket('Being worked');
    claim(live);
    const queued = ticket('Queued behind it');
    blocks(live, queued);
    const dropped = ticket('Dropped');
    const blocked = ticket('Blocked behind it');
    blocks(dropped, blocked);
    forceStatus(d, dropped, 'canceled');
    return { queued, blocked };
  };

  it('Work rows, filters and counts, Overview, Pick next epic and the brief', () => {
    const { queued, blocked } = setup();
    const r = d.read();
    const work = d.services.views.work(r, { scope: 'TST', layout: 'list' });
    const row = (id: string) => work.items.find((i) => i.id === id)!;
    expect(row(queued).wait?.kind).toBe('queued');
    expect(row(blocked).wait).toMatchObject({ kind: 'blocked', reason: 'canceled' });
    expect(work.filter_counts.quick).toMatchObject({ queued: 1, blocked: 1 });
    const only = (quick: 'queued' | 'blocked') =>
      d.services.views.work(r, { scope: 'TST', layout: 'list', quick }).items.map((i) => i.id);
    expect(only('queued')).toEqual([queued]);
    expect(only('blocked')).toEqual([blocked]);

    const overview = d.services.views.overview(r, { scope: 'TST', window: '7d' });
    expect({ queued: overview.queued, blocked: overview.blocked }).toEqual({
      queued: 1,
      blocked: 1,
    });
    const none = overview.workload.find((g) => g.epic_id === null)!;
    expect(none.counts).toMatchObject({ queued: 1, blocked: 1 });
    const list = d.services.views.overviewItems(r, {
      scope: 'TST',
      metric: 'no_epic',
      window: '7d',
    });
    expect(list.rows.find((x) => x.id === queued)!.wait).toBe('queued');

    const brief = d.services.views.brief(r, { scope: 'TST' });
    expect(brief.stuck.queued).toBe(1);
    expect(brief.stuck.blocked.rows).toEqual([
      expect.objectContaining({ id: blocked, reason: 'canceled' }),
    ]);
  });

  it('the item page, epic cards and the critical path', () => {
    const { id: epic } = d.write(planner, (w, s) =>
      s.items.create(w, {
        project: 'TST',
        type: 'Epic',
        title: 'A synthetic epic',
        status: 'planning',
      }),
    );
    const live = ticket('Being worked');
    claim(live);
    const queued = ticket('Queued in the epic');
    blocks(live, queued);
    for (const id of [live, queued]) {
      d.sql.prepare('UPDATE items SET epic_id = ? WHERE id = ?').run(epic, id);
    }
    const r = d.read();
    expect(d.services.views.itemDetail(r, { id: queued }).item_wait?.kind).toBe('queued');
    const detail = d.services.views.itemDetail(r, { id: epic });
    expect(detail.children.find((c) => c.id === queued)!.wait?.kind).toBe('queued');
    const card = d.services.views.work(r, { scope: 'TST', layout: 'board' }).epics[0]!;
    expect(card.children).toMatchObject({ queued: 1, blocked: 0 });
    const path = d.services.subgraph.criticalPath(r, { id: queued });
    expect(path.chain.find((s) => s.item.id === queued)!.wait?.kind).toBe('queued');
    const pick = d.services.subgraph.pickEpic(r, { key: 'TST' });
    expect(pick.epics[0]!.waiting).toEqual({ queued: 1, blocked: 0 });
  });

  it('get_digest and get_context say Queued or Blocked, and why', () => {
    const { queued, blocked } = setup();
    const r = d.read();
    const digest = d.services.digest.get(r, { project: 'TST' });
    expect(digest.blocked.rows.map((x) => [x.id, x.wait])).toEqual([
      [blocked, 'blocked'],
      [queued, 'queued'],
    ]);
    expect(digest.blocked.rows[0]!.why).toMatch(/was canceled/);
    expect(digest.blocked.rows[1]!.why).toBeUndefined();
    const text = renderResult('get_digest', digest, {});
    expect(text).toContain(`${blocked} p2 blocked`);
    expect(text).toContain(`${queued} p2 queued`);

    const ctx = d.services.context.getContext(r, { id: queued, budget: 'small' });
    expect(ctx.wait_kind).toEqual({ kind: 'queued', text: expect.stringMatching(/^Starts after/) });
    expect(renderContext(ctx)).toContain('wait_kind: queued · Starts after');
    const other = d.services.context.getContext(r, { id: blocked, budget: 'small' });
    expect(renderContext(other)).toMatch(/wait_kind: blocked · .* was canceled/);
  });
});

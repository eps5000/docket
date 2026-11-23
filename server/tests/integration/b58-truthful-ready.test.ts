/**
 * B58 (owner decision 48), with synthetic text only: a pause is not an unasked
 * decision, expired part leases end, and Ready says what can really start.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WAIT_FLAGS, renderResult } from '@docket/shared';
import type { Actor } from '../../src/domain/write.js';
import { sweepOnce, recoveryFlags, waitCheckOnce } from '../../src/jobs/sweeper.js';
import { addProject, forceStatus, minutes, startDomain, type Domain } from '../us1-helpers.js';

const OWNER: Actor = { kind: 'owner', client: null, label: null, session_id: null, run_id: null };
const DAY = 24 * 60 * minutes(1);

let d: Domain;
let worker: Actor;
let planner: Actor;

beforeEach(() => {
  d = startDomain({ seed: false, now: new Date('2026-11-23T08:00:00.000Z') });
  addProject(d, 'TST');
  worker = d.agent('claude', { label: 'worker' });
  planner = d.agent('codex', { label: 'planner' });
});
afterEach(() => d.cleanup());

const item = (title: string, status: 'inbox' | 'planning' | 'ready' = 'ready', priority = 2) => {
  const { id } = d.write(planner, (w, s) =>
    s.items.create(w, {
      project: 'TST',
      type: 'Task',
      title,
      priority: priority as 1 | 2 | 3,
      status: 'planning',
    }),
  );
  if (status !== 'planning') forceStatus(d, id, status);
  return id;
};
const blocks = (from: string, to: string) =>
  d.write(planner, (w, s) => s.links.link(w, { from, to, type: 'blocks' }));
const decide = (actor: Actor, title: string) =>
  d.write(actor, (w, s) =>
    s.decisions.publish(w, {
      project: 'TST',
      scope: { kind: 'project' },
      title,
      decision: 'Synthetic decision text.',
    }),
  );
const parkOn = (id: string, reason: string, waiting_on: Record<string, unknown>) => {
  const { run_id } = d.write(worker, (w, s) =>
    s.runs.claim(w, {
      id,
      agent_label: 'worker',
      orchestrator: { name: 'orca', dispatch_id: 'ctx_1' },
    }),
  );
  for (const from of (waiting_on.items as string[] | undefined) ?? []) blocks(from, id);
  d.write({ ...worker, run_id }, (w, s) => s.runs.park(w, { run_id, reason, waiting_on }));
  return run_id;
};
const check = () => waitCheckOnce(d.server.runtime);
const count = (type: string, id: string) =>
  d.row<{ n: number }>('SELECT count(*) AS n FROM events WHERE type = ? AND item_id = ?', type, id)
    .n;
const flagKinds = (id: string) =>
  Object.values(
    (
      JSON.parse(
        d.row<{ wait_flags: string | null }>(
          'SELECT wait_flags FROM runs WHERE item_id = ? AND is_lead = 1',
          id,
        ).wait_flags ?? '{"flags":{}}',
      ) as { flags: Record<string, { kind: string }> }
    ).flags,
  ).map((f) => f.kind);
const card = (id: string) => d.services.views.itemDetail(d.read(), { id }).wait!;
const problemKinds = (id: string) => {
  const view = d.services.views.needsYou(d.read(), { scope: 'TST' });
  return [...view.problems, ...(view.agent_problems ?? [])]
    .filter((p) => p.item_id === id)
    .map((p) => p.kind);
};
const digest = () => d.services.digest.get(d.read(worker), { project: 'TST' });

describe('a pause is not an unasked decision', () => {
  it('a project-wide freeze citing an owner decision never flags or escalates', () => {
    const blocker = item('Synthetic blocker', 'planning');
    const a = item('Synthetic parked story');
    const freeze = decide(OWNER, 'Pause this project');
    const run = parkOn(a, `Paused by ${freeze.id}.`, { person: true, items: [blocker] });
    d.clock.advance(2 * DAY);
    check();

    expect(flagKinds(a)).toEqual([]);
    expect(count('run.wait_flagged', a)).toBe(0);
    expect(problemKinds(a)).toEqual([]);
    expect(recoveryFlags(d.server.runtime).has(`parked_too_long:${run}`)).toBe(false);
    const c = card(a);
    expect(c.held_by).toEqual({ decision_id: freeze.id, title: 'Pause this project' });
    expect(c.next_owner.step).toBe('Resumes when the owner lifts it');
    const row = digest().runs.rows.find((x) => x.item_id === a)!;
    expect(row.wait?.held_by?.decision_id).toBe(freeze.id);
    expect(renderResult('get_digest', digest())).toContain("held by the owner's decision");
  });

  it('holds whenever the decision was made, including after the park', () => {
    const a = item('Synthetic parked story');
    const earlier = decide(OWNER, 'An earlier pause');
    parkOn(a, `Held under ${earlier.id}`, { person: true });
    d.clock.advance(minutes(WAIT_FLAGS.grace_minutes * 2));
    check();
    expect(flagKinds(a)).toEqual([]);
  });

  it('an agent decision settles the wording but silences no alert', () => {
    const blocker = item('Synthetic blocker', 'planning');
    const a = item('Synthetic parked story');
    const record = decide(worker, 'An agent pause');
    const run = parkOn(a, `Paused by ${record.id}.`, { person: true, items: [blocker] });
    d.clock.advance(2 * DAY);
    check();

    expect(flagKinds(a)).toEqual(['wait_no_next_step']);
    expect(problemKinds(a)).toContain('parked_too_long');
    expect(recoveryFlags(d.server.runtime).has(`parked_too_long:${run}`)).toBe(true);
    expect(card(a).held_by).toBeNull();
  });

  it('a decision from another scope that does not apply holds nothing', () => {
    const other = item('Synthetic other story');
    const a = item('Synthetic parked story');
    const record = d.write(OWNER, (w, s) =>
      s.decisions.publish(w, {
        project: 'TST',
        scope: { kind: 'item', id: other },
        title: 'Only about the other story',
        decision: 'Synthetic decision text.',
      }),
    );
    const run = parkOn(a, `Citing ${record.id}.`, { person: true });
    d.clock.advance(2 * DAY);
    expect(card(a).held_by).toBeNull();
    expect(recoveryFlags(d.server.runtime).has(`parked_too_long:${run}`)).toBe(true);
  });

  it('a bare person wait raises no flag and is not called a decision', () => {
    const a = item('Synthetic parked story');
    parkOn(a, 'Waiting on people and things', { person: true });
    d.clock.advance(minutes(WAIT_FLAGS.grace_minutes * 2));
    check();
    expect(flagKinds(a)).toEqual([]);
    expect(card(a).person).toBe(true);
    expect(card(a).next_owner.step).not.toMatch(/decision/i);
  });

  it('a real pending owner decision still flags', () => {
    const a = item('Synthetic parked story');
    parkOn(a, 'This needs an owner decision on the scope.', { person: true });
    d.clock.advance(minutes(WAIT_FLAGS.grace_minutes));
    check();
    expect(flagKinds(a)).toEqual(['wait_owner_unasked']);
  });

  it('clears an existing false flag once, with no flapping', () => {
    const a = item('Synthetic parked story');
    const freeze = decide(OWNER, 'Pause this project');
    const run = parkOn(a, `Paused by ${freeze.id}.`, { person: true });
    const flag = {
      kind: 'wait_owner_unasked',
      on: a,
      since: d.clock.now().toISOString(),
      step: `${a}: ask the owner for the decision (ask_owner)`,
    };
    d.sql
      .prepare('UPDATE runs SET wait_flags = ? WHERE id = ?')
      .run(JSON.stringify({ flags: { [`wait_owner_unasked:${a}`]: flag } }), run);
    check();
    expect(flagKinds(a)).toEqual([]);
    expect(count('run.wait_cleared', a)).toBe(1);
    for (let i = 0; i < 3; i += 1) {
      d.clock.advance(minutes(WAIT_FLAGS.grace_minutes));
      check();
    }
    expect(count('run.wait_cleared', a)).toBe(1);
    expect(count('run.wait_flagged', a)).toBe(0);
  });

  it('lifting the freeze restarts aging from that moment', () => {
    const blocker = item('Synthetic blocker', 'planning');
    const a = item('Synthetic parked story');
    const freeze = decide(OWNER, 'Pause this project');
    const run = parkOn(a, `Paused by ${freeze.id}.`, { items: [blocker] });
    d.clock.advance(3 * DAY);
    d.write(OWNER, (w, s) =>
      s.decisions.withdraw(w, { decision_id: freeze.id, reason: 'Back to work' }),
    );
    check();
    expect(flagKinds(a), 'no wall of alerts when it lifts').toEqual([]);
    expect(recoveryFlags(d.server.runtime).has(`parked_too_long:${run}`)).toBe(false);
    expect(card(a).held_by).toBeNull();

    d.clock.advance(minutes(WAIT_FLAGS.grace_minutes));
    check();
    expect(flagKinds(a), 'normal aging resumes').toEqual(['wait_no_next_step']);
    d.clock.advance(DAY);
    expect(recoveryFlags(d.server.runtime).has(`parked_too_long:${run}`)).toBe(true);
  });

  it('a held run is not told to resume until the owner lifts the decision', () => {
    const blocker = item('Synthetic blocker', 'planning');
    const a = item('Synthetic parked story');
    const freeze = decide(OWNER, 'Pause this project');
    parkOn(a, `Paused by ${freeze.id}.`, { items: [blocker] });
    d.clock.advance(minutes(1));
    const t = d.clock.now().toISOString();
    d.sql
      .prepare("UPDATE items SET status = 'done', closed_at = ?, updated_at = ? WHERE id = ?")
      .run(t, t, blocker);
    check();
    expect(count('run.resume_ready', a)).toBe(0);
    d.write(OWNER, (w, s) =>
      s.decisions.withdraw(w, { decision_id: freeze.id, reason: 'Back to work' }),
    );
    check();
    check();
    expect(count('run.resume_ready', a)).toBe(1);
  });
});

describe('expired part leases', () => {
  const lease = (id: string, item_id: string, run_id: string | null, expires: string) => {
    const t = d.clock.now().toISOString();
    d.sql
      .prepare(
        `INSERT INTO part_leases (id, project_key, part_key, item_id, run_id, taken_at, expires_at, created_at, updated_at)
         VALUES (?, 'TST', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, `part-${id}`, item_id, run_id, t, expires, t, t);
  };
  const ended = (id: string) =>
    d.row<{ ended_at: string | null; end_reason: string | null }>(
      'SELECT ended_at, end_reason FROM part_leases WHERE id = ?',
      id,
    );

  it('ends once, with one event routed to the holder’s coordinator, parked or not', () => {
    const a = item('Synthetic parked holder');
    const run = parkOn(a, 'Waiting on a person', { person: true });
    const past = new Date(d.clock.now().getTime() - minutes(1)).toISOString();
    lease('pls_old', a, run, past);
    expect(sweepOnce(d.server.runtime).part_leases).toEqual(['pls_old']);
    expect(ended('pls_old').end_reason).toBe('expired');
    const event = d.row<{ data: string }>(
      "SELECT data FROM events WHERE type = 'lease.ended' AND item_id = ?",
      a,
    );
    expect(JSON.parse(event.data)).toMatchObject({
      lease_id: 'pls_old',
      end_reason: 'expired',
      run_id: run,
      coordinator: 'orca',
    });
    expect(sweepOnce(d.server.runtime).part_leases).toEqual([]);
    expect(count('lease.ended', a)).toBe(1);
  });

  it('leaves a live lease alone', () => {
    const a = item('Synthetic holder');
    const later = new Date(d.clock.now().getTime() + minutes(30)).toISOString();
    lease('pls_live', a, null, later);
    expect(sweepOnce(d.server.runtime).part_leases).toEqual([]);
    expect(ended('pls_live').ended_at).toBeNull();
  });
});

describe('a true Ready', () => {
  it('splits Ready on Work, with what each ticket waits on', () => {
    const planning = item('Synthetic planning blocker', 'planning');
    const waiting = item('Synthetic waiting story');
    const open = item('Synthetic startable story');
    blocks(planning, waiting);
    const work = (quick: 'startable' | 'waiting') =>
      d.services.views.work(d.read(), { scope: 'TST', layout: 'board', quick });
    expect(work('startable').items.map((i) => i.id)).toEqual([open]);
    const waited = work('waiting');
    expect(waited.items.map((i) => i.id)).toEqual([waiting]);
    expect(waited.items[0]!.ready_state).toEqual({ startable: false, waiting_on: planning });
    expect(waited.filter_counts.quick).toMatchObject({ startable: 1, waiting: 1 });
    expect(d.row<{ status: string }>('SELECT status FROM items WHERE id = ?', waiting).status).toBe(
      'ready',
    );
  });

  it('ranks next work by priority, transitive unlocks, then age', () => {
    const low = item('Synthetic low priority', 'ready', 3);
    d.clock.advance(minutes(1));
    const small = item('Synthetic small unlock');
    d.clock.advance(minutes(1));
    const big = item('Synthetic big unlock');
    const child = item('Synthetic child');
    const grandchild = item('Synthetic grandchild');
    const other = item('Synthetic other child');
    blocks(big, child);
    blocks(child, grandchild);
    blocks(small, other);
    const rows = digest().next_work.rows;
    expect(rows.map((x) => x.id)).toEqual([big, small, low]);
    expect(rows[0]).toMatchObject({ unlocks: 2 });
    expect(rows[0]!.reason).toContain('unlocks 2 tickets');
  });

  it('lists an unowned Inbox or Planning ticket holding up real work', () => {
    const shaping = item('Synthetic unowned blocker', 'planning');
    const held = item('Synthetic held story');
    const further = item('Synthetic further story');
    blocks(shaping, held);
    blocks(held, further);
    const idle = item('Synthetic idle inbox', 'inbox');
    const inboxOnly = item('Synthetic inbox dependent', 'inbox');
    blocks(idle, inboxOnly);
    expect(digest().bottlenecks.rows).toEqual([
      {
        id: shaping,
        title: 'Synthetic unowned blocker',
        status: 'planning',
        unlocks: 2,
        next: 'shape it or assign it',
      },
    ]);
  });

  it('survives a dependency cycle', () => {
    const a = item('Synthetic loop A', 'planning');
    const b = item('Synthetic loop B');
    const c = item('Synthetic loop C');
    blocks(a, b);
    blocks(b, c);
    const t = d.clock.now().toISOString();
    d.sql
      .prepare(
        `INSERT INTO links (id, from_id, to_id, type, created_by, created_at, updated_at) VALUES ('lnk_loop', ?, ?, 'blocks', 'test', ?, ?)`,
      )
      .run(c, a, t, t);
    const row = digest().bottlenecks.rows.find((x) => x.id === a);
    expect(row?.unlocks).toBe(2);
  });
});

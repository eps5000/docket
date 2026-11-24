/**
 * Split and withdraw with B58's wait logic (owner decision 48; BUILD_SPEC
 * §5.26, §5.33): a withdrawn question is not an open owner action, and a split
 * keeps `held_by` and the wait flags true. All content is synthetic.
 */
import { WAIT_FLAGS, type WaitingOn } from '@docket/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getRun } from '../../src/domain/model.js';
import type { SplitInput } from '../../src/domain/split.js';
import { applyUndo } from '../../src/domain/undo.js';
import { OWNER_ACTOR, type Actor } from '../../src/domain/write.js';
import { waitCheckOnce } from '../../src/jobs/sweeper.js';
import { askForm } from '../helpers.js';
import { addProject, forceStatus, minutes, startDomain, type Domain } from '../us1-helpers.js';

const CO = 'orca-coordinator';
const REASON = 'The plan changed, so this no longer matters.';
const PENDING = 'This needs an owner decision on the scope.';

let d: Domain;
let worker: Actor;
let coordinator: Actor;

beforeEach(() => {
  d = startDomain({ seed: false, now: new Date('2026-11-23T08:00:00.000Z') });
  addProject(d, 'TST');
  worker = d.agent('claude', { label: 'worker' });
  coordinator = d.agent('codex', { label: 'coordinator' });
  d.write(OWNER_ACTOR, (w, s) =>
    s.projects.setDefaultSatisfiedWhen(w, { key: 'TST', coordinators: [CO] }),
  );
});
afterEach(() => d.cleanup());

const ticket = (title: string, status: 'planning' | 'ready' = 'ready') => {
  const { id } = d.write(coordinator, (w, s) =>
    s.items.create(w, {
      project: 'TST',
      type: 'Implementation',
      title,
      acceptance: ['First synthetic check', 'Second synthetic check'],
      status: 'planning',
    }),
  );
  if (status !== 'planning') forceStatus(d, id, status);
  return id;
};
const claim = (id: string) =>
  d.write(worker, (w, s) =>
    s.runs.claim(w, {
      id,
      agent_label: 'worker',
      orchestrator: { name: CO, dispatch_id: 'ctx_1' },
    }),
  ).run_id;
const blocks = (from: string, to: string) =>
  d.write(coordinator, (w, s) => s.links.link(w, { from, to, type: 'blocks' }));
const park = (run_id: string, reason: string, waiting_on: WaitingOn) =>
  d.write({ ...worker, run_id }, (w, s) => s.runs.park(w, { run_id, reason, waiting_on }));
/** A parked lead on a new ticket, blocked by each of `blockers`. */
const parked = (blockers: string[], reason = 'Waiting on the other tickets.') => {
  const id = ticket('A parked synthetic story');
  const run = claim(id);
  for (const b of blockers) blocks(b, id);
  park(run, reason, { items: blockers });
  return { id, run };
};
const pastGrace = () => d.clock.advance(minutes(WAIT_FLAGS.grace_minutes * 2));
const check = () => waitCheckOnce(d.server.runtime);
const card = (id: string) => d.services.views.itemDetail(d.read(), { id }).wait!;
const flags = (id: string) => card(id).flags.map((f) => f.kind);
const count = (type: string, id: string) =>
  d.row<{ n: number }>('SELECT count(*) AS n FROM events WHERE type = ? AND item_id = ?', type, id)
    .n;
const waitingOn = (run: string) =>
  JSON.parse(getRun(d.server.runtime.db, run)!.waiting_on as unknown as string) as WaitingOn;
const version = (id: string) =>
  d.row<{ version: number }>('SELECT version FROM items WHERE id = ?', id).version;
const split = (actor: Actor, id: string, extra: Partial<SplitInput>) =>
  d.write(actor, (w, s) =>
    s.items.split(w, {
      id,
      expected_version: version(id),
      move: [2],
      relation: 'none',
      type: 'Implementation',
      title: 'The part that can go ahead',
      ...extra,
    }),
  );
/** Asked by someone who doesn't lead the item, so the question names no run. */
const askUnowned = (id: string) =>
  d.write(coordinator, (w, s) =>
    s.messages.askOwner(w, { id, ...askForm('Should this synthetic story ship first?') }),
  ).question_id;
const withdraw = (question_id: string) =>
  d.write(coordinator, (w, s) =>
    s.messages.withdraw(w, { question_id, reason: REASON, coordinator: CO }),
  );

describe('a withdrawn question and the wait', () => {
  it('stops counting as the owner having been asked', () => {
    const id = ticket('A parked synthetic story');
    const run = claim(id);
    park(run, PENDING, { person: true });
    const question = askUnowned(id);
    pastGrace();
    check();
    expect(flags(id)).toEqual([]);
    expect(card(id).next_owner.step).toContain('an open question to answer');

    withdraw(question);
    check();
    expect(flags(id)).toEqual(['wait_owner_unasked']);
    expect(card(id).next_owner.step).toBe(`${id}: ask the owner what it waits for`);
  });

  it("on a blocker, it is no longer that blocker's next step", () => {
    const blocker = ticket('A synthetic blocker', 'planning');
    const question = askUnowned(blocker);
    const { id } = parked([blocker]);
    pastGrace();
    check();
    expect(flags(id)).toEqual([]);
    expect(card(id).next_owner.step).toBe(`${blocker}: the owner has an open question to answer`);

    withdraw(question);
    check();
    expect(flags(id)).toEqual(['wait_no_next_step']);
    expect(card(id).next_owner.step).toBe(`${blocker}: shape it or assign it`);
  });

  it("B60's critical path stops saying the owner holds it", () => {
    const blocker = ticket('A synthetic blocker', 'planning');
    const goal = ticket('A synthetic goal', 'planning');
    blocks(blocker, goal);
    const question = askUnowned(blocker);
    const next = () => d.services.subgraph.criticalPath(d.read(), { id: goal }).next!;
    expect(next()).toMatchObject({ id: blocker, reason: 'waiting_on_owner' });

    withdraw(question);
    expect(next()).toMatchObject({ id: blocker, reason: 'unowned' });
  });

  it('a parked run stays parked, and resumes as open rather than needing input', () => {
    const id = ticket('A parked synthetic story');
    const run = claim(id);
    const { question_id } = d.write({ ...worker, run_id: run }, (w, s) =>
      s.messages.askOwner(w, { id, ...askForm('Should this synthetic story ship first?') }),
    );
    park(run, 'Waiting for an answer.', { person: true });
    withdraw(question_id);
    expect(getRun(d.server.runtime.db, run)!.state).toBe('parked');

    d.write({ ...worker, run_id: run }, (w, s) => s.runs.resume(w, { run_id: run }));
    expect(getRun(d.server.runtime.db, run)!.state).toBe('open');
  });
});

describe('a split and the wait', () => {
  it('moving the only blocker frees the parked lead, and tells its coordinator once', () => {
    const blocker = ticket('A synthetic blocker', 'planning');
    const { id, run } = parked([blocker]);
    pastGrace();
    check();
    expect(flags(id)).toEqual(['wait_no_next_step']);

    const { item } = split(coordinator, id, {
      coordinator: CO,
      also: [{ kind: 'blocker', id: blocker }],
    });

    expect(getRun(d.server.runtime.db, run)).toMatchObject({ state: 'parked', item_id: id });
    expect(waitingOn(run).items).toBeUndefined();
    expect(card(id)).toMatchObject({ resume_ready: true, blockers: [] });
    const { cleared, resumable } = check();
    expect(cleared).toEqual([`wait_no_next_step:${id}`]);
    expect(resumable).toEqual([id]);
    expect(flags(id)).toEqual([]);
    check();
    expect(count('run.resume_ready', id)).toBe(1);
    // B60's critical path follows the links: nothing holds the original any more.
    expect(d.services.subgraph.criticalPath(d.read(), { id }).state).toBe('clear');
    // The blocker now holds the new ticket.
    expect(
      d.services.items.get(d.read(), { id: item.id, view: 'standard' } as never).item,
    ).toMatchObject({ blocked_by: [blocker] });
  });

  it('with another blocker left, it still waits on that one', () => {
    const first = ticket('First synthetic blocker', 'planning');
    const second = ticket('Second synthetic blocker', 'planning');
    const { id, run } = parked([first, second]);
    split(OWNER_ACTOR, id, { also: [{ kind: 'blocker', id: first }] });
    expect(waitingOn(run)).toEqual({ items: [second] });
    expect(card(id).resume_ready).toBe(false);
    expect(check().resumable).toEqual([]);
  });

  it('a copied blocker changes nothing about the wait', () => {
    const blocker = ticket('A synthetic blocker', 'planning');
    const { id, run } = parked([blocker]);
    const before = getRun(d.server.runtime.db, run)!.waiting_on;
    split(OWNER_ACTOR, id, { also: [{ kind: 'blocker', id: blocker, copy: true }] });
    expect(getRun(d.server.runtime.db, run)!.waiting_on).toBe(before);
    expect(card(id).resume_ready).toBe(false);
  });

  it('a split that moves no blocker leaves raised flags as they were', () => {
    const blocker = ticket('A synthetic blocker', 'planning');
    const { id, run } = parked([blocker]);
    pastGrace();
    check();
    const stored = getRun(d.server.runtime.db, run)!.wait_flags;
    split(OWNER_ACTOR, id, { relation: 'after_original' });
    expect(check()).toMatchObject({ raised: [], cleared: [], resumable: [] });
    expect(getRun(d.server.runtime.db, run)!.wait_flags).toBe(stored);
    expect(count('run.wait_flagged', id)).toBe(1);
  });

  it("an owner's decision keeps holding the run, and frees it only when lifted", () => {
    const blocker = ticket('A synthetic blocker', 'planning');
    const hold = d.write(OWNER_ACTOR, (w, s) =>
      s.decisions.publish(w, {
        project: 'TST',
        scope: { kind: 'project' },
        title: 'Pause this synthetic work',
        decision: 'Synthetic decision text.',
      }),
    );
    const { id } = parked([blocker], `Paused by ${hold.id}.`);
    split(OWNER_ACTOR, id, { also: [{ kind: 'blocker', id: blocker }] });

    expect(card(id).held_by).toEqual({
      decision_id: hold.id,
      title: 'Pause this synthetic work',
    });
    expect(card(id).resume_ready).toBe(false);
    expect(check()).toMatchObject({ raised: [], resumable: [] });

    d.write(OWNER_ACTOR, (w, s) =>
      s.decisions.withdraw(w, { decision_id: hold.id, reason: 'The pause is over.' }),
    );
    expect(card(id).held_by).toBeNull();
    expect(card(id).resume_ready).toBe(true);
    expect(check().resumable).toEqual([id]);
  });

  it("undoing the owner's split restores the wait exactly", () => {
    const blocker = ticket('A synthetic blocker', 'planning');
    const { id, run } = parked([blocker]);
    const before = getRun(d.server.runtime.db, run)!.waiting_on;
    split(OWNER_ACTOR, id, { also: [{ kind: 'blocker', id: blocker }] });
    expect(getRun(d.server.runtime.db, run)!.waiting_on).not.toBe(before);

    const { mutation_id } = d.row<{ mutation_id: string }>(
      "SELECT mutation_id FROM events WHERE type = 'item.split' ORDER BY seq DESC LIMIT 1",
    );
    d.write(OWNER_ACTOR, (w) => applyUndo(w, mutation_id));
    expect(getRun(d.server.runtime.db, run)!.waiting_on).toBe(before);
    expect(card(id).resume_ready).toBe(false);
  });
});

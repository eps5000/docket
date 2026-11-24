/**
 * B69, Pause project (owner decision 53), with synthetic text only: who may
 * pause, what is refused, what keeps working, alerts and aging, resume events,
 * Undo, restart and two projects side by side.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WAIT_FLAGS, renderResult } from '@docket/shared';
import { undoMutation } from '../../src/domain/undo.js';
import { BlockIndex } from '../../src/domain/model.js';
import { readyStates } from '../../src/domain/next-work.js';
import { projectPause } from '../../src/domain/project-pause.js';
import type { Actor } from '../../src/domain/write.js';
import { recoveryFlags, restartSweep, sweepOnce, waitCheckOnce } from '../../src/jobs/sweeper.js';
import { addProject, forceStatus, minutes, startDomain, type Domain } from '../us1-helpers.js';

const OWNER: Actor = { kind: 'owner', client: null, label: null, session_id: null, run_id: null };
const DAY = 24 * 60 * minutes(1);
const REASON = 'Waiting on a synthetic answer';

let d: Domain;
let worker: Actor;

beforeEach(() => {
  d = startDomain({ seed: false, now: new Date('2026-11-24T08:00:00.000Z') });
  addProject(d, 'TST');
  addProject(d, 'OTH');
  worker = d.agent('claude', { label: 'worker' });
});
afterEach(() => d.cleanup());

const item = (project = 'TST', status: 'planning' | 'ready' = 'ready') => {
  const { id } = d.write(worker, (w, s) =>
    s.items.create(w, {
      project,
      type: 'Task',
      title: 'Synthetic item',
      priority: 2,
      status: 'planning',
    }),
  );
  if (status !== 'planning') forceStatus(d, id, status);
  return id;
};
const pause = (key = 'TST') =>
  d.write(OWNER, (w, s) => s.projects.pause(w, { key, reason: REASON }));
const resume = (key = 'TST') => d.write(OWNER, (w, s) => s.projects.resume(w, { key }));
const claim = (id: string) => {
  const { run_id } = d.write(worker, (w, s) =>
    s.runs.claim(w, {
      id,
      agent_label: 'worker',
      orchestrator: { name: 'orca', dispatch_id: 'ctx_1' },
    }),
  );
  return run_id;
};
const parkOn = (id: string, waiting_on: Record<string, unknown>, reason = 'Synthetic wait') => {
  const run_id = claim(id);
  d.write({ ...worker, run_id }, (w, s) => s.runs.park(w, { run_id, reason, waiting_on }));
  return run_id;
};
const blocks = (from: string, to: string) =>
  d.write(worker, (w, s) => s.links.link(w, { from, to, type: 'blocks' }));
const state = (run: string) =>
  d.row<{ state: string }>('SELECT state FROM runs WHERE id = ?', run).state;
const card = (id: string) => d.services.views.itemDetail(d.read(), { id }).wait!;
const digest = (project = 'TST') => d.services.digest.get(d.read(worker), { project });
const check = () => waitCheckOnce(d.server.runtime);
const count = (type: string, id: string) =>
  d.row<{ n: number }>('SELECT count(*) AS n FROM events WHERE type = ? AND item_id = ?', type, id)
    .n;
const problemKinds = (id: string, scope = 'TST') => {
  const view = d.services.views.needsYou(d.read(), { scope });
  return [...view.problems, ...(view.agent_problems ?? [])]
    .filter((p) => p.item_id === id)
    .map((p) => p.kind);
};
const parkMax = () => d.server.runtime.config.parkMaxMs;
const lastMutation = () =>
  d.row<{ mutation_id: string }>(
    "SELECT mutation_id FROM events WHERE type = 'project.updated' ORDER BY seq DESC LIMIT 1",
  ).mutation_id;

describe('authority', () => {
  it('only the owner can pause or resume', () => {
    d.fails(worker, (w, s) => s.projects.pause(w, { key: 'TST', reason: REASON }), 'forbidden');
    pause();
    d.fails(worker, (w, s) => s.projects.resume(w, { key: 'TST' }), 'forbidden');
    const decision = projectPause(d.server.runtime.db, 'TST')!.decision_id;
    d.fails(
      worker,
      (w, s) => s.decisions.withdraw(w, { decision_id: decision, reason: 'no' }),
      'forbidden',
    );
    d.fails(
      worker,
      (w, s) =>
        s.decisions.publish(w, {
          project: 'TST',
          scope: { kind: 'project' },
          title: 'Replace it',
          decision: 'Synthetic.',
          supersedes: decision,
        }),
      'forbidden',
    );
    expect(projectPause(d.server.runtime.db, 'TST')).not.toBeNull();
  });

  it('is an owner, project-scope decision, recorded in history', () => {
    const project = pause();
    const record = d.services.decisions
      .list(d.read(), { project: 'TST', include_inactive: false, limit: 50 })
      .items.find((x) => x.id === project.paused!.decision_id)!;
    expect(record).toMatchObject({
      authority: 'owner',
      scope: { kind: 'project' },
      decision_md: REASON,
    });
    expect(project.paused).toMatchObject({ reason: REASON, paused_by: 'owner' });
    resume();
    const after = d.services.decisions.list(d.read(), {
      project: 'TST',
      include_inactive: true,
      limit: 50,
    });
    expect(after.items.find((x) => x.id === record.id)!.status).toBe('withdrawn');
    const history = d
      .rows<{ summary: string }>(
        "SELECT summary FROM events WHERE type = 'project.updated' ORDER BY seq",
      )
      .map((e) => e.summary);
    expect(history[0]).toContain('paused project');
    expect(history[1]).toContain('resumed project');
  });

  it('refuses a second pause, and a resume with nothing paused', () => {
    d.fails(OWNER, (w, s) => s.projects.resume(w, { key: 'TST' }), 'conflict');
    pause();
    d.fails(OWNER, (w, s) => s.projects.pause(w, { key: 'TST', reason: REASON }), 'conflict');
  });

  it('withdrawing the record on the Decisions page also resumes; rewording keeps it paused', () => {
    pause();
    const first = projectPause(d.server.runtime.db, 'TST')!.decision_id;
    d.write(OWNER, (w, s) =>
      s.decisions.publish(w, {
        project: 'TST',
        scope: { kind: 'project' },
        title: 'Project paused: reworded',
        decision: 'A reworded synthetic reason',
        supersedes: first,
      }),
    );
    const now = projectPause(d.server.runtime.db, 'TST')!;
    expect(now.decision_id).not.toBe(first);
    expect(now.reason).toBe('A reworded synthetic reason');
    d.write(OWNER, (w, s) =>
      s.decisions.withdraw(w, { decision_id: now.decision_id, reason: 'Done' }),
    );
    expect(projectPause(d.server.runtime.db, 'TST')).toBeNull();
  });
});

describe('claims are refused', () => {
  it('on a Ready item, with the reason and who to ask', () => {
    const id = item();
    pause();
    const err = d.fails(worker, (w, s) => s.runs.claim(w, { id }), 'project_paused');
    expect(err.message).toContain(REASON);
    expect(err.message).toContain('ask the owner');
    expect(err.details).toMatchObject({ project: 'TST', reason: REASON, ask: 'the owner' });
    expect(d.row<{ status: string }>('SELECT status FROM items WHERE id = ?', id).status).toBe(
      'ready',
    );
  });

  it('when resuming a claim on an In progress item with no lead', () => {
    const id = item();
    const run_id = claim(id);
    d.write({ ...worker, run_id }, (w, s) =>
      s.runs.finish(w, { run_id, result: 'failed', summary: 'Stopped' }),
    );
    forceStatus(d, id, 'progress');
    pause();
    d.fails(worker, (w, s) => s.runs.claim(w, { id }), 'project_paused');
  });

  it('works again once it resumes', () => {
    const id = item();
    pause();
    d.fails(worker, (w, s) => s.runs.claim(w, { id }), 'project_paused');
    resume();
    expect(claim(id)).toMatch(/^run_/);
  });

  it('a coordinator cannot resume a parked run, or start new work under one', () => {
    const id = item();
    const run_id = parkOn(id, { orchestrator: true });
    pause();
    d.fails(
      d.agent('codex'),
      (w, s) => s.runs.updateStatus(w, { id, coordinator: 'orca', resume: true }),
      'project_paused',
    );
    d.fails(
      { ...worker, run_id },
      (w, s) => s.runs.startRun(w, { id, parent_run_id: run_id, agent_label: 'child' }),
      'project_paused',
    );
    expect(state(run_id)).toBe('parked');
  });
});

describe('nothing gets stranded', () => {
  it('an open run can keep working, and its context says to park', () => {
    const id = item();
    const run_id = claim(id);
    pause();
    const as = { ...worker, run_id };
    d.write(as, (w, s) => s.evidence.addNote(w, { id, text: 'Synthetic note' }));
    d.write(as, (w, s) =>
      s.evidence.reportCommit(w, { id, sha: 'abc1234', branch: 'synthetic', pushed: false }),
    );
    const bundle = d.services.context.getContext(d.read(as), { id, budget: 'small' });
    expect(bundle.paused).toContain('park_run');
    expect(renderResult('get_context', { context: bundle })).toContain('paused:');
    d.write(as, (w, s) => s.runs.finish(w, { run_id, result: 'finished', summary: 'Safe point' }));
    expect(state(run_id)).toBe('finished');
  });

  it('a parked run stays parked, and can still release or finish', () => {
    const a = item();
    const b = item();
    const runA = parkOn(a, { orchestrator: true });
    const runB = parkOn(b, { orchestrator: true });
    pause();
    expect(
      d.write({ ...worker, run_id: runA }, (w, s) => s.runs.resume(w, { run_id: runA })),
    ).toEqual({
      resumed: false,
    });
    expect(state(runA)).toBe('parked');
    d.write({ ...worker, run_id: runA }, (w, s) =>
      s.runs.park(w, { run_id: runA, reason: 'Still waiting', waiting_on: { person: true } }),
    );
    expect(state(runA)).toBe('parked');
    d.write({ ...worker, run_id: runA }, (w, s) =>
      s.runs.release(w, { id: a, run_id: runA, reason: 'Handing it back' }),
    );
    expect(state(runA)).toBe('interrupted');
    d.write({ ...worker, run_id: runB }, (w, s) =>
      s.runs.finish(w, { run_id: runB, result: 'finished', summary: 'Saved' }),
    );
    expect(state(runB)).toBe('finished');
  });

  it("a coordinator's time-limited park waits out the pause, then ends", () => {
    const id = item();
    const run_id = claim(id);
    d.write(d.agent('codex'), (w, s) =>
      s.runs.updateStatus(w, {
        id,
        coordinator: 'orca',
        park_minutes: 30,
        park_reason: 'Synthetic',
        waiting_on: { orchestrator: true },
      }),
    );
    pause();
    d.clock.advance(minutes(40));
    expect(sweepOnce(d.server.runtime).unparked).toEqual([]);
    expect(state(run_id)).toBe('parked');
    resume();
    expect(sweepOnce(d.server.runtime).unparked).toEqual([run_id]);
    expect(state(run_id)).toBe('open');
  });
});

describe('alerts and aging', () => {
  it('holds every parked run, cited or not, and raises nothing', () => {
    const blocker = item('TST', 'planning');
    const a = item();
    const run = parkOn(a, { items: [blocker], person: true }, 'Needs an owner decision on scope');
    blocks(blocker, a);
    const project = pause();
    d.clock.advance(3 * DAY);
    check();

    const c = card(a);
    expect(c.held_by?.decision_id).toBe(project.paused!.decision_id);
    expect(c.next_owner.step).toBe('Resumes when the owner lifts it');
    expect(count('run.wait_flagged', a)).toBe(0);
    expect(problemKinds(a)).toEqual([]);
    expect(recoveryFlags(d.server.runtime).has(`parked_too_long:${run}`)).toBe(false);
  });

  it('clears flags already raised, once each', () => {
    const blocker = item('TST', 'planning');
    const a = item();
    parkOn(a, { items: [blocker] });
    blocks(blocker, a);
    d.clock.advance(minutes(WAIT_FLAGS.grace_minutes + 1));
    check();
    expect(count('run.wait_flagged', a)).toBe(1);
    expect(problemKinds(a)).toContain('wait_no_next_step');
    pause();
    // Gone at once, before the two-minute check records it.
    expect(problemKinds(a)).toEqual([]);
    expect(card(a).flags).toEqual([]);
    check();
    check();
    expect(count('run.wait_cleared', a)).toBe(1);
  });

  it('restarts aging when it lifts, so no wall of alerts', () => {
    const blocker = item('TST', 'planning');
    const a = item();
    const run = parkOn(a, { items: [blocker] });
    blocks(blocker, a);
    pause();
    d.clock.advance(3 * DAY);
    resume();
    check();
    expect(count('run.wait_flagged', a)).toBe(0);
    expect(problemKinds(a)).toEqual([]);
    expect(recoveryFlags(d.server.runtime).has(`parked_too_long:${run}`)).toBe(false);

    d.clock.advance(parkMax() + minutes(1));
    expect(recoveryFlags(d.server.runtime).has(`parked_too_long:${run}`)).toBe(true);
  });

  it('adds nothing to Needs you', () => {
    const id = item();
    parkOn(id, { person: true });
    const count0 = d.services.views.needsYou(d.read(), { scope: 'TST' }).problems.length;
    pause();
    const view = d.services.views.needsYou(d.read(), { scope: 'TST' });
    expect(view.problems.length).toBe(count0);
    expect(view.project_decisions ?? []).toEqual([]);
  });
});

describe('Ready', () => {
  it('nothing in a paused project counts as Startable, and another project is unaffected', () => {
    const here = item('TST');
    const there = item('OTH');
    pause('TST');
    const states = readyStates(d.server.runtime.db, new BlockIndex(d.server.runtime.db), [
      here,
      there,
    ]);
    expect(states.get(here)).toEqual({ startable: false, waiting_on: 'you to resume the project' });
    expect(states.get(there)).toEqual({ startable: true, waiting_on: null });
  });
});

describe('the digest', () => {
  it('offers no next work, with one plain line', () => {
    item();
    const blocked = item('TST', 'planning');
    const end = item();
    blocks(blocked, end);
    expect(digest().next_work.total).toBeGreaterThan(0);
    pause();
    const paused = digest();
    expect(paused.next_work.total).toBe(0);
    expect(paused.bottlenecks.total).toBe(0);
    expect(paused.ready.total).toBe(0);
    expect(paused.paused).toContain(REASON);
    const text = renderResult('get_digest', paused);
    expect(text.split('\n').filter((l) => l.startsWith('paused:'))).toHaveLength(1);
    expect(text).not.toContain('next work');
  });
});

describe('resume events', () => {
  it('a blocker clearing during a pause raises nothing, then one event on resume', () => {
    const blocker = item();
    const a = item();
    parkOn(a, { items: [blocker] });
    blocks(blocker, a);
    pause();
    forceStatus(d, blocker, 'done');
    d.sql
      .prepare('UPDATE items SET closed_at = ? WHERE id = ?')
      .run(d.clock.now().toISOString(), blocker);
    check();
    expect(count('run.resume_ready', a)).toBe(0);
    expect(card(a).resume_ready).toBe(false);

    d.clock.advance(minutes(5));
    resume();
    check();
    check();
    expect(count('run.resume_ready', a)).toBe(1);
    expect(card(a).resume_ready).toBe(true);
  });

  it('a run already told before the pause is told once more after it', () => {
    const blocker = item();
    const a = item();
    parkOn(a, { items: [blocker] });
    blocks(blocker, a);
    forceStatus(d, blocker, 'done');
    d.sql
      .prepare('UPDATE items SET closed_at = ? WHERE id = ?')
      .run(d.clock.now().toISOString(), blocker);
    check();
    expect(count('run.resume_ready', a)).toBe(1);
    pause();
    d.clock.advance(minutes(5));
    resume();
    check();
    check();
    expect(count('run.resume_ready', a)).toBe(2);
  });
});

describe('undo', () => {
  it('undoes a pause', () => {
    pause();
    undoMutation(d.server.runtime.write, lastMutation());
    expect(projectPause(d.server.runtime.db, 'TST')).toBeNull();
    expect(item()).toBeTruthy();
  });

  it('undoes a resume: paused again, with no lift recorded', () => {
    const a = item();
    const run = parkOn(a, { person: true });
    pause();
    d.clock.advance(61_000);
    resume();
    undoMutation(d.server.runtime.write, lastMutation());
    expect(projectPause(d.server.runtime.db, 'TST')).not.toBeNull();
    expect(state(run)).toBe('parked');
    expect(card(a).held_by).not.toBeNull();
    expect(
      d.row<{ at: string | null }>(
        'SELECT max(pause_lifted_at) AS at FROM decision_records WHERE project_key = ?',
        'TST',
      ).at,
    ).toBeNull();
  });
});

describe('scope and durability', () => {
  it('pausing one project leaves another alone', () => {
    const here = item('TST');
    const there = item('OTH');
    pause('TST');
    d.fails(worker, (w, s) => s.runs.claim(w, { id: here }), 'project_paused');
    expect(claim(there)).toMatch(/^run_/);
    expect(digest('OTH').paused).toBeUndefined();
    const boot = d.services.views.bootstrap(d.read());
    expect(boot.projects.find((p) => p.key === 'TST')!.paused).toBeDefined();
    expect(boot.projects.find((p) => p.key === 'OTH')!.paused).toBeUndefined();
  });

  it("a waiter in another project isn't told to dispatch the paused blocker", () => {
    const blocker = item('TST', 'ready');
    const waiter = item('OTH');
    parkOn(waiter, { items: [blocker] });
    pause('TST');
    d.clock.advance(minutes(WAIT_FLAGS.grace_minutes + 1));
    check();
    expect(count('run.wait_flagged', waiter)).toBe(0);
    expect(card(waiter).next_owner.step).toContain('paused project');
  });

  it('survives a restart', () => {
    const id = item();
    const run = parkOn(id, { person: true });
    pause();
    restartSweep(d.server.runtime);
    expect(projectPause(d.server.runtime.db, 'TST')?.reason).toBe(REASON);
    expect(state(run)).toBe('parked');
    d.fails(worker, (w, s) => s.runs.claim(w, { id: item() }), 'project_paused');
  });
});

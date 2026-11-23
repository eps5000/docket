/**
 * Scripted replays of the pilot's five-hour stall behind owner decision 45,
 * with the real IDs and timestamps and synthetic titles and text.
 *
 * Like the B50 replays, each drives only calls the old code also had: claims,
 * parks, resumes, questions and status moves. The new check is looked up
 * optionally, so this file runs unchanged on the commit before B54 and fails
 * there on what the producer can see, not on a missing import.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../../src/domain/write.js';
import * as sweeper from '../../src/jobs/sweeper.js';
import { addProject, forceStatus, minutes, startDomain, type Domain } from '../us1-helpers.js';
import { askForm } from '../helpers.js';

const COORDINATOR = 'pilot-coordinator';
const OWNER: Actor = { kind: 'owner', client: null, label: null, session_id: null, run_id: null };

let d: Domain;
let worker: Actor;
let planner: Actor;

interface CardLike {
  waited_since: string;
  run_id: string;
  next_owner: { kind: string; name: string; step: string };
  resumes_when: string;
  blockers: { id: string; status: string; clears_when: string }[];
  person: boolean;
  flags: unknown[];
  scope_hint?: string;
}

beforeEach(() => {
  d = startDomain({ seed: false, now: new Date('2026-11-22T19:00:00.000Z') });
  addProject(d, 'GF');
  worker = d.agent('claude', { label: 'implementer' });
  planner = d.agent('codex', { label: 'planner' });
});
afterEach(() => d.cleanup());

/** The check Docket runs every two minutes. Absent before B54. */
const check = () =>
  (sweeper as unknown as { waitCheckOnce?: (r: unknown) => unknown }).waitCheckOnce?.(
    d.server.runtime,
  );

const at = (iso: string) => {
  const target = new Date(iso).getTime();
  const delta = target - d.clock.now().getTime();
  expect(delta, `the replay moves forward to ${iso}`).toBeGreaterThanOrEqual(0);
  d.clock.advance(delta);
};

function item(n: number, title: string, status: 'planning' | 'ready', description_md?: string) {
  d.sql.prepare("UPDATE projects SET next_seq = ? WHERE key = 'GF'").run(n);
  const { id } = d.write(planner, (w, s) =>
    s.items.create(w, {
      project: 'GF',
      type: 'Task',
      title,
      priority: 2,
      status: 'planning',
      ...(description_md ? { description_md } : {}),
    }),
  );
  if (status === 'ready') forceStatus(d, id, 'ready');
  return id;
}

const blocks = (from: string, to: string) =>
  d.write(planner, (w, s) => s.links.link(w, { from, to, type: 'blocks' }));

/** A claim is refused on a blocked item, so the prerequisite is found and linked after it. */
const claim = (id: string, dispatch_id: string, blockers: string[] = []) => {
  const { run_id } = d.write(worker, (w, s) =>
    s.runs.claim(w, {
      id,
      agent_label: 'implementer',
      orchestrator: { name: COORDINATOR, dispatch_id },
    }),
  );
  for (const from of blockers) blocks(from, id);
  return run_id;
};

const park = (run_id: string, reason: string, waiting_on: Record<string, unknown>) =>
  d.write({ ...worker, run_id }, (w, s) => s.runs.park(w, { run_id, reason, waiting_on })) as {
    wait?: CardLike;
  };

const touch = (id: string, description_md: string) =>
  d.write(planner, (w, s) =>
    s.items.update(w, {
      id,
      description_md,
      expected_version: d.row<{ version: number }>('SELECT version FROM items WHERE id = ?', id)
        .version,
    }),
  );

const done = (id: string) => {
  const now = d.clock.now().toISOString();
  d.sql
    .prepare("UPDATE items SET status = 'done', closed_at = ?, updated_at = ? WHERE id = ?")
    .run(now, now, id);
};

const events = (type: string, item_id: string) =>
  d
    .rows<{
      at: string;
      summary: string;
      data: string;
    }>(
      'SELECT at, summary, data FROM events WHERE type = ? AND item_id = ? ORDER BY seq',
      type,
      item_id,
    )
    .map((e) => ({
      at: e.at,
      summary: e.summary,
      data: JSON.parse(e.data) as Record<string, unknown>,
    }));

const flagKinds = (item_id: string) => events('run.wait_flagged', item_id).map((e) => e.data.kind);
const digest = () => d.services.digest.get(d.read(), { project: 'GF' });
const needs = () => d.services.views.needsYou(d.read(), { scope: 'GF' });
const context = (id: string) =>
  d.services.context.getContext(d.read(), { id, budget: 'small' }) as unknown as {
    wait?: CardLike;
    waiting_runs?: { total: number; rows: { item_id: string; run_id: string }[] };
  };

describe('the five-hour stall, replayed (decision 45)', () => {
  it('GF-243 → GF-381: shows the wait at once, flags it by 21:12:40, and names the run on clear', () => {
    const gf243 = item(243, 'Synthetic story with a PR to hold', 'ready');
    const gf381 = item(381, 'Synthetic prerequisite in planning', 'planning', 'First draft.');
    expect([gf243, gf381]).toEqual(['GF-243', 'GF-381']);

    at('2026-11-22T19:13:59.000Z');
    const run = claim(gf243, 'ctx_gf243');
    // It works for an hour and a half before the prerequisite is found, renewing its lease.
    at('2026-11-22T20:05:00.000Z');
    d.services.runs.heartbeat(d.read({ ...worker, run_id: run }), { run_id: run });
    at('2026-11-22T20:47:22.000Z');
    blocks(gf381, gf243);

    // The producer sees the whole wait in the park result.
    at('2026-11-22T20:48:00.000Z');
    const parked = park(run, 'Held per recorded choice dec_01synthetic until GF-381 lands', {
      items: [gf381],
    });
    expect(parked.wait, 'the card appears in the park_run result').toBeDefined();
    expect(parked.wait).toMatchObject({
      run_id: run,
      waited_since: '2026-11-22T20:48:00.000Z',
      next_owner: {
        kind: 'orchestrator',
        name: COORDINATOR,
        step: 'GF-381: shape it or assign it',
      },
      blockers: [{ id: gf381, status: 'planning', clears_when: 'done' }],
    });
    expect(parked.wait!.resumes_when).toBe(
      `Resumes when GF-381 is done: ${COORDINATOR} relays it to dispatch ctx_gf243, the same run ${run} (claude · implementer).`,
    );

    expect(parked.wait!.scope_hint, 'GF-381 was linked after the claim').toBe(
      'GF-381 was added after work started: confirm it holds the whole story. If only part is held, split that part out and let the rest proceed.',
    );

    // Someone shapes GF-381 for a few minutes, then stops.
    at('2026-11-22T20:55:40.000Z');
    touch(gf381, 'Second draft, still being shaped.');

    // Whoever picks up the blocker sees what it frees.
    expect(context(gf381).waiting_runs?.rows[0]).toMatchObject({ item_id: gf243, run_id: run });

    at('2026-11-22T21:08:40.000Z');
    check();
    expect(flagKinds(gf243), 'inside the 15-minute grace').toEqual([]);

    at('2026-11-22T21:10:40.000Z');
    check();
    const flagged = events('run.wait_flagged', gf243);
    expect(flagKinds(gf243), 'the first check at 21:10:40 raises it').toEqual([
      'wait_no_next_step',
    ]);
    expect(flagged[0]!.at).toBe('2026-11-22T21:10:40.000Z');
    expect(flagged[0]!.data).toMatchObject({ on: gf381, coordinator: COORDINATOR, run_id: run });

    // Routed to the coordinator: in the digest, not on the owner's Needs you.
    const row = digest().runs.rows.find((x) => x.item_id === gf243) as unknown as {
      wait?: { flags: string[]; next: string };
    };
    expect(row.wait?.flags).toEqual(['wait_no_next_step']);
    expect(digest().problems.rows.map((p) => p.kind)).toContain('wait_no_next_step');
    expect(needs().problems.filter((p) => p.item_id === gf243)).toEqual([]);

    // It stays raised once, however many checks run, up to the 01:41Z the pilot was found at.
    for (const t of ['21:12:40', '22:00:40', '23:30:40']) {
      at(`2026-11-22T${t}.000Z`);
      check();
    }
    at('2026-11-23T01:41:00.000Z');
    check();
    expect(flagKinds(gf243)).toEqual(['wait_no_next_step']);

    // GF-381 reaches Done: one event naming the same run and dispatch.
    at('2026-11-23T01:50:00.000Z');
    done(gf381);
    check();
    check();
    const ready = events('run.resume_ready', gf243);
    expect(ready).toHaveLength(1);
    expect(ready[0]!.data).toMatchObject({
      run_id: run,
      label: 'implementer',
      client: 'claude',
      dispatch_id: 'ctx_gf243',
    });
    expect(String(ready[0]!.data.instruction)).toContain(`Continue under run ${run}`);
    expect(ready[0]!.summary).toContain("Docket can't message a session");
    expect(digest().runs.rows[0]).toMatchObject({ item_id: gf243, resume_ready: true });
    expect(events('run.wait_cleared', gf243).map((e) => e.data.kind)).toEqual([
      'wait_no_next_step',
    ]);
  });

  it('GF-229 → GF-382: the clock survives re-parks, and a real question clears the second flag', () => {
    const gf229 = item(229, 'Synthetic story that can do some work', 'ready');
    const gf382 = item(382, 'Synthetic prerequisite awaiting a call', 'planning', 'Early notes.');

    at('2026-11-22T20:52:32.000Z');
    const run = claim(gf229, 'ctx_gf229');

    at('2026-11-22T21:13:50.000Z');
    // The real sentence's shape, with a synthetic subject.
    touch(gf382, 'The synthetic export options remain a separate owner scope decision and WAIT.');

    at('2026-11-22T21:14:27.000Z');
    expect(park(run, 'Needs GF-382 first', { items: [gf382] }).wait?.waited_since).toBe(
      '2026-11-22T21:14:27.000Z',
    );
    at('2026-11-22T21:14:59.000Z');
    blocks(gf382, gf229);
    expect(context(gf229).wait?.scope_hint, 'GF-382 was linked after the claim').toContain(
      'GF-382 was added after work started',
    );

    // It does some non-body work, and parks again.
    at('2026-11-22T21:20:00.000Z');
    d.write(OWNER, (w, s) => s.runs.resume(w, { run_id: run }));
    at('2026-11-22T21:22:00.000Z');
    expect(park(run, 'Back to waiting on GF-382', { items: [gf382] }).wait?.waited_since).toBe(
      '2026-11-22T21:14:27.000Z',
    );

    at('2026-11-22T21:26:50.000Z');
    check();
    expect(flagKinds(gf229)).toEqual([]);

    at('2026-11-22T21:28:50.000Z');
    check();
    expect(flagKinds(gf229).sort(), 'both raise on the first check at 21:28:50').toEqual([
      'wait_no_next_step',
      'wait_owner_unasked',
    ]);
    expect(needs().problems.filter((p) => p.item_id === gf229)).toEqual([]);

    // A short resume and re-park neither resets the clock nor raises the flags again.
    at('2026-11-22T21:31:00.000Z');
    d.write(OWNER, (w, s) => s.runs.resume(w, { run_id: run }));
    check();
    at('2026-11-22T21:33:37.000Z');
    const again = park(run, 'Still waiting on GF-382', { items: [gf382] });
    expect(again.wait?.waited_since, 'not 21:33:37').toBe('2026-11-22T21:14:27.000Z');
    at('2026-11-22T21:34:50.000Z');
    check();
    expect(flagKinds(gf229)).toHaveLength(2);
    expect(events('run.wait_cleared', gf229)).toEqual([]);
    expect(context(gf229).wait?.waited_since).toBe('2026-11-22T21:14:27.000Z');

    // The coordinator asks the real question: the owner now has something to answer.
    at('2026-11-22T21:40:00.000Z');
    const { question_id } = d.write(planner, (w, s) =>
      s.messages.askOwner(w, {
        id: gf382,
        ...askForm('Which option should the prerequisite use?'),
      }),
    );
    check();
    expect(
      events('run.wait_cleared', gf229)
        .map((e) => e.data.kind)
        .sort(),
    ).toEqual(['wait_no_next_step', 'wait_owner_unasked']);

    // Answered, it stays cleared: the decision was asked for.
    at('2026-11-22T21:50:00.000Z');
    d.write(OWNER, (w, s) =>
      s.messages.answer(w, { id: gf382, question_id, text: 'Use the first option.' }),
    );
    at('2026-11-22T22:30:00.000Z');
    check();
    expect(flagKinds(gf229).filter((k) => k === 'wait_owner_unasked')).toHaveLength(1);

    at('2026-11-22T22:40:00.000Z');
    done(gf382);
    check();
    const ready = events('run.resume_ready', gf229);
    expect(ready).toHaveLength(1);
    expect(ready[0]!.data).toMatchObject({ run_id: run, dispatch_id: 'ctx_gf229' });
  });
});

describe('what must not be flagged (decision 45)', () => {
  it("GF-243's cited decision is not an unasked owner decision", () => {
    const a = item(243, 'Synthetic waiter', 'ready');
    const b = item(381, 'Synthetic blocker', 'planning', 'Follows recorded decision dec_01abc.');
    const run = claim(a, 'ctx_a', [b]);
    park(run, 'Held by the owner decision dec_01abc until the blocker lands', { items: [b] });
    d.clock.advance(minutes(60));
    check();
    expect(flagKinds(a), 'the wait itself is still flagged').toEqual(['wait_no_next_step']);
  });

  it("GF-379's pending Workflow proposal is a real owner action, before and after approval", () => {
    const a = item(379, 'Synthetic story waiting on a person', 'ready');
    const run = claim(a, 'ctx_379');
    const { proposal_id } = d.write({ ...worker, run_id: run }, (w, s) =>
      s.agentProposals.propose(w, {
        project: 'GF',
        file: 'workflow',
        content: 'Synthetic workflow text.',
        reason: 'Synthetic reason for the change.',
        based_on_version_id: null,
        run_id: run,
      }),
    );
    d.clock.advance(minutes(1));
    const parked = park(run, 'Waiting on the owner to pick', { person: true });
    expect(parked.wait, 'it still shows the wait').toMatchObject({
      person: true,
      flags: [],
      next_owner: { step: `${a}: the owner has a Workflow notes proposal to approve` },
    });
    d.clock.advance(minutes(120));
    check();
    expect(flagKinds(a), 'not flagged while the proposal is pending').toEqual([]);

    // Approved during the wait: the owner was asked and answered, so it stays unflagged.
    d.write(OWNER, (w, s) => s.agentProposals.approve(w, { id: proposal_id }));
    d.clock.advance(minutes(30));
    check();
    expect(flagKinds(a), 'not flagged after the approval').toEqual([]);
    expect(context(a).wait?.next_owner.step).toBe(`${a}: the owner has answered; resume it`);
  });

  it('a person wait with nothing to answer is flagged, and goes to the coordinator', () => {
    const a = item(300, 'Synthetic story waiting on a person', 'ready');
    const run = claim(a, 'ctx_300');
    park(run, 'Waiting on a person', { person: true });
    d.clock.advance(minutes(14));
    check();
    expect(flagKinds(a)).toEqual([]);
    d.clock.advance(minutes(2));
    check();
    expect(flagKinds(a)).toEqual(['wait_owner_unasked']);
    expect(needs().problems.filter((p) => p.item_id === a)).toEqual([]);
  });

  it('a blocker with a live lead', () => {
    const a = item(301, 'Synthetic waiter', 'ready');
    const b = item(302, 'Synthetic blocker with a lead', 'ready');
    const run = claim(a, 'ctx_a', [b]);
    d.write(planner, (w, s) => s.runs.claim(w, { id: b, agent_label: 'planner' }));
    park(run, 'Waiting on the blocker', { items: [b] });
    d.clock.advance(minutes(40));
    check();
    expect(flagKinds(a)).toEqual([]);
    expect(context(a).wait?.next_owner).toMatchObject({ kind: 'lead', name: 'codex · planner' });
  });

  it('a blocker being actively shaped, until the shaping stops', () => {
    const a = item(303, 'Synthetic waiter', 'ready');
    const b = item(304, 'Synthetic blocker', 'planning');
    const run = claim(a, 'ctx_a', [b]);
    park(run, 'Waiting on the blocker', { items: [b] });
    for (let n = 1; n <= 5; n += 1) {
      d.clock.advance(minutes(10));
      touch(b, `Shaping pass ${n}.`);
      check();
    }
    expect(flagKinds(a)).toEqual([]);
    d.clock.advance(minutes(15));
    check();
    expect(flagKinds(a)).toEqual(['wait_no_next_step']);
  });

  it('a blocker linked before the claim gets no scope hint', () => {
    const a = item(308, 'Synthetic waiter', 'ready');
    const b = item(309, 'Synthetic blocker', 'planning');
    // A claim is refused while blocked, so the blocker is clear at the claim and reopens later.
    forceStatus(d, b, 'done');
    blocks(b, a);
    d.clock.advance(minutes(1));
    const run = claim(a, 'ctx_a');
    forceStatus(d, b, 'planning');
    d.clock.advance(minutes(1));
    const parked = park(run, 'Waiting on the blocker', { items: [b] });
    expect(parked.wait?.blockers[0]).toMatchObject({ id: b });
    expect(parked.wait?.scope_hint).toBeUndefined();
  });

  it('a dependency cycle ends the chain, and its own Problem owns the fix', () => {
    const a = item(305, 'Synthetic waiter', 'ready');
    const b = item(306, 'Synthetic loop one', 'planning');
    const c = item(307, 'Synthetic loop two', 'planning');
    const run = claim(a, 'ctx_a', [b]);
    blocks(c, b);
    // Links refuse a cycle, but an import can carry one.
    const t = d.clock.now().toISOString();
    d.sql
      .prepare(
        `INSERT INTO links (id, from_id, to_id, type, satisfied_when, created_by, version, created_at, updated_at)
         VALUES ('lnk_cycle', ?, ?, 'blocks', NULL, 'agent', 1, ?, ?)`,
      )
      .run(b, c, t, t);
    const parked = park(run, 'Waiting on the loop', { items: [b] });
    expect(parked.wait?.next_owner.step).toContain('dependency loop');
    d.clock.advance(minutes(40));
    check();
    expect(flagKinds(a)).toEqual([]);
  });
});

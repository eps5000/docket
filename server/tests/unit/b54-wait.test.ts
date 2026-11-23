/**
 * The wait card and flags (owner decision 45; BUILD_SPEC §5.26): the narrow
 * owner-decision match, chains, routing, advisory behaviour and token cost.
 * The replays of the real stall: integration/b54-wait-replays.test.ts.
 */
import { DIGEST_MAX_CHARS, WAIT_FLAGS, renderContext, renderResult } from '@docket/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { saysOwnerDecisionPending } from '../../src/domain/wait.js';
import type { Actor } from '../../src/domain/write.js';
import { waitCheckOnce } from '../../src/jobs/sweeper.js';
import { addProject, forceStatus, minutes, startDomain, type Domain } from '../us1-helpers.js';

let d: Domain;
let worker: Actor;
let other: Actor;

beforeEach(() => {
  d = startDomain({ seed: false });
  addProject(d, 'TST');
  worker = d.agent('claude', { label: 'worker' });
  other = d.agent('codex', { label: 'other' });
});
afterEach(() => d.cleanup());

const item = (title: string, ready = false, description_md?: string) => {
  const { id } = d.write(other, (w, s) =>
    s.items.create(w, {
      project: 'TST',
      type: 'Task',
      title,
      priority: 2,
      status: 'planning',
      ...(description_md ? { description_md } : {}),
    }),
  );
  if (ready) forceStatus(d, id, 'ready');
  return id;
};
const blocks = (from: string, to: string) =>
  d.write(other, (w, s) => s.links.link(w, { from, to, type: 'blocks' }));
const parkOn = (id: string, waiting_on: Record<string, unknown>, orchestrator = true) => {
  const { run_id } = d.write(worker, (w, s) =>
    s.runs.claim(w, {
      id,
      agent_label: 'worker',
      ...(orchestrator ? { orchestrator: { name: 'orca', dispatch_id: 'ctx_1' } } : {}),
    }),
  );
  // A claim is refused on a blocked item, so the blocker is linked after it.
  for (const from of (waiting_on.items as string[] | undefined) ?? []) blocks(from, id);
  const out = d.write({ ...worker, run_id }, (w, s) =>
    s.runs.park(w, { run_id, reason: 'Waiting', waiting_on }),
  );
  return { run_id, wait: out.wait! };
};
const flagged = () =>
  d.rows<{ data: string }>("SELECT data FROM events WHERE type = 'run.wait_flagged' ORDER BY seq");

describe('saysOwnerDecisionPending', () => {
  it.each([
    'A separate owner decision is still needed.',
    'This needs an owner decision before it starts.',
    "Waiting on the owner's call about pricing.",
    'Requires a decision from the owner.',
    'Owner approval is pending.',
  ])('counts %s', (text) => expect(saysOwnerDecisionPending(text)).toBe(true));

  it.each([
    'Follows the owner decision dec_01abc.',
    'Owner decision 42 is needed context here.',
    'The owner decided to ship it.',
    'The owner already approved this choice.',
    'No owner decision is needed.',
    'Needs code owner approval.',
    'The recorded owner decision is needed for context.',
    'Add a decision log to the settings page.',
    '',
  ])('does not count %s', (text) => expect(saysOwnerDecisionPending(text)).toBe(false));

  it('reads one sentence at a time', () => {
    expect(
      saysOwnerDecisionPending('This follows dec_01abc. A new owner decision is still needed.'),
    ).toBe(true);
  });
});

describe('the wait card', () => {
  it('follows an uncleared chain to the item that can move, bounded', () => {
    const ids = Array.from({ length: WAIT_FLAGS.chain_depth + 3 }, (_, n) => item(`Link ${n}`));
    for (let n = 0; n + 1 < ids.length; n += 1) blocks(ids[n + 1]!, ids[n]!);
    const waiter = item('Waiter', true);
    const { wait } = parkOn(waiter, { items: [ids[0]!] });
    expect(wait.blockers[0]!.moves).toBe(ids[WAIT_FLAGS.chain_depth]);
  });

  it('goes to a project coordinator, then the owner, when no orchestrator is recorded', () => {
    const blocker = item('Blocker');
    const waiter = item('Waiter', true);
    d.sql.prepare("UPDATE projects SET coordinators = ? WHERE key = 'TST'").run('["registered"]');
    expect(parkOn(waiter, { items: [blocker] }, false).wait.next_owner).toMatchObject({
      kind: 'coordinator',
      name: 'registered',
    });
    d.sql.prepare("UPDATE projects SET coordinators = NULL WHERE key = 'TST'").run();
    const row = d.row<{ id: string }>('SELECT id FROM runs WHERE item_id = ?', waiter);
    const card = d.services.context.getContext(d.read(), { id: waiter, budget: 'small' }).wait!;
    expect(card.run_id).toBe(row.id);
    expect(card.next_owner).toMatchObject({ kind: 'owner', name: 'the owner' });
  });

  it('a Ready blocker with no lead gets "dispatch it"', () => {
    const blocker = item('Blocker', true);
    const waiter = item('Waiter', true);
    expect(parkOn(waiter, { items: [blocker] }).wait.next_owner.step).toBe(
      `${blocker}: dispatch it`,
    );
  });
});

describe('routing and advice (decision 45)', () => {
  it('reaches Needs you only when no agent can act, and says why', () => {
    const blocker = item('Blocker');
    const waiter = item('Waiter', true);
    parkOn(waiter, { items: [blocker] }, false);
    d.clock.advance(minutes(WAIT_FLAGS.grace_minutes));
    waitCheckOnce(d.server.runtime);
    const needs = d.services.views.needsYou(d.read(), { scope: 'TST' });
    const row = needs.problems.find((p) => p.kind === 'wait_no_next_step');
    expect(row?.reached_you).toBe(`No coordinator or lead is on ${waiter}`);
    expect(row?.explanation?.who).toBe('owner');
  });

  it('with a coordinator it stays with agents until the shared grace period', () => {
    const blocker = item('Blocker');
    const waiter = item('Waiter', true);
    parkOn(waiter, { items: [blocker] });
    d.clock.advance(minutes(WAIT_FLAGS.grace_minutes));
    waitCheckOnce(d.server.runtime);
    const held = d.services.views.needsYou(d.read(), { scope: 'TST' });
    expect(held.problems.filter((p) => p.kind === 'wait_no_next_step')).toEqual([]);
    expect(held.agent_problems?.map((p) => p.kind)).toContain('wait_no_next_step');
    d.clock.advance(d.server.runtime.config.agentProblemGraceMs);
    const late = d.services.views.needsYou(d.read(), { scope: 'TST' });
    expect(late.problems.find((p) => p.kind === 'wait_no_next_step')?.reached_you).toContain(
      'Not handled by an agent',
    );
  });

  it('blocks nothing: the blocker can still be claimed and moved while flagged', () => {
    const blocker = item('Blocker', true);
    const waiter = item('Waiter', true);
    parkOn(waiter, { items: [blocker] });
    d.clock.advance(minutes(WAIT_FLAGS.grace_minutes));
    waitCheckOnce(d.server.runtime);
    expect(flagged()).toHaveLength(1);
    d.write(other, (w, s) => s.runs.claim(w, { id: blocker, agent_label: 'other' }));
    waitCheckOnce(d.server.runtime);
    expect(
      d.rows("SELECT seq FROM events WHERE type = 'run.wait_cleared'"),
      'a live lead ends the condition',
    ).toHaveLength(1);
  });

  it('a check with nothing new writes nothing', () => {
    const blocker = item('Blocker');
    const waiter = item('Waiter', true);
    parkOn(waiter, { items: [blocker] });
    const count = () => d.row<{ n: number }>('SELECT count(*) AS n FROM events').n;
    const before = count();
    waitCheckOnce(d.server.runtime);
    expect(count()).toBe(before);
  });

  it('a flag clears when its run stays out of its park, and when it ends', () => {
    const blocker = item('Blocker');
    const waiter = item('Waiter', true);
    const { run_id } = parkOn(waiter, { items: [blocker] });
    d.clock.advance(minutes(WAIT_FLAGS.grace_minutes));
    waitCheckOnce(d.server.runtime);
    d.write(other, (w, s) => s.runs.resume(w, { run_id }));
    waitCheckOnce(d.server.runtime);
    expect(d.rows("SELECT seq FROM events WHERE type = 'run.wait_cleared'")).toHaveLength(0);
    d.clock.advance(minutes(WAIT_FLAGS.repark_minutes));
    waitCheckOnce(d.server.runtime);
    expect(d.rows("SELECT seq FROM events WHERE type = 'run.wait_cleared'")).toHaveLength(1);
    expect(
      d.row<{ wait_flags: string | null }>('SELECT wait_flags FROM runs WHERE id = ?', run_id)
        .wait_flags,
    ).toBeNull();
  });
});

describe('token cost (B48 budgets)', () => {
  it('keeps the context and the digest inside their caps with many waiting runs', () => {
    const blocker = item('Blocker '.repeat(10));
    for (let n = 0; n < 12; n += 1) {
      const waiter = item(`Waiter ${n} `.repeat(8), true);
      const a = d.agent('claude', { label: `worker-${n}`, session_id: `s-${n}` });
      const { run_id } = d.write(a, (w, s) =>
        s.runs.claim(w, {
          id: waiter,
          agent_label: `worker-${n}`,
          orchestrator: { name: 'a-long-coordinator-name', dispatch_id: `ctx_${n}` },
        }),
      );
      blocks(blocker, waiter);
      d.write({ ...a, run_id }, (w, s) =>
        s.runs.park(w, { run_id, reason: 'Waiting', waiting_on: { items: [blocker] } }),
      );
    }
    d.clock.advance(minutes(WAIT_FLAGS.grace_minutes));
    waitCheckOnce(d.server.runtime);
    const now = d.clock.now();
    const small = d.services.context.getContext(d.read(), { id: blocker, budget: 'small' });
    expect(small.waiting_runs?.total).toBe(12);
    expect(small.waiting_runs?.rows).toHaveLength(WAIT_FLAGS.context_waiters);
    expect(renderContext(small, { now }).length).toBeLessThanOrEqual(4_000);
    const digest = d.services.digest.get(d.read(), { project: 'TST' });
    const text = renderResult('get_digest', digest, { now, args: { project: 'TST' } });
    expect(text.length).toBeLessThanOrEqual(DIGEST_MAX_CHARS);
    expect(text).toContain('wait_no_next_step');
  });
});

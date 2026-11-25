import { renderResult } from '@docket/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../../src/domain/write.js';
import { projectPause } from '../../src/domain/project-pause.js';
import { addProject, forceStatus, startDomain, type Domain } from '../us1-helpers.js';

let d: Domain;
let worker: Actor;
let coordinator: Actor;

beforeEach(() => {
  d = startDomain({ seed: false });
  addProject(d, 'TST');
  worker = d.agent('codex', { label: 'worker' });
  coordinator = d.agent('codex', { label: 'coordinator' });
});
afterEach(() => d.cleanup());

function item(title: string) {
  const { id } = d.write(coordinator, (w, s) =>
    s.items.create(w, {
      project: 'TST',
      type: 'Implementation',
      title,
      priority: 2,
      status: 'planning',
    }),
  );
  forceStatus(d, id, 'ready');
  return id;
}

function parked(id: string, waiting_on: Record<string, unknown>, name = 'orca') {
  const { run_id } = d.write(worker, (w, s) =>
    s.runs.claim(w, {
      id,
      agent_label: 'worker',
      orchestrator: { name, dispatch_id: `ctx_${id}` },
    }),
  );
  d.write({ ...worker, run_id }, (w, s) =>
    s.runs.park(w, {
      run_id,
      reason: 'Waiting for a verified relay',
      waiting_on,
    }),
  );
  return run_id;
}

function problems() {
  return d.services.views.needsYou(d.read(), { scope: 'TST' }).problems;
}

describe('parked orchestration custody', () => {
  it('names the missing coordinator wake in Needs you and the digest, without resuming GF-457', () => {
    const gf457 = item('GF-457 rollout');
    const run = parked(gf457, { orchestrator: true });
    const p = problems().find((x) => x.kind === 'wait_missing_wake');
    expect(p).toMatchObject({ item_id: gf457, run_id: run });
    expect(p?.explanation?.fix).toContain('record an external wake event');
    const digest = d.services.digest.get(d.read(), { project: 'TST' });
    expect(digest.problems.rows).toContainEqual(
      expect.objectContaining({ kind: 'wait_missing_wake', item_id: gf457 }),
    );
    expect(d.row<{ state: string }>('SELECT state FROM runs WHERE id = ?', run).state).toBe(
      'parked',
    );
    d.clock.advance(d.server.runtime.config.parkMaxMs);
    expect(
      problems()
        .filter((x) => x.run_id === run)
        .map((x) => x.kind),
    ).toEqual(['wait_missing_wake']);
  });

  it('detects GF-231 waiting for GF-457 when GF-457 names GF-231 as its wake; all item waits still apply', () => {
    const gf231 = item('GF-231 producer');
    const gf457 = item('GF-457 rollout');
    const gf459 = item('GF-459 diagnostic');
    const due_at = new Date(d.clock.now().getTime() + 3_600_000).toISOString();
    const rollout = parked(gf457, {
      orchestrator: true,
      wake: {
        actor: 'orca',
        event: 'GF-231 completes',
        due_at,
        source_item: gf231,
      },
    });
    const producer = parked(gf231, { items: [gf459, gf457] });
    expect(problems().filter((p) => p.kind === 'wait_missing_wake')).toEqual([
      expect.objectContaining({
        item_id: gf457,
        reason: expect.stringContaining('depends on this parked item'),
      }),
    ]);
    d.write(coordinator, (w, s) =>
      s.runs.updateStatus(w, {
        id: gf457,
        coordinator: 'orca',
        waiting_on: {
          orchestrator: true,
          wake: { actor: 'orca', event: 'GF-459 reviewed report', due_at, source_item: gf459 },
        },
      }),
    );
    expect(problems().some((p) => p.kind === 'wait_missing_wake')).toBe(false);
    forceStatus(d, gf459, 'done');
    const card = d.services.context.getContext(d.read(), { id: gf231, budget: 'small' }).wait!;
    expect(card.resume_ready).toBe(false);
    expect(card.resumes_when).toContain('every listed item clears');
    expect(d.row<{ state: string }>('SELECT state FROM runs WHERE id = ?', producer).state).toBe(
      'parked',
    );
    expect(d.row<{ state: string }>('SELECT state FROM runs WHERE id = ?', rollout).state).toBe(
      'parked',
    );
  });

  it.each([
    'failed',
    'exited',
    'supervisor_unavailable',
    'supervisor_disabled',
    'supervisor_missing_target',
  ] as const)(
    'reports %s as distinct custody evidence, then clears after a verified live handoff',
    (state) => {
      const gf457 = item('GF-457 rollout');
      const due_at = new Date(d.clock.now().getTime() + 3_600_000).toISOString();
      const run = parked(gf457, {
        orchestrator: true,
        wake: { actor: 'orca', event: 'GF-459 report', due_at },
      });
      d.write(coordinator, (w, s) =>
        s.runs.updateStatus(w, {
          id: gf457,
          coordinator: 'orca',
          dispatch_observation: {
            claimed_run: run,
            dispatch_id: `ctx_${gf457}`,
            state,
          },
        }),
      );
      expect(problems()).toContainEqual(
        expect.objectContaining({
          kind: 'dispatch_custody',
          run_id: run,
        }),
      );
      expect(d.services.digest.get(d.read(), { project: 'TST' }).problems.rows).toContainEqual(
        expect.objectContaining({ kind: 'dispatch_custody' }),
      );
      d.write(coordinator, (w, s) =>
        s.runs.updateStatus(w, {
          id: gf457,
          coordinator: 'orca',
          dispatch_observation: {
            claimed_run: run,
            dispatch_id: 'ctx_verified_handoff',
            state: 'live',
          },
        }),
      );
      expect(problems().some((p) => p.kind === 'dispatch_custody')).toBe(false);
      expect(d.row<{ state: string }>('SELECT state FROM runs WHERE id = ?', run).state).toBe(
        'parked',
      );
    },
  );

  it('keeps a named future reviewer wake quiet, and never infers liveness from silence', () => {
    const gf457 = item('GF-457 host hold');
    const due_at = new Date(d.clock.now().getTime() + 3_600_000).toISOString();
    parked(gf457, {
      orchestrator: true,
      wake: { actor: 'reviewer', event: 'host HOLD review', due_at },
    });
    expect(
      problems().filter((p) => ['wait_missing_wake', 'dispatch_custody'].includes(p.kind)),
    ).toEqual([]);
    const digest = d.services.digest.get(d.read(), { project: 'TST' });
    const text = renderResult('get_digest', digest, {
      now: d.clock.now(),
      args: { project: 'TST' },
    });
    expect(text).toContain('reviewer');
  });

  it('shows a disappeared wake source, without changing a project freeze or its parked claim', () => {
    const source = item('GF-459 report');
    const gf457 = item('GF-457 host hold');
    const due_at = new Date(d.clock.now().getTime() + 3_600_000).toISOString();
    const run = parked(gf457, {
      orchestrator: true,
      wake: { actor: 'reviewer', event: 'host HOLD review', due_at, source_item: source },
    });
    forceStatus(d, source, 'canceled');
    const owner: Actor = {
      kind: 'owner',
      client: null,
      label: null,
      session_id: null,
      run_id: null,
    };
    d.write(owner, (w, s) =>
      s.projects.pause(w, { key: 'TST', reason: 'Keep this project frozen.' }),
    );
    expect(problems()).toContainEqual(
      expect.objectContaining({
        kind: 'wait_missing_wake',
        reason: expect.stringContaining(`wake source ${source} is unavailable`),
      }),
    );
    expect(d.row<{ state: string }>('SELECT state FROM runs WHERE id = ?', run).state).toBe(
      'parked',
    );
    expect(projectPause(d.server.runtime.db, 'TST')).not.toBeNull();
  });
});

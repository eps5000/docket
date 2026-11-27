import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../../src/domain/write.js';
import {
  auditFreshAt,
  ENDED_RESOURCE_AUDIT_FRESH_MS,
  PARKED_AUDIT_FRESH_MS,
  resourceRotationBoundMs,
} from '../../src/domain/orca-audit-freshness.js';
import { addProject, forceStatus, startDomain, type Domain } from '../us1-helpers.js';

const source = await import(
  /* @vite-ignore */ pathToFileURL(
    join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      '..',
      'tools',
      'docket-sync',
      'sources',
      'orca-audit.mjs',
    ),
  ).href
);
const now = new Date('2026-11-26T19:30:00.000Z');

describe('Orca audit freshness policy', () => {
  it('rotates 7 parked and 68 ended targets within strict worst-case windows', () => {
    const targets = Array.from({ length: 75 }, (_, index) => ({
      run_id: `run_${index}`,
      dispatch_id: `ctx_${index}`,
      state: index % 11 === 0 ? 'parked' : 'finished',
      path: `C:/audit/${index}`,
      main_branch: 'main',
    }));
    const parked = targets.filter((target) => target.state === 'parked');
    expect(parked).toHaveLength(7);
    let state: { ended?: string[] } = {};
    const lastObserved = new Map<string, number>();
    const visits = new Map<string, number>();
    // Runner starts the next pass after a single POST (30 s timeout) and its interval.
    const passMs = 90_000 + 30_000 + source.intervalMs;
    for (let pass = 0; pass < 12; pass += 1) {
      const selected = source.selectTargets(pass % 2 ? [...targets].reverse() : targets, state);
      state = selected.state;
      expect(selected.batch).toHaveLength(24);
      expect(
        new Set(selected.batch.map((target: { dispatch_id: string }) => target.dispatch_id)).size,
      ).toBe(24);
      expect(
        selected.batch.filter((target: { state: string }) => target.state === 'parked'),
      ).toHaveLength(7);
      for (const target of selected.batch) {
        const previous = lastObserved.get(target.dispatch_id);
        if (previous !== undefined) {
          // Previous observation at pass start, next one at the 90-second deadline.
          const worstGap = pass * passMs + 90_000 - previous;
          expect(worstGap).toBeLessThan(
            target.state === 'parked' ? PARKED_AUDIT_FRESH_MS : ENDED_RESOURCE_AUDIT_FRESH_MS,
          );
        }
        lastObserved.set(target.dispatch_id, pass * passMs);
        visits.set(target.dispatch_id, (visits.get(target.dispatch_id) ?? 0) + 1);
      }
      if (pass === 3) expect(lastObserved.size).toBe(75);
    }
    expect([...visits.values()].every((count) => count >= 2)).toBe(true);
    expect(Math.ceil(24 / source.auditConcurrency) * (source.targetLimitMs + 1_000)).toBeLessThan(
      90_000,
    );
    expect(
      Math.ceil(24 / source.auditConcurrency) * (source.targetLimitMs + 1_000) + 30_000,
    ).toBeLessThan(90_000);
  });

  it('prioritizes all states with the 5-minute server window and fails closed above capacity', () => {
    const targets = Array.from({ length: 69 }, (_, index) => ({
      run_id: `run_${index}`,
      dispatch_id: `ctx_${index}`,
      state: index < 7 ? 'parked' : index === 7 ? 'open' : index === 8 ? 'needs_input' : 'finished',
    }));
    const selected = source.selectTargets(targets, {});
    expect(selected.batch).toHaveLength(24);
    expect(
      selected.batch
        .slice(0, 9)
        .every((target: { state: string }) =>
          ['parked', 'open', 'needs_input'].includes(target.state),
        ),
    ).toBe(true);
    expect(() => source.selectTargets(targets, {}, true)).toThrow('Audit inventory incomplete');
    expect(() => source.selectTargets([targets[0], targets[0]], {})).toThrow(
      'Audit inventory invalid',
    );
    expect(() => source.selectTargets([{ ...targets[0], state: 'unknown' }], {})).toThrow(
      'Audit inventory invalid',
    );
    expect(() =>
      source.selectTargets(
        [
          ...targets,
          ...targets.slice(0, 6).map((target, index) => ({
            ...target,
            run_id: `run_extra_${index}`,
            dispatch_id: `ctx_extra_${index}`,
            state: 'finished',
          })),
        ],
        {},
      ),
    ).toThrow('Audit capacity exceeded');
  });

  it('covers the measured 66-target rotation and the bounded 80-target inventory', () => {
    // The server's historical rotation bound stays unchanged by this source-only fix.
    expect(source.batchSize).toBe(24);
    expect(source.intervalMs).toBe(60_000);
    expect(resourceRotationBoundMs(64)).toBe(10 * 60_000);
    expect(resourceRotationBoundMs(65)).toBe(12 * 60_000 + 30_000);
    expect(resourceRotationBoundMs(66)).toBe(12 * 60_000 + 30_000);
    expect(resourceRotationBoundMs(80)).toBe(12 * 60_000 + 30_000);
    expect(ENDED_RESOURCE_AUDIT_FRESH_MS - resourceRotationBoundMs(80)!).toBe(2 * 60_000 + 30_000);
    expect(resourceRotationBoundMs(81)).toBeNull(); // The helper refuses overflow.
    expect(PARKED_AUDIT_FRESH_MS).toBe(5 * 60_000);
  });

  it('rejects expired, future and invalid observations', () => {
    const at = now.toISOString();
    expect(
      auditFreshAt(
        at,
        new Date(now.getTime() + 6 * 60_000).toISOString(),
        ENDED_RESOURCE_AUDIT_FRESH_MS,
      ),
    ).toBe(true);
    expect(
      auditFreshAt(
        at,
        new Date(now.getTime() + ENDED_RESOURCE_AUDIT_FRESH_MS + 1).toISOString(),
        ENDED_RESOURCE_AUDIT_FRESH_MS,
      ),
    ).toBe(false);
    expect(
      auditFreshAt(
        new Date(now.getTime() + 5_001).toISOString(),
        at,
        ENDED_RESOURCE_AUDIT_FRESH_MS,
      ),
    ).toBe(false);
    expect(auditFreshAt('invalid', at, ENDED_RESOURCE_AUDIT_FRESH_MS)).toBe(false);
  });
});

describe('bounded Orca resource projection', () => {
  it('reads a workspace only after exact Orca dispatch, run and path custody agree', async () => {
    const path = 'C:/Users/test/orca/workspaces/project/worker';
    const target = {
      run_id: 'run_docket',
      dispatch_id: 'ctx_exact',
      path,
      main_branch: 'main',
    };
    const worker = {
      dispatch: { id: 'ctx_exact', runId: 'run_orca_parent' },
      worker: {
        dispatchId: 'ctx_exact',
        worktreeId: `repo::${path}`,
      },
      projection: {
        id: 'ctx_exact',
        dispatchId: 'ctx_exact',
        runId: 'run_orca_parent',
        workspace: { id: `repo::${path}` },
        outcome: 'in_progress',
        liveness: { verdict: 'live' },
      },
      terminalResource: { worktreeId: `repo::${path}` },
    };
    let scans = 0;
    const scan = async (seenPath: string) => {
      scans += 1;
      expect(seenPath).toBe(path);
      return {
        worktree: 'in-progress',
        terminals: 0,
        processes: { count: 0, read: true },
        artifacts: 'clean',
      };
    };
    expect((await source.collectTarget(target, worker, scan, now.toISOString())).liveness).toBe(
      'live',
    );
    expect(scans).toBe(1);
    for (const [changedTarget, changedWorker] of [
      [{ ...target, path: 'C:/Users/test/private' }, worker],
      [target, { ...worker, dispatch: { ...worker.dispatch, id: 'ctx_other' } }],
      [target, { ...worker, projection: { ...worker.projection, dispatchId: 'ctx_other' } }],
      [target, { ...worker, projection: { ...worker.projection, runId: 'run_other' } }],
      [target, { ...worker, worker: { ...worker.worker, worktreeId: 'repo::C:/other' } }],
      [target, { ...worker, terminalResource: { worktreeId: 'repo::C:/other' } }],
      [target, null],
    ] as const) {
      const result = await source.collectTarget(
        changedTarget,
        changedWorker,
        scan,
        now.toISOString(),
      );
      expect(result).toMatchObject({
        liveness: 'unknown',
        worktree_status: 'unknown',
        process_read: false,
        artifacts: 'unknown',
      });
      expect(scans).toBe(1);
    }
  });

  it('drops chat text and process identity, while preserving custody categories', () => {
    const record = source.projectAudit(
      { run_id: 'run_test', dispatch_id: 'ctx_test' },
      {
        projection: {
          outcome: 'succeeded',
          liveness: { verdict: 'live' },
          stage: { activity: 'done' },
          secretTranscript: 'private report',
        },
        terminalResource: { releaseState: 'retained' },
      },
      'in-progress',
      1,
      { count: 2, read: true },
      'private',
      now.toISOString(),
    );
    expect(record).toMatchObject({
      outcome: 'succeeded',
      terminal_state: 'retained',
      live_terminals: 1,
      suspected_processes: 2,
      artifacts: 'private',
    });
    expect(JSON.stringify(record)).not.toContain('private report');
  });
});

describe('Docket dispatch resource reconciliation', () => {
  let d: Domain;
  let id: string;
  let run: string;
  let dispatch: string;
  let worker: Actor;
  beforeEach(() => {
    d = startDomain({ seed: false, now });
    addProject(d, 'GF');
    worker = d.agent('codex');
    id = d.write(worker, (w, s) =>
      s.items.create(w, {
        project: 'GF',
        type: 'Implementation',
        title: 'Synthetic rollout',
        priority: 2,
        status: 'planning',
      }),
    ).id;
    forceStatus(d, id, 'ready');
    dispatch = `ctx_${id}`;
    run = d.write(worker, (w, s) =>
      s.runs.claim(w, {
        id,
        orchestrator: { name: 'orca', dispatch_id: dispatch },
      }),
    ).run_id;
  });
  afterEach(() => d.cleanup());

  const record = (over: Record<string, unknown> = {}) => ({
    key: dispatch,
    run_id: run,
    observed_at: d.clock.now().toISOString(),
    outcome: 'in_progress',
    liveness: 'live',
    terminal_state: 'active',
    protected_hold: false,
    agent_state: 'working',
    worktree_status: 'in-progress',
    live_terminals: 0,
    suspected_processes: 0,
    process_read: true,
    artifacts: 'clean',
    ...over,
  });
  const post = (rows: unknown[]) =>
    d.services.sync.ingest(d.server.runtime.write, 'orca-audit', {
      records: rows as never,
      run: { ok: true, interval_ms: 60_000 },
    });
  const problems = () => d.services.views.needsYou(d.read(), { scope: 'GF' }).problems;

  it('refreshes an unchanged observation without a visible status event or write-path failure', () => {
    expect(post([record()])).toMatchObject({ accepted: 1, changed: 1 });
    const first = d.row<{ resource_observation: string }>(
      'SELECT resource_observation FROM runs WHERE id = ?',
      run,
    ).resource_observation;
    d.clock.advance(60_000);
    expect(post([record()])).toMatchObject({ accepted: 1, changed: 0 });
    const second = d.row<{ resource_observation: string }>(
      'SELECT resource_observation FROM runs WHERE id = ?',
      run,
    ).resource_observation;
    expect(Date.parse(JSON.parse(second).observed_at)).toBeGreaterThan(
      Date.parse(JSON.parse(first).observed_at),
    );
    expect(post([record()])).toMatchObject({ accepted: 1, changed: 0 });
    const events = d.sql
      .prepare(
        "SELECT type FROM events WHERE type IN ('run.status_updated', 'sync.ingested') ORDER BY seq",
      )
      .all() as { type: string }[];
    expect(events.map((event) => event.type)).toEqual(['run.status_updated', 'sync.ingested']);
  });

  it('uses a category event for a mixed batch and no quiet event for out-of-order records', () => {
    const firstAt = d.clock.now().toISOString();
    post([record()]);
    d.clock.advance(60_000);
    const changedAt = new Date(d.clock.now().getTime() + 100).toISOString();
    expect(
      post([
        record(),
        record({ observed_at: changedAt, terminal_state: 'released' }),
        record({ key: 'ctx_other' }),
      ]),
    ).toMatchObject({ accepted: 2, changed: 1, ignored: 1 });
    expect(post([record({ observed_at: firstAt })])).toMatchObject({
      accepted: 1,
      changed: 0,
    });
    const events = d.sql
      .prepare(
        "SELECT type FROM events WHERE type IN ('run.status_updated', 'sync.ingested') ORDER BY seq",
      )
      .all() as { type: string }[];
    expect(events.map((event) => event.type)).toEqual(['run.status_updated', 'run.status_updated']);
    expect(
      JSON.parse(
        d.row<{ resource_observation: string }>(
          'SELECT resource_observation FROM runs WHERE id = ?',
          run,
        ).resource_observation,
      ).observed_at,
    ).toBe(changedAt);
  });

  it('emits one quiet event for a partially accepted unchanged batch', () => {
    post([record()]);
    d.clock.advance(60_000);
    expect(post([record(), record({ key: 'ctx_other' })])).toMatchObject({
      accepted: 1,
      changed: 0,
      ignored: 1,
    });
    const events = d.sql
      .prepare(
        "SELECT type FROM events WHERE type IN ('run.status_updated', 'sync.ingested') ORDER BY seq",
      )
      .all() as { type: string }[];
    expect(events.map((event) => event.type)).toEqual(['run.status_updated', 'sync.ingested']);
  });

  it('emits only one quiet event for multiple refreshed runs in a batch', () => {
    const otherItem = d.write(worker, (w, s) =>
      s.items.create(w, {
        project: 'GF',
        type: 'Implementation',
        title: 'Second synthetic rollout',
        priority: 2,
        status: 'planning',
      }),
    ).id;
    forceStatus(d, otherItem, 'ready');
    const otherDispatch = `ctx_${otherItem}`;
    const otherRun = d.write(worker, (w, s) =>
      s.runs.claim(w, {
        id: otherItem,
        orchestrator: { name: 'orca', dispatch_id: otherDispatch },
      }),
    ).run_id;
    const second = () => record({ run_id: otherRun, key: otherDispatch });
    expect(post([record(), second()])).toMatchObject({ accepted: 2, changed: 2 });
    d.clock.advance(60_000);
    expect(post([record(), second()])).toMatchObject({ accepted: 2, changed: 0 });
    const events = d.sql
      .prepare(
        "SELECT type FROM events WHERE type IN ('run.status_updated', 'sync.ingested') ORDER BY seq",
      )
      .all() as { type: string }[];
    expect(events.map((event) => event.type)).toEqual([
      'run.status_updated',
      'run.status_updated',
      'sync.ingested',
    ]);
  });

  it('exposes the exact run state and update time for a single-dispatch reconciler', () => {
    const settings = d.services.sync.source(d.read(), 'orca-audit').settings;
    expect(settings.targets).toContainEqual(
      expect.objectContaining({
        run_id: run,
        dispatch_id: dispatch,
        state: 'open',
        updated_at: expect.any(String),
      }),
    );
  });

  it('surfaces a lost worker while the parked claim stays live, and clears after a verified live handoff', () => {
    d.write({ ...worker, run_id: run }, (w, s) =>
      s.runs.park(w, {
        run_id: run,
        reason: 'Waiting on a reviewer',
        waiting_on: {
          orchestrator: true,
          wake: {
            actor: 'reviewer',
            event: 'review report',
            due_at: new Date(now.getTime() + 3_600_000).toISOString(),
          },
        },
      }),
    );
    expect(
      post([record({ outcome: 'failed', liveness: 'lost', agent_state: 'done' })]),
    ).toMatchObject({ accepted: 1, changed: 1 });
    expect(problems()).toContainEqual(
      expect.objectContaining({ kind: 'dispatch_custody', run_id: run }),
    );
    expect(d.row<{ state: string }>('SELECT state FROM runs WHERE id = ?', run).state).toBe(
      'parked',
    );
    d.clock.advance(6 * 60_000);
    expect(problems()).toContainEqual(
      expect.objectContaining({
        kind: 'dispatch_custody',
        reason: expect.stringContaining('audit stale'),
      }),
    );
    expect(post([record()])).toMatchObject({ accepted: 1, changed: 1 });
    expect(problems().some((p) => p.kind === 'dispatch_custody')).toBe(false);
  });

  it('reports a completed agent with a live terminal and possible child, preserving private artifacts', () => {
    d.sql
      .prepare("UPDATE runs SET state = 'finished', updated_at = ? WHERE id = ?")
      .run(new Date(now.getTime() - 3 * 60_000).toISOString(), run);
    post([
      record({
        outcome: 'succeeded',
        agent_state: 'done',
        terminal_state: 'retained',
        live_terminals: 1,
        suspected_processes: 1,
        artifacts: 'private',
      }),
    ]);
    expect(problems()).toContainEqual(
      expect.objectContaining({
        kind: 'dispatch_resources',
        run_id: run,
        reason: expect.stringContaining('private artifacts retained'),
      }),
    );
    const inventory = d.services.digest.get(d.read(), { project: 'GF' }).resource_inventory;
    expect(inventory?.rows.rows).toContainEqual(
      expect.objectContaining({
        run_id: run,
        state: 'completed',
        suspected_processes: 1,
      }),
    );
    d.clock.advance(6 * 60_000);
    expect(problems()).toContainEqual(
      expect.objectContaining({
        kind: 'dispatch_resources',
        reason: expect.not.stringContaining('audit stale'),
      }),
    );
    expect(
      d.services.digest.get(d.read(), { project: 'GF' }).resource_inventory?.rows.rows,
    ).toContainEqual(expect.objectContaining({ run_id: run, stale: false, artifacts: 'private' }));
    d.clock.advance(9 * 60_000 + 1);
    expect(problems()).toContainEqual(
      expect.objectContaining({
        kind: 'dispatch_resources',
        reason: expect.stringContaining('audit stale'),
      }),
    );
    expect(
      d.services.digest.get(d.read(), { project: 'GF' }).resource_inventory?.rows.rows,
    ).toContainEqual(expect.objectContaining({ run_id: run, stale: true, artifacts: 'unknown' }));
    d.clock.advance(1_000);
    post([
      record({
        outcome: 'succeeded',
        agent_state: 'done',
        terminal_state: 'released',
        worktree_status: 'completed',
        artifacts: 'private',
      }),
    ]);
    expect(problems().some((p) => p.kind === 'dispatch_resources')).toBe(false);
    expect(
      d.row<{ resource_observation: string }>(
        'SELECT resource_observation FROM runs WHERE id = ?',
        run,
      ).resource_observation,
    ).toContain('private');
  });

  it('rejects mismatched dispatches and stale observations; a legitimate park stays quiet', () => {
    d.write({ ...worker, run_id: run }, (w, s) =>
      s.runs.park(w, {
        run_id: run,
        reason: 'Intentional hold',
        waiting_on: { person: true },
      }),
    );
    expect(
      post([
        record({ key: 'ctx_other' }),
        record({
          observed_at: new Date(now.getTime() - 120_000).toISOString(),
        }),
      ]),
    ).toMatchObject({ ignored: 2 });
    expect(post([record()])).toMatchObject({ accepted: 1 });
    expect(
      problems().filter((p) => ['dispatch_custody', 'dispatch_resources'].includes(p.kind)),
    ).toEqual([]);
  });

  it('refuses a fifth active Orca worker claim, while a parked claim frees a slot', () => {
    const next = () => {
      const other = d.write(worker, (w, s) =>
        s.items.create(w, {
          project: 'GF',
          type: 'Implementation',
          title: 'More synthetic work',
          priority: 2,
          status: 'planning',
        }),
      ).id;
      forceStatus(d, other, 'ready');
      return other;
    };
    const claims: string[] = [];
    for (let n = 0; n < 3; n += 1) {
      const other = next();
      claims.push(
        d.write(worker, (w, s) =>
          s.runs.claim(w, {
            id: other,
            orchestrator: { name: 'orca', dispatch_id: `ctx_extra_${n}` },
          }),
        ).run_id,
      );
    }
    const fifth = next();
    expect(() =>
      d.write(worker, (w, s) =>
        s.runs.claim(w, {
          id: fifth,
          orchestrator: { name: 'orca', dispatch_id: 'ctx_fifth' },
        }),
      ),
    ).toThrow('admission is full');
    d.write({ ...worker, run_id: claims[0] }, (w, s) =>
      s.runs.park(w, {
        run_id: claims[0]!,
        reason: 'Intentional wait',
        waiting_on: { person: true },
      }),
    );
    expect(
      d.write(worker, (w, s) =>
        s.runs.claim(w, {
          id: fifth,
          orchestrator: { name: 'orca', dispatch_id: 'ctx_fifth' },
        }),
      ).run_id,
    ).toMatch(/^run_/);
  });

  it('keeps unknown process and worktree custody visible after completion', () => {
    d.sql
      .prepare("UPDATE runs SET state = 'finished', updated_at = ? WHERE id = ?")
      .run(new Date(now.getTime() - 3 * 60_000).toISOString(), run);
    post([
      record({
        outcome: 'succeeded',
        terminal_state: 'released',
        agent_state: 'done',
        worktree_status: 'unknown',
        process_read: false,
        artifacts: 'unknown',
      }),
    ]);
    expect(problems()).toContainEqual(
      expect.objectContaining({
        kind: 'dispatch_resources',
        reason: expect.stringContaining('process inventory unknown'),
      }),
    );
  });

  it('preserves a requested retained agent and its private artifacts', () => {
    d.sql
      .prepare("UPDATE runs SET state = 'finished', updated_at = ? WHERE id = ?")
      .run(new Date(now.getTime() - 3 * 60_000).toISOString(), run);
    post([
      record({
        outcome: 'succeeded',
        terminal_state: 'retained',
        protected_hold: true,
        agent_state: 'done',
        worktree_status: 'in-progress',
        artifacts: 'private',
      }),
    ]);
    expect(problems().some((p) => p.kind === 'dispatch_resources')).toBe(false);
    expect(
      d.services.digest.get(d.read(), { project: 'GF' }).resource_inventory?.rows.rows,
    ).toContainEqual(expect.objectContaining({ protected_hold: true, artifacts: 'private' }));
  });

  it('enforces two active Orca ticket workers per Epic', () => {
    const epic = d.write(worker, (w, s) =>
      s.items.create(w, {
        project: 'GF',
        type: 'Epic',
        title: 'Synthetic Epic',
        priority: 2,
        status: 'planning',
      }),
    ).id;
    d.sql.prepare('UPDATE items SET epic_id = ? WHERE id = ?').run(epic, id);
    const next = () => {
      const other = d.write(worker, (w, s) =>
        s.items.create(w, {
          project: 'GF',
          type: 'Implementation',
          title: 'Epic work',
          priority: 2,
          status: 'planning',
          epic,
        }),
      ).id;
      forceStatus(d, other, 'ready');
      return other;
    };
    const second = next();
    d.write(worker, (w, s) =>
      s.runs.claim(w, {
        id: second,
        orchestrator: { name: 'orca', dispatch_id: 'ctx_second' },
      }),
    );
    const third = next();
    expect(() =>
      d.write(worker, (w, s) =>
        s.runs.claim(w, {
          id: third,
          orchestrator: { name: 'orca', dispatch_id: 'ctx_third' },
        }),
      ),
    ).toThrow('admission is full');
  });
});

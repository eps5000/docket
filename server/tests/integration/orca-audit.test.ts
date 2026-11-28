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
  it('enforces a hard collection deadline without overlapping a draining read', async () => {
    let finish: (value: unknown) => void = () => {};
    let aborted = false;
    const pending = source.collectBounded(
      [1],
      (_target: unknown, signal: AbortSignal) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => {
            aborted = true;
          });
          finish = resolve;
        }),
      undefined,
      10,
    );
    await expect(pending).rejects.toMatchObject({ code: 'audit_timeout' });
    expect(aborted).toBe(true);
    await expect(source.collectBounded([2], async () => 2, undefined, 10)).rejects.toMatchObject({
      code: 'audit_busy',
    });
    finish(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await source.collectBounded([3], async () => 3, undefined, 10)).toEqual([3]);
  });

  it('aborts on an unexpected audit rejection and waits for siblings to drain', async () => {
    let releaseSibling: (value: number) => void = () => {};
    let siblingAborted = false;
    const pending = source.collectBounded(
      [0, 1],
      (target: number, signal: AbortSignal) =>
        target === 0
          ? Promise.reject(new Error('unexpected audit failure'))
          : new Promise<number>((resolve) => {
              releaseSibling = resolve;
              signal.addEventListener('abort', () => {
                siblingAborted = true;
              });
            }),
      undefined,
      1_000,
    );
    try {
      await expect(pending).rejects.toThrow('unexpected audit failure');
      expect(siblingAborted).toBe(true);
      await expect(source.collectBounded([2], async () => 2, undefined, 10)).rejects.toMatchObject({
        code: 'audit_busy',
      });
    } finally {
      releaseSibling(1);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(await source.collectBounded([3], async () => 3, undefined, 10)).toEqual([3]);
  });

  it('rotates the observed 13 prompt-custody and 116 ended targets within strict windows', () => {
    const targets = Array.from({ length: 129 }, (_, index) => ({
      run_id: `run_${index}`,
      dispatch_id: `ctx_${index}`,
      state: index < 13 ? 'parked' : 'finished',
      path: `C:/audit/${index}`,
      main_branch: 'main',
    }));
    const parked = targets.filter((target) => target.state === 'parked');
    expect(parked).toHaveLength(13);
    let state: { ended?: string[] } = {};
    const lastObserved = new Map<string, number>();
    const visits = new Map<string, number>();
    // The isolated lane adds bounded settings read, collect, one POST and its interval.
    const passMs = 15_000 + source.collectionLimitMs + 30_000 + source.intervalMs;
    expect(passMs).toBe(185_000);
    expect(passMs + 95_000).toBeLessThan(PARKED_AUDIT_FRESH_MS);
    expect(4 * passMs + 95_000).toBeLessThan(ENDED_RESOURCE_AUDIT_FRESH_MS);
    for (let pass = 0; pass < 12; pass += 1) {
      const selected = source.selectTargets(pass % 2 ? [...targets].reverse() : targets, state);
      state = selected.state;
      expect(selected.batch).toHaveLength(51);
      expect(
        new Set(selected.batch.map((target: { dispatch_id: string }) => target.dispatch_id)).size,
      ).toBe(51);
      expect(
        selected.batch.filter((target: { state: string }) => target.state === 'parked'),
      ).toHaveLength(13);
      for (const target of selected.batch) {
        const previous = lastObserved.get(target.run_id);
        if (previous !== undefined) {
          // Previous observation at pass start, next after settings and collection limits.
          const worstGap = pass * passMs + 15_000 + source.collectionLimitMs - previous;
          expect(worstGap).toBeLessThan(
            target.state === 'parked' ? PARKED_AUDIT_FRESH_MS : ENDED_RESOURCE_AUDIT_FRESH_MS,
          );
        }
        lastObserved.set(target.run_id, pass * passMs);
        visits.set(target.run_id, (visits.get(target.run_id) ?? 0) + 1);
      }
      if (pass === 3) expect(lastObserved.size).toBe(129);
    }
    expect([...visits.values()].every((count) => count >= 2)).toBe(true);
    expect(source.independent).toBe(true);
    expect(source.collectionLimitMs).toBeLessThan(90_000);
    expect(source.auditConcurrency).toBe(17);
    expect(Math.ceil(51 / source.auditConcurrency) * (source.targetLimitMs + 1_000)).toBeLessThan(
      source.collectionLimitMs,
    );
    expect(
      Math.ceil(51 / source.auditConcurrency) * (source.targetLimitMs + 1_000) + 30_000,
    ).toBeLessThan(90_000);
  });

  it('prioritizes all states with the 5-minute server window and fails closed above capacity', () => {
    const targets = Array.from({ length: 69 }, (_, index) => ({
      run_id: `run_${index}`,
      dispatch_id: `ctx_${index}`,
      state: index < 7 ? 'parked' : index === 7 ? 'open' : index === 8 ? 'needs_input' : 'finished',
    }));
    const selected = source.selectTargets(targets, {});
    expect(selected.batch).toHaveLength(51);
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
    const growth = Array.from({ length: 160 }, (_, index) => ({
      run_id: `run_growth_${index}`,
      dispatch_id: `ctx_growth_${index}`,
      state: index < 16 ? 'parked' : 'finished',
    }));
    // 144 ended / 35 slots needs five passes, despite fitting the 160-target settings cap.
    expect(() => source.selectTargets(growth, {})).toThrow('Audit capacity exceeded');
    expect(
      source.selectTargets(
        growth.slice(0, 51).map((target) => ({ ...target, state: 'parked' })),
        {},
      ).batch,
    ).toHaveLength(51);
    expect(() =>
      source.selectTargets(
        growth.slice(0, 52).map((target) => ({ ...target, state: 'parked' })),
        {},
      ),
    ).toThrow('Audit capacity exceeded');
    const bounded = growth.map((target, index) => ({
      ...target,
      state: index < 13 ? 'parked' : 'finished',
    }));
    expect(source.selectTargets(bounded, {}).batch).toHaveLength(51);
    expect(() =>
      source.selectTargets(
        [...bounded, { run_id: 'run_extra', dispatch_id: 'ctx_extra', state: 'finished' }],
        {},
      ),
    ).toThrow('Audit inventory incomplete');
  });

  it('keeps distinct historical runs sharing one dispatch separate', () => {
    const targets = [
      { run_id: 'run_first', dispatch_id: 'ctx_shared', state: 'finished' },
      { run_id: 'run_second', dispatch_id: 'ctx_shared', state: 'failed' },
    ];
    const first = source.selectTargets(targets, {});
    expect(first.batch.map((target: { run_id: string }) => target.run_id)).toEqual([
      'run_first',
      'run_second',
    ]);
    expect(() => source.selectTargets([{ ...targets[0] }, { ...targets[0] }], {})).toThrow(
      'Audit inventory invalid',
    );
  });

  it('accepts the schedulable 160 boundary and rejects 161 or unschedulable distributions', () => {
    const roster = (prompt: number, ended: number) =>
      Array.from({ length: prompt + ended }, (_, index) => ({
        run_id: `run_boundary_${index}`,
        dispatch_id: `ctx_boundary_${index}`,
        state: index < prompt ? 'parked' : 'finished',
      }));
    for (const [prompt, ended] of [
      [13, 147],
      [16, 140],
    ] as const) {
      const targets = roster(prompt, ended);
      let state: { ended?: string[] } = {};
      const visited = new Set<string>();
      for (let pass = 0; pass < 4; pass += 1) {
        const selected = source.selectTargets(targets, state);
        expect(selected.batch).toHaveLength(51);
        expect(
          selected.batch
            .slice(0, prompt)
            .every((target: { state: string }) => target.state === 'parked'),
        ).toBe(true);
        selected.batch.forEach((target: { run_id: string }) => visited.add(target.run_id));
        state = selected.state;
      }
      expect(visited.size).toBe(targets.length);
    }
    expect(() => source.selectTargets(roster(13, 148))).toThrow('Audit inventory incomplete');
    expect(() => source.selectTargets(roster(16, 141))).toThrow('Audit capacity exceeded');
    expect(() => source.selectTargets(roster(17, 143))).toThrow('Audit capacity exceeded');
    expect(() => source.selectTargets(roster(52, 0))).toThrow('Audit capacity exceeded');
    expect(() => source.selectTargets(roster(13, 116), {}, true)).toThrow(
      'Audit inventory incomplete',
    );
  });

  it('runs 51 observations in exactly three bounded waves of 17 lanes', async () => {
    const releases: (() => void)[] = [];
    let active = 0;
    let peak = 0;
    let started = 0;
    const pending = source.collectBounded(
      Array.from({ length: 51 }, (_, index) => index),
      async (target: number) => {
        active += 1;
        started += 1;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active -= 1;
        return target;
      },
      undefined,
      10_000,
    );
    void pending.catch(() => {});
    for (let wave = 1; wave <= 3; wave += 1) {
      expect(started).toBe(wave * 17);
      expect(active).toBe(17);
      releases.splice(0).forEach((release) => release());
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(await pending).toEqual(Array.from({ length: 51 }, (_, index) => index));
    expect(peak).toBe(17);
    expect(3 * (source.targetLimitMs + 1_000)).toBe(54_000);
    expect(54_000).toBeLessThan(source.collectionLimitMs);
  });

  it('rejects a first-wave observation at 55 seconds before POST', () => {
    const at = Date.parse(now.toISOString());
    const record = (age: number) => [{ observed_at: new Date(at - age).toISOString() }];
    expect(source.observationsFreshForPost(record(54_999), at)).toBe(true);
    expect(54_999 + 30_000).toBeLessThan(90_000);
    expect(source.observationsFreshForPost(record(55_000), at)).toBe(false);
    expect(source.observationsFreshForPost([{ observed_at: 'invalid' }], at)).toBe(false);
  });

  it('preserves the server historical freshness policy while the source admits 160 targets', () => {
    // The server's historical conservative helper remains unchanged.
    expect(source.batchSize).toBe(51);
    expect(source.intervalMs).toBe(60_000);
    expect(resourceRotationBoundMs(64)).toBe(10 * 60_000);
    expect(resourceRotationBoundMs(65)).toBe(12 * 60_000 + 30_000);
    expect(resourceRotationBoundMs(66)).toBe(12 * 60_000 + 30_000);
    expect(resourceRotationBoundMs(80)).toBe(12 * 60_000 + 30_000);
    expect(ENDED_RESOURCE_AUDIT_FRESH_MS - resourceRotationBoundMs(80)!).toBe(2 * 60_000 + 30_000);
    expect(resourceRotationBoundMs(81)).toBeNull(); // Historical server helper, not source capacity.
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
  it('accepts typed CLI errors only after a completed exit', () => {
    const stdout = JSON.stringify({ ok: false, error: { code: 'selector_not_found' } });
    expect(source.completedOrcaFailure({ code: 1, killed: false, signal: null }, stdout)).toBe(
      true,
    );
    expect(source.completedOrcaFailure({ code: 1, killed: true, signal: 'SIGTERM' }, stdout)).toBe(
      false,
    );
    expect(source.completedOrcaFailure({ code: 1, killed: false, signal: 'SIGTERM' }, stdout)).toBe(
      false,
    );
    expect(source.completedOrcaFailure({ code: 'ABORT_ERR' }, stdout)).toBe(false);
    expect(
      source.completedOrcaFailure({ code: 1, killed: false, signal: null }, stdout, {
        aborted: true,
      }),
    ).toBe(false);
    expect(source.completedOrcaFailure({ code: 1, killed: false, signal: null }, '{')).toBe(false);
  });

  it('keeps failed worktree and terminal reads unknown', () => {
    expect(source.worktreeFailure({ code: 'selector_not_found' })).toBe('missing');
    for (const code of ['unavailable', 'permission_denied', 'bad_response']) {
      expect(source.worktreeFailure({ code })).toBe('unknown');
    }
    expect(source.worktreeFailure({ code: 'selector_not_found' }, true)).toBe('unknown');
    expect(
      source.terminalCount({
        truncated: false,
        hostScope: { omittedHostIds: [] },
        totalCount: 2,
      }),
    ).toBe(2);
    for (const list of [
      null,
      { truncated: true, hostScope: { omittedHostIds: [] }, totalCount: 50 },
      { truncated: false, hostScope: { omittedHostIds: ['other'] }, totalCount: 0 },
      { truncated: false, hostScope: { omittedHostIds: [] }, totalCount: NaN },
      { truncated: false, hostScope: { omittedHostIds: [] }, totalCount: -1 },
      { truncated: false, hostScope: { omittedHostIds: [] }, totalCount: '2' },
    ])
      expect(source.terminalCount(list)).toBeNull();
  });

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
    const malformed = await source.collectTarget(
      target,
      worker,
      async () => ({
        worktree: 'completed',
        terminals: NaN,
        processes: { count: 0, read: true },
        artifacts: 'clean',
      }),
      now.toISOString(),
    );
    expect(malformed).toMatchObject({
      liveness: 'unknown',
      worktree_status: 'unknown',
      live_terminals: 0,
      process_read: false,
      artifacts: 'unknown',
    });
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
  const auditSettings = () => d.services.sync.source(d.read(), 'orca-audit').settings;
  const insertAuditRows = (
    count: number,
    invalid: Set<number> = new Set(),
    badWorkspace: Set<number> = new Set(),
  ) => {
    const insert = d.sql.prepare(
      `INSERT INTO runs (id, item_id, client, state, last_signal_at, last_signal_kind,
        orchestrator, workspace, created_at, updated_at)
       VALUES (?, ?, 'codex', 'finished', ?, 'report', ?, ?, ?, ?)`,
    );
    for (let index = 0; index < count; index += 1) {
      const at = new Date(now.getTime() - index * 1_000).toISOString();
      insert.run(
        `run_audit_${String(index).padStart(3, '0')}`,
        id,
        at,
        JSON.stringify({
          name: 'orca',
          dispatch_id: invalid.has(index) ? 'bad' : `ctx_audit_${index}`,
        }),
        badWorkspace.has(index) ? '{bad' : JSON.stringify({ path: `C:/audit/${index}` }),
        at,
        at,
      );
    }
  };

  it('returns the measured 117 eligible targets from 135 raw rows', () => {
    insertAuditRows(134, new Set(Array.from({ length: 18 }, (_, index) => index + 20)));
    d.sql.prepare('UPDATE runs SET state = ? WHERE id = ?').run('parked', run);
    for (let index = 0; index < 10; index += 1)
      d.sql
        .prepare('UPDATE runs SET state = ? WHERE id = ?')
        .run('parked', `run_audit_${String(index).padStart(3, '0')}`);
    const settings = auditSettings();
    const targets = settings.targets as { state: string }[];
    expect(settings.targets).toHaveLength(117);
    expect(targets.filter((target) => target.state === 'parked')).toHaveLength(11);
    expect(targets.filter((target) => target.state === 'finished')).toHaveLength(106);
    expect(settings.more).toBe(false);
  });

  it('includes the valid 170th raw row after invalid earlier rows at the 160 cap', () => {
    insertAuditRows(169, new Set(Array.from({ length: 10 }, (_, index) => index)));
    const settings = auditSettings();
    expect(settings.targets).toHaveLength(160);
    expect(settings.targets).toContainEqual(expect.objectContaining({ run_id: 'run_audit_168' }));
    expect(settings.more).toBe(false);
  });

  it('returns the observed 129 eligible targets from 148 raw rows through both caps', () => {
    insertAuditRows(147, new Set(Array.from({ length: 19 }, (_, index) => index + 20)));
    d.sql.prepare('UPDATE runs SET state = ? WHERE id = ?').run('parked', run);
    for (let index = 0; index < 12; index += 1)
      d.sql
        .prepare('UPDATE runs SET state = ? WHERE id = ?')
        .run('parked', `run_audit_${String(index).padStart(3, '0')}`);
    const settings = auditSettings();
    expect(settings.targets).toHaveLength(129);
    expect(settings.more).toBe(false);
    expect(source.selectTargets(settings.targets, {}, settings.more).batch).toHaveLength(51);
    expect(
      (settings.targets as { state: string }[]).filter((target) => target.state === 'parked'),
    ).toHaveLength(13);
  });

  it('keeps the server and helper 160 caps aligned for a schedulable roster', () => {
    insertAuditRows(159);
    d.sql.prepare('UPDATE runs SET state = ? WHERE id = ?').run('parked', run);
    for (let index = 0; index < 12; index += 1)
      d.sql
        .prepare('UPDATE runs SET state = ? WHERE id = ?')
        .run('parked', `run_audit_${String(index).padStart(3, '0')}`);
    const settings = auditSettings();
    expect(settings.targets).toHaveLength(source.targetLimit);
    expect(source.targetLimit).toBe(160);
    expect(settings.more).toBe(false);
    expect(source.selectTargets(settings.targets, {}, settings.more).batch).toHaveLength(51);
  });

  it('reports genuine 161st eligible overflow and keeps the helper cap aligned', () => {
    insertAuditRows(160);
    const settings = auditSettings();
    expect(settings.targets).toHaveLength(160);
    expect(settings.more).toBe(true);
    expect(() => source.selectTargets(settings.targets, {}, settings.more)).toThrow(
      'Audit inventory incomplete',
    );
  });

  it('fails closed if the bounded raw scan is truncated before exhaustion', () => {
    insertAuditRows(2_048, new Set(Array.from({ length: 2_048 }, (_, index) => index)));
    const settings = auditSettings();
    expect(settings.targets).toHaveLength(1);
    expect(settings.more).toBe(true);
  });

  it('skips invalid ended rows before taking the most recent eligible ended rows', () => {
    insertAuditRows(82, new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));
    const settings = auditSettings();
    expect(settings.targets).toHaveLength(73);
    expect(settings.targets).toContainEqual(expect.objectContaining({ run_id: 'run_audit_081' }));
    expect(settings.more).toBe(false);
  });

  it('treats malformed optional workspace data as ineligible', () => {
    insertAuditRows(5, new Set(), new Set([0]));
    d.sql.prepare('UPDATE runs SET workspace = ? WHERE id = ?').run('null', 'run_audit_001');
    d.sql.prepare('UPDATE runs SET workspace = ? WHERE id = ?').run('{}', 'run_audit_002');
    d.sql.prepare('UPDATE runs SET workspace = NULL WHERE id = ?').run('run_audit_003');
    d.sql.prepare('UPDATE runs SET workspace = ? WHERE id = ?').run('{"path":5}', 'run_audit_004');
    const settings = auditSettings();
    expect(settings.targets).toHaveLength(3);
    expect(settings.targets).toContainEqual(
      expect.objectContaining({ run_id: 'run_audit_002', path: null }),
    );
    expect(settings.targets).toContainEqual(
      expect.objectContaining({ run_id: 'run_audit_003', path: null }),
    );
    expect(settings.more).toBe(false);
  });

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

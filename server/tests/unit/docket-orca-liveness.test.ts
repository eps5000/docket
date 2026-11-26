import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const liveness = await import(
  /* @vite-ignore */ pathToFileURL(
    join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      '..',
      'tools',
      'docket-orca-liveness.mjs',
    ),
  ).href
);

const path = 'C:/Users/test/orca/workspaces/gameflow/worker';
const workspaceId =
  '50f60e7f-9e46-4591-bf62-b9892a0ea8af::C:/Users/test/orca/workspaces/gameflow/supervisor';
const workerTree = `50f60e7f-9e46-4591-bf62-b9892a0ea8af::${path}`;
const now = Date.parse('2026-11-26T20:00:00Z');

function fixture() {
  let target = {
    run_id: 'run_claimed',
    dispatch_id: 'ctx_exact',
    path,
    main_branch: 'main',
    state: 'parked',
    updated_at: '2026-11-26T19:00:00Z',
  };
  let agent = {
    row_kind: 'run',
    run_id: 'run_claimed',
    run_state: 'parked',
    lease: 'paused',
    item_id: 'GF-457',
    project: 'GAMEFLOW',
    lead_parked: {
      waiting_on: {
        orchestrator: true,
        wake: { actor: 'coordinator', event: 'review', due_at: '2026-11-26T21:00:00Z' },
      },
    },
  };
  let item = {
    item: {
      id: 'GF-457',
      epic_id: 'GF-231',
      runs: [{ run_id: 'run_claimed', parked: { reason: 'Waiting for review' } }],
    },
    decisions: [],
  };
  let project = { key: 'GAMEFLOW' };
  let worker: Record<string, unknown> | null = {
    dispatch: {
      id: 'ctx_exact',
      runId: 'run_orca',
      status: 'running',
      hostScope: { kind: 'local' },
    },
    worker: { dispatchId: 'ctx_exact', state: 'working', worktreeId: workerTree },
    projection: {
      id: 'ctx_exact',
      dispatchId: 'ctx_exact',
      runId: 'run_orca',
      host: { kind: 'local' },
      workspace: { id: workerTree },
      outcome: 'in_progress',
      liveness: { verdict: 'live' },
      stage: { worker: 'in_progress' },
    },
  };
  let automation: Record<string, unknown> | null = {
    id: 'dfc4d245-d983-4be8-a6e2-5bca12d98c3b',
    enabled: true,
    executionTargetType: 'local',
    workspaceMode: 'existing',
    workspaceId,
    nextRunAt: now + 30 * 60_000,
    lastRunAt: now - 10 * 60_000,
  };
  let tree = { worktree: { id: workspaceId } };
  let treeReads = 0;
  const ports = {
    docketSource: async () => ({ settings: { targets: [target], more: false } }),
    agents: async () => ({ rows: [agent] }),
    item: async () => item,
    bootstrap: async () => ({ projects: [project] }),
    workerShow: async () => worker,
    automations: async () => ({ automations: automation ? [automation] : [] }),
    worktreeShow: async () => {
      treeReads += 1;
      return tree;
    },
  };
  const run = (dispatchId = 'ctx_exact') =>
    liveness.inspect({
      runId: 'run_claimed',
      dispatchId,
      epicId: 'GF-231',
      automationId: 'dfc4d245-d983-4be8-a6e2-5bca12d98c3b',
      workspaceId,
      now,
      ports,
    });
  return {
    run,
    ports,
    treeReads: () => treeReads,
    target: (change: Partial<typeof target>) => {
      target = { ...target, ...change };
    },
    agent: (change: Partial<typeof agent>) => {
      agent = { ...agent, ...change };
    },
    item: (change: Partial<typeof item>) => {
      item = { ...item, ...change };
    },
    project: (change: Partial<typeof project>) => {
      project = { ...project, ...change };
    },
    worker: (change: Record<string, unknown> | null) => {
      worker = change;
    },
    automation: (change: Record<string, unknown> | null) => {
      automation = change;
    },
    tree: (change: typeof tree) => {
      tree = change;
    },
    getWorker: () => worker,
  };
}

describe('scoped Orca supervisor liveness inspection', () => {
  it('keeps a legitimate named, future parked wait as a park', async () => {
    const f = fixture();
    expect(await f.run()).toMatchObject({ status: 'parked', reason: 'legitimate_wait' });
    expect(f.treeReads()).toBe(1);
  });

  it('reports exact failed dispatch custody while a Docket claim remains parked', async () => {
    const f = fixture();
    const worker = f.getWorker() as {
      dispatch: Record<string, unknown>;
      projection: Record<string, unknown>;
    };
    f.worker({
      ...worker,
      dispatch: { ...worker.dispatch, status: 'failed' },
      projection: { ...worker.projection, outcome: 'failed' },
    });
    expect(await f.run()).toMatchObject({
      status: 'problem',
      reason: 'dispatch_custody',
      suggested_observation: 'failed',
    });
    f.agent({ lead_parked: { waiting_on: { orchestrator: true } } } as never);
    expect(await f.run()).toMatchObject({ status: 'problem', reason: 'dispatch_custody' });
    f.agent({
      lead_parked: {
        waiting_on: {
          orchestrator: true,
          wake: { actor: 'coordinator', event: 'review', due_at: '2026-11-26T21:00:00Z' },
        },
      },
    });
    f.worker({ ...worker, dispatch: { ...worker.dispatch, id: 'ctx_other', status: 'failed' } });
    expect(await f.run()).toMatchObject({ status: 'hold', reason: 'dispatch_custody_unknown' });
    f.worker(null);
    expect(await f.run()).toMatchObject({ status: 'hold', reason: 'dispatch_custody_unknown' });
  });

  it('reports a missing or overdue coordinator wake without resuming the worker', async () => {
    const f = fixture();
    f.agent({ lead_parked: { waiting_on: { orchestrator: true } } } as never);
    expect(await f.run()).toMatchObject({ status: 'problem', reason: 'missing_wake' });
    f.agent({
      lead_parked: {
        waiting_on: {
          orchestrator: true,
          wake: { actor: 'coordinator', event: 'review', due_at: '2026-11-26T19:00:00Z' },
        },
      },
    });
    expect(await f.run()).toMatchObject({ status: 'problem', reason: 'overdue_wake' });
  });

  it('preserves a project freeze and an active owner decision hold', async () => {
    const f = fixture();
    f.project({ key: 'GAMEFLOW', paused: { decision_id: 'dec_hold' } } as never);
    expect(await f.run()).toMatchObject({ status: 'hold', reason: 'intentional_owner_hold' });
    f.project({ key: 'GAMEFLOW', paused: undefined } as never);
    f.item({
      item: {
        id: 'GF-457',
        epic_id: 'GF-231',
        runs: [{ run_id: 'run_claimed', parked: { reason: 'HOST HOLD dec_approved' } }],
      },
      decisions: [{ id: 'dec_approved', authority: 'owner', status: 'active' }],
    } as never);
    expect(await f.run()).toMatchObject({ status: 'hold', reason: 'intentional_owner_hold' });
  });

  it('surfaces disabled and missing-target supervisor configuration without running it', async () => {
    const f = fixture();
    const automation = {
      id: 'dfc4d245-d983-4be8-a6e2-5bca12d98c3b',
      executionTargetType: 'local',
      workspaceMode: 'existing',
      workspaceId,
      nextRunAt: now + 30 * 60_000,
      lastRunAt: now - 10 * 60_000,
    };
    f.automation({ ...automation, enabled: false });
    expect(await f.run()).toMatchObject({
      status: 'problem',
      reason: 'supervisor_disabled',
      suggested_observation: 'supervisor_disabled',
    });
    expect(f.treeReads()).toBe(0);
    f.automation({ ...automation, enabled: true });
    f.ports.worktreeShow = async () => {
      throw Object.assign(new Error('missing'), { code: 'not_found' });
    };
    expect(await f.run()).toMatchObject({ status: 'problem', reason: 'supervisor_missing_target' });
  });

  it('surfaces an overdue scheduler while keeping unknown schedule data as a hold', async () => {
    const f = fixture();
    const automation = {
      id: 'dfc4d245-d983-4be8-a6e2-5bca12d98c3b',
      enabled: true,
      executionTargetType: 'local',
      workspaceMode: 'existing',
      workspaceId,
      nextRunAt: now - 10 * 60_000,
      lastRunAt: now - 45 * 60_000,
    };
    f.automation(automation);
    expect(await f.run()).toMatchObject({ status: 'problem', reason: 'supervisor_overdue' });
    f.automation({ ...automation, nextRunAt: null });
    expect(await f.run()).toMatchObject({ status: 'hold', reason: 'supervisor_schedule_unknown' });
  });

  it('rejects a broad supervisor scope and clears only after an exact live handoff', async () => {
    const f = fixture();
    f.automation({
      id: 'dfc4d245-d983-4be8-a6e2-5bca12d98c3b',
      enabled: true,
      executionTargetType: 'local',
      workspaceMode: 'new_per_run',
      workspaceId,
      nextRunAt: now + 30 * 60_000,
      lastRunAt: now - 10 * 60_000,
    });
    expect(await f.run()).toMatchObject({ status: 'hold', reason: 'supervisor_scope_unknown' });
    f.automation({
      id: 'dfc4d245-d983-4be8-a6e2-5bca12d98c3b',
      enabled: true,
      executionTargetType: 'local',
      workspaceMode: 'existing',
      workspaceId,
      nextRunAt: now + 30 * 60_000,
      lastRunAt: now - 10 * 60_000,
    });
    const old = f.getWorker() as {
      dispatch: Record<string, unknown>;
      projection: Record<string, unknown>;
    };
    f.worker({ ...old, dispatch: { ...old.dispatch, status: 'failed' } });
    expect(await f.run()).toMatchObject({ status: 'problem', reason: 'dispatch_custody' });
    f.target({ dispatch_id: 'ctx_handoff' });
    expect(await f.run('ctx_handoff')).toMatchObject({
      status: 'hold',
      reason: 'dispatch_custody_unknown',
    });
    f.worker({
      ...old,
      dispatch: { ...old.dispatch, id: 'ctx_handoff', status: 'running' },
      worker: { dispatchId: 'ctx_handoff', state: 'working', worktreeId: workerTree },
      projection: {
        ...old.projection,
        id: 'ctx_handoff',
        dispatchId: 'ctx_handoff',
        outcome: 'in_progress',
      },
    });
    expect(await f.run('ctx_handoff')).toMatchObject({
      status: 'parked',
      reason: 'legitimate_wait',
    });
  });
});

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const reconciler = await import(
  /* @vite-ignore */ pathToFileURL(
    join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      '..',
      'tools',
      'docket-orca-reconcile.mjs',
    ),
  ).href
);

const path = 'C:/Users/test/orca/workspaces/project/settled';
const workspaceId = `repo::${path}`;
const now = Date.parse('2026-11-26T19:10:00Z');

function fixture(
  options: {
    helpers?: boolean;
    privateArtifacts?: boolean;
    protectedHold?: boolean;
    processCount?: number;
    liveTerminal?: boolean;
    exitedTerminal?: boolean;
    stopUnknown?: boolean;
    otherAgent?: boolean;
    terminalMismatch?: boolean;
    alreadyReleased?: boolean;
    helperRemains?: boolean;
  } = {},
) {
  let target = {
    run_id: 'run_docket',
    dispatch_id: 'ctx_exact',
    path,
    main_branch: 'main',
  };
  let runRow = {
    row_kind: 'run',
    run_id: 'run_docket',
    run_state: 'finished',
    at: '2026-11-26T19:00:00Z',
    item_id: 'GF-346',
    lease: 'released',
  };
  let worker = {
    dispatch: {
      id: 'ctx_exact',
      runId: 'run_orca',
      status: 'completed',
      completedAt: '2026-11-26 19:00:00',
      hostScope: { kind: 'local' },
    },
    worker: {
      dispatchId: 'ctx_exact',
      state: 'succeeded',
      worktreeId: workspaceId,
      residualResources: options.helpers ? [{ kind: 'helper' }] : [],
    },
    projection: {
      id: 'ctx_exact',
      dispatchId: 'ctx_exact',
      runId: 'run_orca',
      host: { kind: 'local' },
      workspace: { id: workspaceId },
      outcome: 'succeeded',
      stage: { worker: 'succeeded' },
    },
    terminalResource: {
      ownerDispatchId: 'ctx_exact',
      worktreeId: workspaceId,
      terminalHandle: 'term_agent',
      releaseState: options.alreadyReleased ? 'released' : 'retained',
      retainedReason: options.protectedHold ? 'user_requested' : null,
    },
  };
  let worktreeStatus = 'in-progress';
  let terminals =
    options.liveTerminal || options.exitedTerminal
      ? [{ handle: 'term_idle', worktreeId: workspaceId, incarnationId: 'inc_1', ptyId: 'pty_1' }]
      : [];
  const writes: string[] = [];
  let workerReads = 0;
  const ports = {
    docketSource: async () => ({ settings: { targets: [target] } }),
    docketAgents: async () => ({ rows: [runRow] }),
    workerShow: async () => {
      workerReads += 1;
      return worker;
    },
    safePath: () => true,
    artifacts: async () => (options.privateArtifacts ? 'private' : 'clean'),
    processes: async () => ({ count: options.processCount ?? 0, read: true }),
    workerRelease: async () => {
      writes.push('release');
      worker = {
        ...worker,
        terminalResource: { ...worker.terminalResource, releaseState: 'released' },
      };
    },
    workerStop: async () => {
      writes.push('stop');
      if (options.stopUnknown) return { processAction: 'stop_unknown' };
      worker = {
        ...worker,
        worker: {
          ...worker.worker,
          residualResources: options.helperRemains ? worker.worker.residualResources : [],
        },
        terminalResource: { ...worker.terminalResource, releaseState: 'released' },
      };
      return { processAction: 'closed_agent_terminal' };
    },
    terminalList: async () => ({
      truncated: false,
      hostScope: { omittedHostIds: [] },
      terminals,
      totalCount: terminals.length,
    }),
    terminalExited: async () => !!options.exitedTerminal,
    terminalShow: async () => ({
      terminal: {
        worktreeId: workspaceId,
        incarnationId: options.terminalMismatch ? 'inc_other' : 'inc_1',
        ptyId: 'pty_1',
      },
    }),
    terminalClose: async () => {
      writes.push('close_exited_terminal');
      terminals = [];
    },
    activeAgents: async () => ({
      truncated: false,
      hostScope: { omittedHostIds: [] },
      agents: options.otherAgent ? [{ worktreeId: workspaceId }] : [],
    }),
    worktreeShow: async () => ({ worktree: { id: workspaceId, workspaceStatus: worktreeStatus } }),
    worktreeComplete: async () => {
      writes.push('complete_worktree');
      worktreeStatus = 'completed';
    },
  };
  const run = (extra: Record<string, unknown> = {}) =>
    reconciler.reconcile({
      runId: target.run_id,
      dispatchId: target.dispatch_id,
      now,
      ports,
      ...extra,
    });
  return {
    ports,
    run,
    writes,
    workerReads: () => workerReads,
    changeTarget: (changes: Partial<typeof target>) => {
      target = { ...target, ...changes };
    },
    changeRun: (changes: Partial<typeof runRow>) => {
      runRow = { ...runRow, ...changes };
    },
    changeWorker: (changes: Partial<typeof worker>) => {
      worker = { ...worker, ...changes };
    },
  };
}

describe('one-dispatch Orca-side cleanup', () => {
  it('inspects without action and releases only the exact settled agent when executed', async () => {
    const f = fixture();
    expect(await f.run()).toMatchObject({ status: 'ready', action: 'release' });
    expect(f.writes).toEqual([]);
    expect(await f.run({ execute: true })).toMatchObject({
      status: 'completed',
      action: 'release',
      worktree_status: 'completed',
    });
    expect(f.writes).toEqual(['release', 'complete_worktree']);
  });

  it('uses worker-stop for an owned helper, with a receipt and fresh quiescence reads', async () => {
    const f = fixture({ helpers: true });
    expect(await f.run({ execute: true })).toMatchObject({
      status: 'completed',
      action: 'stop',
      process_action: 'closed_agent_terminal',
    });
    expect(f.writes).toEqual(['stop', 'complete_worktree']);
  });

  it('holds a protected worker, live claim, retention window and mismatched path without action', async () => {
    const protectedWorker = fixture({ protectedHold: true });
    expect(await protectedWorker.run({ execute: true })).toMatchObject({
      status: 'hold',
      reason: 'protected_hold',
    });
    expect(protectedWorker.writes).toEqual([]);
    const f = fixture();
    f.changeRun({ run_state: 'parked' });
    expect(await f.run({ execute: true })).toMatchObject({ reason: 'docket_not_ended' });
    f.changeRun({ run_state: 'finished', at: '2026-11-26T19:09:00Z' });
    expect(await f.run({ execute: true })).toMatchObject({ reason: 'retention_pending' });
    f.changeRun({ at: '2026-11-26T19:00:00Z', lease: 'held' });
    expect(await f.run({ execute: true })).toMatchObject({ reason: 'docket_lease_not_released' });
    f.changeRun({ lease: 'released' });
    f.changeTarget({ path: 'C:/Users/test/private' });
    expect(await f.run({ execute: true })).toMatchObject({ reason: 'custody_unknown' });
    expect(f.writes).toEqual([]);
  });

  it('preserves ignored private artifacts and requires an explicit preservation choice', async () => {
    const f = fixture({ privateArtifacts: true });
    expect(await f.run({ execute: true })).toMatchObject({
      reason: 'private_artifacts_retained',
    });
    expect(f.writes).toEqual([]);
    expect(await f.run({ execute: true, preservePrivate: true })).toMatchObject({
      status: 'completed',
      artifacts: 'private',
    });
    expect(f.writes).toEqual(['release', 'complete_worktree']);
  });

  it('leaves unattributed processes visible after a safe owned-terminal release', async () => {
    const f = fixture({ processCount: 1 });
    expect(await f.run({ execute: true })).toMatchObject({
      status: 'hold',
      reason: 'unattributed_process_hold',
    });
    expect(f.writes).toEqual(['release']);
  });

  it('never closes a live terminal and closes only an exited exact-worktree terminal', async () => {
    const live = fixture({ liveTerminal: true });
    expect(await live.run({ execute: true })).toMatchObject({ reason: 'live_terminal_retained' });
    expect(live.writes).toEqual(['release']);
    const exited = fixture({ exitedTerminal: true });
    expect(await exited.run({ execute: true })).toMatchObject({
      status: 'completed',
      exited_terminals_closed: 1,
    });
    expect(exited.writes).toEqual(['release', 'close_exited_terminal', 'complete_worktree']);
  });

  it('rechecks Docket immediately before action', async () => {
    const f = fixture();
    let reads = 0;
    const original = f.ports.docketAgents;
    f.ports.docketAgents = async () => {
      reads += 1;
      if (reads === 2) f.changeRun({ run_state: 'parked' });
      return original();
    };
    expect(await f.run({ execute: true })).toMatchObject({ reason: 'docket_target_changed' });
    expect(f.writes).toEqual([]);
  });

  it('joins the live identity-only audit target with one exact ended Docket run', async () => {
    const f = fixture();
    expect(await f.run()).toMatchObject({ status: 'ready', action: 'release' });
    expect(f.workerReads()).toBe(1);
    f.changeRun({ run_state: 'parked' });
    expect(await f.run({ execute: true })).toMatchObject({ reason: 'docket_not_ended' });
    expect(f.writes).toEqual([]);
  });

  it('holds absent, duplicate, and mismatched Docket run records before Orca reads', async () => {
    const absent = fixture();
    absent.ports.docketAgents = async () => ({ rows: [] });
    expect(await absent.run({ execute: true })).toMatchObject({
      reason: 'docket_target_unavailable',
    });
    expect(absent.workerReads()).toBe(0);

    const duplicate = fixture();
    const original = duplicate.ports.docketAgents;
    duplicate.ports.docketAgents = async () => {
      const result = await original();
      return { rows: [...result.rows, ...result.rows] };
    };
    expect(await duplicate.run({ execute: true })).toMatchObject({
      reason: 'docket_target_unavailable',
    });
    expect(duplicate.workerReads()).toBe(0);

    const mismatch = fixture();
    mismatch.changeRun({ run_id: 'run_other' });
    expect(await mismatch.run({ execute: true })).toMatchObject({
      reason: 'docket_target_unavailable',
    });
    expect(mismatch.workerReads()).toBe(0);
  });

  it('holds an owned helper still present after worker-stop', async () => {
    const f = fixture({ helpers: true, helperRemains: true });
    expect(await f.run({ execute: true })).toMatchObject({ reason: 'owned_helper_retained' });
    expect(f.writes).toEqual(['stop']);

    const released = fixture({ helpers: true, alreadyReleased: true });
    expect(await released.run({ execute: true })).toMatchObject({
      reason: 'released_helper_inventory_conflict',
    });
    expect(released.writes).toEqual([]);
  });

  it('holds an unknown Orca stop receipt, an active peer, and terminal incarnation drift', async () => {
    const stop = fixture({ helpers: true, stopUnknown: true });
    expect(await stop.run({ execute: true })).toMatchObject({ reason: 'stop_unknown' });
    expect(stop.writes).toEqual(['stop']);
    const peer = fixture({ otherAgent: true });
    expect(await peer.run({ execute: true })).toMatchObject({ reason: 'other_agent_active' });
    expect(peer.writes).toEqual(['release']);
    const drift = fixture({ exitedTerminal: true, terminalMismatch: true });
    expect(await drift.run({ execute: true })).toMatchObject({
      reason: 'terminal_custody_changed',
    });
    expect(drift.writes).toEqual(['release']);
  });

  it('is idempotent after the exact agent resource is already released', async () => {
    const f = fixture({ alreadyReleased: true });
    expect(await f.run({ execute: true })).toMatchObject({
      status: 'completed',
      action: 'verify',
    });
    expect(f.writes).toEqual(['complete_worktree']);
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectOk, startHarness, type ContractHarness } from './harness.js';

let h: ContractHarness;
let runId: string;
const sql = () => h.server.runtime.db.sqlite;
const row = () =>
  sql()
    .prepare(
      'SELECT state, lease_expires_at, last_signal_at, dispatch_observation FROM runs WHERE id = ?',
    )
    .get(runId) as {
    state: string;
    lease_expires_at: string | null;
    last_signal_at: string;
    dispatch_observation: string | null;
  };

beforeAll(async () => {
  h = await startHarness();
  runId = expectOk(
    await h.call('claim_lead', {
      id: 'RCP-17',
      agent_label: 'worker',
      orchestrator: { name: 'orca', dispatch_id: 'ctx_457' },
    }),
  ).structured.run_id as string;
  expectOk(
    await h.call('park_run', {
      run_id: runId,
      reason: 'External report pending',
      waiting_on: { orchestrator: true },
    }),
  );
});
afterAll(async () => h.close());

describe('authenticated coordinator observation', () => {
  it('rejects a different coordinator, claimed run and dispatch without changing custody', async () => {
    const before = row();
    for (const change of [
      { coordinator: 'other', claimed_run: runId, dispatch_id: 'ctx_457' },
      { coordinator: 'orca', claimed_run: 'run_wrong', dispatch_id: 'ctx_457' },
      { coordinator: 'orca', claimed_run: runId, dispatch_id: 'ctx_wrong' },
    ]) {
      const result = await h.call(
        'update_run_status',
        {
          id: 'RCP-17',
          coordinator: change.coordinator,
          dispatch_observation: {
            claimed_run: change.claimed_run,
            dispatch_id: change.dispatch_id,
            state: 'failed',
          },
        },
        h.b,
      );
      expect(result.isError).toBe(true);
      expect(row()).toEqual(before);
    }
    const combined = await h.call(
      'update_run_status',
      {
        id: 'RCP-17',
        coordinator: 'orca',
        resume: true,
        dispatch_observation: { claimed_run: runId, dispatch_id: 'ctx_457', state: 'live' },
      },
      h.b,
    );
    expect(combined.isError).toBe(true);
    expect(row()).toEqual(before);
  });

  it('records bounded failed evidence and a verified live handoff without signaling or resuming the run', async () => {
    const before = row();
    expectOk(
      await h.call(
        'update_run_status',
        {
          id: 'RCP-17',
          coordinator: 'orca',
          dispatch_observation: { claimed_run: runId, dispatch_id: 'ctx_457', state: 'failed' },
        },
        h.b,
      ),
    );
    expect(row()).toMatchObject({
      state: 'parked',
      lease_expires_at: before.lease_expires_at,
      last_signal_at: before.last_signal_at,
    });
    expect(JSON.parse(row().dispatch_observation!)).toMatchObject({ state: 'failed', by: 'orca' });
    expectOk(
      await h.call(
        'update_run_status',
        {
          id: 'RCP-17',
          coordinator: 'orca',
          dispatch_observation: { claimed_run: runId, dispatch_id: 'ctx_new', state: 'live' },
        },
        h.b,
      ),
    );
    expect(row().state).toBe('parked');
    expect(JSON.parse(row().dispatch_observation!)).toMatchObject({
      state: 'live',
      dispatch_id: 'ctx_new',
    });
  });
});

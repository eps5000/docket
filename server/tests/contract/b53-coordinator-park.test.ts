/**
 * Time-limited coordinator parking over real MCP clients (owner decision 44;
 * MCP_SPEC §5.4): the over-limit error, reads never resuming the run, its own
 * write doing so, and what the digest and context say within their budgets.
 */
import { DIGEST_MAX_CHARS, TOOLS } from '@docket/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sweepOnce } from '../../src/jobs/sweeper.js';
import {
  expectOk,
  expectValidation,
  startHarness,
  textOf,
  tokens,
  VALID_ARGS,
  type ContractHarness,
} from './harness.js';

const READS = TOOLS.filter((t) => t.kind !== 'mutating').map((t) => t.name);
const CO = 'orca';
let h: ContractHarness;
let runId: string;

const sql = () => h.server.runtime.db.sqlite;
const row = () =>
  sql()
    .prepare(
      'SELECT state, lease_expires_at, last_signal_at, parked_reason, waiting_on, parked_at, coordinator_park, version FROM runs WHERE id = ?',
    )
    .get(runId) as { state: string; coordinator_park: string | null };
const park = (extra: Record<string, unknown> = {}) =>
  h.call(
    'update_run_status',
    {
      id: 'RCP-17',
      coordinator: CO,
      park_minutes: 60,
      park_reason: 'Waiting for the producer',
      waiting_on: { orchestrator: true },
      ...extra,
    },
    h.b,
  );

beforeEach(async () => {
  h = await startHarness();
  const claim = expectOk(
    await h.call('claim_lead', {
      id: 'RCP-17',
      agent_label: 'worker',
      orchestrator: { name: CO },
    }),
  );
  runId = claim.structured.run_id as string;
});
afterEach(async () => {
  await h.close();
});

describe('update_run_status with park_minutes', () => {
  it('parks the run and says until when, in one short line', async () => {
    const out = expectOk(await park());
    expect(out.structured).toMatchObject({
      id: 'RCP-17',
      run_state: 'parked',
      updated_by: CO,
      parked_until: '2026-11-06T12:00:00.000Z',
    });
    expect(out.text).toBe("Updated RCP-17's run · parked · by orca · until 12:00Z");
    expect(tokens(out.text)).toBeLessThanOrEqual(60);
  });

  it('refuses a park over 4 hours with a clear error, and never clamps it', async () => {
    const before = row();
    const err = expectValidation(await park({ park_minutes: 241 }));
    expect(err.message).toContain('park_minutes must be at most 240');
    expect(row()).toEqual(before);
  });

  it.each([0, -5, 1.5])('refuses park_minutes %s', async (park_minutes) => {
    expectValidation(await park({ park_minutes }));
    expect(row().state).toBe('open');
  });

  it('refuses resume together with park_minutes', async () => {
    expectValidation(
      await h.call(
        'update_run_status',
        { id: 'RCP-17', coordinator: CO, park_minutes: 30, resume: true },
        h.b,
      ),
    );
  });

  it("refuses the run's own run_id, so the park can't speak as the run", async () => {
    expectValidation(await park({ run_id: runId }));
    expect(row().state).toBe('open');
  });

  it('keeps the tool count at 51', () => {
    expect(TOOLS).toHaveLength(51);
  });
});

describe('a coordinator-parked run through reads and writes', () => {
  it.each(READS)('%s leaves it parked, with the deadline unchanged', async (name) => {
    expectOk(await park());
    const before = row();
    h.server.clock.advance(1_000);
    await h.call(name, { ...VALID_ARGS[name], run_id: runId });
    expect(row()).toEqual(before);
  });

  it('a real write by the run resumes it and drops the limit', async () => {
    expectOk(await park());
    expectOk(await h.call('heartbeat', { run_id: runId, note: 'Back to it' }));
    expect(row()).toMatchObject({ state: 'open', coordinator_park: null });
  });

  it("the run's own park_run replaces the limit", async () => {
    expectOk(await park());
    expectOk(await h.call('park_run', { run_id: runId, reason: 'My own wait' }));
    expect(row()).toMatchObject({ state: 'parked', coordinator_park: null });
    h.server.clock.advance(5 * 3_600_000);
    expect(sweepOnce(h.server.runtime).unparked).toEqual([]);
    expect(row().state).toBe('parked');
  });

  it('a read after expiry is the live run calling back, and clears the marker', async () => {
    expectOk(await park());
    h.server.clock.advance(3_600_000);
    expect(sweepOnce(h.server.runtime).unparked).toEqual([runId]);
    expect(row().coordinator_park).toContain('ended_at');
    expectOk(await h.call('get_item', { id: 'RCP-17', run_id: runId, view: 'summary' }));
    expect(row()).toMatchObject({ state: 'open', coordinator_park: null });
  });
});

describe('what the coordinator reads', () => {
  it('get_digest says who parked it and until when, within its cap', async () => {
    expectOk(await park());
    const { text } = expectOk(await h.call('get_digest', { project: 'RCP' }));
    expect(text).toContain(`Parked by ${CO} until 12:00Z`);
    expect(text.length).toBeLessThanOrEqual(DIGEST_MAX_CHARS);
    expect(tokens(text)).toBeLessThanOrEqual(1_000);
  });

  it('get_digest keeps its cap with a long coordinator name on many parked runs', async () => {
    const long = 'c'.repeat(40);
    sql()
      .prepare("UPDATE projects SET coordinators = ? WHERE key = 'RCP'")
      .run(JSON.stringify([long]));
    expectOk(await park({ coordinator: long }));
    for (const id of ['RCP-14', 'RCP-15', 'RCP-16', 'RCP-18']) {
      const claimed = await h.call('claim_lead', { id, agent_label: 'worker' }, h.b);
      if (claimed.isError) continue;
      await h.call('update_run_status', {
        id,
        coordinator: long,
        park_minutes: 240,
        park_reason: 'Waiting',
        waiting_on: { orchestrator: true },
      });
    }
    const { text, structured } = expectOk(await h.call('get_digest', { project: 'RCP' }));
    expect(text.length).toBeLessThanOrEqual(DIGEST_MAX_CHARS);
    expect(text).toContain(`Parked by ${'c'.repeat(19)}…`);
    expect((structured.runs as { total: number }).total).toBeGreaterThan(0);
  });

  it('get_digest marks a park that ran out, and its change', async () => {
    const { structured } = expectOk(await h.call('get_digest', { project: 'RCP' }));
    expectOk(await park());
    h.server.clock.advance(3_600_000);
    sweepOnce(h.server.runtime);
    const next = expectOk(
      await h.call('get_digest', { project: 'RCP', cursor: structured.cursor as string }),
    );
    expect(next.text).toContain('run.park_expired');
    expect(next.text).toContain(`Park by ${CO} ran out 12:00Z`);
  });

  it('get_context and get_item say it too', async () => {
    expectOk(await park());
    const context = textOf(await h.call('get_context', { id: 'RCP-17', budget: 'small' }));
    expect(context).toContain(`Parked by ${CO} until 12:00Z`);
    const item = textOf(await h.call('get_item', { id: 'RCP-17' }));
    expect(item).toContain(`Parked by ${CO} until 12:00Z`);
    expect(row().state).toBe('parked');
  });

  it('a get_context on a run with no coordinator park has no such row', async () => {
    const context = textOf(await h.call('get_context', { id: 'RCP-17', budget: 'small' }));
    expect(context).not.toContain('coordinator_park');
  });
});

/**
 * Only work resumes a parked run (owner decision 42; BUILD_SPEC §5.16), over
 * real MCP clients. Which tools count comes from the registry's `kind`, so a
 * new read tool is covered here without being added to a list.
 */
import { TOOLS } from '@docket/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { expectOk, startHarness, VALID_ARGS, type ContractHarness } from './harness.js';

const READS = TOOLS.filter((t) => t.kind !== 'mutating').map((t) => t.name);

let h: ContractHarness;
let runId: string;

const sql = () => h.server.runtime.db.sqlite;
const row = () =>
  sql()
    .prepare(
      'SELECT state, lease_expires_at, last_signal_at, parked_reason, waiting_on, parked_at, version FROM runs WHERE id = ?',
    )
    .get(runId);
const maxSeq = () => (sql().prepare('SELECT max(seq) AS m FROM events').get() as { m: number }).m;
const runEvents = (after: number) =>
  sql()
    .prepare(
      "SELECT type FROM events WHERE seq > ? AND type IN ('run.resumed', 'run.parked') ORDER BY seq",
    )
    .all(after) as { type: string }[];

beforeAll(async () => {
  h = await startHarness();
  const claim = expectOk(await h.call('claim_lead', { id: 'RCP-17', agent_label: 'worker' }));
  runId = claim.structured.run_id as string;
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  expectOk(await h.call('park_run', { run_id: runId, reason: 'Waiting on the mailbox' }));
});

describe('a parked run stays parked through reads (decision 42)', () => {
  it('covers every read-only tool, and get_item', () => {
    expect(READS).toContain('get_item');
    expect(READS).toContain('get_digest');
    expect(READS.length).toBe(15);
  });

  it.each(READS)('%s leaves its state, lease and park alone, with no event', async (name) => {
    const before = row();
    const seq = maxSeq();
    h.server.clock.advance(1_000);
    await h.call(name, { ...VALID_ARGS[name], run_id: runId });
    expect(row()).toEqual(before);
    expect(runEvents(seq)).toEqual([]);
  });

  it('heartbeat resumes it', async () => {
    const seq = maxSeq();
    expectOk(await h.call('heartbeat', { run_id: runId, note: 'Back' }));
    expect(row()).toMatchObject({ state: 'open' });
    expect(runEvents(seq).map((e) => e.type)).toEqual(['run.resumed']);
  });

  it('another mutating call naming the run resumes it', async () => {
    const seq = maxSeq();
    expectOk(await h.call('add_note', { id: 'RCP-17', run_id: runId, text: 'Picking this up' }));
    expect(row()).toMatchObject({ state: 'open' });
    expect(runEvents(seq).map((e) => e.type)).toEqual(['run.resumed']);
  });

  it("update_run_status refuses the run's own run_id, and doesn't wake it", async () => {
    const before = row();
    const seq = maxSeq();
    const res = await h.call('update_run_status', {
      id: 'RCP-17',
      coordinator: 'orca',
      current_action: 'Borrowing the run',
      run_id: runId,
    });
    expect(res.isError).toBe(true);
    expect((res.structuredContent as { code: string }).code).toBe('validation');
    expect(row()).toEqual(before);
    expect(runEvents(seq)).toEqual([]);
  });

  it('park_run re-parks without resuming first', async () => {
    const seq = maxSeq();
    expectOk(await h.call('park_run', { run_id: runId, reason: 'Still waiting' }));
    expect(row()).toMatchObject({ state: 'parked', parked_reason: 'Still waiting' });
    expect(runEvents(seq).map((e) => e.type)).toEqual(['run.parked']);
  });
});

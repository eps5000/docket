/**
 * `get_digest` (owner decision 40; MCP_SPEC §5.2): one compact coordinator
 * snapshot. The fixture is the 300-item STR stress project, plus the sample
 * project's items, which is about the size of the Gameflow pilot.
 */
import {
  DIGEST_CAPS,
  DIGEST_MAX_CHARS,
  getDigestOutput,
  renderResult,
  type Digest,
} from '@docket/shared';
import { afterEach, describe, expect, it } from 'vitest';
import {
  expectNotFound,
  expectOk,
  expectValidation,
  startHarness,
  tokens,
  type ContractHarness,
} from './harness.js';

let h: ContractHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const digest = async (x: ContractHarness, args: Record<string, unknown>) => {
  const { structured, text } = expectOk(await x.call('get_digest', args));
  return { d: getDigestOutput.parse(structured) as Digest, text };
};

describe('get_digest', () => {
  it('fits a Gameflow-sized project in 1,000 tokens, with +N more on long sections', async () => {
    h = await startHarness({ stress: true });
    const { d, text } = await digest(h, { project: 'STR' });
    expect(tokens(text)).toBeLessThanOrEqual(1_000);
    expect(d.ready.total).toBeGreaterThan(DIGEST_CAPS.ready);
    expect(d.ready.rows).toHaveLength(DIGEST_CAPS.ready);
    expect(text).toContain(`ready ${d.ready.total}:`);
    expect(text).toContain(`+${d.ready.total - DIGEST_CAPS.ready} more`);
    expect(d.blocked.total).toBeGreaterThan(0);
    expect(d.blocked.rows.length).toBeLessThanOrEqual(DIGEST_CAPS.blocked);
    console.log(`get_digest on STR (300 items): ${tokens(text)} tokens`);
  });

  it('lists ready work by priority, then by what it unblocks', async () => {
    h = await startHarness({ stress: true });
    const { d } = await digest(h, { project: 'STR' });
    const search = expectOk(
      await h.call('search_items', {
        project: 'STR',
        filter: 'ready_to_start',
        limit: DIGEST_CAPS.ready,
      }),
    ).structured.items as { id: string }[];
    expect(d.ready.rows.map((r) => r.id)).toEqual(search.map((r) => r.id));
  });

  it('says why an item is blocked', async () => {
    h = await startHarness({ stress: true });
    const { d, text } = await digest(h, { project: 'STR' });
    const first = d.blocked.rows[0]!;
    expect(first.blocked_by.length).toBeGreaterThan(0);
    expect(text).toContain(`${first.id} p${first.priority}`);
    expect(text).toContain(`by ${first.blocked_by[0]}`);
  });

  it('flags runs: a parked run shows resume_ready and what it waits on', async () => {
    h = await startHarness();
    const claim = expectOk(await h.call('claim_lead', { id: 'RCP-17', agent_label: 'orca-w3' }));
    const run_id = claim.structured.run_id as string;
    expectOk(
      await h.call('park_run', {
        run_id,
        reason: 'Waiting for the coordinator',
        waiting_on: { orchestrator: true },
      }),
    );
    const { d, text } = await digest(h, { project: 'RCP' });
    const row = d.runs.rows.find((r) => r.run_id === run_id)!;
    expect(row).toMatchObject({ item_id: 'RCP-17', state: 'parked', waiting: 'coordinator' });
    expect(text).toContain('RCP-17 parked');
    expect(text).toContain('waiting coordinator');
  });

  it('shows what waits on the owner, and the current cursor', async () => {
    h = await startHarness();
    const { d, text } = await digest(h, { project: 'RCP' });
    expect(d.owner.total).toBeGreaterThan(0);
    expect(text).toContain(`owner ${d.owner.total}:`);
    const changes = expectOk(await h.call('get_changes', {})).structured;
    expect(d.cursor).toBe(changes.next_cursor);
    expect(d.since).toBeNull();
  });

  it('with cursor: only what changed since then', async () => {
    h = await startHarness({ stress: true });
    const first = await digest(h, { project: 'STR' });
    const quiet = await digest(h, { project: 'STR', cursor: first.d.cursor });
    expect(quiet.d.since).toBe(first.d.cursor);
    expect(quiet.d.ready.total).toBe(0);
    expect(quiet.d.changed.total).toBe(0);
    expect(quiet.text).toContain(`No changes since ${first.d.cursor}.`);
    expect(tokens(quiet.text)).toBeLessThan(40);

    const target = first.d.ready.rows[0]!.id;
    expectOk(await h.call('claim_lead', { id: target, agent_label: 'orca-w3' }));
    const next = await digest(h, { project: 'STR', cursor: first.d.cursor });
    expect(next.d.changed.total).toBeGreaterThan(0);
    expect(next.d.changed.rows.every((c) => c.item_id === target)).toBe(true);
    expect(next.d.runs.rows.map((r) => r.item_id)).toEqual([target]);
    expect(next.d.ready.total).toBe(0);
    expect(next.d.blocked.rows.every((r) => r.id === target)).toBe(true);
    expect(next.text.split('\n')[1]).toMatch(/^changed \d+:/);
    expect(tokens(next.text)).toBeLessThan(tokens(first.text));
  });

  it('never exceeds the hard cap, however long the rows', () => {
    const long = 'x'.repeat(5_000);
    const many = <T>(row: T, n: number) => ({
      total: 1_000,
      rows: Array.from({ length: n }, () => row),
    });
    const d: Digest = {
      project: 'STR',
      cursor: '999999',
      since: null,
      ready: many({ id: 'STR-1000', title: long, priority: 1, unblocks: 99 }, DIGEST_CAPS.ready),
      runs: many(
        {
          item_id: 'STR-1000',
          run_id: 'run_1',
          state: 'parked' as const,
          label: long,
          resume_ready: true,
          waiting: long,
        },
        DIGEST_CAPS.runs,
      ),
      blocked: many(
        {
          id: 'STR-1000',
          title: long,
          priority: 1,
          unblocks: 99,
          blocked_by: ['STR-1', 'STR-2', 'STR-3', 'STR-4'],
        },
        DIGEST_CAPS.blocked,
      ),
      owner: many({ kind: 'question', item_id: 'STR-1000', text: long }, DIGEST_CAPS.owner),
      problems: many(
        { id: long, kind: 'radar_conflict', item_id: null, fix: long },
        DIGEST_CAPS.problems,
      ),
      leases: many(
        { part: long, item_id: 'STR-1000', until: '2026-11-21T10:00:00.000Z' },
        DIGEST_CAPS.leases,
      ),
      conflicts: many(
        { items: ['STR-1000', 'STR-1001'], parts: [long, long, long], outcome: 'sequence' },
        DIGEST_CAPS.conflicts,
      ),
      changed: many(
        { cursor: '999999', item_id: 'STR-1000', type: 'review.decided' },
        DIGEST_CAPS.changed,
      ),
    };
    const text = renderResult('get_digest', d);
    expect(text.length).toBeLessThanOrEqual(DIGEST_MAX_CHARS);
    expect(text).toContain('more');
  });

  it('refuses an unknown project and a bad cursor', async () => {
    h = await startHarness();
    expectNotFound(await h.call('get_digest', { project: 'NOPE' }));
    expectValidation(await h.call('get_digest', { project: 'RCP', cursor: 'abc' }));
  });

  it('writes nothing', async () => {
    h = await startHarness();
    const count = () =>
      (
        h!.server.runtime.db.sqlite.prepare('SELECT count(*) AS n FROM events').get() as {
          n: number;
        }
      ).n;
    const before = count();
    await digest(h, { project: 'RCP' });
    expect(count()).toBe(before);
  });
});

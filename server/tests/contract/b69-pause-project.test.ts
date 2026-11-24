/**
 * Pause project over real MCP clients (owner decision 53): the refused claim,
 * a write on a parked run recording the work without resuming it, and what a
 * paused project costs in the digest and context budgets.
 */
import { DIGEST_MAX_CHARS } from '@docket/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OWNER_ACTOR } from '../../src/domain/write.js';
import {
  expectOk,
  expectToolError,
  startHarness,
  textOf,
  tokens,
  type ContractHarness,
} from './harness.js';

const REASON = 'Waiting on a synthetic answer';
let h: ContractHarness;

const pause = () =>
  h.server.runtime.write.run({ actor: OWNER_ACTOR, operation: 'test', args: {} }, (w) =>
    h.server.runtime.services.projects.pause(w, { key: 'RCP', reason: REASON }),
  );
const stateOf = (run: string) =>
  (
    h.server.runtime.db.sqlite.prepare('SELECT state FROM runs WHERE id = ?').get(run) as {
      state: string;
    }
  ).state;
const parkedRun = async (id: string) => {
  const claim = expectOk(await h.call('claim_lead', { id, agent_label: 'worker' })).structured;
  const run_id = claim.run_id as string;
  expectOk(
    await h.call('park_run', { run_id, reason: 'Synthetic wait', waiting_on: { person: true } }),
  );
  return run_id;
};

beforeEach(async () => {
  h = await startHarness();
});
afterEach(() => h.close());

describe('Pause project over MCP (decision 53)', () => {
  it('refuses claim_lead with project_paused, the reason and who to ask', async () => {
    pause();
    const err = expectToolError(await h.call('claim_lead', { id: 'RCP-17' }), 'project_paused');
    expect(err.message).toContain(REASON);
    expect(err.details).toMatchObject({ project: 'RCP', ask: 'the owner' });
  });

  it.each([
    ['add_note', (run_id: string) => ({ id: 'RCP-17', text: 'Synthetic note', run_id })],
    [
      'report_commit',
      (run_id: string) => ({ id: 'RCP-17', sha: 'abc1234', branch: 'b69', run_id }),
    ],
    ['heartbeat', (run_id: string) => ({ run_id, note: 'Saving my work' })],
  ])('%s on a parked run records the work and leaves it parked', async (tool, args) => {
    const run = await parkedRun('RCP-17');
    pause();
    const result = await h.call(tool, args(run));
    expect(result.isError ?? false, textOf(result)).toBe(false);
    expect(stateOf(run)).toBe('parked');
    expect(textOf(result)).toContain('stays parked');
  });

  it('park_run, then finish_run, still work on a parked run', async () => {
    const run = await parkedRun('RCP-17');
    pause();
    expectOk(await h.call('park_run', { run_id: run, reason: 'Still waiting', waiting_on: {} }));
    const done = await h.call('finish_run', {
      run_id: run,
      result: 'finished',
      summary: 'Saved my work',
    });
    expect(textOf(done)).not.toContain('stays parked');
    expect(stateOf(run)).toBe('finished');
  });

  it('a read of a parked run neither resumes it nor warns', async () => {
    const run = await parkedRun('RCP-17');
    pause();
    const result = await h.call('get_context', { id: 'RCP-17', run_id: run });
    expect(textOf(result)).toContain(`paused: the owner paused RCP`);
    expect(stateOf(run)).toBe('parked');
  });

  it('stays inside the digest and context budgets', async () => {
    await parkedRun('RCP-17');
    pause();
    const digest = textOf(await h.call('get_digest', { project: 'RCP' }));
    expect(digest.length).toBeLessThanOrEqual(DIGEST_MAX_CHARS);
    expect(digest).toContain('paused:');
    expect(digest).not.toMatch(/^next work/m);
    const small = textOf(await h.call('get_context', { id: 'RCP-17', budget: 'small' }));
    expect(tokens(small)).toBeLessThanOrEqual(600 * 1.2);
    expect(small).toContain('paused:');
  });
});

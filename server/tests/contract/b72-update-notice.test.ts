/**
 * The update notice (owner decision 56; BUILD_SPEC §5.38; MCP_SPEC §5.2, §5.4):
 * an install that's behind hears how to take the update from `claim_lead` and
 * `get_digest`, within budget, and nobody else pays for it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { syncBundledFiles } from '../../src/jobs/bundled.js';
import { SYSTEM_ACTOR } from '../../src/domain/write.js';
import { expectOk, startHarness, textOf, tokens, type ContractHarness } from './harness.js';

const NOTICE_BUDGET = 200;

let h: ContractHarness;
let current: string;
let behind: string;

/** An install row whose manifest is current, or one that lacks the newest skill. */
function addInstall(stale: boolean): string {
  const { runtime } = h.server;
  const read = { project: 'RCP', client: 'claude' as const, files: [] };
  const ctx = runtime.services.installs;
  const { result } = runtime.write.run(
    { actor: SYSTEM_ACTOR, operation: 'test.install', args: {} },
    (w) => {
      const prepared = ctx.prepareUpdate(w, read);
      const manifest = stale
        ? prepared.manifest.filter((f) => f.key !== 'skill:docket-delivery')
        : prepared.manifest;
      const id = ctx.recordUpdate(w, { ...prepared, manifest })!;
      w.update('installs', id, { token_used_at: w.now });
      return id;
    },
  );
  return result;
}

const report = (install_id: string) => ({ install_id, files: [] });

beforeAll(async () => {
  h = await startHarness();
  syncBundledFiles(h.server.runtime);
  behind = addInstall(true);
  current = addInstall(false);
});
afterAll(async () => {
  await h.close();
});

describe('the update notice (decision 56)', () => {
  it('is on claim_lead for an install that is behind only while main is behind too', async () => {
    // The project's latest install is current, so this branch just needs to merge main.
    const merged = expectOk(
      await h.call('claim_lead', { id: 'RCP-17', instructions: report(behind) }),
    );
    expect(merged.structured.agent_files_update).toBeUndefined();
    expect(merged.text).not.toContain('update:');
    expectOk(
      await h.call('release_lead', {
        id: 'RCP-17',
        run_id: merged.structured.run_id as string,
        reason: 'Notice test',
      }),
    );
  });

  it('is left out for a current install, and of later digests', async () => {
    const digest = expectOk(await h.call('get_digest', { project: 'RCP' }));
    expect(digest.structured.agent_files_update).toBeUndefined();
    expect(textOf(await h.call('get_digest', { project: 'RCP' }))).not.toContain('update:');
    expect(current).toMatch(/^ins_/);
  });

  it('tells a coordinator and a worker what to do, within budget', async () => {
    const newest = addInstall(true);
    const digest = expectOk(await h.call('get_digest', { project: 'RCP' }));
    const line = digest.structured.agent_files_update as string;
    expect(line).toContain('Coordinator');
    expect(line).toContain("Workers: tell your coordinator; don't update files yourself.");
    expect(line).toContain('/agent/update/docket-update.sh');
    expect(line).toContain('/agent/update/docket-update.ps1');
    expect(digest.text).toContain(`update: ${line}`);
    expect(tokens(line)).toBeLessThanOrEqual(NOTICE_BUDGET);

    const later = expectOk(
      await h.call('get_digest', { project: 'RCP', cursor: digest.structured.cursor as string }),
    );
    expect(later.structured.agent_files_update).toBeUndefined();

    const claim = expectOk(
      await h.call('claim_lead', { id: 'RCP-17', instructions: report(newest) }),
    );
    expect(claim.structured.agent_files_update).toBe(line);
    expect(claim.text).toContain(`update: ${line}`);
  });
});

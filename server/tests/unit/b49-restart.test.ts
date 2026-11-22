/**
 * Runs survive a Docket restart (owner decision 41; BUILD_SPEC §5.3): the
 * claim, workspace and `run_id` stay, the lease runs at least the grace, one
 * `service.restarted` event, an agent's next call continues, and a run that
 * never returns ends by normal lease expiry. `service_restart` history stays
 * readable. The same over real MCP clients is in contract/us11-recovery.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../../src/domain/write.js';
import { restartSweep, sweepOnce } from '../../src/jobs/sweeper.js';
import { endRunsAsOldRestart, minutes, startDomain, type Domain } from '../us1-helpers.js';

let d: Domain;
let claude: Actor;

beforeEach(() => {
  d = startDomain();
  claude = d.agent('claude', { label: 'orca-w1' });
});
afterEach(() => d.cleanup());

const claim = (id: string, extra: Record<string, unknown> = {}) =>
  d.write(claude, (w, s) => s.runs.claim(w, { id, agent_label: 'orca-w1', ...extra }));
const run = (id: string) =>
  d.row<{
    state: string;
    end_reason: string | null;
    lease_expires_at: string | null;
    workspace: string | null;
    version: number;
  }>('SELECT * FROM runs WHERE id = ?', id);
const restarts = () =>
  d.rows<{ summary: string; data: string }>(
    "SELECT summary, data FROM events WHERE type = 'service.restarted'",
  );
const graceFromNow = () =>
  new Date(d.clock.now().getTime() + d.server.runtime.config.restartGraceMs).toISOString();

describe('a Docket restart keeps open runs (decision 41)', () => {
  it('keeps the claim, workspace and run_id, with one event however many runs', () => {
    const a = claim('RCP-17', { workspace: { path: 'C:/work/rcp-17', branch: 'b' } }).run_id;
    const b = claim('RCP-25').run_id;
    const before = run(a);
    const open = d.rows("SELECT id FROM runs WHERE state IN ('open', 'needs_input')").length;
    const { kept } = restartSweep(d.server.runtime);
    expect(kept).toEqual(expect.arrayContaining([a, b]));
    expect(run(a)).toMatchObject({ state: 'open', end_reason: null, workspace: before.workspace });
    expect(run(a).version).toBe(before.version);
    expect(restarts()).toHaveLength(1);
    expect(restarts()[0]!.summary).toContain(`kept ${open} open runs`);
    expect(JSON.parse(restarts()[0]!.data)).toMatchObject({ runs_kept: open });
    d.fails(d.agent('codex'), (w, s) => s.runs.claim(w, { id: 'RCP-17' }), 'conflict');
  });

  it('extends a lease to at least now + the grace, and never shortens one', () => {
    const { run_id } = claim('RCP-17');
    const long = run(run_id).lease_expires_at!;
    restartSweep(d.server.runtime);
    expect(run(run_id).lease_expires_at).toBe(long); // 60 minutes is already past the grace
    d.clock.advance(minutes(55));
    restartSweep(d.server.runtime);
    expect(run(run_id).lease_expires_at).toBe(graceFromNow());
  });

  it('revives a lease that ran out while Docket was down', () => {
    const { run_id } = claim('RCP-17');
    d.clock.advance(minutes(180));
    restartSweep(d.server.runtime);
    expect(run(run_id)).toMatchObject({ state: 'open', lease_expires_at: graceFromNow() });
    expect(sweepOnce(d.server.runtime).interrupted).not.toContain(run_id);
  });

  it("an agent's next call with its run_id continues, and renews the lease", () => {
    const { run_id } = claim('RCP-17');
    d.clock.advance(minutes(180));
    restartSweep(d.server.runtime);
    d.clock.advance(minutes(5));
    d.services.runs.heartbeat(d.read({ ...claude, run_id }), { run_id });
    const lease = new Date(d.clock.now().getTime() + d.server.runtime.config.leaseMs).toISOString();
    expect(run(run_id)).toMatchObject({ state: 'open', lease_expires_at: lease });
  });

  it('a run that never returns ends by normal lease expiry, item back to Ready', () => {
    const { run_id } = claim('RCP-17');
    d.clock.advance(minutes(180));
    restartSweep(d.server.runtime);
    d.clock.advance(d.server.runtime.config.restartGraceMs + minutes(1));
    expect(sweepOnce(d.server.runtime).interrupted).toContain(run_id);
    expect(run(run_id)).toMatchObject({ state: 'interrupted', end_reason: 'lease_expired' });
    expect(d.row<{ status: string }>("SELECT status FROM items WHERE id = 'RCP-17'").status).toBe(
      'ready',
    );
  });

  it('leaves parked runs parked, with their lease suspended', () => {
    const { run_id } = claim('RCP-17');
    d.write({ ...claude, run_id }, (w, s) =>
      s.runs.park(w, { run_id, reason: 'Waiting.', waiting_on: { orchestrator: true } }),
    );
    expect(restartSweep(d.server.runtime).kept).not.toContain(run_id);
    expect(run(run_id)).toMatchObject({ state: 'parked', lease_expires_at: null });
  });

  it('writes nothing with no open run', () => {
    endRunsAsOldRestart(d.server.runtime);
    expect(restartSweep(d.server.runtime).kept).toEqual([]);
    expect(restarts()).toEqual([]);
  });

  it('keeps service_restart history readable in recovery_report', () => {
    const { run_id } = claim('RCP-17');
    endRunsAsOldRestart(d.server.runtime);
    const report = d.services.recovery.report(d.read(), { limit: 50, include_briefs: false });
    expect(report.interrupted.find((e) => e.run.run_id === run_id)?.end_reason).toBe(
      'service_restart',
    );
  });

  it("a run silent only because of the restart is its agent's until the grace ends", () => {
    const { run_id } = claim('RCP-17');
    const stale = d.server.runtime.config.staleAfterMs;
    d.clock.advance(stale + minutes(1));
    restartSweep(d.server.runtime);
    const view = () => d.services.views.needsYou(d.read(), { scope: 'all' });
    const id = `stale_run:${run_id}`;
    expect(view().problems.map((p) => p.id)).not.toContain(id);
    expect(view().agent_problems!.find((p) => p.id === id)?.explanation).toMatchObject({
      who: 'agent',
      what: expect.stringContaining('Docket restarted'),
    });
    d.clock.advance(d.server.runtime.config.restartGraceMs + minutes(1));
    // The lease it had left is what holds it now; once the grace is over it's the owner's again.
    expect(view().problems.map((p) => p.id)).toContain(id);
  });
});

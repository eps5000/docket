/**
 * Child runs through a Docket restart (owner decision 41; BUILD_SPEC §5.3).
 * A child has no lease, so a restart gives it a stored deadline to signal: it
 * continues if it does, ends as `service_restart` if it doesn't, and never
 * affects its parent. Outside a restart a child still has no time limit.
 */
import { ToolError } from '@docket/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../../src/domain/write.js';
import { restartSweep, sweepOnce } from '../../src/jobs/sweeper.js';
import type { Runtime } from '../../src/runtime.js';
import { createTestServer, type TestServer } from '../integration/harness.js';
import { forceStatus, minutes, startDomain, type Domain } from '../us1-helpers.js';

let d: Domain;
let lead: Actor;
let sub: Actor;
let rebooted: TestServer | null;

beforeEach(() => {
  d = startDomain();
  lead = d.agent('claude', { label: 'orca-w1' });
  sub = d.agent('claude', { label: 'orca-w1-sub' });
  rebooted = null;
});
afterEach(async () => {
  await rebooted?.cleanup().catch(() => {});
  await d.cleanup().catch(() => {});
});

interface Row {
  state: string;
  end_reason: string | null;
  lease_expires_at: string | null;
  restart_deadline_at: string | null;
}
const rowOn = (runtime: Runtime, id: string) =>
  runtime.db.sqlite.prepare('SELECT * FROM runs WHERE id = ?').get(id) as Row;
const run = (id: string) => rowOn(d.server.runtime, id);
const grace = () => d.server.runtime.config.restartGraceMs;
const graceFromNow = () => new Date(d.clock.now().getTime() + grace()).toISOString();
const claim = (id = 'RCP-17', extra: Record<string, unknown> = {}) =>
  d.write(lead, (w, s) => s.runs.claim(w, { id, agent_label: 'orca-w1', ...extra })).run_id;
const child = (parent: string, extra: Record<string, unknown> = {}, id = 'RCP-17') =>
  d.write({ ...lead, run_id: parent }, (w, s) =>
    s.runs.startRun(w, { id, parent_run_id: parent, agent_label: 'orca-w1-sub', ...extra }),
  ).run_id;
const beat = (run_id: string, extra: Record<string, unknown> = {}) =>
  d.services.runs.heartbeat(d.read({ ...sub, run_id }), { run_id, ...extra });
const restart = () => restartSweep(d.server.runtime);
const sweep = () => sweepOnce(d.server.runtime);
const ended = (run_id: string) =>
  d.rows(
    "SELECT seq FROM events WHERE type = 'run.ended' AND json_extract(data, '$.run_id') = ?",
    run_id,
  );
const wsState = (path: string) =>
  d.services.recovery.workspaceStates(d.read(), { paths: [path] })[path];

/** A real second boot: the runtime closes and a new one opens the same data directory. */
async function reboot(): Promise<Runtime> {
  await d.server.runtime.close();
  rebooted = createTestServer({ clock: d.clock, dataDir: d.server.dataDir });
  return rebooted.runtime;
}

describe('a child that signals in time', () => {
  it('continues, and has no time limit again until the next restart', () => {
    const parent = claim();
    const c = child(parent);
    expect(run(c).restart_deadline_at).toBeNull();
    restart();
    expect(run(c)).toMatchObject({
      state: 'open',
      restart_deadline_at: graceFromNow(),
      lease_expires_at: null,
    });
    d.clock.advance(grace() - minutes(1));
    expect(beat(c).lease_expires_at).toBeNull();
    expect(run(c).restart_deadline_at).toBeNull();
    d.clock.advance(minutes(2));
    expect(sweep().children).toEqual([]);
    d.clock.advance(minutes(30)); // Silent for far longer than the grace: no general lease.
    d.services.runs.heartbeat(d.read({ ...lead, run_id: parent }), { run_id: parent });
    d.clock.advance(minutes(50));
    expect(sweep().children).not.toContain(c);
    expect(run(c)).toMatchObject({ state: 'open', end_reason: null });
    expect(ended(c)).toEqual([]);
  });

  it('clears the deadline even when it signals in the same instant as the restart', () => {
    const c = child(claim());
    restart();
    beat(c);
    expect(run(c).restart_deadline_at).toBeNull();
  });
});

describe('a child that stays silent', () => {
  it('ends at the deadline as interrupted (service_restart), with one run.ended', () => {
    const c = child(claim());
    restart();
    d.clock.advance(grace() - 1);
    expect(sweep().children).toEqual([]);
    d.clock.advance(1);
    expect(sweep().children).toEqual([c]);
    expect(run(c)).toMatchObject({
      state: 'interrupted',
      end_reason: 'service_restart',
      restart_deadline_at: null,
    });
    expect(ended(c)).toHaveLength(1);
    expect(sweep().children).toEqual([]);
    expect(ended(c)).toHaveLength(1);
  });

  it('a call after the deadline is refused, even before the sweep ends it', () => {
    const c = child(claim());
    restart();
    d.clock.advance(grace());
    let caught: unknown;
    try {
      beat(c);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ToolError);
    expect((caught as ToolError).code).toBe('conflict');
    expect((caught as ToolError).message).toContain('service restart');
  });

  it('its worktree follows the normal rules: at risk, then safe once the item is done', () => {
    const parent = claim('RCP-17', { workspace: { path: 'C:/work/lead', branch: 'lead' } });
    const dirty = child(parent, { workspace: { path: 'C:/work/dirty', branch: 'd' } });
    const clean = child(parent, { workspace: { path: 'C:/work/clean', branch: 'c' } });
    beat(dirty, { workspace: { dirty: true } });
    beat(clean, { workspace: { head_sha: 'abc1234', pushed_sha: 'abc1234', dirty: false } });
    expect(wsState('C:/work/clean')).toBe('in_use');
    restart();
    d.clock.advance(grace());
    expect(sweep().children.sort()).toEqual([dirty, clean].sort());
    expect(wsState('C:/work/dirty')).toBe('at_risk');
    expect(wsState('C:/work/clean')).toBe('at_risk'); // In-flight work on an open item.
    forceStatus(d, 'RCP-17', 'done');
    expect(wsState('C:/work/dirty')).toBe('at_risk');
    expect(wsState('C:/work/clean')).toBe('safe_to_prune');
  });
});

describe('a second restart during the grace', () => {
  it('keeps the first deadline, across a real reboot', async () => {
    const c = child(claim());
    restart();
    const deadline = run(c).restart_deadline_at!;
    d.clock.advance(minutes(10));
    const second = await reboot();
    const out = restartSweep(second);
    expect(out.kept).toContain(c);
    expect(rowOn(second, c).restart_deadline_at).toBe(deadline);
    d.clock.advance(grace() - minutes(10) - 1);
    expect(sweepOnce(second).children).toEqual([]);
    d.clock.advance(1);
    expect(sweepOnce(second).children).toEqual([c]);
    expect(rowOn(second, c)).toMatchObject({
      state: 'interrupted',
      end_reason: 'service_restart',
    });
  });

  it('a deadline that passed while Docket was down ends the child at boot', async () => {
    const c = child(claim());
    restart();
    d.clock.advance(grace() + minutes(5));
    const second = await reboot();
    const out = restartSweep(second);
    expect(out.ended).toEqual([c]);
    expect(out.kept).not.toContain(c);
    expect(rowOn(second, c).end_reason).toBe('service_restart');
  });

  it('a child that signalled between the restarts gets a new window', () => {
    const c = child(claim());
    restart();
    d.clock.advance(minutes(5));
    beat(c);
    d.clock.advance(minutes(5));
    restart();
    expect(run(c).restart_deadline_at).toBe(graceFromNow());
  });
});

describe('a parked child', () => {
  const park = (run_id: string) =>
    d.write({ ...sub, run_id }, (w, s) =>
      s.runs.park(w, { run_id, reason: 'Waiting.', waiting_on: { orchestrator: true } }),
    );

  it('stays parked through a restart, with no deadline', () => {
    const c = child(claim());
    park(c);
    expect(restart().kept).not.toContain(c);
    expect(run(c)).toMatchObject({ state: 'parked', restart_deadline_at: null });
    d.clock.advance(grace() + minutes(30));
    expect(sweep().children).toEqual([]);
    expect(run(c).state).toBe('parked');
  });

  it('parking inside the window clears the deadline, and resuming starts no lease', () => {
    const c = child(claim());
    restart();
    park(c);
    expect(run(c).restart_deadline_at).toBeNull();
    d.clock.advance(grace() + minutes(1));
    expect(sweep().children).toEqual([]);
    d.write({ ...sub, run_id: c }, (w, s) => s.runs.resume(w, { run_id: c }));
    expect(run(c)).toMatchObject({
      state: 'open',
      lease_expires_at: null,
      restart_deadline_at: null,
    });
  });
});

describe('a child and its live parent', () => {
  it('a child that signals keeps working beside its parent', () => {
    const parent = claim();
    const c = child(parent);
    restart();
    d.clock.advance(minutes(5));
    d.services.runs.heartbeat(d.read({ ...lead, run_id: parent }), { run_id: parent });
    beat(c);
    d.clock.advance(grace());
    const { interrupted, children } = sweep();
    expect(children).toEqual([]);
    expect(interrupted).not.toContain(parent);
    expect(run(parent).state).toBe('open');
    expect(run(c).state).toBe('open');
  });

  it('a dead child ends alone: the parent, its lease, the claim and the item are untouched', () => {
    const parent = claim();
    const live = child(parent);
    const dead = child(parent);
    restart();
    d.clock.advance(minutes(5));
    d.services.runs.heartbeat(d.read({ ...lead, run_id: parent }), { run_id: parent });
    beat(live);
    const before = run(parent);
    const released = () =>
      d.rows("SELECT seq FROM events WHERE type = 'claim.released' AND item_id = 'RCP-17'").length;
    const releasedBefore = released();
    d.clock.advance(grace());
    expect(sweep().children).toEqual([dead]);
    expect(run(dead).end_reason).toBe('service_restart');
    expect(run(parent)).toEqual(before);
    expect(run(live).state).toBe('open');
    expect(released()).toBe(releasedBefore);
    expect(d.row<{ status: string }>("SELECT status FROM items WHERE id = 'RCP-17'").status).toBe(
      'progress',
    );
    d.fails(d.agent('codex'), (w, s) => s.runs.claim(w, { id: 'RCP-17' }), 'conflict');
  });

  it('a signal from the parent does not keep a dead child alive', () => {
    const parent = claim();
    const dead = child(parent);
    restart();
    d.clock.advance(grace() - minutes(1));
    d.services.runs.heartbeat(d.read({ ...lead, run_id: parent }), { run_id: parent });
    expect(run(dead).restart_deadline_at).not.toBeNull();
    d.clock.advance(minutes(1));
    expect(sweep().children).toEqual([dead]);
  });
});

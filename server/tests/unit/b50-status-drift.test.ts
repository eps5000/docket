/**
 * Status that follows the work (owner decision 42; BUILD_SPEC §5.23): who may
 * update a run's status and what that can't do, producer holds across worker
 * handoffs, and the activity flag's lifecycle. The Gameflow replays are in
 * integration/b50-replays.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getRun, isResumable } from '../../src/domain/model.js';
import type { Actor } from '../../src/domain/write.js';
import { runActivityOnce, sweepOnce } from '../../src/jobs/sweeper.js';
import { minutes, startDomain, type Domain } from '../us1-helpers.js';

const CO = 'orca-coordinator';
let d: Domain;
let worker: Actor;
let other: Actor;

beforeEach(() => {
  d = startDomain();
  worker = d.agent('claude', { label: 'worker-1' });
  other = d.agent('codex', { label: 'someone' });
});
afterEach(() => d.cleanup());

const claim = (extra: Record<string, unknown> = {}, id = 'RCP-17', actor = worker) =>
  d.write(actor, (w, s) => s.runs.claim(w, { id, agent_label: 'worker-1', ...extra })).run_id;
const status = (id = 'RCP-17') =>
  d.row<{ status: string }>('SELECT status FROM items WHERE id = ?', id).status;
const update = (input: Record<string, unknown>, actor = other) =>
  d.write(actor, (w, s) =>
    s.runs.updateStatus(w, { id: 'RCP-17', coordinator: CO, ...input } as never),
  );
const park = (run_id: string, waiting_on: Record<string, unknown> = { orchestrator: true }) =>
  d.write({ ...worker, run_id }, (w, s) =>
    s.runs.park(w, { run_id, reason: 'Waiting', waiting_on }),
  );
const run = (id: string) => getRun(d.server.runtime.db, id)!;
const flag = (id: string) =>
  (JSON.parse(run(id).park_activity ?? '{}') as { flag?: { events: number } | null }).flag ?? null;
const note = (text = 'Found it') =>
  d.write(other, (w, s) => s.evidence.addNote(w, { id: 'RCP-17', text }));

describe('update_run_status: who may use it', () => {
  it("allows the run's recorded orchestrator, and names them", () => {
    const id = claim({ orchestrator: { name: CO } });
    const out = update({ current_action: 'Checking the build' });
    expect(out).toMatchObject({ id: 'RCP-17', updated_by: CO });
    expect(run(id).summary).toBe('Checking the build');
    expect(JSON.parse(run(id).status_update!)).toMatchObject({ by: CO, client: 'codex' });
    const event = d.row<{ summary: string; data: string }>(
      "SELECT summary, data FROM events WHERE type = 'run.status_updated'",
    );
    expect(event.summary).toContain(`${CO} (coordinator)`);
    expect(JSON.parse(event.data)).toMatchObject({ run_id: id, updated_by: CO });
  });

  it('allows a coordinator the owner registered for the project', () => {
    claim();
    d.fails(
      other,
      (w, s) => s.runs.updateStatus(w, { id: 'RCP-17', coordinator: CO, current_action: 'x' }),
      'forbidden',
    );
    d.write({ kind: 'owner', client: null, label: null, session_id: null, run_id: null }, (w, s) =>
      s.projects.setDefaultSatisfiedWhen(w, { key: 'RCP', coordinators: [CO] }),
    );
    expect(update({ current_action: 'x' }).updated_by).toBe(CO);
  });

  it('refuses anyone else, and changes nothing', () => {
    const id = claim({ orchestrator: { name: CO } });
    const before = run(id);
    d.fails(
      other,
      (w, s) =>
        s.runs.updateStatus(w, { id: 'RCP-17', coordinator: 'not-them', current_action: 'x' }),
      'forbidden',
    );
    expect(run(id)).toEqual(before);
  });

  it("doesn't count as the run's signal or renew its lease", () => {
    const id = claim({ orchestrator: { name: CO } });
    const before = run(id);
    d.clock.advance(minutes(10));
    update({ current_action: 'x' });
    expect(run(id).last_signal_at).toBe(before.last_signal_at);
    expect(run(id).lease_expires_at).toBe(before.lease_expires_at);
  });

  it('grants no claim: the item stays with its lead and others are still refused', () => {
    const id = claim({ orchestrator: { name: CO } });
    update({ current_action: 'x' });
    d.fails(other, (w, s) => s.runs.claim(w, { id: 'RCP-17' }), 'conflict');
    d.fails(
      other,
      (w, s) => s.runs.finish(w, { run_id: id, result: 'finished', summary: 'x' }),
      'forbidden',
    );
    expect(run(id).state).toBe('open');
  });

  it("can't park an open run, and can't resume one that isn't parked", () => {
    claim({ orchestrator: { name: CO } });
    for (const input of [
      { park_reason: 'x' },
      { waiting_on: { person: true } },
      { resume: true },
    ]) {
      d.fails(
        other,
        (w, s) => s.runs.updateStatus(w, { id: 'RCP-17', coordinator: CO, ...input } as never),
        'validation',
      );
    }
  });

  it('changes a park reason and waiting-on, keeping when it parked', () => {
    const id = claim({ orchestrator: { name: CO } });
    park(id);
    const since = run(id).parked_at;
    d.clock.advance(minutes(5));
    update({ park_reason: 'Now waiting on RCP-25', waiting_on: { items: ['RCP-25'] } });
    expect(run(id)).toMatchObject({
      state: 'parked',
      parked_reason: 'Now waiting on RCP-25',
      parked_at: since,
    });
    expect(JSON.parse(run(id).waiting_on!)).toEqual({ items: ['RCP-25'] });
  });

  it('a resume names the coordinator, not the run', () => {
    const id = claim({ orchestrator: { name: CO } });
    park(id);
    update({ resume: true });
    expect(run(id).state).toBe('open');
    const e = d.row<{ summary: string; data: string }>(
      "SELECT summary, data FROM events WHERE type = 'run.resumed'",
    );
    expect(e.summary).toContain(`${CO} (coordinator) resumed`);
    expect(JSON.parse(e.data)).toMatchObject({ updated_by: CO });
  });

  it("the run's own words replace the coordinator's", () => {
    const id = claim({ orchestrator: { name: CO } });
    update({ current_action: 'From the coordinator' });
    d.clock.advance(minutes(1));
    d.services.runs.heartbeat(d.read({ ...worker, run_id: id }), { run_id: id, note: 'Mine' });
    expect(run(id).status_update).toBeNull();
    expect(run(id).summary).toBe('Mine');
  });
});

describe('producer holds (one story, many workers)', () => {
  it('a release under a producer keeps the story In progress and off the resumable list', () => {
    const id = claim({ producer: 'p1' });
    d.write({ ...worker, run_id: id }, (w, s) =>
      s.runs.release(w, { id: 'RCP-17', run_id: id, reason: 'Slice done' }),
    );
    expect(status()).toBe('progress');
    expect(isResumable(d.server.runtime.db, 'RCP-17')).toBe(false);
  });

  it('only the same producer can pick it up; attribution stays per worker', () => {
    const a = claim({ producer: 'p1' });
    d.write({ ...worker, run_id: a }, (w, s) =>
      s.runs.release(w, { id: 'RCP-17', run_id: a, reason: 'Done' }),
    );
    d.fails(other, (w, s) => s.runs.claim(w, { id: 'RCP-17' }), 'conflict');
    d.fails(other, (w, s) => s.runs.claim(w, { id: 'RCP-17', producer: 'p2' }), 'conflict');
    const b = d.write(other, (w, s) =>
      s.runs.claim(w, { id: 'RCP-17', agent_label: 'worker-2', producer: 'p1' }),
    ).run_id;
    expect(run(b)).toMatchObject({ client: 'codex', label: 'worker-2', producer: 'p1' });
    expect(run(a).producer_hold_until).toBeNull();
    const granted = d.row<{ summary: string }>(
      "SELECT summary FROM events WHERE type = 'claim.granted' ORDER BY seq DESC LIMIT 1",
    );
    expect(granted.summary).toContain('took over from claude · worker-1 under producer p1');
  });

  it('keeps one active lead: a second worker is refused while the first holds it', () => {
    claim({ producer: 'p1' });
    d.fails(other, (w, s) => s.runs.claim(w, { id: 'RCP-17', producer: 'p1' }), 'conflict');
  });

  it('a real release by the producer returns it to Ready', () => {
    const id = claim({ producer: 'p1' });
    d.write({ ...worker, run_id: id }, (w, s) =>
      s.runs.release(w, { id: 'RCP-17', run_id: id, reason: 'Giving it up', release_story: true }),
    );
    expect(status()).toBe('ready');
    expect(run(id).producer_hold_until).toBeNull();
  });

  it("a worker's lease expiry holds it, and the hold's expiry returns it to Ready", () => {
    const id = claim({ producer: 'p1' });
    d.clock.advance(d.server.runtime.config.leaseMs + minutes(1));
    expect(sweepOnce(d.server.runtime).interrupted).toContain(id);
    expect(status()).toBe('progress');
    d.clock.advance(d.server.runtime.config.producerGraceMs + minutes(1));
    expect(sweepOnce(d.server.runtime).returned).toEqual(['RCP-17']);
    expect(status()).toBe('ready');
    expect(run(id).producer_hold_until).toBeNull();
  });

  it('a run with no producer behaves exactly as before', () => {
    const id = claim();
    d.write({ ...worker, run_id: id }, (w, s) =>
      s.runs.release(w, { id: 'RCP-17', run_id: id, reason: 'Stopping' }),
    );
    expect(status()).toBe('ready');
    expect(run(id).producer_hold_until).toBeNull();
  });

  it('leaving In progress ends the hold, whatever moved it', () => {
    const id = claim({ producer: 'p1' });
    d.write({ ...worker, run_id: id }, (w, s) =>
      s.runs.release(w, { id: 'RCP-17', run_id: id, reason: 'Done' }),
    );
    d.sql.prepare("UPDATE items SET status = 'review' WHERE id = 'RCP-17'").run();
    expect(run(id).producer_hold_until).toBeNull();
    d.sql.prepare("UPDATE items SET status = 'progress' WHERE id = 'RCP-17'").run();
    expect(isResumable(d.server.runtime.db, 'RCP-17')).toBe(true);
  });
});

describe('activity since parked', () => {
  it('flags a note, keeps the state, and raises one event', async () => {
    const id = claim();
    park(id);
    d.clock.advance(minutes(5));
    note();
    expect(await runActivityOnce(d.server.runtime)).toEqual([id]);
    expect(run(id).state).toBe('parked');
    expect(flag(id)).toMatchObject({ events: 1 });
    note('Another');
    expect(await runActivityOnce(d.server.runtime)).toEqual([]);
    expect(flag(id)).toMatchObject({ events: 2 });
    expect(d.rows("SELECT seq FROM events WHERE type = 'run.activity'")).toHaveLength(1);
  });

  it('nothing new, nothing written', async () => {
    const id = claim();
    park(id);
    d.clock.advance(minutes(5));
    expect(await runActivityOnce(d.server.runtime)).toEqual([]);
    expect(flag(id)).toBeNull();
  });

  it("clears when a coordinator updates it, and what they saw isn't raised again", async () => {
    const id = claim({ orchestrator: { name: CO } });
    park(id);
    d.clock.advance(minutes(5));
    note();
    await runActivityOnce(d.server.runtime);
    d.clock.advance(minutes(1));
    update({ park_reason: 'Still waiting' });
    expect(flag(id)).toBeNull();
    d.clock.advance(minutes(2));
    expect(await runActivityOnce(d.server.runtime)).toEqual([]);
    expect(flag(id)).toBeNull();
  });

  it('clears when the run resumes itself', async () => {
    const id = claim();
    park(id);
    d.clock.advance(minutes(5));
    note();
    await runActivityOnce(d.server.runtime);
    d.write({ ...worker, run_id: id }, (w, s) => s.runs.resume(w, { run_id: id }));
    expect(run(id).park_activity).toBeNull();
  });

  it("doesn't count the park's own bookkeeping", async () => {
    const id = claim();
    d.clock.advance(minutes(1));
    park(id);
    d.clock.advance(minutes(5));
    expect(await runActivityOnce(d.server.runtime)).toEqual([]);
  });
});

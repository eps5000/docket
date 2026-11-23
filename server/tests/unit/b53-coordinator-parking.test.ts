/**
 * Time-limited coordinator parking (owner decision 44; BUILD_SPEC §5.25): who
 * may park, the limits, renewal and early end, what happens at the deadline,
 * restarts, and how it meets the run's own park and other protections. Over
 * real MCP clients: contract/b53-coordinator-park.test.ts.
 */
import { COORDINATOR_PARK } from '@docket/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getRun } from '../../src/domain/model.js';
import type { Actor } from '../../src/domain/write.js';
import { restartSweep, runActivityOnce, sweepOnce } from '../../src/jobs/sweeper.js';
import { minutes, startDomain, type Domain } from '../us1-helpers.js';
import { askForm } from '../helpers.js';

const CO = 'orca-coordinator';
const OWNER: Actor = { kind: 'owner', client: null, label: null, session_id: null, run_id: null };
let d: Domain;
let worker: Actor;
let coordinator: Actor;

beforeEach(() => {
  d = startDomain();
  worker = d.agent('claude', { label: 'worker-1' });
  coordinator = d.agent('codex', { label: 'lead' });
});
afterEach(() => d.cleanup());

const claim = (extra: Record<string, unknown> = {}, id = 'RCP-17') =>
  d.write(worker, (w, s) =>
    s.runs.claim(w, { id, agent_label: 'worker-1', orchestrator: { name: CO }, ...extra }),
  ).run_id;
const update = (input: Record<string, unknown>, id = 'RCP-17') =>
  d.write(coordinator, (w, s) =>
    s.runs.updateStatus(w, { id, coordinator: CO, ...input } as never),
  );
const refused = (input: Record<string, unknown>, code: 'validation' | 'forbidden' = 'validation') =>
  d.fails(
    coordinator,
    (w, s) => s.runs.updateStatus(w, { id: 'RCP-17', coordinator: CO, ...input } as never),
    code,
  );
const parkFor = (park_minutes: number, id = 'RCP-17') =>
  update({ park_minutes, park_reason: 'Waiting on CI', waiting_on: { orchestrator: true } }, id);
const run = (id: string) => getRun(d.server.runtime.db, id)!;
const stored = (id: string) =>
  JSON.parse(run(id).coordinator_park ?? 'null') as {
    by: string;
    client: string;
    until: string;
    ended_at?: string;
  } | null;
const status = (id = 'RCP-17') =>
  d.row<{ status: string }>('SELECT status FROM items WHERE id = ?', id).status;
const eventsOf = (type: string) =>
  d.rows<{ summary: string; data: string }>(
    'SELECT summary, data FROM events WHERE type = ? ORDER BY seq',
    type,
  );
const graceMs = () => d.server.runtime.config.restartGraceMs;
const iso = (offsetMs: number) => new Date(d.clock.now().getTime() + offsetMs).toISOString();
/** The run's own later write, as the MCP hook does it: resume, then the signal. */
const ownWrite = (id: string) => {
  d.write({ ...worker, run_id: id }, (w, s) => s.runs.resume(w, { run_id: id }));
  d.services.runs.recordSignal(d.read({ ...worker, run_id: id }), {
    run_id: id,
    kind: 'report',
    session_id: null,
  });
};

describe('who may park', () => {
  it("allows the run's recorded orchestrator, and records who and until when", () => {
    const id = claim();
    const out = parkFor(60);
    expect(out).toMatchObject({
      run_state: 'parked',
      updated_by: CO,
      parked_until: iso(minutes(60)),
    });
    expect(run(id)).toMatchObject({ state: 'parked', lease_expires_at: null });
    expect(stored(id)).toMatchObject({ by: CO, client: 'codex', until: iso(minutes(60)) });
    const [event] = eventsOf('run.parked');
    expect(event!.summary).toContain(`${CO} (coordinator) parked`);
    expect(JSON.parse(event!.data)).toMatchObject({ parked_by: CO, until: iso(minutes(60)) });
  });

  it('allows a coordinator the owner registered for the project', () => {
    claim({ orchestrator: undefined });
    refused({ park_minutes: 30, park_reason: 'x', waiting_on: { person: true } }, 'forbidden');
    d.write(OWNER, (w, s) =>
      s.projects.setDefaultSatisfiedWhen(w, { key: 'RCP', coordinators: [CO] }),
    );
    expect(parkFor(30).run_state).toBe('parked');
  });

  it('refuses anyone else and changes nothing', () => {
    const id = claim();
    const before = run(id);
    d.fails(
      coordinator,
      (w, s) =>
        s.runs.updateStatus(w, {
          id: 'RCP-17',
          coordinator: 'not-them',
          park_minutes: 30,
          park_reason: 'x',
          waiting_on: { person: true },
        }),
      'forbidden',
    );
    expect(run(id)).toEqual(before);
  });

  it('grants no claim or close, and is not the run signalling', () => {
    const id = claim();
    const signalled = run(id).last_signal_at;
    d.clock.advance(minutes(5));
    parkFor(30);
    expect(run(id).last_signal_at).toBe(signalled);
    d.fails(coordinator, (w, s) => s.runs.claim(w, { id: 'RCP-17' }), 'conflict');
    d.fails(
      coordinator,
      (w, s) => s.runs.finish(w, { run_id: id, result: 'finished', summary: 'x' }),
      'forbidden',
    );
  });

  it('a new park needs a reason and waiting_on', () => {
    claim();
    expect(refused({ park_minutes: 30, waiting_on: { person: true } }).message).toContain(
      'park_reason',
    );
    expect(refused({ park_minutes: 30, park_reason: 'x' }).message).toContain('waiting_on');
  });
});

describe('the limits', () => {
  it('names them: 4 hours a park, 24 hours since the last own signal', () => {
    expect(COORDINATOR_PARK).toEqual({ max_minutes: 240, total_minutes: 1_440 });
  });

  it('allows exactly the per-park limit', () => {
    const id = claim();
    parkFor(COORDINATOR_PARK.max_minutes);
    expect(stored(id)!.until).toBe(iso(minutes(240)));
  });

  it('renews up to exactly 24 hours since the last own signal, then refuses without clamping', () => {
    const id = claim();
    const signalled = d.clock.now().getTime();
    for (let hour = 0; hour < 5; hour++) {
      parkFor(240);
      d.clock.advance(minutes(230));
    }
    // 1,150 minutes in: 290 are left, so a 240 fits and leaves the deadline at 1,390.
    parkFor(240);
    d.clock.advance(minutes(40));
    // 1,190 in: 250 left.
    parkFor(240);
    d.clock.advance(minutes(200));
    // 1,390 in: 50 left.
    const before = run(id);
    const err = refused({ park_minutes: 51 });
    expect(err.message).toContain('at most 50 more minutes');
    expect(run(id)).toEqual(before);
    parkFor(50);
    expect(stored(id)!.until).toBe(new Date(signalled + minutes(1_440)).toISOString());
  });

  it('refuses a new park once 24 hours have passed since the last own signal', () => {
    const id = claim();
    d.sql
      .prepare('UPDATE runs SET last_signal_at = ?, lease_expires_at = ? WHERE id = ?')
      .run(iso(-minutes(1_440)), iso(minutes(10)), id);
    expect(refused({ park_minutes: 1, park_reason: 'x', waiting_on: {} }).message).toContain(
      "can't be parked again",
    );
    expect(run(id).state).toBe('open');
  });

  it("can't turn the run's own park into a limited one", () => {
    const id = claim();
    d.write({ ...worker, run_id: id }, (w, s) =>
      s.runs.park(w, { run_id: id, reason: 'Mine', waiting_on: { person: true } }),
    );
    expect(refused({ park_minutes: 30 }).message).toContain('parked itself');
    expect(stored(id)).toBeNull();
  });
});

describe('renewing and ending early', () => {
  it('a renewal moves the deadline, keeps when it parked, and keeps what it waits on', () => {
    const id = claim();
    parkFor(60);
    const since = run(id).parked_at;
    d.clock.advance(minutes(30));
    const out = update({ park_minutes: 120 });
    expect(out.parked_until).toBe(iso(minutes(120)));
    expect(run(id)).toMatchObject({
      state: 'parked',
      parked_at: since,
      parked_reason: 'Waiting on CI',
    });
    expect(JSON.parse(run(id).waiting_on!)).toEqual({ orchestrator: true });
    expect(eventsOf('run.parked')).toHaveLength(1);
    expect(JSON.parse(eventsOf('run.status_updated').at(-1)!.data)).toMatchObject({
      renewed: true,
      until: iso(minutes(120)),
    });
  });

  it('a raised activity flag survives renewals, new reasons and the expiry', async () => {
    const id = claim();
    parkFor(60);
    d.clock.advance(minutes(5));
    d.write(coordinator, (w, s) => s.evidence.addNote(w, { id: 'RCP-17', text: 'Found it' }));
    expect(await runActivityOnce(d.server.runtime)).toEqual([id]);
    const raised = run(id).park_activity;
    expect(JSON.parse(raised!).flag).toMatchObject({ events: 1 });

    d.clock.advance(minutes(5));
    update({ park_minutes: 120 });
    expect(run(id).park_activity).toBe(raised);
    d.clock.advance(minutes(5));
    update({
      park_minutes: 120,
      park_reason: 'Now waiting on review',
      waiting_on: { person: true },
    });
    expect(run(id).park_activity).toBe(raised);

    d.clock.advance(minutes(120));
    expect(sweepOnce(d.server.runtime).unparked).toEqual([id]);
    expect(run(id).state).toBe('open');
    expect(run(id).park_activity).toBe(raised);
    expect(eventsOf('run.activity')).toHaveLength(1);
  });

  describe('activity before a renewal that no check has seen yet is still detected', () => {
    const blocker = 'RCP-25';
    const cases: [string, Record<string, unknown>, () => void, Record<string, unknown>][] = [
      [
        'a note',
        { orchestrator: true },
        () =>
          d.write(coordinator, (w, s) => s.evidence.addNote(w, { id: 'RCP-17', text: 'Found it' })),
        { events: 1 },
      ],
      [
        'a reported commit',
        { orchestrator: true },
        () =>
          d.write(coordinator, (w, s) =>
            s.evidence.reportCommit(w, {
              id: 'RCP-17',
              sha: '4be1c09',
              branch: 'rcp-17',
              pushed: false,
            }),
          ),
        { events: 1 },
      ],
      [
        'a blocker clearing',
        { items: [blocker] },
        () =>
          d.sql
            .prepare("UPDATE items SET status = 'done', closed_at = ?, updated_at = ? WHERE id = ?")
            .run(d.clock.now().toISOString(), d.clock.now().toISOString(), blocker),
        { cleared_items: [blocker] },
      ],
    ];

    it.each(cases)('%s', async (_name, waiting_on, happen, expected) => {
      const id = claim();
      update({ park_minutes: 60, park_reason: 'Waiting', waiting_on });
      const baseline = run(id).park_activity;
      d.clock.advance(minutes(5));
      happen();
      d.clock.advance(minutes(1));
      update({ park_minutes: 120, park_reason: 'Still waiting', waiting_on });
      expect(run(id).park_activity).toBe(baseline);
      d.clock.advance(minutes(1));
      update({ park_minutes: 120 });
      expect(run(id).park_activity).toBe(baseline);

      expect(await runActivityOnce(d.server.runtime)).toEqual([id]);
      expect(run(id).state).toBe('parked');
      expect(JSON.parse(run(id).park_activity!).flag).toMatchObject(expected);
    });
  });

  it('a new park after the old one ran out starts from a fresh baseline', async () => {
    const id = claim();
    parkFor(60);
    d.clock.advance(minutes(5));
    d.write(coordinator, (w, s) => s.evidence.addNote(w, { id: 'RCP-17', text: 'Found it' }));
    await runActivityOnce(d.server.runtime);
    d.clock.advance(minutes(55));
    sweepOnce(d.server.runtime);
    parkFor(30);
    expect(JSON.parse(run(id).park_activity!)).toEqual({
      since: d.clock.now().toISOString(),
      flag: null,
    });
  });

  it('changing the reason leaves the deadline alone', () => {
    const id = claim();
    parkFor(60);
    const until = stored(id)!.until;
    d.clock.advance(minutes(5));
    expect(update({ park_reason: 'Waiting on review' }).parked_until).toBe(until);
    expect(stored(id)!.until).toBe(until);
  });

  it('ending it early returns the run on the short lease, named as the coordinator', () => {
    const id = claim();
    parkFor(120);
    d.clock.advance(minutes(10));
    update({ resume: true });
    expect(run(id)).toMatchObject({
      state: 'open',
      lease_expires_at: iso(graceMs()),
      coordinator_park: null,
    });
    expect(eventsOf('run.resumed').at(-1)!.summary).toContain(`${CO} (coordinator) resumed`);
  });
});

describe('at the deadline', () => {
  it('stays parked until then', () => {
    const id = claim();
    parkFor(60);
    d.clock.advance(minutes(60) - 1);
    expect(sweepOnce(d.server.runtime).unparked).toEqual([]);
    expect(run(id).state).toBe('parked');
  });

  it('returns to open on a short lease, keeps the claim, and tells the coordinator once', () => {
    const id = claim();
    parkFor(60);
    d.clock.advance(minutes(60));
    const sweep = sweepOnce(d.server.runtime);
    expect(sweep.unparked).toEqual([id]);
    expect(sweep.interrupted).not.toContain(id);
    expect(run(id)).toMatchObject({
      state: 'open',
      end_reason: null,
      lease_expires_at: iso(graceMs()),
      parked_at: null,
    });
    expect(status()).toBe('progress');
    expect(stored(id)!.ended_at).toBe(d.clock.now().toISOString());
    expect(eventsOf('run.park_expired')).toHaveLength(1);
    expect(JSON.parse(eventsOf('run.park_expired')[0]!.data)).toMatchObject({
      run_id: id,
      parked_by: CO,
      lease_expires_at: iso(graceMs()),
    });
  });

  it('is processed once, however many sweeps follow', () => {
    const id = claim();
    parkFor(60);
    d.clock.advance(minutes(60));
    expect(sweepOnce(d.server.runtime).unparked).toEqual([id]);
    const version = run(id).version;
    expect(sweepOnce(d.server.runtime).unparked).toEqual([]);
    expect(sweepOnce(d.server.runtime).unparked).toEqual([]);
    expect(eventsOf('run.park_expired')).toHaveLength(1);
    expect(run(id).version).toBe(version);
  });

  it('a dead run then loses its claim through the normal lease_expired path', () => {
    const id = claim();
    parkFor(60);
    d.clock.advance(minutes(60));
    sweepOnce(d.server.runtime);
    d.clock.advance(graceMs() - 1);
    expect(sweepOnce(d.server.runtime).interrupted).not.toContain(id);
    d.clock.advance(1);
    expect(sweepOnce(d.server.runtime).interrupted).toContain(id);
    expect(run(id)).toMatchObject({ state: 'interrupted', end_reason: 'lease_expired' });
    expect(status()).toBe('ready');
  });

  it('a dead worker under a producer leaves the story held, as any lease expiry does', () => {
    const id = claim({ producer: 'p1' });
    parkFor(60);
    d.clock.advance(minutes(60));
    sweepOnce(d.server.runtime);
    d.clock.advance(graceMs());
    sweepOnce(d.server.runtime);
    expect(run(id).end_reason).toBe('lease_expired');
    expect(run(id).producer_hold_until).not.toBeNull();
    expect(status()).toBe('progress');
  });

  it('a live run continues: its next call renews the full lease and clears the marker', () => {
    const id = claim();
    parkFor(60);
    d.clock.advance(minutes(60));
    sweepOnce(d.server.runtime);
    d.clock.advance(minutes(1));
    d.services.runs.heartbeat(d.read({ ...worker, run_id: id }), { run_id: id, note: 'Back' });
    expect(run(id)).toMatchObject({
      state: 'open',
      coordinator_park: null,
      lease_expires_at: iso(d.server.runtime.config.leaseMs),
    });
    d.clock.advance(d.server.runtime.config.leaseMs - 1);
    expect(sweepOnce(d.server.runtime).interrupted).not.toContain(id);
  });

  it('a run with a question still open goes back to needs_input', () => {
    const id = claim();
    d.write({ ...worker, run_id: id }, (w, s) =>
      s.messages.askOwner(w, { id: 'RCP-17', run_id: id, ...askForm('Which one?') }),
    );
    expect(run(id).state).toBe('needs_input');
    parkFor(60);
    d.clock.advance(minutes(60));
    sweepOnce(d.server.runtime);
    expect(run(id).state).toBe('needs_input');
  });

  it("the coordinator's call after the deadline, before the sweep, treats it as ended", () => {
    const id = claim();
    parkFor(60);
    d.clock.advance(minutes(61));
    update({ current_action: 'Checking on it' });
    expect(run(id).state).toBe('open');
    expect(eventsOf('run.park_expired')).toHaveLength(1);
    expect(sweepOnce(d.server.runtime).unparked).toEqual([]);
    expect(eventsOf('run.park_expired')).toHaveLength(1);
  });

  it('a coordinator may park it again after expiry, within the 24 hours', () => {
    const id = claim();
    parkFor(240);
    d.clock.advance(minutes(240));
    sweepOnce(d.server.runtime);
    expect(parkFor(120).run_state).toBe('parked');
    expect(stored(id)!.ended_at).toBeUndefined();
  });
});

describe('restarts', () => {
  it('a deadline that passed while Docket was down is handled at boot, and no other run is hurt', () => {
    const id = claim();
    const other = claim({ orchestrator: undefined }, otherReady());
    parkFor(60);
    d.clock.advance(minutes(90));
    const out = restartSweep(d.server.runtime);
    expect(out.unparked).toEqual([id]);
    expect(run(id)).toMatchObject({ state: 'open', lease_expires_at: iso(graceMs()) });
    expect(run(other).state).toBe('open');
    expect(out.kept).toEqual(expect.arrayContaining([id, other]));
    expect(sweepOnce(d.server.runtime).unparked).toEqual([]);
    expect(eventsOf('run.park_expired')).toHaveLength(1);
  });

  it('a deadline still ahead survives the restart and expires on time', () => {
    const id = claim();
    parkFor(120);
    const until = stored(id)!.until;
    d.clock.advance(minutes(30));
    expect(restartSweep(d.server.runtime).unparked).toEqual([]);
    expect(run(id).state).toBe('parked');
    expect(stored(id)!.until).toBe(until);
    d.clock.advance(minutes(90));
    expect(sweepOnce(d.server.runtime).unparked).toEqual([id]);
  });
});

describe("the run's own word", () => {
  it('its own park_run replaces the limit, and is never expired', () => {
    const id = claim();
    parkFor(60);
    d.clock.advance(minutes(10));
    d.write({ ...worker, run_id: id }, (w, s) =>
      s.runs.park(w, { run_id: id, reason: 'My own wait', waiting_on: { person: true } }),
    );
    expect(run(id)).toMatchObject({
      state: 'parked',
      coordinator_park: null,
      parked_reason: 'My own wait',
      last_signal_at: d.clock.now().toISOString(),
    });
    d.clock.advance(minutes(600));
    expect(sweepOnce(d.server.runtime).unparked).toEqual([]);
    expect(run(id).state).toBe('parked');
  });

  it('a real write by the run resumes it on the full lease', () => {
    const id = claim();
    parkFor(60);
    d.clock.advance(minutes(10));
    ownWrite(id);
    expect(run(id)).toMatchObject({
      state: 'open',
      coordinator_park: null,
      lease_expires_at: iso(d.server.runtime.config.leaseMs),
    });
    d.clock.advance(minutes(60));
    expect(sweepOnce(d.server.runtime).unparked).toEqual([]);
  });

  it('own parks are unchanged: no deadline, and a coordinator resume keeps the full lease', () => {
    const id = claim();
    d.write({ ...worker, run_id: id }, (w, s) =>
      s.runs.park(w, { run_id: id, reason: 'Mine', waiting_on: { orchestrator: true } }),
    );
    expect(run(id).coordinator_park).toBeNull();
    d.clock.advance(minutes(30));
    update({ resume: true });
    expect(run(id).lease_expires_at).toBe(iso(d.server.runtime.config.leaseMs));
  });
});

describe('alongside the other protections', () => {
  const PART = 'file:server/src/db/schema.ts';
  const addPart = () => {
    const at = d.clock.now().toISOString();
    d.sql
      .prepare(
        `INSERT INTO shared_parts (id, project_key, key, kind, paths, single_writer, created_by, version, created_at, updated_at)
         VALUES ('spt_b53', 'RCP', ?, 'file', '[]', 1, 'owner', 1, ?, ?)`,
      )
      .run(PART, at, at);
  };

  it("doesn't extend or hide a part lease: it runs out on its own clock while parked", () => {
    addPart();
    claim();
    d.write(worker, (w, s) => s.sharedChanges.takeLease(w, { id: 'RCP-17', part: PART }));
    const until = d.row<{ expires_at: string }>('SELECT expires_at FROM part_leases').expires_at;
    parkFor(240);
    expect(d.row<{ expires_at: string }>('SELECT expires_at FROM part_leases').expires_at).toBe(
      until,
    );
    expect(d.services.digest.get(d.read(), { project: 'RCP' }).leases.total).toBe(1);
    d.clock.advance(d.server.runtime.config.partLeaseMs);
    expect(d.services.digest.get(d.read(), { project: 'RCP' }).leases.total).toBe(0);
    expect(run(getLead()).state).toBe('parked');
    const taker = d.agent('gemini', { label: 'other' });
    const next = otherReady();
    d.write(taker, (w, s) => s.runs.claim(w, { id: next, agent_label: 'other' }));
    expect(
      d.write(taker, (w, s) => s.sharedChanges.takeLease(w, { id: next, part: PART })).item_id,
    ).toBe(next);
  });

  it('a parked lead still holds its item against other claims', () => {
    claim();
    parkFor(60);
    d.fails(d.agent('gemini'), (w, s) => s.runs.claim(w, { id: 'RCP-17' }), 'conflict');
  });

  it('the activity flag still rises, and survives the expiry for the coordinator', async () => {
    const id = claim();
    parkFor(60);
    d.clock.advance(minutes(5));
    d.write(coordinator, (w, s) => s.evidence.addNote(w, { id: 'RCP-17', text: 'Found it' }));
    expect(await runActivityOnce(d.server.runtime)).toEqual([id]);
    d.clock.advance(minutes(55));
    sweepOnce(d.server.runtime);
    expect(run(id).state).toBe('open');
    expect(JSON.parse(run(id).park_activity!).flag).toMatchObject({ events: 1 });
  });

  it('resume_ready still shows, and the expiry records it', () => {
    const id = claim();
    update({ park_minutes: 60, park_reason: 'Until then', waiting_on: { until: iso(minutes(5)) } });
    d.clock.advance(minutes(10));
    expect(update({ current_action: 'Still waiting' }).resume_ready).toBe(true);
    d.clock.advance(minutes(50));
    sweepOnce(d.server.runtime);
    expect(JSON.parse(eventsOf('run.park_expired')[0]!.data)).toMatchObject({
      run_id: id,
      resume_ready: true,
    });
  });
});

describe('where it shows', () => {
  const digestRow = () =>
    d.services.digest
      .get(d.read(), { project: 'RCP' })
      .runs.rows.find((r) => r.item_id === 'RCP-17');
  const itemRun = (id: string) =>
    d.services.items
      .get(d.read(), { id: 'RCP-17', view: 'standard' })
      .item.runs?.find((r) => r.run_id === id);
  const needsYou = () => d.services.views.needsYou(d.read(), { scope: 'RCP' });

  it('on the item and in the digest while it holds', () => {
    const id = claim();
    parkFor(60);
    const shown = { by: CO, until: iso(minutes(60)) };
    expect(itemRun(id)?.coordinator_park).toMatchObject(shown);
    expect(digestRow()?.coordinator_park).toMatchObject(shown);
  });

  it('the expiry reaches the digest as a change and a marked row, and stays off Needs you', () => {
    const id = claim();
    const { cursor } = d.services.digest.get(d.read(), { project: 'RCP' });
    parkFor(120);
    d.clock.advance(minutes(120));
    sweepOnce(d.server.runtime);
    const next = d.services.digest.get(d.read(), { project: 'RCP', cursor });
    expect(next.changed.rows.map((c) => c.type)).toContain('run.park_expired');
    expect(digestRow()?.coordinator_park?.ended_at).toBeTruthy();
    expect(itemRun(id)?.coordinator_park?.ended_at).toBeTruthy();
    // The run is silent past the stale window, so it's a stale_run: the coordinator's for now.
    const view = needsYou();
    expect(view.problems.filter((p) => p.kind === 'stale_run')).toEqual([]);
    const theirs = view.agent_problems!.find((p) => p.kind === 'stale_run' && p.run_id === id);
    expect(theirs?.explanation).toMatchObject({ who: 'agent' });
    expect(theirs?.explanation?.what).toContain(`${CO}'s park on RCP-17 ran out`);
  });

  it("once the short lease ends, the normal path takes over and the marker isn't shown", () => {
    const id = claim();
    parkFor(120);
    d.clock.advance(minutes(120));
    sweepOnce(d.server.runtime);
    d.clock.advance(graceMs());
    sweepOnce(d.server.runtime);
    expect(run(id).state).toBe('interrupted');
    expect(itemRun(id)?.coordinator_park).toBeUndefined();
    expect(digestRow()).toBeUndefined();
  });
});

/** A Ready item other than the one under test. */
function otherReady(): string {
  const page = d.services.search.searchItems(d.read(), {
    project: 'RCP',
    filter: 'ready_to_start',
    include_archived: false,
    limit: 10,
  });
  return (page.items as { id: string }[]).find((i) => i.id !== 'RCP-17')!.id;
}

function getLead(): string {
  return d.row<{ id: string }>(
    "SELECT id FROM runs WHERE item_id = 'RCP-17' AND is_lead = 1 ORDER BY created_at DESC LIMIT 1",
  ).id;
}

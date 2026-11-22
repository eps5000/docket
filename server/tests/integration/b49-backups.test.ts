/**
 * Backups can't be silently missed (owner decision 41; BUILD_SPEC §5.13): the
 * scheduler compares the wall clock on every wake, catches up once after a
 * missed night, a restart, host sleep or a clock jump, never runs twice at
 * once, and a failed or overdue backup is an owner Problem until the next
 * success. Real backups on a real runtime; only the clock is the test's.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readContext } from '../../src/domain/contracts.js';
import { OWNER_ACTOR } from '../../src/domain/write.js';
import {
  backupTrouble,
  lastBackupAt,
  listArchives,
  startBackupJob,
} from '../../src/jobs/backup.js';
import { TestClock, tempDir, type TempDir } from '../helpers.js';
import { createTestServer, type TestServer } from './harness.js';

const at = (day: number, h: number, m = 0) => new Date(2026, 10, day, h, m);
const HOUR = 3_600_000;

let tmp: TempDir;
let s: TestServer;
let clock: TestClock;
let jobs: { stop(): void }[];
let logs: string[];

beforeEach(() => {
  tmp = tempDir('docket-b49-');
  clock = new TestClock(at(20, 12));
  logs = [];
  jobs = [];
  s = createTestServer({ clock, log: (l) => logs.push(l), dataDir: join(tmp.dir, 'data') });
});
afterEach(async () => {
  for (const j of jobs) j.stop();
  await s.cleanup().catch(() => {});
  rmSync(tmp.dir, { recursive: true, force: true });
});

const read = () => readContext(s.runtime.db, OWNER_ACTOR, clock.now());
const dir = () => s.runtime.config.paths.backups;
const archives = () => listArchives(dir()).length;
const statusFile = () => join(dir(), 'status.json');
const trouble = () => backupTrouble(s.runtime.config, clock.now());
const problem = () =>
  s.runtime.services.views
    .needsYou(read(), { scope: 'all' })
    .problems.find((p) => p.kind === 'backup_missed');

/** A job on the test clock, ticked by hand (its timers are far in the future). */
function job(backup: () => Promise<unknown> = () => s.runtime.services.backup.runNow(read())) {
  const j = startBackupJob({
    config: s.runtime.config,
    log: (l) => logs.push(l),
    now: () => clock.now(),
    backup,
    tickMs: 3_600_000,
    startDelayMs: 3_600_000,
  });
  jobs.push(j);
  return j;
}

describe('lastBackupAt', () => {
  it('is the latest scheduled time at or before now', () => {
    expect(lastBackupAt(at(21, 2, 59), '03:00')).toEqual(at(20, 3));
    expect(lastBackupAt(at(21, 3), '03:00')).toEqual(at(21, 3));
    expect(lastBackupAt(at(21, 9), '03:00')).toEqual(at(21, 3));
  });
});

describe('catching up (decision 41)', () => {
  it('a first install is not behind: its first backup is at the next scheduled time', async () => {
    const j = job();
    expect(await j.tick()).toBe(false);
    expect(archives()).toBe(0);
    expect(trouble()).toBeNull();
    clock.current = at(21, 3);
    expect(await j.tick()).toBe(true);
    expect(archives()).toBe(1);
  });

  it('a missed night runs one backup, however many nights were missed', async () => {
    await s.runtime.services.backup.runNow(read()); // Nov 20, 12:00
    const j = job();
    expect(await j.tick()).toBe(false);
    clock.current = at(23, 9); // Nov 21, 22 and 23 all missed
    expect(await j.tick()).toBe(true);
    expect(archives()).toBe(2);
    expect(await j.tick()).toBe(false);
    expect(archives()).toBe(2);
  });

  it('a restart during the window catches up, and a restart after the backup does not repeat it', async () => {
    await s.runtime.services.backup.runNow(read());
    const first = job();
    first.stop();
    clock.current = at(21, 3, 5); // Down at 03:00, back at 03:05.
    const second = job();
    expect(await second.tick()).toBe(true);
    expect(archives()).toBe(2);
    second.stop();
    clock.current = at(21, 3, 10);
    expect(await job().tick()).toBe(false);
    expect(archives()).toBe(2);
  });

  it('a run the process did not survive gets one more try after the restart, then stops', async () => {
    await s.runtime.services.backup.runNow(read());
    clock.current = at(21, 3);
    let calls = 0;
    const never = () => {
      calls += 1;
      return new Promise<void>(() => {}); // The process dies while it runs.
    };
    void job(never).tick();
    await Promise.resolve();
    expect(calls).toBe(1);
    void job(never).tick(); // Restarted: the one retry.
    await Promise.resolve();
    expect(calls).toBe(2);
    expect(await job(never).tick()).toBe(false); // Restarted again: no loop.
    expect(calls).toBe(2);
  });

  it('host sleep: a wake long after the scheduled time runs it once', async () => {
    await s.runtime.services.backup.runNow(read());
    const j = job();
    clock.current = at(21, 2, 59);
    expect(await j.tick()).toBe(false);
    clock.current = at(21, 8, 30); // Asleep across 03:00.
    expect(await j.tick()).toBe(true);
    expect(archives()).toBe(2);
  });

  it('clock jumps: forward runs once; back does not repeat; a far-future stamp does not block it', async () => {
    await s.runtime.services.backup.runNow(read());
    const j = job();
    clock.current = at(25, 12);
    expect(await j.tick()).toBe(true);
    expect(archives()).toBe(2);
    clock.current = at(25, 11); // A small correction back: the backup is still current.
    expect(await j.tick()).toBe(false);
    expect(archives()).toBe(2);
    clock.current = at(21, 12); // Far back: the stamp from "Nov 25" can't count as a backup today.
    expect(await j.tick()).toBe(true);
    expect(archives()).toBe(3);
    expect(await j.tick()).toBe(false);
  });

  it('never runs two at once: a tick during a run joins it', async () => {
    await s.runtime.services.backup.runNow(read());
    clock.current = at(21, 3);
    let calls = 0;
    let finish!: () => void;
    const j = job(() => {
      calls += 1;
      return new Promise<void>((done) => (finish = done));
    });
    const one = j.tick();
    const two = j.tick();
    await new Promise((r) => setTimeout(r, 5));
    expect(calls).toBe(1);
    finish();
    await Promise.all([one, two]);
    expect(calls).toBe(1);
  });

  it('keeps the 14-day retention on a catch-up', async () => {
    await s.runtime.services.backup.runNow(read());
    const old = at(1, 3);
    const name = `docket-202611${String(old.getDate()).padStart(2, '0')}-0300.tar.gz`;
    writeFileSync(join(dir(), name), 'old');
    clock.current = at(21, 3);
    await job().tick();
    expect(existsSync(join(dir(), name))).toBe(false);
  });
});

describe('a failed or overdue backup is an owner Problem (decision 41)', () => {
  it('a failure shows once, is not retried every tick, and clears on the next success', async () => {
    await s.runtime.services.backup.runNow(read());
    clock.current = at(21, 3);
    let calls = 0;
    const failing = async () => {
      calls += 1;
      const status = JSON.parse(readFileSync(statusFile(), 'utf8')) as {
        volume: Record<string, unknown>;
      };
      status.volume.last_error = 'no space left on device';
      writeFileSync(statusFile(), JSON.stringify(status));
      throw new Error('no space left on device');
    };
    const j = job(failing);
    await j.tick();
    await j.tick();
    expect(calls).toBe(1);
    expect(problem()).toMatchObject({
      kind: 'backup_missed',
      item_id: null,
      explanation: {
        who: 'owner',
        what: expect.stringContaining('The last backup failed: no space left on device'),
      },
    });
    j.stop();
    clock.current = at(22, 3);
    await job().tick();
    expect(problem()).toBeUndefined();
  });

  it('overdue only after an hour with no backup; a success clears it', async () => {
    await s.runtime.services.backup.runNow(read());
    clock.current = new Date(at(21, 3).getTime() + HOUR - 60_000);
    expect(problem()).toBeUndefined();
    clock.current = new Date(at(21, 3).getTime() + HOUR);
    expect(problem()?.explanation).toMatchObject({
      who: 'owner',
      what: expect.stringContaining("hasn't run"),
    });
    await s.runtime.services.backup.runNow(read());
    expect(problem()).toBeUndefined();
  });

  it('acknowledging one night does not hide the next', async () => {
    await s.runtime.services.backup.runNow(read());
    clock.current = at(21, 5);
    const first = problem()!;
    clock.current = at(22, 5);
    expect(problem()!.id).not.toBe(first.id);
  });
});

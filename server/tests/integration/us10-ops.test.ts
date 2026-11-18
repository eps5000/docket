/**
 * Running Docket safely (tasks.md T128; BUILD_SPEC §3, §5.12, §5.13;
 * FR-101–FR-108; SC-008; constitution Principle VI).
 *
 * - **Backups:** an archive is written to /data/backups and verified, holds
 *   the database and every document but not `docs/.staging`, and is pruned
 *   after `BACKUP_KEEP` days.
 * - **Extra location:** with `DOCKET_BACKUP_EXTRA_DIR` set, the archive is
 *   in both places, and the extra copy restores after the data directory is
 *   removed; a missing or unwritable extra folder still lets the default
 *   backup succeed and raises a Problem, which clears after a good copy.
 * - **Restore:** identical by item, event and document checksums, documents
 *   byte for byte; refused while the server runs or when the archive is
 *   damaged, changing nothing.
 * - **Project delete:** the typed key confirms it; rows and the docs folder
 *   go, other projects are untouched, and a failed removal is retried at
 *   startup; agents get `not_found` for the deleted IDs.
 * - **Logs:** the call log holds metadata only; no log holds a token, a key
 *   or an `Authorization` value, even after *Reveal token*.
 * - **Container replacement (in process):** a new runtime on the same data
 *   directory sees every item, event and document. The CI Docker job does
 *   the same with `docker compose down && up` (SC-008).
 */
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main as cli } from '../../src/cli/index.js';
import { loadConfig } from '../../src/config.js';
import { loadSampleSeed } from '../../src/db/seed/loader.js';
import { readContext } from '../../src/domain/contracts.js';
import { OWNER_ACTOR } from '../../src/domain/write.js';
import {
  archiveTime,
  holdServerLock,
  listArchives,
  liveChecksums,
  nextBackupAt,
  restoreBackup,
  runningServer,
  type DataChecksums,
} from '../../src/jobs/backup.js';
import { startupHousekeeping } from '../../src/jobs/startup.js';
import { restartSweep } from '../../src/jobs/sweeper.js';
import { readTarGz } from '../../src/jobs/tar.js';
import {
  expectNotFound,
  expectOk,
  startHarness,
  type ContractHarness,
} from '../contract/harness.js';
import { TestClock, tempDir, type TempDir } from '../helpers.js';
import { createTestServer, parseSetCookies, type TestServer } from './harness.js';

const NOW = new Date('2026-11-06T11:00:00.000Z');
const canChmod = process.platform !== 'win32' && process.getuid?.() !== 0;

let tmp: TempDir;
let servers: TestServer[] = [];
let logs: string[] = [];

beforeEach(() => {
  tmp = tempDir('docket-us10-');
  logs = [];
});
afterEach(async () => {
  for (const s of servers) await s.cleanup().catch(() => {});
  servers = [];
  rmSync(tmp.dir, { recursive: true, force: true });
});

function server(env: Record<string, string> = {}, dataDir?: string): TestServer {
  const s = createTestServer({
    env,
    clock: new TestClock(new Date(NOW)),
    log: (line) => logs.push(line),
    dataDir,
  });
  servers.push(s);
  return s;
}

function seeded(env: Record<string, string> = {}): TestServer {
  const s = server(env);
  loadSampleSeed(s.runtime.db, { now: s.clock.now(), docsDir: s.runtime.config.paths.docs });
  return s;
}

async function readTarGzNames(path: string): Promise<string[]> {
  const names: string[] = [];
  await readTarGz(path, (e) => {
    names.push(e.name);
    return null;
  });
  return names;
}

const read = (s: TestServer) => readContext(s.runtime.db, OWNER_ACTOR, s.clock.now());
const checksumsOf = (dataDir: string): DataChecksums =>
  liveChecksums({ db: join(dataDir, 'docket.db'), docs: join(dataDir, 'docs') });

/** Every file under `dir` (relative path → sha256), skipping `.staging`. */
function fileHashes(dir: string, base = dir, out = new Map<string, string>()) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === '.staging') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) fileHashes(full, base, out);
    else
      out.set(
        full.slice(base.length + 1).replace(/\\/g, '/'),
        createHash('sha256').update(readFileSync(full)).digest('hex'),
      );
  }
  return out;
}

async function unlock(s: TestServer): Promise<string> {
  const res = await s.request('/api/session/unlock', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: s.runtime.secrets.ownerKey() }),
  });
  expect(res.status).toBe(200);
  const c = parseSetCookies(res);
  return `docket_owner=${c.docket_owner!.value}; docket_csrf=${c.docket_csrf!.value}`;
}

function ownerHeaders(cookie: string): Record<string, string> {
  const csrf = /docket_csrf=([^;]+)/.exec(cookie)![1]!;
  return { cookie, 'x-docket-csrf': csrf, 'content-type': 'application/json' };
}

/** A folder the service can't write: read-only where chmod works, else a file in its place. */
function unwritableDir(path: string): void {
  if (canChmod) {
    mkdirSync(path);
    chmodSync(path, 0o555);
  } else {
    writeFileSync(path, 'not a folder');
  }
}

// ---- Backups ----

describe('backups (BUILD_SPEC §5.13)', () => {
  it('writes a verified archive with the database and documents, never docs/.staging', async () => {
    const s = seeded();
    const docs = s.runtime.config.paths.docs;
    mkdirSync(join(docs, '.staging'), { recursive: true });
    writeFileSync(join(docs, '.staging', 'abc.part'), 'half an upload');

    const result = await s.runtime.services.backup.runNow(read(s));
    expect(result.extra_copy).toBeNull();
    expect(result.archive_path.startsWith(s.runtime.config.paths.backups)).toBe(true);
    expect(result.archive_path).toMatch(/tasklite-\d{8}-\d{4}\.tar\.gz$/);

    const names = await readTarGzNames(result.archive_path);
    expect(names[0]).toBe('docket.db');
    expect(names.at(-1)).toBe('manifest.json');
    const docNames = names.filter((n) => n.startsWith('docs/'));
    expect(docNames.length).toBe(fileHashes(docs).size);
    expect(docNames.length).toBeGreaterThan(0);
    expect(names.some((n) => n.includes('.staging'))).toBe(false);
    expect(names.some((n) => n.includes('secrets'))).toBe(false);

    // No secret is in the archive (the database holds hashes of sessions only).
    const raw = gunzipSync(readFileSync(result.archive_path)).toString('latin1');
    expect(raw).not.toContain(s.runtime.secrets.agentToken());
    expect(raw).not.toContain(s.runtime.secrets.ownerKey());

    const [volume] = s.runtime.services.backup.status(read(s));
    expect(volume).toMatchObject({
      location: 'volume',
      path: s.runtime.config.paths.backups,
      keep_days: 14,
      last_error: null,
    });
    expect(volume!.last_success_at).toBe(NOW.toISOString());
    expect(logs.some((l) => l.startsWith('Backup written and verified:'))).toBe(true);
  });

  it(`keeps DOCKET_BACKUP_KEEP days and clears leftovers of interrupted runs`, async () => {
    const s = seeded({ DOCKET_BACKUP_KEEP: '3' });
    const dir = s.runtime.config.paths.backups;
    mkdirSync(dir, { recursive: true });
    const old = new Date(NOW.getTime() - 4 * 86_400_000);
    const recent = new Date(NOW.getTime() - 2 * 86_400_000);
    const nameAt = (d: Date) =>
      `tasklite-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-0300.tar.gz`;
    writeFileSync(join(dir, nameAt(old)), 'old');
    writeFileSync(join(dir, nameAt(recent)), 'recent');
    writeFileSync(join(dir, 'tasklite-20261101-0300.tar.gz.partial'), 'interrupted');
    writeFileSync(join(dir, 'notes.txt'), 'the owner’s own file');

    await s.runtime.services.backup.runNow(read(s));
    const left = readdirSync(dir).sort();
    expect(left).not.toContain(nameAt(old));
    expect(left).toContain(nameAt(recent));
    expect(left).toContain('notes.txt');
    expect(left.some((n) => n.endsWith('.partial'))).toBe(false);
    expect(listArchives(dir)).toHaveLength(2);
  });

  it('names archives by local time and schedules the next run at DOCKET_BACKUP_AT', () => {
    expect(archiveTime('tasklite-20261106-0300.tar.gz')).toEqual(new Date(2026, 10, 6, 3, 0));
    expect(archiveTime('tasklite-20261106-030015-2.tar.gz')).toEqual(
      new Date(2026, 10, 6, 3, 0, 15),
    );
    expect(archiveTime('status.json')).toBeNull();
    const before = new Date(2026, 10, 6, 2, 59);
    expect(nextBackupAt(before, '03:00')).toEqual(new Date(2026, 10, 6, 3, 0));
    expect(nextBackupAt(new Date(2026, 10, 6, 3, 0), '03:00')).toEqual(new Date(2026, 10, 7, 3, 0));
  });

  it('two backups in the same minute get different names', async () => {
    const s = seeded();
    const a = await s.runtime.services.backup.runNow(read(s));
    const b = await s.runtime.services.backup.runNow(read(s));
    expect(a.archive_path).not.toBe(b.archive_path);
    expect(listArchives(s.runtime.config.paths.backups)).toHaveLength(2);
  });
});

describe('the extra backup location (owner decision 24; FR-103a)', () => {
  it('writes the same archive to both places, and the extra copy restores after the data dir is removed', async () => {
    const extra = join(tmp.dir, 'host-backups');
    mkdirSync(extra);
    const s = seeded({ DOCKET_BACKUP_EXTRA_DIR: extra });
    const dataDir = s.dataDir;
    const before = checksumsOf(dataDir);
    const docsBefore = fileHashes(join(dataDir, 'docs'));

    const result = await s.runtime.services.backup.runNow(read(s));
    expect(result.extra_copy).toMatchObject({ ok: true, error: null });
    const name = result.archive_path.split(/[\\/]/).at(-1)!;
    const copy = join(extra, name);
    expect(readFileSync(copy).equals(readFileSync(result.archive_path))).toBe(true);

    const status = s.runtime.services.backup.status(read(s));
    expect(status.map((b) => b.location)).toEqual(['volume', 'extra']);
    expect(status[1]).toMatchObject({ path: extra, keep_days: 14, last_error: null });
    expect(status[1]!.last_success_at).not.toBeNull();

    // Settings shows both locations.
    const cookie = await unlock(s);
    const settings = (await (await s.request('/api/settings', { headers: { cookie } })).json()) as {
      health: { backups: unknown[]; extra_backup_configured: boolean };
    };
    expect(settings.health.extra_backup_configured).toBe(true);
    expect(settings.health.backups).toHaveLength(2);

    // Lose the volume: stop the service and remove the whole data directory.
    await s.cleanup();
    servers = servers.filter((x) => x !== s);
    rmSync(dataDir, { recursive: true, force: true });
    expect(existsSync(dataDir)).toBe(false);

    const config = loadConfig({ DOCKET_BACKUP_EXTRA_DIR: extra }, { dataDir });
    // `tasklite restore` accepts a bare name from the extra location.
    const restored = await restoreBackup({ config, file: name });
    expect(restored.archive).toBe(copy);
    expect(checksumsOf(dataDir)).toEqual(before);
    expect(fileHashes(join(dataDir, 'docs'))).toEqual(docsBefore);
    expect(readdirSync(join(dataDir, 'docs', '.staging'))).toEqual([]);

    // The restored data starts as a service again.
    const again = server({ DOCKET_BACKUP_EXTRA_DIR: extra }, dataDir);
    const items = again.runtime.db.sqlite.prepare('SELECT count(*) AS n FROM items').get() as {
      n: number;
    };
    expect(items.n).toBe(before.items.count);
  });

  it('a missing or unwritable extra folder never fails the default backup, and raises a Problem until a copy succeeds', async () => {
    const extra = join(tmp.dir, 'not-mounted');
    unwritableDir(extra);
    const s = seeded({ DOCKET_BACKUP_EXTRA_DIR: extra });

    const result = await s.runtime.services.backup.runNow(read(s));
    expect(existsSync(result.archive_path)).toBe(true);
    expect(result.extra_copy?.ok).toBe(false);
    expect(result.extra_copy?.error).toMatch(canChmod ? /isn't writable/ : /doesn't exist/);
    expect(logs.some((l) => l.startsWith('Extra backup copy failed:'))).toBe(true);

    const [volume, extraStatus] = s.runtime.services.backup.status(read(s));
    expect(volume!.last_success_at).toBe(NOW.toISOString());
    expect(volume!.last_error).toBeNull();
    expect(extraStatus).toMatchObject({ location: 'extra', last_success_at: null });
    expect(extraStatus!.last_error).toBe(result.extra_copy!.error);

    const cookie = await unlock(s);
    const problems = async () =>
      (
        (await (await s.request('/api/needs-you?scope=all', { headers: { cookie } })).json()) as {
          problems: { kind: string; reason: string; item_id: string | null }[];
        }
      ).problems.filter((p) => p.kind === 'extra_backup_failed');
    const [problem] = await problems();
    expect(problem).toMatchObject({ item_id: null });
    expect(problem!.reason).toMatch(/^Extra backup copy failed: /);

    // The owner fixes the mount; the next backup copies, and the Problem clears.
    if (canChmod) chmodSync(extra, 0o755);
    else {
      rmSync(extra);
      mkdirSync(extra);
    }
    s.clock.advance(60_000);
    const fixed = await s.runtime.services.backup.runNow(read(s));
    expect(fixed.extra_copy?.ok).toBe(true);
    expect(await problems()).toEqual([]);
    expect(s.runtime.services.backup.status(read(s))[1]!.last_error).toBeNull();
  });
});

// ---- Restore ----

describe('restore (BUILD_SPEC §5.13; SC-008)', () => {
  async function backupOf(s: TestServer) {
    return (await s.runtime.services.backup.runNow(read(s))).archive_path;
  }

  it('is identical by item, event and document checksums, with documents byte for byte', async () => {
    const s = seeded();
    const archive = await backupOf(s);
    const before = checksumsOf(s.dataDir);
    expect(before.items.count).toBeGreaterThan(0);
    expect(before.events.count).toBeGreaterThan(0);
    expect(before.documents.count).toBeGreaterThan(0);

    const scratch = join(tmp.dir, 'scratch');
    const result = await restoreBackup({
      config: loadConfig({}, { dataDir: scratch }),
      file: archive,
    });
    expect(result.checksums).toEqual(before);
    expect(checksumsOf(scratch)).toEqual(before);
    expect(fileHashes(join(scratch, 'docs'))).toEqual(fileHashes(join(s.dataDir, 'docs')));
    // Nothing is left behind: no staging or old-data folders.
    expect(readdirSync(scratch).filter((n) => n.startsWith('.'))).toEqual([]);
  });

  it('replaces existing data, and the CLI does the same (`backup now`, `restore <file>`)', async () => {
    const s = server({}, join(tmp.dir, 'data'));
    loadSampleSeed(s.runtime.db, { now: NOW, docsDir: s.runtime.config.paths.docs });
    const before = checksumsOf(s.dataDir);
    await s.runtime.close();

    const out: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });
    try {
      expect(await cli(['backup', 'now', '--data-dir', s.dataDir])).toBe(0);
      const archive = listArchives(join(s.dataDir, 'backups'))[0]!.path;

      // Change the data after the backup; restoring brings back the backup exactly.
      const other = join(tmp.dir, 'other');
      const o = server({}, other);
      loadSampleSeed(o.runtime.db, {
        now: new Date('2026-12-01T00:00:00Z'),
        docsDir: o.runtime.config.paths.docs,
      });
      await o.runtime.close();
      expect(checksumsOf(other)).not.toEqual(before);

      expect(await cli(['restore', archive, '--data-dir', other])).toBe(0);
      expect(checksumsOf(other)).toEqual(before);
      expect(out.join('')).toMatch(
        /Verified identical: \d+ items, \d+ events, \d+ document versions/,
      );
      expect(await cli(['checksums', '--data-dir', other])).toBe(0);
      expect(JSON.parse(out.at(-1)!)).toEqual(before);
    } finally {
      spy.mockRestore();
    }
    // The CLI prints no secret.
    expect(out.join('')).not.toContain(s.runtime.secrets.agentToken());
  });

  it('refuses while the server is running, and changes nothing', async () => {
    const s = seeded();
    const archive = await backupOf(s);
    const lock = holdServerLock(s.runtime.config);
    try {
      expect(runningServer(s.runtime.config)).not.toBeNull();
      const before = checksumsOf(s.dataDir);
      await expect(restoreBackup({ config: s.runtime.config, file: archive })).rejects.toThrow(
        /running on this data volume/,
      );
      expect(checksumsOf(s.dataDir)).toEqual(before);
    } finally {
      lock.stop();
    }
    expect(runningServer(s.runtime.config)).toBeNull();
  });

  it('a stale lock (the server crashed) does not block a restore', async () => {
    const s = seeded();
    const archive = await backupOf(s);
    writeFileSync(
      join(s.dataDir, 'server.lock'),
      JSON.stringify({
        pid: 999_999,
        host: 'another-container',
        started_at: '2026-01-01T00:00:00Z',
        heartbeat_at: new Date(Date.now() - 5 * 60_000).toISOString(),
      }),
    );
    expect(runningServer(s.runtime.config)).toBeNull();
    const before = checksumsOf(s.dataDir);
    await s.runtime.close();
    await expect(restoreBackup({ config: s.runtime.config, file: archive })).resolves.toBeTruthy();
    expect(checksumsOf(s.dataDir)).toEqual(before);
  });

  it('verifies the archive first: a damaged or foreign archive is refused and nothing changes', async () => {
    const s = seeded();
    const archive = await backupOf(s);
    const scratch = join(tmp.dir, 'scratch');
    const config = loadConfig({}, { dataDir: scratch });
    const r = server({}, scratch);
    const mine = checksumsOf(scratch);
    await r.cleanup();
    servers = servers.filter((x) => x !== r);

    const bytes = readFileSync(archive);
    const damaged = join(tmp.dir, 'damaged.tar.gz');
    const copy = Buffer.from(bytes);
    const mid = Math.floor(copy.length / 2);
    copy[mid] = copy[mid]! ^ 0xff;
    writeFileSync(damaged, copy);
    await expect(restoreBackup({ config, file: damaged })).rejects.toThrow();
    const truncated = join(tmp.dir, 'truncated.tar.gz');
    writeFileSync(truncated, bytes.subarray(0, Math.floor(bytes.length / 3)));
    await expect(restoreBackup({ config, file: truncated })).rejects.toThrow();
    const foreign = join(tmp.dir, 'foreign.tar.gz');
    writeFileSync(foreign, 'not an archive');
    await expect(restoreBackup({ config, file: foreign })).rejects.toThrow();
    await expect(restoreBackup({ config, file: 'tasklite-19990101-0300.tar.gz' })).rejects.toThrow(
      /No backup at/,
    );

    expect(checksumsOf(scratch)).toEqual(mine);
    expect(readdirSync(scratch).filter((n) => n.startsWith('.'))).toEqual([]);
  });
});

// ---- Project delete ----

describe('project delete (BUILD_SPEC §5.12; O10; FR-104)', () => {
  let h: ContractHarness;
  afterEach(async () => {
    await h?.close();
  });

  const count = (s: TestServer, sql: string, ...args: unknown[]) =>
    (s.runtime.db.sqlite.prepare(sql).get(...args) as { n: number }).n;

  it('the typed key confirms it; rows and the docs folder go together; other projects are untouched', async () => {
    h = await startHarness({ log: (l) => logs.push(l) });
    const s = h.server;
    const cookie = await unlock(s);
    const docs = s.runtime.config.paths.docs;
    expect(existsSync(join(docs, 'RCP'))).toBe(true);
    const docOther = fileHashes(join(docs, 'DOC'));
    const otherItems = s.runtime.db.sqlite
      .prepare("SELECT * FROM items WHERE project_key = 'DOC' ORDER BY id")
      .all();
    const otherEvents = count(s, "SELECT count(*) AS n FROM events WHERE project_key = 'DOC'");
    // An agent's change cursor from before the delete.
    const cursor = expectOk(await h.call('get_changes', {})).structured.next_cursor as string;

    const del = (confirm: string) =>
      s.request('/api/projects/RCP', {
        method: 'DELETE',
        headers: ownerHeaders(cookie),
        body: JSON.stringify({ confirm_key: confirm }),
      });
    const wrong = await del('DOC');
    expect(wrong.status).toBe(400);
    expect(((await wrong.json()) as { error: { message: string } }).error.message).toBe(
      'Type RCP to confirm deleting Sample · Recipe App.',
    );
    expect(count(s, "SELECT count(*) AS n FROM items WHERE project_key = 'RCP'")).toBeGreaterThan(
      0,
    );

    // Agents can't delete a project: the bearer token isn't an owner session.
    const asAgent = await s.request('/api/projects/RCP', {
      method: 'DELETE',
      headers: {
        authorization: `Bearer ${s.runtime.secrets.agentToken()}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ confirm_key: 'RCP' }),
    });
    expect(asAgent.status).toBe(401);

    const ok = await del('RCP');
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ deleted: true, key: 'RCP' });

    for (const table of ['items', 'labels', 'documents', 'decision_records']) {
      expect(count(s, `SELECT count(*) AS n FROM ${table} WHERE project_key = 'RCP'`), table).toBe(
        0,
      );
    }
    for (const table of ['runs', 'work_steps', 'packets', 'questions', 'hr_items', 'commits']) {
      expect(count(s, `SELECT count(*) AS n FROM ${table} WHERE item_id LIKE 'RCP-%'`), table).toBe(
        0,
      );
    }
    expect(count(s, 'SELECT count(*) AS n FROM document_versions WHERE path LIKE ?', 'RCP/%')).toBe(
      0,
    );
    expect(
      count(s, "SELECT count(*) AS n FROM links WHERE from_id LIKE 'RCP-%' OR to_id LIKE 'RCP-%'"),
    ).toBe(0);
    expect(s.runtime.db.sqlite.pragma('foreign_key_check')).toEqual([]);
    expect(existsSync(join(docs, 'RCP'))).toBe(false);

    // The tombstone and its one event.
    const tomb = s.runtime.db.sqlite
      .prepare("SELECT deleted_at FROM projects WHERE key = 'RCP'")
      .get() as {
      deleted_at: string | null;
    };
    expect(tomb.deleted_at).not.toBeNull();
    const events = s.runtime.db.sqlite
      .prepare("SELECT type, item_id, summary, inverse FROM events WHERE project_key = 'RCP'")
      .all() as { type: string; item_id: string | null; summary: string; inverse: string | null }[];
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'project.updated', item_id: null, inverse: null });
    expect(events[0]!.summary).toMatch(
      /^Deleted project Sample · Recipe App \(RCP\): \d+ items, \d+ documents$/,
    );

    // The other project is untouched.
    expect(
      s.runtime.db.sqlite
        .prepare("SELECT * FROM items WHERE project_key = 'DOC' ORDER BY id")
        .all(),
    ).toEqual(otherItems);
    expect(count(s, "SELECT count(*) AS n FROM events WHERE project_key = 'DOC'")).toBe(
      otherEvents,
    );
    expect(fileHashes(join(docs, 'DOC'))).toEqual(docOther);

    // Settings no longer lists it; a second delete is not_found.
    const settings = (await (await s.request('/api/settings', { headers: { cookie } })).json()) as {
      projects: { key: string }[];
    };
    expect(settings.projects.map((p) => p.key)).toEqual(['DOC']);
    expect((await del('RCP')).status).toBe(404);

    // get_changes still works: the delete shows as one project change.
    const changes = expectOk(await h.call('get_changes', { cursor })).structured as {
      events: { type: string; item_id?: string | null }[];
    };
    expect(changes.events.map((e) => e.type)).toEqual(['project.updated']);
    expectOk(await h.call('get_changes', { cursor, project: 'DOC' }));
  });

  it('afterwards, agents get not_found for the deleted IDs', async () => {
    h = await startHarness();
    const cookie = await unlock(h.server);
    const res = await h.server.request('/api/projects/RCP', {
      method: 'DELETE',
      headers: ownerHeaders(cookie),
      body: JSON.stringify({ confirm_key: 'RCP' }),
    });
    expect(res.status).toBe(200);

    expectNotFound(await h.call('get_item', { id: 'RCP-14' }));
    expectNotFound(await h.call('get_context', { id: 'RCP-14' }));
    expectNotFound(await h.call('claim_lead', { id: 'RCP-17', agent_label: 'orca-w3' }));
    expectNotFound(await h.call('set_status', { id: 'RCP-14', status: 'ready' }));
    expectNotFound(
      await h.call('create_item', { project: 'RCP', type: 'Task', title: 'After the delete' }),
    );
    expectNotFound(await h.call('dependency_subgraph', { id: 'RCP-14' }));
    const projects = expectOk(await h.call('list_projects', {})).text;
    expect(projects).not.toContain('RCP');
    // Owner reads too.
    expect((await h.server.request('/api/items/RCP-14', { headers: { cookie } })).status).toBe(404);
  });

  it('a removal that failed after the commit is retried at startup from the tombstone', async () => {
    const dataDir = join(tmp.dir, 'data');
    // The first service commits the delete but its docs removal does nothing (as if it crashed first).
    const first = createTestServer({
      dataDir,
      clock: new TestClock(new Date(NOW)),
      log: (l) => logs.push(l),
      services: { projects: { removeDeletedDocs: () => Promise.resolve([]) } },
    });
    servers.push(first);
    loadSampleSeed(first.runtime.db, { now: NOW, docsDir: first.runtime.config.paths.docs });
    const cookie = await unlock(first);
    const res = await first.request('/api/projects/RCP', {
      method: 'DELETE',
      headers: ownerHeaders(cookie),
      body: JSON.stringify({ confirm_key: 'RCP' }),
    });
    expect(res.status).toBe(200);
    const rcpDocs = join(dataDir, 'docs', 'RCP');
    expect(existsSync(rcpDocs)).toBe(true);
    mkdirSync(join(dataDir, 'docs', '.staging'), { recursive: true });
    writeFileSync(join(dataDir, 'docs', '.staging', 'interrupted.part'), 'x');
    await first.runtime.close();

    // The restart: the same volume, the real services.
    const second = server({}, dataDir);
    const { staged, removed } = await startupHousekeeping(second.runtime);
    expect(removed).toEqual(['RCP']);
    expect(staged).toBe(1);
    expect(existsSync(rcpDocs)).toBe(false);
    expect(existsSync(join(dataDir, 'docs', 'DOC'))).toBe(true);
    expect(readdirSync(join(dataDir, 'docs', '.staging'))).toEqual([]);
    // Nothing left to do on the next start.
    expect((await startupHousekeeping(second.runtime)).removed).toEqual([]);
  });

  it.skipIf(!canChmod)(
    'a failed removal is logged, not thrown, and left for the retry',
    async () => {
      const s = seeded();
      const docs = s.runtime.config.paths.docs;
      const cookie = await unlock(s);
      chmodSync(docs, 0o555);
      try {
        const res = await s.request('/api/projects/RCP', {
          method: 'DELETE',
          headers: ownerHeaders(cookie),
          body: JSON.stringify({ confirm_key: 'RCP' }),
        });
        expect(res.status).toBe(200);
        expect(existsSync(join(docs, 'RCP'))).toBe(true);
        expect(logs.some((l) => /Deleted project RCP: .*retrying at the next start/.test(l))).toBe(
          true,
        );
      } finally {
        chmodSync(docs, 0o755);
      }
      expect((await startupHousekeeping(s.runtime)).removed).toEqual(['RCP']);
    },
  );

  it('deleting is owner only and not undoable', async () => {
    const s = seeded();
    const cookie = await unlock(s);
    const res = await s.request('/api/projects/DOC', {
      method: 'DELETE',
      headers: ownerHeaders(cookie),
      body: JSON.stringify({ confirm_key: 'DOC' }),
    });
    expect(res.status).toBe(200);
    const { mutation_id } = s.runtime.db.sqlite
      .prepare("SELECT mutation_id FROM events WHERE project_key = 'DOC'")
      .get() as { mutation_id: string };
    const undo = await s.request(`/api/mutations/${mutation_id}/undo`, {
      method: 'POST',
      headers: ownerHeaders(cookie),
      body: '{}',
    });
    expect(undo.status).toBeGreaterThanOrEqual(400);
    expect(
      s.runtime.db.sqlite.prepare("SELECT deleted_at FROM projects WHERE key = 'DOC'").get(),
    ).not.toEqual({
      deleted_at: null,
    });
  });
});

// ---- Logs and secrets (Principle VI; FR-105, FR-108) ----

describe('logs hold no arguments and no credentials', () => {
  let h: ContractHarness;
  afterEach(async () => {
    await h?.close();
  });

  /** Every log line the service wrote: its own log, the console, and the files under /data/logs. */
  function allLogs(s: TestServer, captured: string[]): string {
    const files = readdirSync(join(s.dataDir, 'logs')).map((n) =>
      readFileSync(join(s.dataDir, 'logs', n), 'utf8'),
    );
    return [...captured, ...files].join('\n');
  }

  it('the call log has metadata only, and no log has a token, a key or an Authorization value', async () => {
    const consoleLines: string[] = [];
    const capture = (...a: unknown[]) => consoleLines.push(a.map(String).join(' '));
    const spies = [
      vi.spyOn(console, 'log').mockImplementation(capture),
      vi.spyOn(console, 'error').mockImplementation(capture),
      vi.spyOn(console, 'warn').mockImplementation(capture),
    ];
    try {
      h = await startHarness({ log: (l) => logs.push(l) });
      const s = h.server;
      const MARKER = 'zebra-argument-7c1f';
      expectOk(
        await h.call('create_item', {
          project: 'RCP',
          type: 'Task',
          title: `Pantry ${MARKER}`,
          description_md: `Body ${MARKER}`,
        }),
      );
      expectOk(await h.call('search_items', { project: 'RCP', text: MARKER }));
      await h.call('get_item', { id: `RCP-${MARKER}` });
      // A refused secret-looking write.
      await h.call('create_item', {
        project: 'RCP',
        type: 'Task',
        title: 'Key',
        description_md: `api key ${s.runtime.secrets.agentToken()}`,
      });
      // A bad bearer token, then the owner reveals the token.
      await s.request('/mcp', {
        method: 'POST',
        headers: {
          authorization: 'Bearer tl_wrong-token-value',
          'content-type': 'application/json',
        },
        body: '{}',
      });
      const cookie = await unlock(s);
      const reveal = await s.request('/api/settings/agent-token', { headers: { cookie } });
      expect(reveal.status).toBe(200);
      expect(reveal.headers.get('cache-control')).toBe('no-store');
      expect(await reveal.json()).toEqual({ token: s.runtime.secrets.agentToken() });
      await s.runtime.services.backup.runNow(read(s));

      // The call log: one line per call, only the allowed fields.
      const callLines = readFileSync(s.runtime.callLog.fileFor(s.clock.now()), 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(callLines.length).toBeGreaterThanOrEqual(4);
      for (const line of callLines) {
        expect(Object.keys(line)).toEqual([
          'time',
          'tool',
          'client',
          'label',
          'run',
          'duration_ms',
          'result',
        ]);
      }
      expect(callLines.map((l) => l.tool)).toContain('create_item');

      // The download is the same metadata.
      const download = await s.request('/api/diagnostics/calls?days=7', { headers: { cookie } });
      expect(download.status).toBe(200);
      expect(download.headers.get('content-type')).toMatch(/application\/x-ndjson/);
      expect(download.headers.get('content-disposition')).toMatch(/attachment/);
      const body = await download.text();
      expect(body.trim().split('\n')).toHaveLength(callLines.length);

      const everything = `${allLogs(s, [...logs, ...consoleLines])}\n${body}`;
      expect(everything).not.toContain(MARKER);
      expect(everything).not.toContain(s.runtime.secrets.agentToken());
      expect(everything).not.toContain(s.runtime.secrets.ownerKey());
      expect(everything).not.toContain('tl_wrong-token-value');
      expect(everything).not.toMatch(/bearer\s+tl_/i);
      expect(everything).not.toMatch(/authorization:/i);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it('Reveal token needs the owner session; the agent token itself is refused', async () => {
    const s = seeded();
    const none = await s.request('/api/settings/agent-token');
    expect(none.status).toBe(401);
    const asAgent = await s.request('/api/settings/agent-token', {
      headers: { authorization: `Bearer ${s.runtime.secrets.agentToken()}` },
    });
    expect(asAgent.status).toBe(401);
    expect(await asAgent.text()).not.toContain(s.runtime.secrets.agentToken());
  });
});

// ---- Container replacement (SC-008), in process ----

describe('container replacement (SC-008)', () => {
  it('a new service on the same data directory keeps every item, event and document', async () => {
    const volume = join(tmp.dir, 'volume');
    const first = server({}, volume);
    loadSampleSeed(first.runtime.db, { now: NOW, docsDir: first.runtime.config.paths.docs });
    const before = checksumsOf(volume);
    expect(before.items.count).toBeGreaterThan(0);
    expect(before.documents.count).toBeGreaterThan(0);
    await first.runtime.close();

    // The replacement: a new process on the same volume, with its startup steps.
    const second = server({}, volume);
    restartSweep(second.runtime);
    await startupHousekeeping(second.runtime);
    // The restart may append events (open runs end as interrupted); none before it change.
    const after = liveChecksums(
      { db: join(volume, 'docket.db'), docs: join(volume, 'docs') },
      { throughSeq: before.events.max_seq },
    );
    expect(after.items.ids_sha256).toBe(before.items.ids_sha256);
    expect(after.events).toEqual(before.events);
    expect(after.documents).toEqual(before.documents);
  });
});

// ---- Settings → Connections and Service health (UI_SPEC §6.7; FR-107) ----

describe('GET /api/settings: connections and health', () => {
  it('lists every supported surface, none verified before the smoke test, and the backup locations', async () => {
    const s = seeded();
    const cookie = await unlock(s);
    const get = async () =>
      (await (await s.request('/api/settings', { headers: { cookie } })).json()) as {
        connections: {
          clients: { client: string; status: string; last_seen_at: string | null; notes: string }[];
        };
        health: {
          backups: { location: string; last_success_at: string | null; keep_days: number }[];
          extra_backup_configured: boolean;
        };
      };
    const before = await get();
    expect(before.connections.clients.map((c) => [c.client, c.status])).toEqual([
      ['Codex CLI (host)', 'not_verified'],
      ['Claude Code (host)', 'not_verified'],
      ['Orca worker · Codex', 'not_verified'],
      ['Orca worker · Claude', 'not_verified'],
      ['Agent in another container', 'not_configured'],
    ]);
    // The sample seed has codex and claude runs, some labelled orca-*.
    expect(before.connections.clients.some((c) => c.last_seen_at !== null)).toBe(true);
    expect(before.health.extra_backup_configured).toBe(false);
    expect(before.health.backups).toEqual([
      expect.objectContaining({ location: 'volume', last_success_at: null, keep_days: 14 }),
    ]);

    await s.runtime.services.backup.runNow(read(s));
    const after = await get();
    expect(after.health.backups[0]!.last_success_at).toBe(NOW.toISOString());
  });

  it("shows each surface's result mode from DOCKET_TEXT_ONLY_CLIENTS (MCP_SPEC §3 Results)", async () => {
    const modes = async (env: Record<string, string>) => {
      const s = seeded(env);
      const cookie = await unlock(s);
      const body = (await (await s.request('/api/settings', { headers: { cookie } })).json()) as {
        connections: { clients: { client: string; result_mode: string }[] };
      };
      return body.connections.clients.map((c) => [c.client, c.result_mode]);
    };
    // The shipped default (an empty value counts as unset): Claude Code is text-only.
    expect(await modes({ DOCKET_TEXT_ONLY_CLIENTS: '' })).toEqual([
      ['Codex CLI (host)', 'structured'],
      ['Claude Code (host)', 'text'],
      ['Orca worker · Codex', 'structured'],
      ['Orca worker · Claude', 'text'],
      ['Agent in another container', 'structured'],
    ]);
    expect(
      (await modes({ DOCKET_TEXT_ONLY_CLIENTS: 'codex-mcp-client' })).map(([, m]) => m),
    ).toEqual(['text', 'structured', 'text', 'structured', 'structured']);
  });
});

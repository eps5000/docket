/**
 * `docket export` (tasks.md T147; ROADMAP §1 "Have a way out"; O06).
 *
 * The round trip: export the sample seed (plus a document and a Jira-style
 * attachment-free project), rebuild a fresh database from nothing but the
 * archive's JSON, put the archive's document files back, and compare:
 * every table's row count, and the item, event and document checksums
 * `docket checksums` prints. They must be identical.
 *
 * Also: no key, token or browser session is in the archive, the excluded
 * tables are absent, the CLI writes the file and prints the counts, and an
 * export over a secret refuses to finish.
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EXCLUDED_TABLES,
  EXPORT_MANIFEST,
  exportedTables,
  runExport,
  type ExportManifest,
} from '../../src/cli/export.js';
import { main } from '../../src/cli/index.js';
import { ReadOnlyExportRefused, runReadOnlyExport } from '../../src/cli/read-only-export.js';
import { migrateDb, openDb } from '../../src/db/client.js';
import { loadSampleSeed } from '../../src/db/seed/loader.js';
import { dataChecksums, liveChecksums } from '../../src/jobs/backup.js';
import { readTarGz } from '../../src/jobs/tar.js';
import { tempDir } from '../helpers.js';
import { createTestServer, type TestServer } from './harness.js';

let s: TestServer | undefined;
const temps: { cleanup(): void }[] = [];
afterEach(async () => {
  await s?.cleanup();
  s = undefined;
  for (const t of temps.splice(0)) t.cleanup();
});

function seeded(): TestServer {
  const server = createTestServer({ log: () => {} });
  loadSampleSeed(server.runtime.db, {
    now: server.clock.now(),
    docsDir: server.runtime.config.paths.docs,
  });
  return server;
}

/** Every entry of a tar.gz, in memory (the seed is small). */
async function readAll(path: string): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  await readTarGz(path, (entry) => {
    if (entry.type !== 'file') return null;
    const chunks: Buffer[] = [];
    return {
      write: (c) => void chunks.push(c),
      end: () => void files.set(entry.name, Buffer.concat(chunks)),
    };
  });
  return files;
}

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

function fileMetadata(path: string): { size: number; mtimeMs: number; sha256: string } | null {
  if (!existsSync(path)) return null;
  const stat = statSync(path);
  return { size: stat.size, mtimeMs: stat.mtimeMs, sha256: sha256(readFileSync(path)) };
}

describe('docket export (T147)', () => {
  it('round-trips the seed: a database rebuilt from the JSON has the same counts and checksums', async () => {
    s = seeded();
    const out = join(tempDir('docket-export-').dir, 'seed-export.tar.gz');
    const { archive_path, manifest } = await runExport({
      config: s.runtime.config,
      sqlite: s.runtime.db.sqlite,
      clock: s.clock.now,
      secrets: () => s!.runtime.secrets.known(),
      out,
    });
    expect(archive_path).toBe(out);
    const files = await readAll(out);

    // The manifest in the archive is the one returned, and every file's hash matches it.
    const inArchive = JSON.parse(files.get(EXPORT_MANIFEST)!.toString('utf8')) as ExportManifest;
    expect(inArchive).toEqual(JSON.parse(JSON.stringify(manifest)));
    expect(inArchive.format).toBe('docket-export');
    for (const [name, f] of Object.entries(inArchive.files)) {
      expect(sha256(files.get(name)!), name).toBe(f.sha256);
    }

    // Rebuild: a fresh, migrated database, filled from data/<table>.json only.
    const rebuilt = tempDir('docket-rebuilt-');
    temps.push(rebuilt);
    const db = openDb(join(rebuilt.dir, 'docket.db'));
    migrateDb(db);
    const sql = db.sqlite;
    sql.pragma('foreign_keys = OFF');
    sql.exec("DELETE FROM settings WHERE key LIKE '\\_\\_%' ESCAPE '\\'");
    const source = s.runtime.db.sqlite;
    const counts: Record<string, [number, number]> = {};
    for (const table of exportedTables(source)) {
      const rows = JSON.parse(files.get(`data/${table}.json`)!.toString('utf8')) as Record<
        string,
        unknown
      >[];
      sql.prepare(`DELETE FROM "${table}"`).run();
      for (const row of rows) {
        const cols = Object.keys(row);
        sql
          .prepare(
            `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
          )
          .run(...cols.map((c) => row[c] as string | number | null));
      }
      const live = (source.prepare(`SELECT count(*) AS n FROM "${table}"`).get() as { n: number })
        .n;
      const back = (sql.prepare(`SELECT count(*) AS n FROM "${table}"`).get() as { n: number }).n;
      counts[table] = [live, back];
      expect(manifest.tables[table]!.rows, table).toBe(live);
    }
    for (const [table, [live, back]] of Object.entries(counts)) expect(back, table).toBe(live);

    // Documents back on disk from the archive, then the checksums.
    const docsDir = join(rebuilt.dir, 'docs');
    for (const [name, bytes] of files) {
      if (!name.startsWith('documents/')) continue;
      const path = join(docsDir, ...name.slice('documents/'.length).split('/'));
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, bytes);
    }
    const docSha = new Map(
      [...files]
        .filter(([n]) => n.startsWith('documents/'))
        .map(([n, b]) => [n.slice('documents/'.length), sha256(b)]),
    );
    const back = dataChecksums(sql, (p) => docSha.get(p) ?? null);
    db.sqlite.close();
    const live = liveChecksums(s.runtime.config.paths);
    expect(back).toEqual(live);
    expect(manifest.checksums).toEqual(live);
    expect(live.items.count).toBeGreaterThan(20);
    expect(live.documents.count).toBeGreaterThan(0);

    const tableCount = Object.keys(counts).length;
    const rows = Object.values(counts).reduce((n, [l]) => n + l, 0);
    console.log(
      `Export round trip: ${tableCount} tables, ${rows} rows; items ${live.items.count} ${live.items.sha256.slice(0, 12)}…, events ${live.events.count} ${live.events.sha256.slice(0, 12)}…, documents ${live.documents.count} ${live.documents.sha256.slice(0, 12)}… — identical after rebuild`,
    );
  });

  it('holds no key, token or session, and leaves out the excluded and internal tables', async () => {
    s = seeded();
    // An owner session exists (its hash would be in owner_sessions).
    const unlock = await s.request('/api/session/unlock', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:7420' },
      body: JSON.stringify({ key: s.runtime.secrets.ownerKey() }),
    });
    expect(unlock.status).toBe(200);
    const out = join(tempDir('docket-export-').dir, 'x.tar.gz');
    await runExport({
      config: s.runtime.config,
      sqlite: s.runtime.db.sqlite,
      clock: s.clock.now,
      secrets: () => s!.runtime.secrets.known(),
      out,
    });
    const files = await readAll(out);
    const names = [...files.keys()];
    for (const t of Object.keys(EXCLUDED_TABLES)) expect(names).not.toContain(`data/${t}.json`);
    expect(names.some((n) => /search_fts|drizzle|sqlite_/.test(n))).toBe(false);
    expect(names.some((n) => n.includes('secrets'))).toBe(false);
    const all = Buffer.concat([...files.values()]).toString('utf8');
    expect(all).not.toContain(s.runtime.secrets.agentToken());
    expect(all).not.toContain(s.runtime.secrets.ownerKey());
    const sessionHash = (
      s.runtime.db.sqlite.prepare('SELECT id FROM owner_sessions LIMIT 1').get() as { id: string }
    ).id;
    expect(all).not.toContain(sessionHash);
  });

  it('refuses to finish, and leaves no file, if a secret ever reached a table', async () => {
    s = seeded();
    const dir = tempDir('docket-export-').dir;
    // Bypass the write path's guard on purpose, straight into SQLite.
    s.runtime.db.sqlite
      .prepare("UPDATE items SET title = ? WHERE id = 'RCP-14'")
      .run(`leak ${s.runtime.secrets.agentToken()}`);
    await expect(
      runExport({
        config: s.runtime.config,
        sqlite: s.runtime.db.sqlite,
        clock: s.clock.now,
        secrets: () => s!.runtime.secrets.known(),
        out: join(dir, 'x.tar.gz'),
      }),
    ).rejects.toThrow('Export stopped: a secret appeared in the items table. Nothing was written.');
    expect(readdirSync(dir)).toEqual([]);
  });

  it('the CLI writes to <data>/exports by default and prints the counts and checksums', async () => {
    s = seeded();
    const lines: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });
    let code: number;
    try {
      code = await main(['export', '--data-dir', s.dataDir]);
    } finally {
      spy.mockRestore();
    }
    expect(code).toBe(0);
    const text = lines.join('');
    expect(text).toMatch(/Export written: .*exports[\\/]docket-export-\d{8}-\d{6}\.tar\.gz/);
    expect(text).toContain('No keys or tokens.');
    expect(text).toMatch(/items \d+ [0-9a-f]{64}/);
    expect(readdirSync(join(s.dataDir, 'exports'))).toHaveLength(1);
  });
});

describe('read-only current export', () => {
  it('includes committed WAL state while leaving source database, WAL, SHM, docs and secrets unchanged', async () => {
    s = seeded();
    s.runtime.db.sqlite
      .prepare("UPDATE items SET title = ? WHERE id = 'RCP-14'")
      .run('Current WAL title');
    const dest = tempDir('docket-readonly-dest-');
    temps.push(dest);
    const out = join(dest.dir, 'current.tar.gz');
    const config = s.runtime.config;
    const docPath = s.runtime.db.sqlite
      .prepare('SELECT path FROM document_versions ORDER BY path LIMIT 1')
      .get() as { path: string };
    const sourceFiles = [
      config.paths.db,
      `${config.paths.db}-wal`,
      `${config.paths.db}-shm`,
      config.paths.agentToken,
      config.paths.ownerKey,
      join(config.paths.docs, ...docPath.path.split('/')),
    ];
    expect(statSync(`${config.paths.db}-wal`).size).toBeGreaterThan(0);
    const before = sourceFiles.map(fileMetadata);
    const result = await runReadOnlyExport({ config, out, clock: s.clock.now });
    const after = sourceFiles.map(fileMetadata);
    expect(after).toEqual(before);
    expect(result.manifest.documents.missing).toEqual([]);
    expect(result.manifest.checksums).toEqual(liveChecksums(config.paths));
    const files = await readAll(out);
    const items = JSON.parse(files.get('data/items.json')!.toString('utf8')) as { title: string }[];
    expect(items.some((item) => item.title === 'Current WAL title')).toBe(true);
  });

  it('refuses source/output aliases and missing or mismatched source secrets', async () => {
    s = seeded();
    const config = s.runtime.config;
    const inside = join(s.dataDir, 'exports');
    mkdirSync(inside);
    await expect(runReadOnlyExport({ config, out: join(inside, 'bad.tar.gz') })).rejects.toThrow(
      'Source and destination must be separate mounts.',
    );
    await expect(runReadOnlyExport({ config, out: 'relative.tar.gz' })).rejects.toThrow(
      'Use an absolute destination on a separate scratch mount.',
    );
    if (process.platform !== 'win32') {
      const dest = tempDir('docket-readonly-link-');
      temps.push(dest);
      const link = join(dest.dir, 'alias');
      symlinkSync(inside, link, 'dir');
      await expect(runReadOnlyExport({ config, out: join(link, 'bad.tar.gz') })).rejects.toThrow(
        'Source and destination must be separate mounts.',
      );
    }
    const dest = tempDir('docket-readonly-dest-');
    temps.push(dest);
    const existing = join(dest.dir, 'existing.tar.gz');
    writeFileSync(existing, 'keep this file');
    await expect(runReadOnlyExport({ config, out: existing })).rejects.toThrow(
      'Destination already exists.',
    );
    expect(readFileSync(existing, 'utf8')).toBe('keep this file');
    unlinkSync(config.paths.ownerKey);
    await expect(runReadOnlyExport({ config, out: join(dest.dir, 'bad.tar.gz') })).rejects.toThrow(
      'Required service secret guard is unavailable.',
    );
    expect(readdirSync(dest.dir)).toEqual(['existing.tar.gz']);
  });

  it('refuses schema drift, missing referenced documents and secret-bearing rows without an archive', async () => {
    s = seeded();
    const config = s.runtime.config;
    const dest = tempDir('docket-readonly-dest-');
    temps.push(dest);
    const out = join(dest.dir, 'bad.tar.gz');
    s.runtime.db.sqlite.exec(
      'DELETE FROM __drizzle_migrations WHERE created_at = (SELECT max(created_at) FROM __drizzle_migrations)',
    );
    await expect(runReadOnlyExport({ config, out })).rejects.toThrow(
      'Source schema differs from this Docket build.',
    );
    expect(readdirSync(dest.dir)).toEqual([]);
    // Restore a valid fixture for the independent missing-file and leak cases.
    await s.cleanup();
    s = seeded();
    const document = s.runtime.db.sqlite
      .prepare('SELECT path FROM document_versions ORDER BY path LIMIT 1')
      .get() as { path: string };
    unlinkSync(join(s.runtime.config.paths.docs, ...document.path.split('/')));
    await expect(runReadOnlyExport({ config: s.runtime.config, out })).rejects.toBeInstanceOf(
      ReadOnlyExportRefused,
    );
    expect(readdirSync(dest.dir)).toEqual([]);
    await s.cleanup();
    s = seeded();
    s.runtime.db.sqlite
      .prepare("UPDATE items SET title = ? WHERE id = 'RCP-14'")
      .run(`synthetic ${s.runtime.secrets.agentToken()}`);
    await expect(runReadOnlyExport({ config: s.runtime.config, out })).rejects.toBeInstanceOf(
      ReadOnlyExportRefused,
    );
    expect(readdirSync(dest.dir)).toEqual([]);
    await s.cleanup();
    s = seeded();
    const secretDocument = s.runtime.db.sqlite
      .prepare('SELECT path FROM document_versions ORDER BY path LIMIT 1')
      .get() as { path: string };
    writeFileSync(
      join(s.runtime.config.paths.docs, ...secretDocument.path.split('/')),
      `synthetic ${s.runtime.secrets.ownerKey()}`,
    );
    await expect(runReadOnlyExport({ config: s.runtime.config, out })).rejects.toBeInstanceOf(
      ReadOnlyExportRefused,
    );
    expect(readdirSync(dest.dir)).toEqual([]);
  });

  it('requires an explicit scratch output and emits counts without source paths or secrets', async () => {
    s = seeded();
    const dest = tempDir('docket-readonly-dest-');
    temps.push(dest);
    const out = join(dest.dir, 'current.tar.gz');
    const lines: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });
    try {
      expect(await main(['export', '--read-only-source', '--data-dir', s.dataDir])).toBe(2);
      expect(
        await main(['export', '--read-only-source', '--data-dir', s.dataDir, '--out', out]),
      ).toBe(0);
    } finally {
      spy.mockRestore();
    }
    const text = lines.join('');
    expect(text).toContain('Read-only export written to separate scratch destination.');
    expect(text).toMatch(/items \d+ [0-9a-f]{64}/);
    expect(text).not.toContain(s.dataDir);
    expect(text).not.toContain(s.runtime.secrets.agentToken());
    expect(text).not.toContain(s.runtime.secrets.ownerKey());
    expect(existsSync(out)).toBe(true);
  });
});

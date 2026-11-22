/**
 * Backups and restore (BUILD_SPEC §5.13; owner decision 24; FR-103, FR-103a; SC-008).
 *
 * A backup is one `docket-YYYYMMDD-HHMM.tar.gz` (local time) holding:
 * - `docket.db`: a `VACUUM INTO` snapshot, consistent under WAL;
 * - `docs/<path>`: every document version the snapshot references, byte for byte.
 *   `docs/.staging` (uploads still arriving) is never archived;
 * - `manifest.json`, last: each file's size and sha256, plus the item, event
 *   and document checksums of the data (`dataChecksums`).
 *
 * Every archive is verified after writing: it is read back, every file is
 * checked against the manifest, the database passes `integrity_check`, and
 * its checksums match. Only then is it renamed into place. Backups go to
 * `/data/backups` and are kept `DOCKET_BACKUP_KEEP` days. When
 * `DOCKET_BACKUP_EXTRA_DIR` is set, the verified archive is also copied
 * there (and the copy checked byte for byte), with the same retention. A
 * failed extra copy never fails the backup; it is recorded in
 * `/data/backups/status.json`, which Settings and Problems read.
 *
 * Restore runs offline (`docket restore <file>`): it refuses while the
 * server holds its lock, verifies the whole archive into a staging
 * directory, swaps it in, and checks the restored data's checksums against
 * the manifest before it removes the old data.
 *
 * Nothing here logs a secret: backups hold no token or key (the secrets
 * directory is not archived), and log lines name only paths and sizes.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { basename, dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { LEGACY_BACKUP_FORMAT, LEGACY_DB_FILE } from '@docket/shared';
import Database from 'better-sqlite3';
import type { Config } from '../config.js';
import type { BackupLocationStatus, BackupResult, BackupTrouble } from '../domain/contracts.js';
import { APP_VERSION } from '../version.js';
import { readTarGz, writeTarGz, type TarFileEntry, type TarSink } from './tar.js';

type Sqlite = Database.Database;

export const MANIFEST = 'manifest.json';
export const DB_ENTRY = 'docket.db';
const FORMAT = 'docket-backup';
/**
 * Archives are `docket-…`. Those taken before the rename (B28) are named
 * `tasklite-…`, hold `tasklite.db` and say `tasklite-backup`; they are
 * listed, pruned, verified and restored the same way.
 */
const ARCHIVE = /^(?:docket|tasklite)-(\d{8})-(\d{4}|\d{6})(?:-(\d+))?\.tar\.gz$/;
/** The database entry an archive of each format holds. */
const DB_ENTRY_OF: Record<string, string> = {
  [FORMAT]: DB_ENTRY,
  [LEGACY_BACKUP_FORMAT]: LEGACY_DB_FILE,
};
const DAY_MS = 86_400_000;

// ---- Checksums (SC-008: "a restored backup matches the original exactly") ----

export interface DataChecksums {
  items: { count: number; ids_sha256: string; sha256: string };
  events: { count: number; max_seq: number; sha256: string };
  documents: { count: number; bytes: number; sha256: string };
}

const sha = () => createHash('sha256');

/** The sha256 of a file, read in chunks; null when it doesn't exist. */
export function sha256File(path: string): string | null {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  try {
    const hash = sha();
    const buf = Buffer.alloc(1024 * 1024);
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      hash.update(buf.subarray(0, n));
    }
    return hash.digest('hex');
  } finally {
    closeSync(fd);
  }
}

/**
 * Checksums of every item row, every event row (up to `throughSeq`, when
 * given) and every document version with its bytes. `fileSha(path)` gives
 * the sha256 of a version's file (`path` relative to the docs directory),
 * or null when it is missing.
 */
export function dataChecksums(
  sqlite: Sqlite,
  fileSha: (path: string) => string | null,
  opts: { throughSeq?: number } = {},
): DataChecksums {
  const items = { count: 0, ids: sha(), rows: sha() };
  for (const row of sqlite.prepare('SELECT * FROM items ORDER BY id').iterate() as Iterable<{
    id: string;
  }>) {
    items.count += 1;
    items.ids.update(`${row.id}\n`);
    items.rows.update(`${JSON.stringify(row)}\n`);
  }
  const events = { count: 0, max: 0, rows: sha() };
  const through = opts.throughSeq ?? Number.MAX_SAFE_INTEGER;
  for (const row of sqlite
    .prepare('SELECT * FROM events WHERE seq <= ? ORDER BY seq')
    .iterate(through) as Iterable<{ seq: number }>) {
    events.count += 1;
    events.max = row.seq;
    events.rows.update(`${JSON.stringify(row)}\n`);
  }
  const docs = { count: 0, bytes: 0, rows: sha() };
  for (const row of sqlite
    .prepare(
      `SELECT v.id, v.document_id, v.version_no, v.mime, v.size, v.sha256, v.path,
              d.project_key, d.item_id, d.name, d.kind
       FROM document_versions v JOIN documents d ON d.id = v.document_id
       ORDER BY v.id`,
    )
    .iterate() as Iterable<{ path: string; size: number }>) {
    docs.count += 1;
    docs.bytes += row.size;
    docs.rows.update(`${JSON.stringify(row)} ${fileSha(row.path) ?? 'missing'}\n`);
  }
  return {
    items: {
      count: items.count,
      ids_sha256: items.ids.digest('hex'),
      sha256: items.rows.digest('hex'),
    },
    events: { count: events.count, max_seq: events.max, sha256: events.rows.digest('hex') },
    documents: { count: docs.count, bytes: docs.bytes, sha256: docs.rows.digest('hex') },
  };
}

/** The checksums of a data directory as it is on disk (read-only). */
export function liveChecksums(
  paths: { db: string; docs: string },
  opts: { throughSeq?: number } = {},
): DataChecksums {
  const sqlite = new Database(paths.db, { readonly: true, fileMustExist: true });
  try {
    return dataChecksums(sqlite, (p) => sha256File(join(paths.docs, p)), opts);
  } finally {
    sqlite.close();
  }
}

export function sameChecksums(a: DataChecksums, b: DataChecksums): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---- Archive names and retention ----

const two = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}`;

/** When an archive was taken, from its name (local time); null for other files. */
export function archiveTime(name: string): Date | null {
  const m = ARCHIVE.exec(name);
  if (!m) return null;
  const [d, t] = [m[1]!, m[2]!];
  return new Date(
    Number(d.slice(0, 4)),
    Number(d.slice(4, 6)) - 1,
    Number(d.slice(6, 8)),
    Number(t.slice(0, 2)),
    Number(t.slice(2, 4)),
    t.length === 6 ? Number(t.slice(4, 6)) : 0,
  );
}

/** The archives in a folder, newest first. */
export function listArchives(dir: string): { name: string; path: string; at: Date }[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .map((name) => ({ name, path: join(dir, name), at: archiveTime(name) }))
    .filter((a): a is { name: string; path: string; at: Date } => a.at !== null)
    .sort((a, b) => b.at.getTime() - a.at.getTime() || b.name.localeCompare(a.name));
}

/** A new archive name for `now` that doesn't exist yet in any of `dirs`. */
function archiveName(now: Date, dirs: string[]): string {
  const hm = `${two(now.getHours())}${two(now.getMinutes())}`;
  const candidates = [
    `docket-${ymd(now)}-${hm}.tar.gz`,
    `docket-${ymd(now)}-${hm}${two(now.getSeconds())}.tar.gz`,
  ];
  for (let i = 2; i < 1000; i++) {
    candidates.push(`docket-${ymd(now)}-${hm}${two(now.getSeconds())}-${i}.tar.gz`);
  }
  const name = candidates.find((n) => dirs.every((d) => !existsSync(join(d, n))));
  if (!name) throw new Error('Too many backups this second.');
  return name;
}

/** Delete archives older than `keepDays`, and leftovers of interrupted runs. Returns the names removed. */
export function pruneArchives(dir: string, keepDays: number, now: Date): string[] {
  const cutoff = now.getTime() - keepDays * DAY_MS;
  const removed: string[] = [];
  for (const a of listArchives(dir)) {
    if (a.at.getTime() < cutoff) {
      rmSync(a.path, { force: true });
      removed.push(a.name);
    }
  }
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return removed;
  }
  for (const name of names) {
    if (name.endsWith('.partial') || name.startsWith('.tmp-')) {
      rmSync(join(dir, name), { recursive: true, force: true });
    }
  }
  return removed;
}

// ---- Status (Settings, Problems) ----

interface LocationState {
  path: string;
  last_success_at: string | null;
  last_archive: string | null;
  last_error: string | null;
}
interface StatusFile {
  volume?: LocationState;
  extra?: LocationState;
  /** The scheduler's memory across restarts (decision 41). */
  schedule?: {
    /** When Docket first ran with no backup yet: a new install isn't "behind". */
    first_seen_at?: string;
    /** The scheduled time last tried, and how many automatic tries it had. */
    slot?: string;
    attempts?: number;
  };
}

const statusPath = (config: Config) => join(config.paths.backups, 'status.json');

function readStatusFile(config: Config): StatusFile {
  try {
    return JSON.parse(readFileSync(statusPath(config), 'utf8')) as StatusFile;
  } catch {
    return {};
  }
}

function writeStatusFile(config: Config, status: StatusFile): void {
  mkdirSync(config.paths.backups, { recursive: true });
  const tmp = `${statusPath(config)}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(status, null, 2)}\n`, { mode: 0o640 });
  renameSync(tmp, statusPath(config));
}

/** Each backup location with its last successful backup (Settings → Service health). */
export function backupStatus(config: Config): BackupLocationStatus[] {
  const status = readStatusFile(config);
  const newest = (dir: string) => listArchives(dir)[0]?.at.toISOString() ?? null;
  const out: BackupLocationStatus[] = [
    {
      location: 'volume',
      path: config.paths.backups,
      last_success_at: status.volume?.last_success_at ?? newest(config.paths.backups),
      keep_days: config.backupKeepDays,
      last_error: status.volume?.last_error ?? null,
    },
  ];
  if (config.backupExtraDir) {
    const extra = status.extra?.path === config.backupExtraDir ? status.extra : undefined;
    out.push({
      location: 'extra',
      path: config.backupExtraDir,
      last_success_at: extra?.last_success_at ?? newest(config.backupExtraDir),
      keep_days: config.backupKeepDays,
      last_error: extra?.last_error ?? null,
    });
  }
  return out;
}

// ---- Verifying an archive ----

export interface Manifest {
  /** `docket-backup`, or `tasklite-backup` for an archive from before the rename. */
  format: string;
  version: 1;
  created_at: string;
  app_version: string;
  files: Record<string, { size: number; sha256: string }>;
  /** Document versions whose file was missing when the backup was taken. */
  missing: string[];
  checksums: DataChecksums;
}

export class ArchiveError extends Error {
  override name = 'ArchiveError';
}

/** A name inside the archive that is safe to extract under a directory. */
function safeEntryName(name: string): string {
  const clean = normalize(name).split(sep).join('/');
  if (
    name === '' ||
    isAbsolute(name) ||
    /^[a-zA-Z]:/.test(name) ||
    clean.split('/').some((part) => part === '..') ||
    name.includes('\0')
  ) {
    throw new ArchiveError(`The archive has an unsafe path: ${JSON.stringify(name)}`);
  }
  return clean;
}

interface FileSink extends TarSink {
  /** Stop writing (a damaged archive) and wait until the file is closed. */
  abort(): Promise<void>;
}

function fileSink(path: string, hash: ReturnType<typeof sha>): FileSink {
  mkdirSync(dirname(path), { recursive: true });
  const out = createWriteStream(path, { flags: 'wx', mode: 0o640 });
  let failure: Error | null = null;
  const closed = new Promise<void>((done) => out.once('close', () => done()));
  out.on('error', (err) => {
    failure = err;
  });
  const check = () => {
    if (failure) throw failure;
  };
  return {
    write: (chunk) => {
      check();
      hash.update(chunk);
      if (!out.write(chunk)) {
        return new Promise<void>((done) => out.once('drain', () => done())).then(check);
      }
    },
    end: async () => {
      check();
      await new Promise<void>((done, fail) =>
        out.end((err?: Error | null) => (err ? fail(err) : done())),
      );
      await closed;
      check();
    },
    abort: async () => {
      if (!out.closed) out.destroy();
      await closed;
    },
  };
}

/**
 * Read a whole archive and prove it is sound: every file matches the
 * manifest, the database passes `integrity_check`, and the data checksums
 * match. With `extractTo`, the database and documents are written there
 * (`docket.db`, `docs/…`); otherwise only the database goes to a
 * temporary directory, removed afterwards.
 */
export async function verifyArchive(
  path: string,
  opts: { extractTo?: string; tmpParent?: string } = {},
): Promise<{ manifest: Manifest; checksums: DataChecksums; dbEntry: string }> {
  const tmp =
    opts.extractTo ??
    join(opts.tmpParent ?? dirname(path), `.tmp-${randomBytes(6).toString('hex')}`);
  mkdirSync(tmp, { recursive: true });
  const seen = new Map<string, { size: number; sha256: string }>();
  const sinks: FileSink[] = [];
  let manifestText = '';
  try {
    try {
      await readTarGz(path, (entry) => {
        if (entry.type === 'directory') return null;
        if (entry.type !== 'file') {
          throw new ArchiveError(`The archive has an unexpected entry: ${entry.name}`);
        }
        const name = safeEntryName(entry.name);
        if (seen.has(name)) throw new ArchiveError(`The archive lists ${name} twice.`);
        const hash = sha();
        let size = 0;
        const done = () => seen.set(name, { size, sha256: hash.digest('hex') });
        if (name === MANIFEST) {
          const parts: Buffer[] = [];
          return {
            write: (c) => {
              size += c.length;
              hash.update(c);
              parts.push(c);
            },
            end: () => {
              manifestText = Buffer.concat(parts).toString('utf8');
              done();
            },
          };
        }
        const extract =
          Object.values(DB_ENTRY_OF).includes(name) ||
          (opts.extractTo !== undefined && name.startsWith('docs/'));
        if (extract) {
          const sink = fileSink(join(tmp, ...name.split('/')), hash);
          sinks.push(sink);
          return {
            write: (c) => {
              size += c.length;
              return sink.write(c);
            },
            end: async () => {
              await sink.end();
              done();
            },
          };
        }
        return {
          write: (c) => {
            size += c.length;
            hash.update(c);
          },
          end: done,
        };
      });
    } catch (err) {
      // Close any file still open before the caller removes the folder.
      await Promise.all(sinks.map((x) => x.abort()));
      if (err instanceof ArchiveError) throw err;
      throw new ArchiveError(`The archive can't be read: ${(err as Error).message}`);
    }

    let manifest: Manifest;
    try {
      manifest = JSON.parse(manifestText) as Manifest;
    } catch {
      throw new ArchiveError(
        'The archive has no readable manifest.json; it is not a Docket backup.',
      );
    }
    const dbEntry = DB_ENTRY_OF[manifest.format];
    if (!dbEntry || manifest.version !== 1) {
      throw new ArchiveError('The archive is not a Docket backup (unknown manifest format).');
    }
    for (const [name, want] of Object.entries(manifest.files)) {
      const got = seen.get(name);
      if (!got) throw new ArchiveError(`The archive is missing ${name}.`);
      if (got.size !== want.size || got.sha256 !== want.sha256) {
        throw new ArchiveError(`${name} doesn't match its checksum in the manifest.`);
      }
    }
    for (const name of seen.keys()) {
      if (name !== MANIFEST && !(name in manifest.files)) {
        throw new ArchiveError(`The archive has a file the manifest doesn't list: ${name}.`);
      }
    }
    if (!manifest.files[dbEntry]) throw new ArchiveError('The archive has no database.');

    const sqlite = new Database(join(tmp, dbEntry), { readonly: true, fileMustExist: true });
    let checksums: DataChecksums;
    try {
      const integrity = sqlite.pragma('integrity_check', { simple: true });
      if (integrity !== 'ok') {
        throw new ArchiveError(
          `The archived database failed its integrity check: ${String(integrity)}`,
        );
      }
      checksums = dataChecksums(sqlite, (p) => seen.get(`docs/${p}`)?.sha256 ?? null);
    } finally {
      sqlite.close();
    }
    if (!sameChecksums(checksums, manifest.checksums)) {
      throw new ArchiveError("The archived data doesn't match the manifest's checksums.");
    }
    return { manifest, checksums, dbEntry };
  } finally {
    if (opts.extractTo === undefined) rmSync(tmp, { recursive: true, force: true });
  }
}

// ---- Taking a backup ----

export interface BackupDeps {
  config: Config;
  /** A connection to the live database (the server's own, or the CLI's). */
  sqlite: Sqlite;
  clock: () => Date;
  log: (line: string) => void;
}

/** Why the extra copy failed, in the owner's terms. Never includes file contents. */
export function extraCopyReason(err: unknown, dir: string): string {
  const code = (err as NodeJS.ErrnoException)?.code;
  switch (code) {
    case 'ENOENT':
    case 'ENOTDIR':
      return `${dir} doesn't exist. Mount the host folder there, or unset DOCKET_BACKUP_EXTRA_DIR`;
    case 'EACCES':
    case 'EPERM':
    case 'EROFS':
      return `${dir} isn't writable by the service (uid 10001)`;
    case 'ENOSPC':
    case 'EDQUOT':
      return `${dir} is full`;
    default:
      return (err as Error)?.message ?? String(err);
  }
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Take a backup now: snapshot, archive, verify, rename into place, prune;
 * then the extra copy when configured. Throws only when the default backup
 * fails; an extra-copy failure is reported in the result and the status.
 */
export async function runBackup(deps: BackupDeps): Promise<BackupResult> {
  const { config, clock, log } = deps;
  const dir = config.paths.backups;
  mkdirSync(dir, { recursive: true });
  const now = clock();
  const extraDir = config.backupExtraDir;
  const name = archiveName(now, extraDir ? [dir, extraDir] : [dir]);
  const finalPath = join(dir, name);
  const partial = `${finalPath}.partial`;
  const tmp = join(dir, `.tmp-${randomBytes(6).toString('hex')}`);
  const status = readStatusFile(config);
  try {
    mkdirSync(tmp);
    const snapshot = join(tmp, DB_ENTRY);
    deps.sqlite.prepare('VACUUM INTO ?').run(snapshot);
    const snap = new Database(snapshot, { readonly: true, fileMustExist: true });
    let versions: { path: string; size: number }[];
    try {
      versions = snap.prepare('SELECT path, size FROM document_versions ORDER BY path').all() as {
        path: string;
        size: number;
      }[];
    } finally {
      snap.close();
    }

    const files: Manifest['files'] = {};
    const missing: string[] = [];
    const docHashes = new Map<string, string>();
    async function* entries(): AsyncGenerator<TarFileEntry> {
      const dbHash = sha();
      const dbSize = statSync(snapshot).size;
      yield { name: DB_ENTRY, size: dbSize, source: { path: snapshot }, hash: dbHash, mtime: now };
      files[DB_ENTRY] = { size: dbSize, sha256: dbHash.digest('hex') };
      const done = new Set<string>();
      for (const v of versions) {
        if (done.has(v.path)) continue;
        done.add(v.path);
        const full = join(config.paths.docs, ...v.path.split('/'));
        let st;
        try {
          st = statSync(full);
        } catch {
          missing.push(v.path);
          continue;
        }
        const hash = sha();
        const entryName = `docs/${v.path}`;
        yield { name: entryName, size: st.size, source: { path: full }, hash, mtime: st.mtime };
        const digest = hash.digest('hex');
        files[entryName] = { size: st.size, sha256: digest };
        docHashes.set(v.path, digest);
      }
      const snapDb = new Database(snapshot, { readonly: true, fileMustExist: true });
      let checksums: DataChecksums;
      try {
        checksums = dataChecksums(snapDb, (p) => docHashes.get(p) ?? null);
      } finally {
        snapDb.close();
      }
      const manifest: Manifest = {
        format: FORMAT,
        version: 1,
        created_at: now.toISOString(),
        app_version: APP_VERSION,
        files,
        missing,
        checksums,
      };
      const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
      yield { name: MANIFEST, size: bytes.length, source: { bytes }, mtime: now };
    }
    await writeTarGz(partial, entries());
    await verifyArchive(partial, { tmpParent: dir });
    renameSync(partial, finalPath);
    if (missing.length > 0) {
      log(`Backup: ${missing.length} document file(s) were missing and are not in the archive.`);
    }
  } catch (err) {
    rmSync(partial, { force: true });
    status.volume = {
      path: dir,
      last_success_at: status.volume?.last_success_at ?? null,
      last_archive: status.volume?.last_archive ?? null,
      last_error: (err as Error).message,
    };
    writeStatusFile(config, status);
    throw err;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  const size = statSync(finalPath).size;
  const pruned = pruneArchives(dir, config.backupKeepDays, now);
  status.volume = {
    path: dir,
    last_success_at: now.toISOString(),
    last_archive: name,
    last_error: null,
  };
  log(
    `Backup written and verified: ${finalPath} (${mb(size)})${pruned.length > 0 ? `; removed ${pruned.length} older than ${config.backupKeepDays} days` : ''}.`,
  );

  let extra: BackupResult['extra_copy'] = null;
  if (extraDir) {
    const target = join(extraDir, name);
    const part = `${target}.partial`;
    try {
      if (!statSync(extraDir).isDirectory()) {
        throw Object.assign(new Error(`${extraDir} is not a folder`), { code: 'ENOTDIR' });
      }
      await copyFile(finalPath, part);
      if (sha256File(part) !== sha256File(finalPath)) {
        throw new Error('the copy does not match the original archive');
      }
      renameSync(part, target);
      pruneArchives(extraDir, config.backupKeepDays, now);
      status.extra = {
        path: extraDir,
        last_success_at: clock().toISOString(),
        last_archive: name,
        last_error: null,
      };
      extra = { path: target, ok: true, error: null };
      log(`Backup copied to the extra location: ${target}.`);
    } catch (err) {
      try {
        rmSync(part, { force: true });
      } catch {
        // The folder may be unreadable too.
      }
      const reason = extraCopyReason(err, extraDir);
      const previous = status.extra?.path === extraDir ? status.extra : undefined;
      status.extra = {
        path: extraDir,
        last_success_at: previous?.last_success_at ?? null,
        last_archive: previous?.last_archive ?? null,
        last_error: reason,
      };
      extra = { path: target, ok: false, error: reason };
      log(`Extra backup copy failed: ${reason}. The backup in the data volume is fine.`);
    }
  }
  writeStatusFile(config, status);
  return { archive_path: finalPath, extra_copy: extra };
}

// ---- The server lock: restore refuses while the server runs ----

const LOCK_FILE = 'server.lock';
/** The server refreshes its lock this often… */
export const LOCK_REFRESH_MS = 15_000;
/** …and a lock older than this belongs to a server that is gone. */
export const LOCK_STALE_MS = 60_000;

interface LockInfo {
  pid: number;
  host: string;
  started_at: string;
  heartbeat_at: string;
}

const lockPath = (config: Config) => join(config.dataDir, LOCK_FILE);

/** Hold the server lock while the server runs: written now, refreshed, removed on stop. */
export function holdServerLock(
  config: Config,
  clock: () => Date = () => new Date(),
): { stop(): void } {
  const started = clock().toISOString();
  const write = () => {
    const info: LockInfo = {
      pid: process.pid,
      host: hostname(),
      started_at: started,
      heartbeat_at: clock().toISOString(),
    };
    try {
      writeFileSync(lockPath(config), `${JSON.stringify(info)}\n`, { mode: 0o640 });
    } catch {
      // The volume may be briefly unavailable; the next refresh tries again.
    }
  };
  write();
  const timer = setInterval(write, LOCK_REFRESH_MS);
  timer.unref();
  return {
    stop() {
      clearInterval(timer);
      rmSync(lockPath(config), { force: true });
    },
  };
}

/** The running server's lock, or null when no server is running on this data directory. */
export function runningServer(config: Config, now: Date = new Date()): LockInfo | null {
  let info: LockInfo;
  try {
    info = JSON.parse(readFileSync(lockPath(config), 'utf8')) as LockInfo;
  } catch {
    return null;
  }
  const age = now.getTime() - Date.parse(info.heartbeat_at);
  if (age >= 0 && age < LOCK_STALE_MS) return info;
  if (info.host === hostname() && info.pid !== process.pid) {
    try {
      process.kill(info.pid, 0);
      return info;
    } catch {
      return null;
    }
  }
  return null;
}

// ---- Restore ----

export class RestoreRefused extends Error {
  override name = 'RestoreRefused';
}

/**
 * Find the archive to restore: a path as given, else a name in the volume's
 * backups folder or the extra location (`docket restore` takes either).
 */
export function resolveArchive(config: Config, file: string): string {
  const candidates = [resolve(file)];
  if (basename(file) === file) {
    candidates.push(join(config.paths.backups, file));
    if (config.backupExtraDir) candidates.push(join(config.backupExtraDir, file));
  }
  const found = candidates.find((p) => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  });
  if (!found) throw new RestoreRefused(`No backup at ${file}.`);
  return found;
}

const DATA_PARTS = (config: Config) => [
  config.paths.db,
  `${config.paths.db}-wal`,
  `${config.paths.db}-shm`,
  config.paths.docs,
];

/**
 * Restore a backup into the data directory. Refuses while the server runs;
 * verifies the whole archive before it replaces anything; checks the
 * restored data against the manifest, and puts the old data back if they
 * differ. Secrets and logs are left as they are.
 */
export async function restoreBackup(opts: {
  config: Config;
  file: string;
  clock?: () => Date;
  log?: (line: string) => void;
}): Promise<{ archive: string; manifest: Manifest; checksums: DataChecksums }> {
  const { config } = opts;
  const clock = opts.clock ?? (() => new Date());
  const log = opts.log ?? (() => {});
  const running = runningServer(config, clock());
  if (running) {
    throw new RestoreRefused(
      'Docket is running on this data volume. Stop it first (docker compose stop docket), then run: docker compose run --rm docket docket restore <file>',
    );
  }
  const archive = resolveArchive(config, opts.file);
  mkdirSync(config.dataDir, { recursive: true });
  const stamp = `${ymd(clock())}-${randomBytes(4).toString('hex')}`;
  const staging = join(config.dataDir, `.restore-${stamp}`);
  const aside = join(config.dataDir, `.pre-restore-${stamp}`);
  log(`Verifying ${archive}…`);
  let verified: { manifest: Manifest; checksums: DataChecksums; dbEntry: string };
  try {
    verified = await verifyArchive(archive, { extractTo: staging });
  } catch (err) {
    rmSync(staging, { recursive: true, force: true });
    throw err;
  }
  mkdirSync(join(staging, 'docs', '.staging'), { recursive: true });

  // Swap: move the current data aside, move the restored data in.
  mkdirSync(aside);
  const moved: [string, string][] = [];
  try {
    for (const part of DATA_PARTS(config)) {
      if (existsSync(part)) {
        const to = join(aside, basename(part));
        renameSync(part, to);
        moved.push([to, part]);
      }
    }
    renameSync(join(staging, verified.dbEntry), config.paths.db);
    renameSync(join(staging, 'docs'), config.paths.docs);
    const restored = liveChecksums({ db: config.paths.db, docs: config.paths.docs });
    if (!sameChecksums(restored, verified.manifest.checksums)) {
      throw new ArchiveError("The restored data doesn't match the backup's checksums.");
    }
  } catch (err) {
    // Put the old data back exactly as it was.
    for (const part of DATA_PARTS(config)) rmSync(part, { recursive: true, force: true });
    for (const [from, to] of moved) renameSync(from, to);
    rmSync(staging, { recursive: true, force: true });
    rmSync(aside, { recursive: true, force: true });
    throw err;
  }
  rmSync(aside, { recursive: true, force: true });
  rmSync(staging, { recursive: true, force: true });
  return { archive, manifest: verified.manifest, checksums: verified.checksums };
}

// ---- Startup housekeeping and the nightly schedule ----

/** Remove uploads left in `docs/.staging` (no upload survives a restart). Returns how many. */
export function clearStaging(docsDir: string): number {
  const dir = join(docsDir, '.staging');
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  let n = 0;
  for (const name of names) {
    if (name.endsWith('.part')) {
      rmSync(join(dir, name), { force: true });
      n += 1;
    }
  }
  return n;
}

/** The next `HH:MM` (local time) strictly after `now`. */
export function nextBackupAt(now: Date, at: string): Date {
  const [h, m] = at.split(':').map(Number) as [number, number];
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next;
}

/** The latest `HH:MM` (local time) at or before `now`: the backup that should exist by now. */
export function lastBackupAt(now: Date, at: string): Date {
  const [h, m] = at.split(':').map(Number) as [number, number];
  const last = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0, 0);
  if (last.getTime() > now.getTime()) last.setDate(last.getDate() - 1);
  return last;
}

/** How often the scheduler wakes and compares the wall clock (decision 41). */
export const BACKUP_TICK_MS = 60_000;
/** The first check waits this long, so a catch-up never delays the server's start. */
export const BACKUP_START_DELAY_MS = 5_000;
/** A missed backup is a Problem this long after its scheduled time (catch-up usually fixes it first). */
export const BACKUP_OVERDUE_AFTER_MS = 3_600_000;
/**
 * Automatic tries per scheduled time. A run the process didn't survive (a
 * restart in the middle of it) gets one more; a run that failed doesn't, so a
 * broken backup can't loop. It waits for the next night, shown as a Problem.
 */
const MAX_SLOT_ATTEMPTS = 2;

/** When the last good backup finished, from the status file, else the newest archive. */
function newestSuccess(config: Config, status: StatusFile): Date | null {
  const recorded = status.volume?.last_success_at;
  if (recorded) return new Date(recorded);
  return listArchives(config.paths.backups)[0]?.at ?? null;
}

/**
 * Whether the backup due at `slot` is missing. A first install isn't behind
 * until a scheduled time passes after Docket first saw it. A newest backup
 * more than a day in the future means the clock moved back, so it doesn't count.
 */
function slotMissed(status: StatusFile, newest: Date | null, slot: Date, now: Date): boolean {
  if (newest && newest.getTime() <= now.getTime() + DAY_MS) {
    return newest.getTime() < slot.getTime();
  }
  if (newest) return true;
  const first = status.schedule?.first_seen_at;
  return !!first && Date.parse(first) < slot.getTime();
}

/** Why the nightly backup needs the owner (owner decision 41): it failed, or it's overdue. */
export function backupTrouble(config: Config, now: Date): BackupTrouble | null {
  const status = readStatusFile(config);
  const newest = newestSuccess(config, status);
  const slot = lastBackupAt(now, config.backupAt);
  const base = { last_success_at: newest?.toISOString() ?? null, due_at: slot.toISOString() };
  const error = status.volume?.last_error;
  if (error) return { state: 'failed', error, ...base };
  if (!slotMissed(status, newest, slot, now)) return null;
  if (now.getTime() - slot.getTime() < BACKUP_OVERDUE_AFTER_MS) return null;
  return { state: 'overdue', error: null, ...base };
}

/**
 * The nightly backup at `DOCKET_BACKUP_AT`, robust to restarts, host sleep
 * and clock jumps (owner decision 41). It wakes every `BACKUP_TICK_MS` and at
 * startup, and compares the wall clock: when the newest good backup is older
 * than the last scheduled time, it runs one. Timers don't count sleep and a
 * restart forgets them, so nothing depends on one long timer. One run at a
 * time; however many nights were missed, one backup catches up. The tries for
 * each scheduled time are kept in `status.json`, so they survive a restart.
 */
export function startBackupJob(opts: {
  config: Config;
  backup: () => Promise<unknown>;
  log: (line: string) => void;
  now?: () => Date;
  tickMs?: number;
  startDelayMs?: number;
}): { stop(): void; next(): Date; tick(): Promise<boolean> } {
  const { config, log } = opts;
  const now = opts.now ?? (() => new Date());
  let next = nextBackupAt(now(), config.backupAt);
  let stopped = false;
  let running: Promise<boolean> | null = null;
  // Also in memory: on a full disk the status file can't record the try.
  let tried: { slot: string; attempts: number } = { slot: '', attempts: 0 };

  const record = (schedule: Partial<NonNullable<StatusFile['schedule']>>) => {
    try {
      const status = readStatusFile(config);
      writeStatusFile(config, { ...status, schedule: { ...status.schedule, ...schedule } });
    } catch (err) {
      log(`Backup schedule not recorded: ${(err as Error).message}`);
    }
  };

  const initial = readStatusFile(config);
  if (!newestSuccess(config, initial) && !initial.schedule?.first_seen_at) {
    record({ first_seen_at: now().toISOString() });
  }

  const check = async (): Promise<boolean> => {
    const at = now();
    next = nextBackupAt(at, config.backupAt);
    const due = lastBackupAt(at, config.backupAt);
    const slot = due.toISOString();
    const status = readStatusFile(config);
    if (!slotMissed(status, newestSuccess(config, status), due, at)) return false;
    const stored = status.schedule?.slot === slot ? (status.schedule.attempts ?? 0) : 0;
    const attempts = Math.max(stored, tried.slot === slot ? tried.attempts : 0);
    if (attempts >= MAX_SLOT_ATTEMPTS) return false;
    tried = { slot, attempts: attempts + 1 };
    record({ slot, attempts: attempts + 1 });
    log(`Running the backup due at ${slot}.`);
    try {
      await opts.backup();
    } catch (err) {
      log(`Backup failed: ${(err as Error).message}. It tries again at the next scheduled time.`);
      tried = { slot, attempts: MAX_SLOT_ATTEMPTS };
      record({ slot, attempts: MAX_SLOT_ATTEMPTS });
    }
    return true;
  };

  const tick = (): Promise<boolean> => {
    if (stopped) return Promise.resolve(false);
    running ??= check()
      .catch((err: unknown) => {
        log(`Backup check failed: ${(err as Error).message}`);
        return false;
      })
      .finally(() => {
        running = null;
      });
    return running;
  };

  const first = setTimeout(() => void tick(), opts.startDelayMs ?? BACKUP_START_DELAY_MS);
  first.unref();
  const timer = setInterval(() => void tick(), opts.tickMs ?? BACKUP_TICK_MS);
  timer.unref();
  return {
    stop() {
      stopped = true;
      clearTimeout(first);
      clearInterval(timer);
    },
    next: () => next,
    tick,
  };
}

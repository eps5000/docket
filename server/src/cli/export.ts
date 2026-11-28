/**
 * `docket export` (tasks.md T147; ROADMAP §1 "Have a way out"; O06): a
 * complete, readable copy of the owner's data in one `.tar.gz`, for leaving
 * Docket or keeping outside it. Unlike a backup, it is meant to be read
 * by other tools, not restored.
 *
 * The archive holds:
 * - `data/<table>.json`: every row of every table that holds owner data, as
 *   a JSON array (one row per line), from a `VACUUM INTO` snapshot, so the
 *   export is consistent while the service runs;
 * - `documents/<project>/<document>/v<n>/<file>`: every stored document
 *   version's bytes, as on the volume;
 * - `manifest.json`: the format, the time, each table's row count and
 *   sha256, each file's size and sha256, and the same item, event and
 *   document checksums `docket checksums` prints, so a copy can be
 *   checked against the live data.
 *
 * Never exported (the same rule as backups): the agent token and the owner
 * key (they live in `/data/secrets`, not the database), browser sessions
 * (`owner_sessions`), the retry cache (`idempotency`), the search index
 * (derived from items) and the migrations table. As a last guard, the
 * export refuses to finish if a known secret appears in any table's JSON.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import type { Config } from '../config.js';
import { dataChecksums, type DataChecksums } from '../jobs/backup.js';
import { writeTarGz, type TarFileEntry } from '../jobs/tar.js';
import { APP_VERSION } from '../version.js';

type Sqlite = Database.Database;

export const EXPORT_FORMAT = 'docket-export';
export const EXPORT_MANIFEST = 'manifest.json';

/** Tables that never leave the volume, and why (shown in the manifest). */
export const EXCLUDED_TABLES: Record<string, string> = {
  owner_sessions: 'browser sessions (hashed session IDs), not owner data',
  idempotency: 'the retry cache of recent responses, not owner data',
};

/** Internal tables: SQLite's own, the migrations table and the search index. */
const INTERNAL = /^(sqlite_|__drizzle|search_fts)/;

export interface ExportManifest {
  format: typeof EXPORT_FORMAT;
  version: 1;
  created_at: string;
  app_version: string;
  tables: Record<string, { rows: number; file: string; sha256: string }>;
  excluded: Record<string, string>;
  documents: { count: number; bytes: number; missing: string[] };
  files: Record<string, { size: number; sha256: string }>;
  checksums: DataChecksums;
}

export interface ExportResult {
  archive_path: string;
  manifest: ExportManifest;
}

export interface ExportDeps {
  config: Config;
  sqlite: Sqlite;
  clock: () => Date;
  /** Values that must not appear in the export (the agent token and the owner key). */
  secrets: () => readonly string[];
  /** Where to write the archive; default `<data>/exports/docket-export-<time>.tar.gz`. */
  out?: string;
  /** Refuse an archive that omits any document referenced by the snapshot. */
  requireCompleteDocuments?: boolean;
  /** Strict source reader for a read-only mounted volume. */
  readDocument?: (path: string) => { bytes: Buffer; mtime: Date };
}

const sha = () => createHash('sha256');

/** The tables `docket export` writes, in name order. */
export function exportedTables(sqlite: Sqlite): string[] {
  const names = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as { name: string }[];
  return names
    .map((n) => n.name)
    .filter((name) => !INTERNAL.test(name) && !(name in EXCLUDED_TABLES));
}

/** A table's rows as a JSON array, one row per line, in primary-key order. */
function tableJson(sqlite: Sqlite, table: string): { bytes: Buffer; rows: number } {
  const pk = (
    sqlite.prepare('SELECT name FROM pragma_table_info(?) WHERE pk > 0 ORDER BY pk').all(table) as {
      name: string;
    }[]
  ).map((c) => `"${c.name}"`);
  const order = pk.length > 0 ? pk.join(', ') : 'rowid';
  const lines: string[] = [];
  for (const row of sqlite.prepare(`SELECT * FROM "${table}" ORDER BY ${order}`).iterate()) {
    lines.push(JSON.stringify(row));
  }
  const text = lines.length === 0 ? '[]\n' : `[\n${lines.join(',\n')}\n]\n`;
  return { bytes: Buffer.from(text, 'utf8'), rows: lines.length };
}

function stamp(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}-${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`;
}

export function defaultExportPath(config: Config, now: Date): string {
  return join(dirname(config.paths.db), 'exports', `docket-export-${stamp(now)}.tar.gz`);
}

export async function runExport(deps: ExportDeps): Promise<ExportResult> {
  const now = deps.clock();
  const finalPath = deps.out ?? defaultExportPath(deps.config, now);
  const dir = dirname(finalPath);
  mkdirSync(dir, { recursive: true });
  const partial = `${finalPath}.partial`;
  const tmp = join(dir, `.tmp-export-${randomBytes(6).toString('hex')}`);
  const secrets = deps.secrets().filter((s) => s.length >= 8);
  try {
    mkdirSync(tmp);
    const snapshot = join(tmp, 'snapshot.db');
    deps.sqlite.prepare('VACUUM INTO ?').run(snapshot);
    const snap = new Database(snapshot, { readonly: true, fileMustExist: true });
    try {
      const manifest: ExportManifest = {
        format: EXPORT_FORMAT,
        version: 1,
        created_at: now.toISOString(),
        app_version: APP_VERSION,
        tables: {},
        excluded: EXCLUDED_TABLES,
        documents: { count: 0, bytes: 0, missing: [] },
        files: {},
        checksums: dataChecksums(snap, () => null),
      };
      const docHashes = new Map<string, string>();
      const config = deps.config;

      async function* entries(): AsyncGenerator<TarFileEntry> {
        for (const table of exportedTables(snap)) {
          const { bytes, rows } = tableJson(snap, table);
          const text = bytes.toString('utf8');
          if (secrets.some((s) => text.includes(s))) {
            throw new Error(
              `Export stopped: a secret appeared in the ${table} table. Nothing was written.`,
            );
          }
          const name = `data/${table}.json`;
          const digest = sha().update(bytes).digest('hex');
          manifest.tables[table] = { rows, file: name, sha256: digest };
          manifest.files[name] = { size: bytes.length, sha256: digest };
          yield { name, size: bytes.length, source: { bytes }, mtime: now };
        }
        const versions = snap
          .prepare('SELECT DISTINCT path FROM document_versions ORDER BY path')
          .all() as { path: string }[];
        for (const { path } of versions) {
          const full = join(config.paths.docs, ...path.split('/'));
          let size: number;
          let mtime: Date;
          let guardedBytes: Buffer | undefined;
          if (deps.readDocument) {
            // Refuse invalid paths and aliases before any filesystem read.
            // Missing documents still fail the complete-export requirement.
            const document = deps.readDocument(path);
            guardedBytes = document.bytes;
            size = guardedBytes.length;
            mtime = document.mtime;
          } else {
            try {
              const st = statSync(full);
              size = st.size;
              mtime = st.mtime;
            } catch {
              manifest.documents.missing.push(path);
              continue;
            }
          }
          const name = `documents/${path}`;
          let digest: string;
          if (deps.requireCompleteDocuments) {
            // Scan the exact bytes that will be archived. Read one document
            // at a time to avoid a separate-scan/archive race.
            const bytes = guardedBytes ?? readFileSync(full);
            if (secrets.some((secret) => bytes.includes(Buffer.from(secret)))) {
              throw new Error('Export stopped: a service secret appeared in a document.');
            }
            size = bytes.length;
            digest = sha().update(bytes).digest('hex');
            yield { name, size, source: { bytes }, mtime };
          } else {
            const hash = sha();
            yield { name, size, source: { path: full }, hash, mtime };
            digest = hash.digest('hex');
          }
          docHashes.set(path, digest);
          manifest.files[name] = { size, sha256: digest };
          manifest.documents.count += 1;
          manifest.documents.bytes += size;
        }
        if (deps.requireCompleteDocuments && manifest.documents.missing.length > 0) {
          throw new Error('Export stopped: referenced document missing; no archive written.');
        }
        manifest.checksums = dataChecksums(snap, (p) => docHashes.get(p) ?? null);
        const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
        yield { name: EXPORT_MANIFEST, size: bytes.length, source: { bytes }, mtime: now };
      }

      await writeTarGz(partial, entries());
      renameSync(partial, finalPath);
      return { archive_path: finalPath, manifest };
    } finally {
      snap.close();
    }
  } catch (err) {
    rmSync(partial, { force: true });
    throw err;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

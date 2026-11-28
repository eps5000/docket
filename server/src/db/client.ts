/**
 * Opening the database and running migrations (BUILD_SPEC §2; MCP_SPEC §9).
 * better-sqlite3 is synchronous: handlers run on the main thread and never
 * await inside a transaction. Writes use BEGIN IMMEDIATE, and a busy lock
 * waits up to 5 s before the write path reports `unavailable`.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import * as schema from './schema.js';

export const BUSY_TIMEOUT_MS = 5_000;

export interface Db {
  sqlite: Database.Database;
  orm: BetterSQLite3Database<typeof schema>;
  path: string;
}

export interface OpenOptions {
  busyTimeoutMs?: number;
}

export function openDb(path: string, opts: OpenOptions = {}): Db {
  const sqlite = new Database(path);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma(`busy_timeout = ${Math.max(0, Math.floor(opts.busyTimeoutMs ?? BUSY_TIMEOUT_MS))}`);
  return { sqlite, orm: drizzle(sqlite, { schema }), path };
}

/**
 * The migrations folder. In the workspace this module runs from src/db, next
 * to migrations/; built, it runs from dist/db and the SQL ships in
 * src/db/migrations (package.json "files").
 */
export function migrationsFolder(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(here, 'migrations'), join(here, '..', '..', 'src', 'db', 'migrations')];
  const found = candidates.find((dir) => existsSync(join(dir, 'meta', '_journal.json')));
  if (!found) throw new Error(`Migrations folder not found (looked in ${candidates.join(', ')})`);
  return found;
}

/**
 * Apply pending migrations.
 *
 * Drizzle runs them all in one transaction, where `PRAGMA foreign_keys` is a
 * no-op, so a migration that rebuilds a parent table (SQLite's only way to
 * change a CHECK constraint; 0002 rebuilds `runs` and `documents`) would fire
 * the children's ON DELETE actions on `DROP TABLE`. Foreign keys are
 * therefore off for the migration run, as SQLite's table-rebuild procedure
 * prescribes, and `PRAGMA foreign_key_check` must come back clean before
 * they're turned on again.
 */
export function migrateDb(db: Db): void {
  const wasOn = db.sqlite.pragma('foreign_keys', { simple: true }) === 1;
  db.sqlite.pragma('foreign_keys = OFF');
  try {
    migrate(db.orm, { migrationsFolder: migrationsFolder() });
    const violations = db.sqlite.pragma('foreign_key_check') as unknown[];
    if (violations.length > 0) {
      throw new Error(
        `Migration left ${violations.length} foreign key violation(s): ${JSON.stringify(violations.slice(0, 5))}`,
      );
    }
  } finally {
    if (wasOn) db.sqlite.pragma('foreign_keys = ON');
  }
}

export interface MigrationStatus {
  current: boolean;
  applied: number;
  expected: number;
}

/** Whether every migration shipped with this build has been applied, and nothing newer. */
export function migrationStatus(db: Pick<Db, 'sqlite'>): MigrationStatus {
  const expected = readMigrationFiles({ migrationsFolder: migrationsFolder() });
  let applied: { hash: string }[] = [];
  const hasTable = db.sqlite
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'")
    .get();
  if (hasTable) {
    applied = db.sqlite
      .prepare('SELECT hash FROM __drizzle_migrations ORDER BY created_at, id')
      .all() as { hash: string }[];
  }
  const current =
    applied.length === expected.length && applied.every((row, i) => row.hash === expected[i]?.hash);
  return { current, applied: applied.length, expected: expected.length };
}

/** Run `fn` in a BEGIN IMMEDIATE transaction: it takes the write lock up front. */
export function immediate<T>(db: Db, fn: () => T): T {
  return db.sqlite.transaction(fn).immediate();
}

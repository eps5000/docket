/**
 * Migration 0008_connection_drift_key (B31; owner decision 32; BUILD_SPEC
 * §5.17a): `drift.file_key` also allows exactly `connection`, the project
 * connection file. `drift` is rebuilt, so this proves on a database created by
 * 0000–0007, with drift rows in it, that every row comes through unchanged and
 * `foreign_key_check` is clean; and that other keys are still refused.
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  migrateDb,
  migrationsFolder,
  migrationStatus,
  openDb,
  type Db,
} from '../../src/db/client.js';
import { insertProject, tempDir, type TempDir } from '../helpers.js';

const ts = '2026-11-18T00:00:00.000Z';
const SHA = 'a'.repeat(64);
const BEFORE = [
  '0000_init',
  '0001_search_fts',
  '0002_recovery',
  '0003_agent_setup',
  '0004_agent_proposals',
  '0005_docket_rename',
  '0006_onboarding',
  '0007_onboarding_guide_key',
];

/** A migrations folder holding only 0000–0007 (`main` before B31). */
function beforeB31(dir: string): string {
  const src = migrationsFolder();
  const out = join(dir, 'migrations-b30');
  mkdirSync(join(out, 'meta'), { recursive: true });
  for (const tag of BEFORE) copyFileSync(join(src, `${tag}.sql`), join(out, `${tag}.sql`));
  const journal = JSON.parse(readFileSync(join(src, 'meta', '_journal.json'), 'utf8')) as {
    entries: { tag: string }[];
  };
  journal.entries = journal.entries.filter((e) => BEFORE.includes(e.tag));
  writeFileSync(join(out, 'meta', '_journal.json'), JSON.stringify(journal));
  return out;
}

const run = (db: Db, sql: string, ...params: unknown[]) => db.sqlite.prepare(sql).run(...params);

function install(db: Db) {
  run(
    db,
    `INSERT INTO installs (id, at, client, target_kind, project_key, path, method, manifest, created_at, updated_at)
     VALUES ('ins_1', ?, 'claude', 'repo', 'RCP', 'recipes', 'push', '{}', ?, ?)`,
    ts,
    ts,
    ts,
  );
}

function drift(db: Db, id: string, key: string) {
  run(
    db,
    `INSERT INTO drift (id, install_id, project_key, file_key, change, state, local_sha256,
       detected_at, created_at, updated_at)
     VALUES (?, 'ins_1', 'RCP', ?, 'edited', 'open', ?, ?, ?, ?)`,
    id,
    key,
    SHA,
    ts,
    ts,
    ts,
  );
}

describe('0008_connection_drift_key', () => {
  let tmp: TempDir;
  let db: Db;
  beforeEach(() => {
    tmp = tempDir('docket-migrate-');
    db = openDb(join(tmp.dir, 'docket.db'));
  });
  afterEach(() => {
    db.sqlite.close();
    tmp.cleanup();
  });

  it('keeps every drift row, then accepts connection and still refuses other keys', () => {
    migrate(drizzle(db.sqlite), { migrationsFolder: beforeB31(tmp.dir) });
    insertProject(db, 'RCP');
    install(db);
    drift(db, 'dft_1', 'skill:docket-worker');
    drift(db, 'dft_2', 'agents_block');
    expect(() => drift(db, 'dft_x', 'connection')).toThrow(
      /CHECK constraint failed: drift_file_key/,
    );
    const before = db.sqlite.prepare('SELECT * FROM drift ORDER BY id').all();

    migrateDb(db);
    expect(migrationStatus(db).current).toBe(true);
    expect(db.sqlite.prepare('SELECT * FROM drift ORDER BY id').all()).toEqual(before);
    expect(db.sqlite.pragma('foreign_key_check')).toEqual([]);
    drift(db, 'dft_3', 'connection');
    for (const key of ['connection2', 'workflow', 'guide:onboarding', 'skill:Bad']) {
      expect(() => drift(db, `dft_${key}`, key), key).toThrow(
        /CHECK constraint failed: drift_file_key/,
      );
    }
  });
});

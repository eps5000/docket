/**
 * Migration 0007_onboarding_guide_key (B30; owner decision 31; BUILD_SPEC §4,
 * §5.20): `agent_files.key` also allows exactly `guide:onboarding`.
 *
 * `agent_files` is rebuilt (SQLite can't alter a CHECK), so this proves, on a
 * database created by 0000–0006 with data in every table that points at it,
 * that every row comes through unchanged: the files keep their IDs, so their
 * versions, history, proposals, installs and drift stay attached, and
 * `foreign_key_check` is clean. `migrateDb` turns foreign keys off around the
 * rebuild (as for 0002) and back on afterwards.
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
import { insertItem, insertProject, tempDir, type TempDir } from '../helpers.js';

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
];

/** A migrations folder holding only 0000–0006 (current `main` before B30). */
function beforeB30(dir: string): string {
  const src = migrationsFolder();
  const out = join(dir, 'migrations-b29');
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
const all = (db: Db, sql: string) => db.sqlite.prepare(sql).all();

function agentFile(db: Db, id: string, key: string, layer: string, project: string | null) {
  run(
    db,
    `INSERT INTO agent_files (id, key, layer, project_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    id,
    key,
    layer,
    project,
    ts,
    ts,
  );
}
function version(db: Db, id: string, file: string, no: number, content: string) {
  run(
    db,
    `INSERT INTO agent_file_versions (id, file_id, version_no, content, sha256, author,
       created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'owner', ?, ?)`,
    id,
    file,
    no,
    content,
    SHA,
    ts,
    ts,
  );
  run(db, 'UPDATE agent_files SET current_version_id = ? WHERE id = ?', id, file);
}

describe('0007_onboarding_guide_key on a fresh database', () => {
  let tmp: TempDir;
  let db: Db;
  beforeEach(() => {
    tmp = tempDir('docket-migrate-');
    db = openDb(join(tmp.dir, 'docket.db'));
    migrateDb(db);
  });
  afterEach(() => {
    db.sqlite.close();
    tmp.cleanup();
  });

  it('accepts guide:onboarding in every layer, and still refuses other keys', () => {
    insertProject(db, 'RCP');
    agentFile(db, 'af_g1', 'guide:onboarding', 'bundled', null);
    agentFile(db, 'af_g2', 'guide:onboarding', 'service', null);
    agentFile(db, 'af_g3', 'guide:onboarding', 'project', 'RCP');
    for (const key of ['guide:other', 'guide:', 'guide:onboarding2', 'skill:Bad', 'workflow']) {
      expect(() => agentFile(db, `af_${key}`, key, 'bundled', null), key).toThrow(
        /CHECK constraint failed: agent_files_key/,
      );
    }
    // Proposals keep the narrower check: the guide can't be proposed.
    expect(() =>
      run(
        db,
        `INSERT INTO agent_file_proposals (id, project_key, file_key, content, reason,
           based_on_version_id, proposed_by, state, created_at, updated_at)
         VALUES ('afp_g', 'RCP', 'guide:onboarding', 'x', 'y', NULL, 'claude', 'pending', ?, ?)`,
        ts,
        ts,
      ),
    ).toThrow(/CHECK constraint failed: agent_file_proposals_file_key/);
  });
});

describe('0007_onboarding_guide_key on a B29-era database (0000–0006, with data)', () => {
  let tmp: TempDir;
  let db: Db;

  beforeEach(() => {
    tmp = tempDir('docket-migrate-');
    db = openDb(join(tmp.dir, 'docket.db'));
    migrate(drizzle(db.sqlite), { migrationsFolder: beforeB30(tmp.dir) });
    expect(migrationStatus(db)).toEqual({ current: false, applied: 7, expected: 8 });
    expect(() => agentFile(db, 'af_x', 'guide:onboarding', 'bundled', null)).toThrow(
      /agent_files_key/,
    );
    insertProject(db, 'RCP');
    insertItem(db, { id: 'RCP-1' });
    run(
      db,
      `INSERT INTO runs (id, item_id, client, is_lead, state, last_signal_at, last_signal_kind,
         lease_expires_at, created_at, updated_at)
       VALUES ('run_1', 'RCP-1', 'claude', 1, 'open', ?, 'session', ?, ?, ?)`,
      ts,
      ts,
      ts,
      ts,
    );
    // Bundled, service and project layers, with history (two versions of the bundled worker).
    agentFile(db, 'af_1', 'skill:docket-worker', 'bundled', null);
    version(db, 'afv_1', 'af_1', 1, '# Worker v1');
    version(db, 'afv_2', 'af_1', 2, '# Worker v2');
    agentFile(db, 'af_2', 'agents_block', 'service', null);
    version(db, 'afv_3', 'af_2', 1, '# Block');
    agentFile(db, 'af_3', 'skill:docket-worker', 'project', 'RCP');
    version(db, 'afv_4', 'af_3', 1, '# Worker for RCP');
    run(db, "UPDATE agent_files SET bundled_hash_at_edit = ? WHERE id = 'af_3'", SHA);
    // A reverted layer: no current version, history kept.
    agentFile(db, 'af_4', 'agents_block', 'project', 'RCP');
    version(db, 'afv_5', 'af_4', 1, '# Old block');
    run(db, "UPDATE agent_files SET current_version_id = NULL WHERE id = 'af_4'");
    run(
      db,
      `INSERT INTO agent_file_proposals (id, project_key, file_key, content, reason,
         based_on_version_id, run_id, proposed_by, state, created_at, updated_at)
       VALUES ('afp_1', 'RCP', 'skill:docket-worker', '# Proposed', 'Clearer.', 'afv_4', 'run_1',
         'claude · orca-w3', 'pending', ?, ?)`,
      ts,
      ts,
    );
    run(
      db,
      `INSERT INTO onboarding_sessions (id, project_key, started_by, client, started_at, state,
         questions, created_at, updated_at)
       VALUES ('onb_1', 'RCP', 'claude', 'claude', ?, 'in_progress', '[]', ?, ?)`,
      ts,
      ts,
      ts,
    );
  });
  afterEach(() => {
    db.sqlite.close();
    tmp.cleanup();
  });

  it('migrates to current, and migrating again is a no-op', () => {
    migrateDb(db);
    expect(migrationStatus(db)).toEqual({ current: true, applied: 8, expected: 8 });
    migrateDb(db);
    expect(migrationStatus(db).applied).toBe(8);
  });

  it('keeps every agent file, version and reference; foreign_key_check is clean', () => {
    const queries = [
      'SELECT * FROM agent_files ORDER BY id',
      'SELECT * FROM agent_file_versions ORDER BY id',
      'SELECT * FROM agent_file_proposals ORDER BY id',
      'SELECT * FROM onboarding_sessions ORDER BY id',
      'SELECT * FROM projects ORDER BY key',
      'SELECT * FROM items ORDER BY id',
      'SELECT * FROM runs ORDER BY id',
    ];
    const before = queries.map((q) => all(db, q));
    migrateDb(db);
    expect(db.sqlite.pragma('foreign_key_check')).toEqual([]);
    expect(queries.map((q) => all(db, q))).toEqual(before);
    // The history still hangs off each file by ID.
    expect(
      all(
        db,
        `SELECT f.id, f.key, count(v.id) AS versions FROM agent_files f
           LEFT JOIN agent_file_versions v ON v.file_id = f.id GROUP BY f.id ORDER BY f.id`,
      ),
    ).toEqual([
      { id: 'af_1', key: 'skill:docket-worker', versions: 2 },
      { id: 'af_2', key: 'agents_block', versions: 1 },
      { id: 'af_3', key: 'skill:docket-worker', versions: 1 },
      { id: 'af_4', key: 'agents_block', versions: 1 },
    ]);
  });

  it('keeps the indexes, the cascades and the foreign keys working, and allows the guide', () => {
    migrateDb(db);
    expect(db.sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
    const indexes = (
      all(
        db,
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'agent_files'",
      ) as {
        name: string;
      }[]
    ).map((r) => r.name);
    expect(indexes).toEqual(
      expect.arrayContaining([
        'agent_files_key_layer',
        'agent_files_key_project',
        'agent_files_project',
      ]),
    );
    expect(() => agentFile(db, 'af_dup', 'skill:docket-worker', 'bundled', null)).toThrow(
      /UNIQUE constraint failed/,
    );
    expect(() => agentFile(db, 'af_nope', 'agents_block', 'project', 'NOPE')).toThrow(
      /FOREIGN KEY/,
    );
    agentFile(db, 'af_g', 'guide:onboarding', 'bundled', null);
    version(db, 'afv_g', 'af_g', 1, '# Guide');
    // A file's versions cascade with it; the project's layers cascade with the project.
    run(db, "DELETE FROM agent_files WHERE id = 'af_g'");
    expect(all(db, "SELECT id FROM agent_file_versions WHERE file_id = 'af_g'")).toEqual([]);
    run(db, "DELETE FROM agent_file_proposals WHERE project_key = 'RCP'");
    run(db, "DELETE FROM onboarding_sessions WHERE project_key = 'RCP'");
    run(db, "DELETE FROM runs WHERE item_id = 'RCP-1'");
    run(db, "DELETE FROM items WHERE project_key = 'RCP'");
    run(db, "DELETE FROM projects WHERE key = 'RCP'");
    expect(all(db, "SELECT id FROM agent_files WHERE project_key = 'RCP'")).toEqual([]);
    expect(db.sqlite.pragma('foreign_key_check')).toEqual([]);
  });
});

/**
 * Migration 0005_docket_rename (B28; the product was formerly Task Lite).
 *
 * On a database made by the migrations before B28 (0000–0004), with agent
 * setup, proposals, installs, reports and drift that use the old
 * `skill:tasklite-*` keys, it renames every stored key to `skill:docket-*`:
 * the agent file keeps its id, so its versions and history stay attached;
 * install manifests record where the old folders are (`installed_as`); and
 * migrating again changes nothing.
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
const SHA_B = 'b'.repeat(64);
const BEFORE = [
  '0000_init',
  '0001_search_fts',
  '0002_recovery',
  '0003_agent_setup',
  '0004_agent_proposals',
];
const OLD = 'skill:tasklite-worker';
const NEW = 'skill:docket-worker';

/** A migrations folder holding only the migrations shipped before B28. */
function beforeRename(dir: string): string {
  const src = migrationsFolder();
  const out = join(dir, 'migrations-before');
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
const one = <T>(db: Db, sql: string, ...params: unknown[]) =>
  db.sqlite.prepare(sql).get(...params) as T;
const all = (db: Db, sql: string) => db.sqlite.prepare(sql).all();

describe('0005_docket_rename on a database from before the rename', () => {
  let tmp: TempDir;
  let db: Db;

  beforeEach(() => {
    tmp = tempDir('docket-migrate-');
    db = openDb(join(tmp.dir, 'tasklite.db'));
    migrate(drizzle(db.sqlite), { migrationsFolder: beforeRename(tmp.dir) });
    expect(migrationStatus(db)).toMatchObject({ current: false, applied: 5 });
    insertProject(db, 'RCP');
    insertItem(db, { id: 'RCP-1' });
    run(
      db,
      `INSERT INTO runs (id, item_id, client, is_lead, state, last_signal_at, last_signal_kind,
         lease_expires_at, created_at, updated_at)
       VALUES ('run_1', 'RCP-1', 'codex', 1, 'open', ?, 'session', ?, ?, ?)`,
      ts,
      ts,
      ts,
      ts,
    );
    // The bundled default (two versions) and RCP's own copy of the old worker skill.
    for (const [id, layer, project] of [
      ['af_1', 'bundled', null],
      ['af_2', 'project', 'RCP'],
    ] as const) {
      run(
        db,
        `INSERT INTO agent_files (id, key, layer, project_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        id,
        OLD,
        layer,
        project,
        ts,
        ts,
      );
    }
    run(
      db,
      `INSERT INTO agent_files (id, key, layer, project_key, created_at, updated_at)
       VALUES ('af_3', 'agents_block', 'bundled', NULL, ?, ?)`,
      ts,
      ts,
    );
    for (const [id, file, n] of [
      ['afv_1', 'af_1', 1],
      ['afv_2', 'af_1', 2],
      ['afv_3', 'af_2', 1],
      ['afv_4', 'af_3', 1],
    ] as const) {
      run(
        db,
        `INSERT INTO agent_file_versions (id, file_id, version_no, content, sha256, author,
           created_at, updated_at)
         VALUES (?, ?, ?, '# Worker', ?, 'bundled', ?, ?)`,
        id,
        file,
        n,
        SHA,
        ts,
        ts,
      );
    }
    run(db, "UPDATE agent_files SET current_version_id = 'afv_2' WHERE id = 'af_1'");
    run(db, "UPDATE agent_files SET current_version_id = 'afv_3' WHERE id = 'af_2'");
    run(db, "UPDATE agent_files SET current_version_id = 'afv_4' WHERE id = 'af_3'");
    const manifest = {
      [OLD]: { version_id: 'afv_3', sha256: SHA },
      'skill:tasklite-planner': { version_id: 'afv_2', sha256: SHA_B },
      agents_block: { version_id: 'afv_4', sha256: SHA },
    };
    run(
      db,
      `INSERT INTO installs (id, at, client, target_kind, project_key, path, method, manifest,
         created_at, updated_at)
       VALUES ('ins_1', ?, 'claude', 'repo', 'RCP', '/host-code/recipes', 'push', ?, ?, ?)`,
      ts,
      JSON.stringify(manifest),
      ts,
      ts,
    );
    run(
      db,
      `INSERT INTO instruction_reports (id, source, run_id, install_id, project_key, location,
         files, at, created_at, updated_at)
       VALUES ('irp_1', 'agent', 'run_1', 'ins_1', 'RCP', '/w/rcp-1', ?, ?, ?, ?)`,
      JSON.stringify({
        [OLD]: { sha256: SHA_B, content: '# Edited' },
        agents_block: { sha256: SHA },
      }),
      ts,
      ts,
      ts,
    );
    run(
      db,
      `INSERT INTO drift (id, install_id, project_key, file_key, change, state, local_sha256,
         report_id, detected_at, created_at, updated_at)
       VALUES ('dft_1', 'ins_1', 'RCP', ?, 'edited', 'open', ?, 'irp_1', ?, ?, ?)`,
      OLD,
      SHA_B,
      ts,
      ts,
      ts,
    );
    run(
      db,
      `INSERT INTO agent_file_proposals (id, project_key, file_key, content, reason,
         based_on_version_id, run_id, proposed_by, state, created_at, updated_at)
       VALUES ('afp_1', 'RCP', ?, '# Worker v2', 'Run the linter first.', 'afv_3', 'run_1',
         'codex', 'pending', ?, ?)`,
      OLD,
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
    expect(migrationStatus(db)).toMatchObject({ current: true, applied: 18 });
    const after = ['agent_files', 'installs', 'instruction_reports', 'drift'].map((t) =>
      all(db, `SELECT * FROM ${t} ORDER BY id`),
    );
    migrateDb(db);
    expect(
      ['agent_files', 'installs', 'instruction_reports', 'drift'].map((t) =>
        all(db, `SELECT * FROM ${t} ORDER BY id`),
      ),
    ).toEqual(after);
    expect(db.sqlite.pragma('foreign_key_check')).toEqual([]);
  });

  it('renames the agent files and keeps their ids, versions and current version', () => {
    const versionsBefore = all(db, 'SELECT * FROM agent_file_versions ORDER BY id');
    migrateDb(db);
    expect(
      all(db, 'SELECT id, key, layer, current_version_id FROM agent_files ORDER BY id'),
    ).toEqual([
      { id: 'af_1', key: NEW, layer: 'bundled', current_version_id: 'afv_2' },
      { id: 'af_2', key: NEW, layer: 'project', current_version_id: 'afv_3' },
      { id: 'af_3', key: 'agents_block', layer: 'bundled', current_version_id: 'afv_4' },
    ]);
    expect(all(db, 'SELECT * FROM agent_file_versions ORDER BY id')).toEqual(versionsBefore);
  });

  it('renames proposal and drift keys', () => {
    migrateDb(db);
    expect(one(db, "SELECT file_key FROM agent_file_proposals WHERE id = 'afp_1'")).toEqual({
      file_key: NEW,
    });
    expect(one(db, "SELECT file_key, state FROM drift WHERE id = 'dft_1'")).toEqual({
      file_key: NEW,
      state: 'open',
    });
  });

  it('renames manifest keys and records where each old folder is', () => {
    migrateDb(db);
    const { manifest } = one<{ manifest: string }>(
      db,
      "SELECT manifest FROM installs WHERE id = 'ins_1'",
    );
    expect(JSON.parse(manifest)).toEqual({
      [NEW]: { version_id: 'afv_3', sha256: SHA, installed_as: 'tasklite-worker' },
      'skill:docket-planner': {
        version_id: 'afv_2',
        sha256: SHA_B,
        installed_as: 'tasklite-planner',
      },
      agents_block: { version_id: 'afv_4', sha256: SHA },
    });
  });

  it('renames instruction report keys, keeping the reported text', () => {
    migrateDb(db);
    const { files } = one<{ files: string }>(
      db,
      "SELECT files FROM instruction_reports WHERE id = 'irp_1'",
    );
    expect(JSON.parse(files)).toEqual({
      [NEW]: { sha256: SHA_B, content: '# Edited' },
      agents_block: { sha256: SHA },
    });
  });
});

/**
 * Migration 0003_agent_setup (tasks.md T150; BUILD_SPEC §4, §5.17; owner
 * decision 29).
 *
 * It must apply to a fresh database and to one created by the migrations on
 * `main` before B21 (0000–0002), with data in it. It only adds four tables,
 * so existing rows must come through untouched; the new tables' limits,
 * enums, uniqueness and cascades are enforced by the schema.
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
import {
  createTestDb,
  insertItem,
  insertProject,
  tempDir,
  type TempDir,
  without0010,
} from '../helpers.js';

const ts = '2026-11-17T00:00:00.000Z';
const SHA = 'a'.repeat(64);
const MAIN_ERA = ['0000_init', '0001_search_fts', '0002_recovery'];
const NEW_TABLES = ['agent_files', 'agent_file_versions', 'project_workflows', 'installs'];

/** A migrations folder holding only the migrations `main` shipped before B21. */
function mainEraMigrations(dir: string): string {
  const src = migrationsFolder();
  const out = join(dir, 'migrations-main');
  mkdirSync(join(out, 'meta'), { recursive: true });
  for (const tag of MAIN_ERA) copyFileSync(join(src, `${tag}.sql`), join(out, `${tag}.sql`));
  const journal = JSON.parse(readFileSync(join(src, 'meta', '_journal.json'), 'utf8')) as {
    entries: { tag: string }[];
  };
  journal.entries = journal.entries.filter((e) => MAIN_ERA.includes(e.tag));
  writeFileSync(join(out, 'meta', '_journal.json'), JSON.stringify(journal));
  return out;
}

const tables = (db: Db) =>
  (
    db.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
      name: string;
    }[]
  ).map((r) => r.name);
const columns = (db: Db, table: string) =>
  (db.sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
const run = (db: Db, sql: string, ...params: unknown[]) => db.sqlite.prepare(sql).run(...params);
const all = (db: Db, sql: string) => db.sqlite.prepare(sql).all();

// ---- Row helpers ----

function file(db: Db, id: string, key: string, layer: string, project: string | null = null) {
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
function version(db: Db, id: string, fileId: string, no: number, content = '# Skill\n') {
  run(
    db,
    `INSERT INTO agent_file_versions (id, file_id, version_no, content, sha256, author, note,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'system', NULL, ?, ?)`,
    id,
    fileId,
    no,
    content,
    SHA,
    ts,
    ts,
  );
  run(db, 'UPDATE agent_files SET current_version_id = ? WHERE id = ?', id, fileId);
}
function workflow(db: Db, project: string, no: number, content = '- Branch per item.') {
  run(
    db,
    `INSERT INTO project_workflows (id, project_key, version_no, content_md, author, note,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, 'owner', NULL, ?, ?)`,
    `wf_${project}_${no}`,
    project,
    no,
    content,
    ts,
    ts,
  );
}
function install(
  db: Db,
  id: string,
  fields: Partial<
    Record<'method' | 'path' | 'project_key' | 'token_sha256' | 'token_expires_at', string | null>
  > = {},
) {
  const row = {
    method: 'command',
    path: null,
    project_key: null,
    token_sha256: null,
    token_expires_at: null,
    ...fields,
  };
  run(
    db,
    `INSERT INTO installs (id, at, client, target_kind, project_key, path, method, manifest,
       token_sha256, token_expires_at, created_at, updated_at)
     VALUES (?, ?, 'claude', 'repo', ?, ?, ?, '{}', ?, ?, ?, ?)`,
    id,
    ts,
    row.project_key,
    row.path,
    row.method,
    row.token_sha256,
    row.token_expires_at,
    ts,
    ts,
  );
}

// ---- Fresh database ----

describe('0003_agent_setup on a fresh database', () => {
  let t: ReturnType<typeof createTestDb>;
  beforeEach(() => {
    t = createTestDb();
    insertProject(t.db, 'RCP');
    insertProject(t.db, 'DOC');
  });
  afterEach(() => t.cleanup());

  it('applies every migration, with foreign keys on and the check clean', () => {
    expect(migrationStatus(t.db)).toEqual({ current: true, applied: 13, expected: 13 });
    expect(t.db.sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(t.db.sqlite.pragma('foreign_key_check')).toEqual([]);
  });

  it('creates the four BUILD_SPEC §4 tables with their key columns', () => {
    expect(tables(t.db)).toEqual(expect.arrayContaining(NEW_TABLES));
    expect(columns(t.db, 'agent_files')).toEqual([
      'id',
      'key',
      'layer',
      'project_key',
      'current_version_id',
      'bundled_hash_at_edit',
      'created_at',
      'updated_at',
    ]);
    expect(columns(t.db, 'agent_file_versions')).toEqual(
      expect.arrayContaining(['file_id', 'version_no', 'content', 'sha256', 'author', 'note']),
    );
    expect(columns(t.db, 'project_workflows')).toEqual(
      expect.arrayContaining(['project_key', 'version_no', 'content_md', 'author', 'note']),
    );
    expect(columns(t.db, 'installs')).toEqual(
      expect.arrayContaining([
        'at',
        'client',
        'target_kind',
        'project_key',
        'path',
        'method',
        'manifest',
        'token_used_at',
        // B21 resolution: the token's hash and expiry, never the token.
        'token_sha256',
        'token_expires_at',
      ]),
    );
  });

  it('keeps one row per key, layer and project (bundled and service have no project)', () => {
    file(t.db, 'af_1', 'skill:docket-worker', 'bundled');
    file(t.db, 'af_2', 'skill:docket-worker', 'service');
    file(t.db, 'af_3', 'skill:docket-worker', 'project', 'RCP');
    file(t.db, 'af_4', 'skill:docket-worker', 'project', 'DOC');
    file(t.db, 'af_5', 'agents_block', 'bundled');
    expect(() => file(t.db, 'af_6', 'skill:docket-worker', 'service')).toThrow(/UNIQUE/);
    expect(() => file(t.db, 'af_7', 'skill:docket-worker', 'project', 'RCP')).toThrow(/UNIQUE/);
  });

  const badFiles: [name: string, key: string, layer: string, project: string | null][] = [
    ['an unknown layer', 'agents_block', 'owner', null],
    ['a project layer without a project', 'agents_block', 'project', null],
    ['a service layer with a project', 'agents_block', 'service', 'RCP'],
    ['a key that is neither a skill nor the block', 'readme', 'bundled', null],
    ['a skill key with capitals', 'skill:Worker', 'bundled', null],
    ['a skill key without a name', 'skill:', 'bundled', null],
    ['a skill name over 60', `skill:${'a'.repeat(61)}`, 'bundled', null],
  ];
  it.each(badFiles)('rejects %s', (_name, key, layer, project) => {
    expect(() => file(t.db, 'af_x', key, layer, project)).toThrow(/CHECK constraint failed/);
  });

  it('versions are numbered per file, ≤ 50,000 characters, and cascade with their file', () => {
    file(t.db, 'af_1', 'skill:docket-worker', 'bundled');
    version(t.db, 'afv_1', 'af_1', 1);
    version(t.db, 'afv_2', 'af_1', 2, 'x'.repeat(50_000));
    expect(() => version(t.db, 'afv_3', 'af_1', 2)).toThrow(/UNIQUE/);
    expect(() => version(t.db, 'afv_4', 'af_1', 3, 'x'.repeat(50_001))).toThrow(/CHECK/);
    expect(() => version(t.db, 'afv_5', 'af_1', 3, '')).toThrow(/CHECK/);
    expect(() => version(t.db, 'afv_6', 'af_1', 0)).toThrow(/CHECK/);
    run(t.db, "DELETE FROM agent_files WHERE id = 'af_1'");
    expect(all(t.db, 'SELECT id FROM agent_file_versions')).toEqual([]);
  });

  it('Workflow notes: versioned per project, ≤ 10,000 characters, may be empty', () => {
    workflow(t.db, 'RCP', 1);
    workflow(t.db, 'RCP', 2, '');
    workflow(t.db, 'DOC', 1, 'x'.repeat(10_000));
    expect(() => workflow(t.db, 'RCP', 2)).toThrow(/UNIQUE/);
    expect(() => workflow(t.db, 'RCP', 3, 'x'.repeat(10_001))).toThrow(/CHECK/);
    expect(() => workflow(t.db, 'ZZZ', 1)).toThrow(/FOREIGN KEY/);
  });

  it('installs: push needs a path and has no token; a token has an expiry and is unique', () => {
    install(t.db, 'ins_1');
    install(t.db, 'ins_2', { method: 'push', path: '/host-code/recipes' });
    install(t.db, 'ins_3', { token_sha256: SHA, token_expires_at: ts });
    expect(() => install(t.db, 'ins_4', { method: 'push' })).toThrow(/CHECK/);
    expect(() =>
      install(t.db, 'ins_5', {
        method: 'push',
        path: '/x',
        token_sha256: 'b'.repeat(64),
        token_expires_at: ts,
      }),
    ).toThrow(/CHECK/);
    expect(() => install(t.db, 'ins_6', { token_sha256: 'c'.repeat(64) })).toThrow(/CHECK/);
    expect(() => install(t.db, 'ins_7', { token_sha256: SHA, token_expires_at: ts })).toThrow(
      /UNIQUE/,
    );
    expect(() => install(t.db, 'ins_8', { path: 'x'.repeat(1_001) })).toThrow(/CHECK/);
  });

  it('deleting a project removes its overrides, versions, workflow notes and installs (§5.12)', () => {
    file(t.db, 'af_s', 'agents_block', 'service');
    version(t.db, 'afv_s', 'af_s', 1);
    file(t.db, 'af_p', 'agents_block', 'project', 'RCP');
    version(t.db, 'afv_p', 'af_p', 1);
    workflow(t.db, 'RCP', 1);
    install(t.db, 'ins_r', { project_key: 'RCP' });
    install(t.db, 'ins_s');
    run(t.db, "DELETE FROM projects WHERE key = 'RCP'");
    expect(all(t.db, 'SELECT id FROM agent_files')).toEqual([{ id: 'af_s' }]);
    expect(all(t.db, 'SELECT id FROM agent_file_versions')).toEqual([{ id: 'afv_s' }]);
    expect(all(t.db, 'SELECT id FROM project_workflows')).toEqual([]);
    expect(all(t.db, 'SELECT id FROM installs')).toEqual([{ id: 'ins_s' }]);
    expect(t.db.sqlite.pragma('foreign_key_check')).toEqual([]);
  });
});

// ---- A main-era database ----

describe('0003_agent_setup on a main-era database (0000–0002, with data)', () => {
  let tmp: TempDir;
  let db: Db;

  beforeEach(() => {
    tmp = tempDir('docket-migrate-');
    db = openDb(join(tmp.dir, 'docket.db'));
    // What main's migrateDb produced before B21: 0000 to 0002 only.
    migrate(drizzle(db.sqlite), { migrationsFolder: mainEraMigrations(tmp.dir) });
    expect(migrationStatus(db)).toEqual({ current: false, applied: 3, expected: 13 });
    for (const table of NEW_TABLES) expect(tables(db)).not.toContain(table);
    insertProject(db, 'RCP');
    insertItem(db, { id: 'RCP-1' });
    insertItem(db, { id: 'RCP-2' });
    run(
      db,
      `INSERT INTO runs (id, item_id, client, is_lead, state, last_signal_at, last_signal_kind,
         lease_expires_at, workspace, created_at, updated_at)
       VALUES ('run_1', 'RCP-1', 'claude', 1, 'parked', ?, 'session', ?, '{"path":"/w/rcp-1"}', ?, ?)`,
      ts,
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
    expect(migrationStatus(db)).toEqual({ current: true, applied: 13, expected: 13 });
    migrateDb(db);
    expect(migrationStatus(db).applied).toBe(13);
    expect(tables(db)).toEqual(expect.arrayContaining(NEW_TABLES));
  });

  it('keeps every existing row; foreign_key_check stays clean', () => {
    const before = {
      projects: all(
        db,
        'SELECT id, key, name, short_name, color, next_seq, default_satisfied_when, deleted_at, version, created_at, updated_at FROM projects',
      ),
      items: all(db, 'SELECT * FROM items ORDER BY id'),
      runs: all(db, 'SELECT * FROM runs'),
      search: all(db, 'SELECT rowid, * FROM search_fts ORDER BY rowid'),
    };
    migrateDb(db);
    expect(db.sqlite.pragma('foreign_key_check')).toEqual([]);
    expect(
      all(
        db,
        'SELECT id, key, name, short_name, color, next_seq, default_satisfied_when, deleted_at, version, created_at, updated_at FROM projects',
      ),
    ).toEqual(before.projects);
    expect(without0010(all(db, 'SELECT * FROM items ORDER BY id'))).toEqual(before.items);
    expect(all(db, 'SELECT * FROM runs')).toEqual(before.runs);
    expect(all(db, 'SELECT rowid, * FROM search_fts ORDER BY rowid')).toEqual(before.search);
  });

  it('the new tables work against the existing projects, and foreign keys are back on', () => {
    migrateDb(db);
    expect(db.sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
    workflow(db, 'RCP', 1);
    file(db, 'af_1', 'skill:docket-worker', 'project', 'RCP');
    version(db, 'afv_1', 'af_1', 1);
    install(db, 'ins_1', { project_key: 'RCP' });
    expect(() => file(db, 'af_2', 'agents_block', 'project', 'ZZZ')).toThrow(/FOREIGN KEY/);
    expect(db.sqlite.pragma('foreign_key_check')).toEqual([]);
  });
});

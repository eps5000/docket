/**
 * Migration 0002_recovery (tasks.md T050; BUILD_SPEC §4, §5.16).
 *
 * It must apply to a fresh database and to one created by the migrations
 * on `main` before B5 (0000 and 0001), with data in it. It rebuilds `runs`
 * and `documents`, which other tables reference, so this also proves that
 * the rebuild keeps every child row and its foreign key values (no ON DELETE
 * action fires) and that `PRAGMA foreign_key_check` stays clean.
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
import { createTestDb, insertItem, insertProject, tempDir, type TempDir } from '../helpers.js';

const ts = '2026-11-14T00:00:00.000Z';
const MAIN_ERA = ['0000_init', '0001_search_fts'];

/** A migrations folder holding only the migrations `main` shipped before B5. */
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

const columns = (db: Db, table: string) =>
  (db.sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);

const run = (db: Db, sql: string, ...params: unknown[]) => db.sqlite.prepare(sql).run(...params);
const all = (db: Db, sql: string) => db.sqlite.prepare(sql).all();

const RUN_COLUMNS = [
  'end_reason',
  'parked_reason',
  'waiting_on',
  'parked_at',
  'workspace',
  'orchestrator',
  'brief_document_version_id',
  'external',
  'unpushed_handled_at',
];

/** A main-era dataset touching every table that references `runs` or `documents`. */
function seedMainEra(db: Db): void {
  insertProject(db, 'RCP');
  insertItem(db, { id: 'RCP-1' });
  insertItem(db, { id: 'RCP-2' });
  const runRow = (id: string, item: string, state: string, lead: number, parent: string | null) =>
    run(
      db,
      `INSERT INTO runs (id, item_id, parent_run_id, client, label, session_id, is_lead, state,
         last_signal_at, last_signal_kind, lease_expires_at, summary, created_at, updated_at)
       VALUES (?, ?, ?, 'claude', 'orca-w1', 'sess_1', ?, ?, ?, 'session', ?, 'did it', ?, ?)`,
      id,
      item,
      parent,
      lead,
      state,
      ts,
      ts,
      ts,
      ts,
    );
  runRow('run_lead', 'RCP-1', 'open', 1, null);
  runRow('run_child', 'RCP-1', 'finished', 0, 'run_lead');
  runRow('run_old', 'RCP-2', 'interrupted', 1, null);
  run(
    db,
    `INSERT INTO questions (id, item_id, run_id, text, asked_by, created_at, updated_at)
     VALUES ('q_1', 'RCP-1', 'run_lead', 'Per serving?', 'claude', ?, ?)`,
    ts,
    ts,
  );
  run(
    db,
    `INSERT INTO subagent_logs (id, item_id, name, outcome, provenance, child_run_id,
       reported_by_run_id, created_at, updated_at)
     VALUES ('sl_1', 'RCP-1', 'tests', 'green', 'observed', 'run_child', 'run_lead', ?, ?)`,
    ts,
    ts,
  );
  run(
    db,
    `INSERT INTO commits (id, item_id, sha, branch, reported_by, reported_at, created_at, updated_at)
     VALUES ('cmt_1', 'RCP-1', '4be1c09', 'rcp-1', 'claude', ?, ?, ?)`,
    ts,
    ts,
    ts,
  );
  run(
    db,
    `INSERT INTO documents (id, project_key, item_id, name, kind, created_at, updated_at)
     VALUES ('doc_1', 'RCP', 'RCP-1', 'pantry-prd.md', 'planning', ?, ?)`,
    ts,
    ts,
  );
  run(
    db,
    `INSERT INTO document_versions (id, document_id, version_no, mime, size, sha256, path,
       created_by, created_at, updated_at)
     VALUES ('dv_1', 'doc_1', 1, 'text/markdown', 12, 'abc', 'docs/dv_1', 'claude', ?, ?)`,
    ts,
    ts,
  );
}

describe('0002_recovery on a fresh database', () => {
  let t: ReturnType<typeof createTestDb>;
  beforeEach(() => {
    t = createTestDb();
  });
  afterEach(() => t.cleanup());

  it('applies every migration through 0004, leaves foreign keys on and the check clean', () => {
    expect(migrationStatus(t.db)).toEqual({ current: true, applied: 30, expected: 30 });
    expect(t.db.sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(t.db.sqlite.pragma('foreign_key_check')).toEqual([]);
  });

  it('adds the recovery columns and the run_resources table', () => {
    expect(columns(t.db, 'runs')).toEqual(expect.arrayContaining(RUN_COLUMNS));
    expect(columns(t.db, 'commits')).toEqual(expect.arrayContaining(['run_id', 'pushed']));
    expect(columns(t.db, 'run_resources')).toEqual([
      'id',
      'run_id',
      'kind',
      'label',
      'locator',
      'started_at',
      'released_at',
      'released_by',
      'release_note',
      'created_at',
      'updated_at',
    ]);
  });
});

describe('0002_recovery on a main-era database', () => {
  let tmp: TempDir;
  let db: Db;

  beforeEach(() => {
    tmp = tempDir('docket-migrate-');
    db = openDb(join(tmp.dir, 'docket.db'));
    // Exactly what main's migrateDb did: foreign keys on, 0000 and 0001 only.
    migrate(drizzle(db.sqlite), { migrationsFolder: mainEraMigrations(tmp.dir) });
    expect(migrationStatus(db)).toEqual({ current: false, applied: 2, expected: 30 });
    expect(columns(db, 'runs')).not.toContain('workspace');
    seedMainEra(db);
  });
  afterEach(() => {
    db.sqlite.close();
    tmp.cleanup();
  });

  it('migrates to current, and migrating again is a no-op', () => {
    migrateDb(db);
    expect(migrationStatus(db)).toEqual({ current: true, applied: 30, expected: 30 });
    migrateDb(db);
    expect(migrationStatus(db).applied).toBe(30);
  });

  it('keeps every row and every foreign key value through the rebuild; foreign_key_check is clean', () => {
    const before = {
      runs: all(
        db,
        'SELECT id, item_id, parent_run_id, state, is_lead, summary FROM runs ORDER BY id',
      ),
      questions: all(db, 'SELECT id, run_id FROM questions'),
      subagent_logs: all(db, 'SELECT id, child_run_id, reported_by_run_id FROM subagent_logs'),
      documents: all(db, 'SELECT * FROM documents'),
      document_versions: all(db, 'SELECT id, document_id FROM document_versions'),
      commits: all(db, 'SELECT id, item_id, sha FROM commits'),
    };
    migrateDb(db);
    expect(db.sqlite.pragma('foreign_key_check')).toEqual([]);
    expect(
      all(db, 'SELECT id, item_id, parent_run_id, state, is_lead, summary FROM runs ORDER BY id'),
    ).toEqual(before.runs);
    // ON DELETE SET NULL / CASCADE did not fire when the old tables were dropped.
    expect(all(db, 'SELECT id, run_id FROM questions')).toEqual(before.questions);
    expect(all(db, 'SELECT id, child_run_id, reported_by_run_id FROM subagent_logs')).toEqual(
      before.subagent_logs,
    );
    expect(all(db, 'SELECT * FROM documents')).toEqual(before.documents);
    expect(all(db, 'SELECT id, document_id FROM document_versions')).toEqual(
      before.document_versions,
    );
    expect(all(db, 'SELECT id, item_id, sha FROM commits')).toEqual(before.commits);
  });

  it('gives existing rows null recovery fields and unpushed commits', () => {
    migrateDb(db);
    const runRow = db.sqlite.prepare("SELECT * FROM runs WHERE id = 'run_old'").get() as Record<
      string,
      unknown
    >;
    for (const c of RUN_COLUMNS) expect(runRow[c], c).toBeNull();
    expect(
      db.sqlite.prepare("SELECT run_id, pushed FROM commits WHERE id = 'cmt_1'").get(),
    ).toEqual({
      run_id: null,
      pushed: 0,
    });
  });

  it('keeps the references to runs and documents working after the rename', () => {
    migrateDb(db);
    // A child row pointing at a missing run is still rejected…
    expect(() =>
      run(
        db,
        `INSERT INTO questions (id, item_id, run_id, text, asked_by, created_at, updated_at)
         VALUES ('q_2', 'RCP-2', 'run_missing', 'x', 'claude', ?, ?)`,
        ts,
        ts,
      ),
    ).toThrow(/FOREIGN KEY constraint failed/);
    // …and deleting a run still nulls its references, as before.
    run(db, "DELETE FROM runs WHERE id = 'run_child'");
    expect(
      db.sqlite.prepare("SELECT child_run_id FROM subagent_logs WHERE id = 'sl_1'").get(),
    ).toEqual({
      child_run_id: null,
    });
    run(db, "DELETE FROM documents WHERE id = 'doc_1'");
    expect(all(db, 'SELECT id FROM document_versions')).toEqual([]);
  });

  it('turns foreign keys back on afterwards', () => {
    migrateDb(db);
    expect(db.sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
  });
});

/**
 * Migration 0006_onboarding (tasks.md T163; BUILD_SPEC §4, §5.20; owner
 * decision 31).
 *
 * It must apply to a fresh database and to one created by the migrations on
 * current `main` before B29 (0000–0005), with data in it. It only adds a
 * table (`onboarding_sessions`) and a nullable column (`projects.created_by`),
 * so existing rows come through untouched, with `created_by` null; the new
 * table's states, limits, one-in-progress rule and cascades are enforced by
 * the schema.
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

const ts = '2026-11-18T00:00:00.000Z';
const later = '2026-11-18T01:00:00.000Z';
const SHA = 'a'.repeat(64);
const MAIN_ERA = [
  '0000_init',
  '0001_search_fts',
  '0002_recovery',
  '0003_agent_setup',
  '0004_agent_proposals',
  '0005_docket_rename',
];

/** A migrations folder holding only the migrations `main` shipped before B29. */
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

function leadRun(db: Db, id: string, item: string) {
  run(
    db,
    `INSERT INTO runs (id, item_id, client, is_lead, state, last_signal_at, last_signal_kind,
       lease_expires_at, created_at, updated_at)
     VALUES (?, ?, 'claude', 1, 'open', ?, 'session', ?, ?, ?)`,
    id,
    item,
    ts,
    ts,
    ts,
    ts,
  );
}

type SessionRow = {
  project_key: string;
  run_id: string | null;
  state: string;
  summary: string | null;
  questions: string;
  finished_at: string | null;
  reviewed_at: string | null;
};
function session(db: Db, id: string, fields: Partial<SessionRow> = {}) {
  const row: SessionRow = {
    project_key: 'RCP',
    run_id: null,
    state: 'in_progress',
    summary: null,
    questions: '[]',
    finished_at: null,
    reviewed_at: null,
    ...fields,
  };
  run(
    db,
    `INSERT INTO onboarding_sessions (id, project_key, started_by, client, run_id, started_at,
       state, summary, questions, finished_at, reviewed_at, created_at, updated_at)
     VALUES (?, ?, 'claude · orca-w3', 'claude', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    row.project_key,
    row.run_id,
    ts,
    row.state,
    row.summary,
    row.questions,
    row.finished_at,
    row.reviewed_at,
    ts,
    ts,
  );
}
const finished = { state: 'ready_for_review', summary: 'Created 12 items.', finished_at: later };
const reviewed = { ...finished, state: 'reviewed', reviewed_at: later };

describe('0006_onboarding on a fresh database', () => {
  let t: ReturnType<typeof createTestDb>;
  beforeEach(() => {
    t = createTestDb();
    insertProject(t.db, 'RCP');
    insertProject(t.db, 'GF');
    insertItem(t.db, { id: 'RCP-1' });
    leadRun(t.db, 'run_1', 'RCP-1');
  });
  afterEach(() => t.cleanup());

  it('applies every migration, with foreign keys on and the check clean', () => {
    expect(migrationStatus(t.db)).toEqual({ current: true, applied: 15, expected: 15 });
    expect(t.db.sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(t.db.sqlite.pragma('foreign_key_check')).toEqual([]);
    expect(tables(t.db)).toContain('onboarding_sessions');
    expect(columns(t.db, 'onboarding_sessions')).toEqual([
      'id',
      'project_key',
      'started_by',
      'client',
      'run_id',
      'started_at',
      'state',
      'summary',
      'questions',
      'finished_at',
      'reviewed_at',
      'created_at',
      'updated_at',
    ]);
    expect(columns(t.db, 'projects')).toContain('created_by');
  });

  it('projects.created_by is nullable: null for the owner, an agent name for onboard_project', () => {
    expect(all(t.db, "SELECT created_by FROM projects WHERE key = 'RCP'")).toEqual([
      { created_by: null },
    ]);
    run(t.db, "UPDATE projects SET created_by = 'claude · orca-w3' WHERE key = 'GF'");
    expect(all(t.db, "SELECT created_by FROM projects WHERE key = 'GF'")).toEqual([
      { created_by: 'claude · orca-w3' },
    ]);
  });

  it('accepts each state with its matching fields, and questions as a JSON array', () => {
    session(t.db, 'onb_1', { run_id: 'run_1' });
    session(t.db, 'onb_2', {
      ...finished,
      questions: JSON.stringify(['Is the editor in scope?']),
    });
    session(t.db, 'onb_3', reviewed);
    expect(all(t.db, 'SELECT id, state FROM onboarding_sessions ORDER BY id')).toEqual([
      { id: 'onb_1', state: 'in_progress' },
      { id: 'onb_2', state: 'ready_for_review' },
      { id: 'onb_3', state: 'reviewed' },
    ]);
  });

  it('rejects a bad state, and finished or reviewed times that disagree with the state', () => {
    const bad: Partial<SessionRow>[] = [
      { state: 'done' },
      // In progress: no summary, no finished_at, no reviewed_at.
      { summary: 'early' },
      { finished_at: later },
      { reviewed_at: later },
      // Ready for review: a summary and finished_at, no reviewed_at.
      { ...finished, summary: null },
      { ...finished, summary: '' },
      { ...finished, summary: 'x'.repeat(4_001) },
      { ...finished, finished_at: null },
      { ...finished, reviewed_at: later },
      // Reviewed: reviewed_at too.
      { ...reviewed, reviewed_at: null },
    ];
    bad.forEach((fields, i) => {
      expect(() => session(t.db, `onb_bad${i}`, fields), JSON.stringify(fields)).toThrow(
        /CHECK constraint failed/,
      );
    });
    session(t.db, 'onb_ok', { ...finished, summary: 'x'.repeat(4_000) });
  });

  it('questions must be a JSON array of at most 20', () => {
    const q = (n: number) => JSON.stringify(Array.from({ length: n }, (_, i) => `Q${i}`));
    session(t.db, 'onb_20', { ...finished, questions: q(20) });
    for (const questions of [q(21), '{"a":1}', 'not json', '"text"']) {
      expect(() => session(t.db, `onb_${questions.length}`, { ...finished, questions })).toThrow(
        /CHECK constraint failed/,
      );
    }
  });

  it('allows one session in progress per project, and any number finished', () => {
    session(t.db, 'onb_1');
    expect(() => session(t.db, 'onb_2')).toThrow(/UNIQUE constraint failed/);
    session(t.db, 'onb_3', { project_key: 'GF' });
    session(t.db, 'onb_4', finished);
    session(t.db, 'onb_5', reviewed);
    run(
      t.db,
      "UPDATE onboarding_sessions SET state = 'ready_for_review', summary = 'Done.', finished_at = ? WHERE id = 'onb_1'",
      later,
    );
    session(t.db, 'onb_6');
  });

  it('cascades with its project, and its run_id becomes null when the run goes', () => {
    session(t.db, 'onb_1', { run_id: 'run_1' });
    session(t.db, 'onb_2', { project_key: 'GF' });
    run(t.db, "DELETE FROM runs WHERE id = 'run_1'");
    expect(all(t.db, "SELECT run_id FROM onboarding_sessions WHERE id = 'onb_1'")).toEqual([
      { run_id: null },
    ]);
    run(t.db, "DELETE FROM projects WHERE key = 'GF'");
    expect(all(t.db, 'SELECT id FROM onboarding_sessions')).toEqual([{ id: 'onb_1' }]);
    expect(() => session(t.db, 'onb_3', { project_key: 'XYZ' })).toThrow(/FOREIGN KEY/);
    expect(t.db.sqlite.pragma('foreign_key_check')).toEqual([]);
  });
});

describe('0006_onboarding on a main-era database (0000–0005, with data)', () => {
  let tmp: TempDir;
  let db: Db;

  beforeEach(() => {
    tmp = tempDir('docket-migrate-');
    db = openDb(join(tmp.dir, 'docket.db'));
    // What current main's migrateDb produced before B29: 0000 to 0005.
    migrate(drizzle(db.sqlite), { migrationsFolder: mainEraMigrations(tmp.dir) });
    expect(migrationStatus(db)).toEqual({ current: false, applied: 6, expected: 15 });
    expect(tables(db)).not.toContain('onboarding_sessions');
    expect(columns(db, 'projects')).not.toContain('created_by');
    insertProject(db, 'RCP');
    insertProject(db, 'ABC');
    insertItem(db, { id: 'RCP-1' });
    insertItem(db, { id: 'ABC-1' });
    run(db, "UPDATE items SET jira_key = 'ABC-1', imported = 1 WHERE id = 'ABC-1'");
    leadRun(db, 'run_1', 'RCP-1');
    run(
      db,
      `INSERT INTO agent_files (id, key, layer, project_key, created_at, updated_at)
       VALUES ('af_1', 'skill:docket-worker', 'project', 'RCP', ?, ?)`,
      ts,
      ts,
    );
    run(
      db,
      `INSERT INTO agent_file_versions (id, file_id, version_no, content, sha256, author,
         created_at, updated_at)
       VALUES ('afv_1', 'af_1', 1, '# Worker', ?, 'owner', ?, ?)`,
      SHA,
      ts,
      ts,
    );
    run(db, "UPDATE agent_files SET current_version_id = 'afv_1' WHERE id = 'af_1'");
    run(
      db,
      `INSERT INTO agent_file_proposals (id, project_key, file_key, content, reason,
         based_on_version_id, run_id, proposed_by, state, created_at, updated_at)
       VALUES ('afp_1', 'RCP', 'workflow', '- Branch per item.', 'First notes.', NULL, 'run_1',
         'claude · orca-w3', 'pending', ?, ?)`,
      ts,
      ts,
    );
    // A deleted project's tombstone, which keeps its key.
    run(db, "UPDATE projects SET deleted_at = ? WHERE key = 'ABC'", ts);
  });
  afterEach(() => {
    db.sqlite.close();
    tmp.cleanup();
  });

  it('migrates to current, and migrating again is a no-op', () => {
    migrateDb(db);
    expect(migrationStatus(db)).toEqual({ current: true, applied: 15, expected: 15 });
    migrateDb(db);
    expect(migrationStatus(db).applied).toBe(15);
    expect(tables(db)).toContain('onboarding_sessions');
    expect(columns(db, 'projects')).toContain('created_by');
  });

  it('keeps every existing row, with created_by null on existing projects; foreign_key_check stays clean', () => {
    const queries = [
      'SELECT * FROM items ORDER BY id',
      'SELECT * FROM runs',
      'SELECT * FROM agent_files',
      'SELECT * FROM agent_file_versions',
      'SELECT * FROM agent_file_proposals',
      'SELECT rowid, * FROM search_fts ORDER BY rowid',
    ];
    const before = queries.map((q) => all(db, q));
    const projectsBefore = all(db, 'SELECT * FROM projects ORDER BY key') as object[];
    migrateDb(db);
    expect(db.sqlite.pragma('foreign_key_check')).toEqual([]);
    expect(queries.map((q) => without0010(all(db, q)))).toEqual(before);
    expect(without0010(all(db, 'SELECT * FROM projects ORDER BY key'))).toEqual(
      projectsBefore.map((p) => ({ ...p, created_by: null })),
    );
  });

  it('the new table works against the existing projects and runs', () => {
    migrateDb(db);
    expect(db.sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
    session(db, 'onb_1', { run_id: 'run_1' });
    expect(() => session(db, 'onb_2')).toThrow(/UNIQUE constraint failed/);
    session(db, 'onb_3', { project_key: 'ABC', ...finished });
    expect(() => session(db, 'onb_4', { project_key: 'NOPE' })).toThrow(/FOREIGN KEY/);
    expect(db.sqlite.pragma('foreign_key_check')).toEqual([]);
  });
});

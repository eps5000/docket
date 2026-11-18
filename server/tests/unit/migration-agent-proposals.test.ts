/**
 * Migration 0004_agent_proposals (tasks.md T159; BUILD_SPEC §4, §5.19; owner
 * decision 30).
 *
 * It must apply to a fresh database and to one created by the migrations on
 * `main` before B26 (0000–0003), with data in it, agent setup rows included.
 * It only adds three tables (`agent_file_proposals`, `instruction_reports`,
 * `drift`), so existing rows must come through untouched; the new tables'
 * limits, enums, uniqueness and cascades are enforced by the schema.
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

const ts = '2026-11-18T00:00:00.000Z';
const SHA = 'a'.repeat(64);
const MAIN_ERA = ['0000_init', '0001_search_fts', '0002_recovery', '0003_agent_setup'];
const NEW_TABLES = ['agent_file_proposals', 'instruction_reports', 'drift'];

/** A migrations folder holding only the migrations `main` shipped before B26. */
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

function leadRun(db: Db, id: string, item: string) {
  run(
    db,
    `INSERT INTO runs (id, item_id, client, is_lead, state, last_signal_at, last_signal_kind,
       lease_expires_at, created_at, updated_at)
     VALUES (?, ?, 'codex', 1, 'open', ?, 'session', ?, ?, ?)`,
    id,
    item,
    ts,
    ts,
    ts,
    ts,
  );
}

function install(db: Db, id: string, project: string | null = 'RCP') {
  run(
    db,
    `INSERT INTO installs (id, at, client, target_kind, project_key, path, method, manifest,
       created_at, updated_at)
     VALUES (?, ?, 'claude', 'repo', ?, '/host-code/recipes', 'push', '{}', ?, ?)`,
    id,
    ts,
    project,
    ts,
    ts,
  );
}

type ProposalRow = {
  project_key: string | null;
  file_key: string;
  content: string;
  reason: string;
  based_on_version_id: string | null;
  run_id: string | null;
  state: string;
  decided_at: string | null;
  decided_note: string | null;
};
function proposal(db: Db, id: string, fields: Partial<ProposalRow> = {}) {
  const row: ProposalRow = {
    project_key: 'RCP',
    file_key: 'skill:tasklite-worker',
    content: '# Worker\n',
    reason: 'Run the linter before each commit.',
    based_on_version_id: 'afv_1',
    run_id: null,
    state: 'pending',
    decided_at: null,
    decided_note: null,
    ...fields,
  };
  run(
    db,
    `INSERT INTO agent_file_proposals (id, project_key, file_key, content, reason,
       based_on_version_id, run_id, proposed_by, state, decided_at, decided_note,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'codex · orca-w3', ?, ?, ?, ?, ?)`,
    id,
    row.project_key,
    row.file_key,
    row.content,
    row.reason,
    row.based_on_version_id,
    row.run_id,
    row.state,
    row.decided_at,
    row.decided_note,
    ts,
    ts,
  );
}

type ReportRow = {
  source: string;
  run_id: string | null;
  install_id: string | null;
  project_key: string | null;
  location: string | null;
};
function report(db: Db, id: string, fields: Partial<ReportRow> = {}) {
  const row: ReportRow = {
    source: 'agent',
    run_id: 'run_1',
    install_id: 'ins_1',
    project_key: 'RCP',
    location: '/w/rcp-1',
    ...fields,
  };
  run(
    db,
    `INSERT INTO instruction_reports (id, source, run_id, install_id, project_key, location, files,
       at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    row.source,
    row.run_id,
    row.install_id,
    row.project_key,
    row.location,
    JSON.stringify({ agents_block: { sha256: SHA } }),
    ts,
    ts,
    ts,
  );
}

type DriftRow = {
  install_id: string;
  project_key: string | null;
  file_key: string;
  change: string;
  state: string;
  local_sha256: string | null;
  report_id: string | null;
  resolved_at: string | null;
};
function drift(db: Db, id: string, fields: Partial<DriftRow> = {}) {
  const row: DriftRow = {
    install_id: 'ins_1',
    project_key: 'RCP',
    file_key: 'skill:tasklite-worker',
    change: 'edited',
    state: 'open',
    local_sha256: SHA,
    report_id: null,
    resolved_at: null,
    ...fields,
  };
  run(
    db,
    `INSERT INTO drift (id, install_id, project_key, file_key, change, state, local_sha256,
       report_id, detected_at, resolved_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    row.install_id,
    row.project_key,
    row.file_key,
    row.change,
    row.state,
    row.local_sha256,
    row.report_id,
    ts,
    row.resolved_at,
    ts,
    ts,
  );
}

// ---- Fresh database ----

describe('0004_agent_proposals on a fresh database', () => {
  let t: ReturnType<typeof createTestDb>;
  beforeEach(() => {
    t = createTestDb();
    insertProject(t.db, 'RCP');
    insertProject(t.db, 'DOC');
    insertItem(t.db, { id: 'RCP-1' });
    leadRun(t.db, 'run_1', 'RCP-1');
    install(t.db, 'ins_1');
  });
  afterEach(() => t.cleanup());

  it('applies every migration, with foreign keys on and the check clean', () => {
    expect(migrationStatus(t.db)).toEqual({ current: true, applied: 5, expected: 5 });
    expect(t.db.sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(t.db.sqlite.pragma('foreign_key_check')).toEqual([]);
  });

  it('creates the three BUILD_SPEC §4 tables with their key columns', () => {
    expect(tables(t.db)).toEqual(expect.arrayContaining(NEW_TABLES));
    expect(columns(t.db, 'agent_file_proposals')).toEqual(
      expect.arrayContaining([
        'id',
        'project_key',
        'file_key',
        'content',
        'reason',
        'based_on_version_id',
        'run_id',
        'proposed_by',
        'state',
        'decided_at',
        'decided_note',
        'result_version_id',
      ]),
    );
    expect(columns(t.db, 'instruction_reports')).toEqual(
      expect.arrayContaining([
        'id',
        'source',
        'run_id',
        'install_id',
        'project_key',
        'location',
        'files',
        'at',
      ]),
    );
    expect(columns(t.db, 'drift')).toEqual(
      expect.arrayContaining([
        'id',
        'install_id',
        'project_key',
        'file_key',
        'state',
        'local_sha256',
        'detected_at',
        'resolved_at',
        // B26 resolution 7: how it differs, and the report that found it.
        'change',
        'report_id',
      ]),
    );
  });

  it('proposals: to a project or the default, every target key, pending by default', () => {
    proposal(t.db, 'afp_1');
    proposal(t.db, 'afp_2', { project_key: null, file_key: 'agents_block' });
    proposal(t.db, 'afp_3', { file_key: 'workflow', content: '', based_on_version_id: null });
    proposal(t.db, 'afp_4', { file_key: 'workflow', content: 'x'.repeat(10_000) });
    proposal(t.db, 'afp_5', { content: 'x'.repeat(50_000) });
    proposal(t.db, 'afp_6', { run_id: 'run_1' });
    proposal(t.db, 'afp_7', { state: 'declined', decided_at: ts, decided_note: 'Not now.' });
    // More than one pending proposal per file and project (the 5-per-file limit is B27's rule).
    proposal(t.db, 'afp_8');
    expect(
      all(t.db, "SELECT count(*) AS n FROM agent_file_proposals WHERE state = 'pending'"),
    ).toEqual([{ n: 7 }]);
  });

  const badProposals: [name: string, fields: Partial<ProposalRow>][] = [
    ['an unknown state', { state: 'withdrawn' }],
    ['a key that is no file', { file_key: 'readme' }],
    ['a skill key with capitals', { file_key: 'skill:Worker' }],
    ['Workflow notes without a project', { file_key: 'workflow', project_key: null }],
    ['Workflow notes over 10,000', { file_key: 'workflow', content: 'x'.repeat(10_001) }],
    ['an empty skill', { content: '' }],
    ['a skill over 50,000', { content: 'x'.repeat(50_001) }],
    ['an empty reason', { reason: '' }],
    ['a reason over 500', { reason: 'r'.repeat(501) }],
    [
      'a decision note over 500',
      { state: 'declined', decided_at: ts, decided_note: 'n'.repeat(501) },
    ],
    ['a decided proposal without decided_at', { state: 'approved' }],
    ['a pending proposal with decided_at', { decided_at: ts }],
  ];
  it.each(badProposals)('rejects a proposal with %s', (_name, fields) => {
    expect(() => proposal(t.db, 'afp_x', fields)).toThrow(/CHECK constraint failed/);
  });

  it('a proposal keeps its run as null when the run goes; its project takes it along', () => {
    proposal(t.db, 'afp_1', { run_id: 'run_1' });
    run(t.db, "DELETE FROM runs WHERE id = 'run_1'");
    expect(all(t.db, 'SELECT id, run_id FROM agent_file_proposals')).toEqual([
      { id: 'afp_1', run_id: null },
    ]);
    expect(() => proposal(t.db, 'afp_2', { project_key: 'ZZZ' })).toThrow(/FOREIGN KEY/);
    expect(() => proposal(t.db, 'afp_3', { run_id: 'run_nope' })).toThrow(/FOREIGN KEY/);
  });

  it('instruction reports: an agent report needs its run; a push check may have none', () => {
    report(t.db, 'irp_1');
    report(t.db, 'irp_2', { source: 'push_check', run_id: null });
    report(t.db, 'irp_3', { install_id: null, location: null });
    report(t.db, 'irp_4', { source: 'push_check', run_id: null, project_key: null });
    expect(() => report(t.db, 'irp_5', { run_id: null })).toThrow(/CHECK/);
    expect(() => report(t.db, 'irp_6', { source: 'owner' })).toThrow(/CHECK/);
    expect(() => report(t.db, 'irp_7', { location: 'x'.repeat(1_001) })).toThrow(/CHECK/);
    expect(() => report(t.db, 'irp_8', { location: '' })).toThrow(/CHECK/);
    expect(() => report(t.db, 'irp_9', { install_id: 'ins_nope' })).toThrow(/FOREIGN KEY/);
  });

  it('drift: one open row per install and file; resolved rows stay as history', () => {
    report(t.db, 'irp_1');
    drift(t.db, 'dft_1', { report_id: 'irp_1' });
    drift(t.db, 'dft_2', { file_key: 'agents_block', change: 'missing', local_sha256: null });
    drift(t.db, 'dft_3', { file_key: 'skill:my-extra', change: 'extra' });
    expect(() => drift(t.db, 'dft_4')).toThrow(/UNIQUE/);
    run(t.db, "UPDATE drift SET state = 'kept_local', resolved_at = ? WHERE id = 'dft_1'", ts);
    drift(t.db, 'dft_5');
    drift(t.db, 'dft_6', { state: 'adopted', resolved_at: ts });
    drift(t.db, 'dft_7', { state: 'restored', resolved_at: ts });
    // A user-wide install has no project.
    install(t.db, 'ins_2', null);
    drift(t.db, 'dft_8', { install_id: 'ins_2', project_key: null });
    expect(all(t.db, "SELECT id FROM drift WHERE state = 'open' ORDER BY id")).toEqual([
      { id: 'dft_2' },
      { id: 'dft_3' },
      { id: 'dft_5' },
      { id: 'dft_8' },
    ]);
  });

  const badDrift: [name: string, fields: Partial<DriftRow>][] = [
    ['an unknown state', { state: 'ignored' }],
    ['an unknown change', { change: 'renamed' }],
    ['a workflow key (never installed)', { file_key: 'workflow' }],
    ['a missing file with a hash', { change: 'missing' }],
    ['an edited file without a hash', { local_sha256: null }],
    ['a hash that is not 64 characters', { local_sha256: 'abc' }],
    ['an open row with resolved_at', { resolved_at: ts }],
    ['a resolved row without resolved_at', { state: 'adopted' }],
  ];
  it.each(badDrift)('rejects a drift row with %s', (_name, fields) => {
    expect(() => drift(t.db, 'dft_x', fields)).toThrow(/CHECK constraint failed/);
  });

  it('drift needs a real install; deleting the install or the report behaves', () => {
    report(t.db, 'irp_1');
    drift(t.db, 'dft_1', { report_id: 'irp_1' });
    expect(() => drift(t.db, 'dft_2', { install_id: 'ins_nope' })).toThrow(/FOREIGN KEY/);
    run(t.db, "DELETE FROM instruction_reports WHERE id = 'irp_1'");
    expect(all(t.db, 'SELECT report_id FROM drift')).toEqual([{ report_id: null }]);
    report(t.db, 'irp_2');
    run(t.db, "DELETE FROM installs WHERE id = 'ins_1'");
    expect(all(t.db, 'SELECT id FROM drift')).toEqual([]);
    expect(all(t.db, 'SELECT id, install_id FROM instruction_reports')).toEqual([
      { id: 'irp_2', install_id: null },
    ]);
  });

  it("deleting a project removes its proposals, reports and drift, and keeps the default's (§5.12)", () => {
    proposal(t.db, 'afp_r');
    proposal(t.db, 'afp_d', { project_key: null });
    report(t.db, 'irp_r');
    drift(t.db, 'dft_r');
    run(t.db, "DELETE FROM projects WHERE key = 'RCP'");
    expect(all(t.db, 'SELECT id FROM agent_file_proposals')).toEqual([{ id: 'afp_d' }]);
    expect(all(t.db, 'SELECT id FROM instruction_reports')).toEqual([]);
    expect(all(t.db, 'SELECT id FROM drift')).toEqual([]);
    expect(t.db.sqlite.pragma('foreign_key_check')).toEqual([]);
  });
});

// ---- A main-era database ----

describe('0004_agent_proposals on a main-era database (0000–0003, with data)', () => {
  let tmp: TempDir;
  let db: Db;

  beforeEach(() => {
    tmp = tempDir('docket-migrate-');
    db = openDb(join(tmp.dir, 'docket.db'));
    // What main's migrateDb produced before B26: 0000 to 0003 only.
    migrate(drizzle(db.sqlite), { migrationsFolder: mainEraMigrations(tmp.dir) });
    expect(migrationStatus(db)).toEqual({ current: false, applied: 4, expected: 5 });
    for (const table of NEW_TABLES) expect(tables(db)).not.toContain(table);
    insertProject(db, 'RCP');
    insertItem(db, { id: 'RCP-1' });
    insertItem(db, { id: 'RCP-2' });
    leadRun(db, 'run_1', 'RCP-1');
    // Agent setup rows from decision 29, which the new tables point at.
    run(
      db,
      `INSERT INTO agent_files (id, key, layer, project_key, created_at, updated_at)
       VALUES ('af_1', 'skill:tasklite-worker', 'project', 'RCP', ?, ?)`,
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
      `INSERT INTO project_workflows (id, project_key, version_no, content_md, author,
         created_at, updated_at)
       VALUES ('wf_1', 'RCP', 1, '- Branch per item.', 'owner', ?, ?)`,
      ts,
      ts,
    );
    install(db, 'ins_1');
  });
  afterEach(() => {
    db.sqlite.close();
    tmp.cleanup();
  });

  it('migrates to current, and migrating again is a no-op', () => {
    migrateDb(db);
    expect(migrationStatus(db)).toEqual({ current: true, applied: 5, expected: 5 });
    migrateDb(db);
    expect(migrationStatus(db).applied).toBe(5);
    expect(tables(db)).toEqual(expect.arrayContaining(NEW_TABLES));
  });

  it('keeps every existing row; foreign_key_check stays clean', () => {
    const queries = [
      'SELECT * FROM projects',
      'SELECT * FROM items ORDER BY id',
      'SELECT * FROM runs',
      'SELECT * FROM agent_files',
      'SELECT * FROM agent_file_versions',
      'SELECT * FROM project_workflows',
      'SELECT * FROM installs',
      'SELECT rowid, * FROM search_fts ORDER BY rowid',
    ];
    const before = queries.map((q) => all(db, q));
    migrateDb(db);
    expect(db.sqlite.pragma('foreign_key_check')).toEqual([]);
    expect(queries.map((q) => all(db, q))).toEqual(before);
  });

  it('the new tables work against the existing projects, runs and installs', () => {
    migrateDb(db);
    expect(db.sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
    proposal(db, 'afp_1', { run_id: 'run_1' });
    proposal(db, 'afp_2', { file_key: 'workflow', based_on_version_id: 'wf_1' });
    report(db, 'irp_1');
    drift(db, 'dft_1', { report_id: 'irp_1' });
    expect(() => drift(db, 'dft_2', { install_id: 'ins_nope' })).toThrow(/FOREIGN KEY/);
    expect(db.sqlite.pragma('foreign_key_check')).toEqual([]);
  });
});

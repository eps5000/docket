import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateDb, openDb, type Db } from '../src/db/client.js';

/** A clock tests can move. */
export class TestClock {
  constructor(public current = new Date('2026-11-14T12:00:00.000Z')) {}
  now = (): Date => new Date(this.current.getTime());
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export interface TempDir {
  dir: string;
  cleanup(): void;
}

export function tempDir(prefix = 'docket-test-'): TempDir {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export interface TestDb extends TempDir {
  db: Db;
}

/** A fresh, migrated database in its own temporary directory. */
export function createTestDb(): TestDb {
  const tmp = tempDir('docket-db-');
  const db = openDb(join(tmp.dir, 'docket.db'));
  migrateDb(db);
  return {
    db,
    dir: tmp.dir,
    cleanup: () => {
      db.sqlite.close();
      tmp.cleanup();
    },
  };
}

const T0 = '2026-11-14T11:00:00.000Z';

/** Insert a project row directly (test fixture only; production writes go through the write path). */
export function insertProject(db: Db, key = 'RCP'): void {
  db.sqlite
    .prepare(
      `INSERT INTO projects (id, key, name, short_name, color, next_seq, default_satisfied_when, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, '#3b5bdb', 1, 'done', 1, ?, ?)`,
    )
    .run(`prj_${key}`, key, `Project ${key}`, key, T0, T0);
}

/** Insert an item row directly (test fixture only). */
export function insertItem(
  db: Db,
  item: { id: string; project?: string; title?: string; status?: string },
): void {
  db.sqlite
    .prepare(
      `INSERT INTO items (id, project_key, type, title, description_md, outcome_md, status, priority, imported, version, created_at, updated_at)
       VALUES (?, ?, 'Task', ?, '', '', ?, 2, 0, 1, ?, ?)`,
    )
    .run(
      item.id,
      item.project ?? item.id.split('-')[0],
      item.title ?? `Item ${item.id}`,
      item.status ?? 'ready',
      T0,
      T0,
    );
}

export interface ItemRow {
  id: string;
  title: string;
  status: string;
  version: number;
  updated_at: string;
}

export function getItem(db: Db, id: string): ItemRow | undefined {
  return db.sqlite
    .prepare('SELECT id, title, status, version, updated_at FROM items WHERE id = ?')
    .get(id) as ItemRow | undefined;
}

export interface EventRowDb {
  seq: number;
  at: string;
  actor_kind: string;
  client: string | null;
  label: string | null;
  run_id: string | null;
  project_key: string | null;
  item_id: string | null;
  type: string;
  summary: string;
  data: string | null;
  inverse: string | null;
  mutation_id: string;
  idempotency_key: string | null;
}

export function allEvents(db: Db): EventRowDb[] {
  return db.sqlite.prepare('SELECT * FROM events ORDER BY seq').all() as EventRowDb[];
}

export function count(db: Db, table: string): number {
  return (db.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
}

/**
 * Columns migrations 0010_shared_changes (B38), 0011_radar_branches (B40) and
 * 0012_item_branches (B41) add to existing tables, at their defaults. Older migration tests migrate to the latest schema, so they compare
 * rows without these; 0010's own test checks them.
 */
export const COLUMNS_0010 = [
  'shared_none_at',
  'repo_path',
  'main_branch',
  'radar_last_run_at',
  'radar_off_reason',
  'changed_files',
  'branch',
  'held_undeclared',
  // 0011_radar_branches (B40) adds these to items.
  'branch_by',
  'branch_at',
  'radar_branch',
  'radar_branch_matches',
  // 0012_item_branches (B41) adds the reported branches to items.
  'branches',
  // 0015 (decision 39): the project's Overlap handling override.
  'overlap_handling',
  // 0018 (decision 42): the project's registered coordinators.
  'coordinators',
  // 0019 (B52): how long the last radar run took.
  'radar_last_duration_ms',
] as const;

/** Rows without the columns 0010 added to `items`, `projects` and `packets`. */
export function without0010<T>(rows: T): T {
  if (!Array.isArray(rows)) return rows;
  return rows.map((row: unknown) => {
    if (row === null || typeof row !== 'object') return row;
    const out = { ...(row as Record<string, unknown>) };
    // commits.branch and runs have their own `branch`-free shapes; only drop 0010's on its tables.
    if ('shared_none_at' in out || 'main_branch' in out || 'held_undeclared' in out) {
      for (const c of COLUMNS_0010) delete out[c];
    }
    // Decision 41 (0017): two more columns on runs, null on every row from before it.
    if ('unpushed_handled_at' in out) {
      delete out.unpushed_outcome;
      delete out.worktree_check;
      delete out.restart_deadline_at;
      // Decision 42 (0018): null on every row from before it.
      delete out.producer;
      delete out.producer_hold_until;
      delete out.status_update;
      delete out.park_activity;
      // Decision 44 (0020): null on every row from before it.
      delete out.coordinator_park;
    }
    return out;
  }) as T;
}

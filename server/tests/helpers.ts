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

export function tempDir(prefix = 'tasklite-test-'): TempDir {
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

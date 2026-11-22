/**
 * Migration 0014_project_decision_review (B44; owner decision 38; BUILD_SPEC
 * §4, §5.14): `decision_records` gains `acknowledged_at` (nullable) and
 * `review_grouped` (NOT NULL DEFAULT 0), and the migration sets
 * `review_grouped` for every active agent record of project scope, so Needs
 * you shows the records from before decision 38 as one grouped card. It is
 * additive and forward-only: on a copy of a database created by 0000–0013
 * every other column comes through unchanged, and the original file is
 * untouched.
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

const ts = '2026-11-20T00:00:00.000Z';

/** A migrations folder holding only 0000–0013 (`main` before B44). */
function beforeB44(dir: string): string {
  const src = migrationsFolder();
  const out = join(dir, 'migrations-b43');
  mkdirSync(join(out, 'meta'), { recursive: true });
  const journal = JSON.parse(readFileSync(join(src, 'meta', '_journal.json'), 'utf8')) as {
    entries: { tag: string; idx: number }[];
  };
  journal.entries = journal.entries.filter((e) => e.idx <= 13);
  for (const e of journal.entries)
    copyFileSync(join(src, `${e.tag}.sql`), join(out, `${e.tag}.sql`));
  writeFileSync(join(out, 'meta', '_journal.json'), JSON.stringify(journal));
  return out;
}

const run = (db: Db, sql: string, ...params: unknown[]) => db.sqlite.prepare(sql).run(...params);

function decision(
  db: Db,
  id: string,
  scope: 'project' | 'item',
  authority: 'agent' | 'owner',
  status = 'active',
) {
  run(
    db,
    `INSERT INTO decision_records (id, project_key, scope_kind, scope_id, title, decision_md, rationale_md,
       authority, author, status, version, created_at, updated_at)
     VALUES (?, 'RCP', ?, ?, ?, 'Text.', NULL, ?, ?, ?, 1, ?, ?)`,
    id,
    scope,
    scope === 'project' ? null : 'RCP-1',
    `Title ${id}`,
    authority,
    authority === 'owner' ? 'owner' : 'claude',
    status,
    ts,
    ts,
  );
}

const records = (db: Db) =>
  db.sqlite.prepare('SELECT * FROM decision_records ORDER BY id').all() as Record<
    string,
    unknown
  >[];

describe('0014_project_decision_review', () => {
  let tmp: TempDir;
  beforeEach(() => {
    tmp = tempDir('docket-migrate-');
  });
  afterEach(() => {
    tmp.cleanup();
  });

  it('adds the columns and groups the existing agent project records', () => {
    const original = join(tmp.dir, 'docket.db');
    const db = openDb(original);
    let before: Record<string, unknown>[];
    try {
      migrate(drizzle(db.sqlite), { migrationsFolder: beforeB44(tmp.dir) });
      insertProject(db, 'RCP');
      insertItem(db, { id: 'RCP-1' });
      decision(db, 'dec_a', 'project', 'agent'); // grouped
      decision(db, 'dec_b', 'project', 'agent', 'withdrawn'); // inactive: not grouped
      decision(db, 'dec_c', 'project', 'owner'); // owner: not grouped
      decision(db, 'dec_d', 'item', 'agent'); // item scope: not grouped
      before = records(db);
      expect(Object.keys(before[0]!)).not.toContain('review_grouped');
    } finally {
      db.sqlite.close();
    }

    const copy = join(tmp.dir, 'docket-copy.db');
    copyFileSync(original, copy);
    const migrated = openDb(copy);
    try {
      migrateDb(migrated);
      expect(migrationStatus(migrated)).toEqual({ current: true, applied: 19, expected: 19 });
      const after = records(migrated);
      expect(after).toEqual(
        before.map((row) => ({
          ...row,
          acknowledged_at: null,
          review_grouped: row.id === 'dec_a' ? 1 : 0,
        })),
      );
      expect(migrated.sqlite.pragma('foreign_key_check')).toEqual([]);
      const cols = migrated.sqlite.pragma('table_info(decision_records)') as {
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
      }[];
      const col = (name: string) => cols.find((c) => c.name === name)!;
      expect(col('acknowledged_at')).toMatchObject({ type: 'TEXT', notnull: 0, dflt_value: null });
      expect(col('review_grouped')).toMatchObject({ type: 'INTEGER', notnull: 1 });
      // A record written after the migration defaults to its own card.
      decision(migrated, 'dec_e', 'project', 'agent');
      expect(
        migrated.sqlite
          .prepare("SELECT review_grouped FROM decision_records WHERE id = 'dec_e'")
          .get(),
      ).toEqual({ review_grouped: 0 });

      // Migrating again is a no-op.
      migrateDb(migrated);
      expect(migrationStatus(migrated).applied).toBe(19);
    } finally {
      migrated.sqlite.close();
    }

    const untouched = openDb(original);
    try {
      expect(records(untouched)).toEqual(before);
    } finally {
      untouched.sqlite.close();
    }
  });
});

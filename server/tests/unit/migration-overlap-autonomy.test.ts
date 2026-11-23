/**
 * Migration 0015_overlap_autonomy (B46; owner decision 39; BUILD_SPEC §5.21):
 * additive and forward-only. On a copy of a database created by 0000–0014,
 * declarations read as bare parts, decided overlaps stay decided, projects
 * follow the default, and every existing column comes through unchanged.
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrateDb, migrationsFolder, migrationStatus, openDb } from '../../src/db/client.js';
import { overlapHandling } from '../../src/domain/overlap-policy.js';
import { insertItem, insertProject, tempDir, type TempDir } from '../helpers.js';

const ts = '2026-11-20T00:00:00.000Z';

/** A migrations folder holding only 0000–0014 (`main` before B46). */
function beforeB46(dir: string): string {
  const src = migrationsFolder();
  const out = join(dir, 'migrations-b45');
  mkdirSync(join(out, 'meta'), { recursive: true });
  const journal = JSON.parse(readFileSync(join(src, 'meta', '_journal.json'), 'utf8')) as {
    entries: { tag: string; idx: number }[];
  };
  journal.entries = journal.entries.filter((e) => e.idx <= 14);
  for (const e of journal.entries)
    copyFileSync(join(src, `${e.tag}.sql`), join(out, `${e.tag}.sql`));
  writeFileSync(join(out, 'meta', '_journal.json'), JSON.stringify(journal));
  return out;
}

describe('0015_overlap_autonomy', () => {
  let tmp: TempDir;
  beforeEach(() => {
    tmp = tempDir('docket-migrate-');
  });
  afterEach(() => {
    tmp.cleanup();
  });

  it('keeps declarations as bare parts and decided overlaps decided', () => {
    const original = join(tmp.dir, 'docket.db');
    const db = openDb(original);
    let overlapsBefore: Record<string, unknown>[];
    let changesBefore: Record<string, unknown>[];
    try {
      migrate(drizzle(db.sqlite), { migrationsFolder: beforeB46(tmp.dir) });
      insertProject(db, 'RCP');
      for (const id of ['RCP-1', 'RCP-2', 'RCP-3', 'RCP-4']) insertItem(db, { id });
      db.sqlite
        .prepare(
          `INSERT INTO item_shared_changes (id, item_id, part_key, change, note, declared_by,
             declared_at, created_at, updated_at)
           VALUES ('isc_1', 'RCP-1', 'model:Token', 'change', 'n', 'claude', ?, ?, ?)`,
        )
        .run(ts, ts, ts);
      const overlap = db.sqlite.prepare(
        `INSERT INTO part_overlaps (id, project_key, item_a, item_b, claimed_first, parts, state,
           raised_at, decided_by, decided_at, version, created_at, updated_at)
         VALUES (?, 'RCP', ?, ?, ?, '["model:Token"]', ?, ?, ?, ?, 1, ?, ?)`,
      );
      overlap.run('pov_c', 'RCP-1', 'RCP-2', 'RCP-1', 'compatible', ts, 'owner', ts, ts, ts);
      overlap.run('pov_o', 'RCP-3', 'RCP-4', 'RCP-3', 'open', ts, null, null, ts, ts);
      overlapsBefore = db.sqlite.prepare('SELECT * FROM part_overlaps ORDER BY id').all() as never;
      changesBefore = db.sqlite.prepare('SELECT * FROM item_shared_changes').all() as never;
    } finally {
      db.sqlite.close();
    }

    const copy = join(tmp.dir, 'copy.db');
    copyFileSync(original, copy);
    const migrated = openDb(copy);
    try {
      migrateDb(migrated);
      expect(migrationStatus(migrated)).toEqual({ current: true, applied: 25, expected: 25 });

      const overlaps = migrated.sqlite
        .prepare('SELECT * FROM part_overlaps ORDER BY id')
        .all() as Record<string, unknown>[];
      overlaps.forEach((row, i) => {
        expect(row).toEqual({ ...overlapsBefore[i], outcome: null, reason: null, evidence: null });
      });

      expect(migrated.sqlite.prepare('SELECT * FROM item_shared_changes').all()).toEqual([
        {
          ...changesBefore[0],
          member: null,
          design_impact: 'none',
          design_note: null,
          disputed: 0,
        },
      ]);

      // The owner's design reviews start empty: nothing existing asks for one.
      expect(migrated.sqlite.prepare('SELECT count(*) AS n FROM design_reviews').get()).toEqual({
        n: 0,
      });

      // Existing projects get the default.
      expect(
        migrated.sqlite.prepare('SELECT overlap_handling FROM projects WHERE key = ?').get('RCP'),
      ).toEqual({ overlap_handling: null });
      expect(overlapHandling(migrated, 'RCP')).toBe('agents_resolve');
    } finally {
      migrated.sqlite.close();
    }

    // The original file is untouched.
    const still = openDb(original);
    try {
      expect(
        (still.sqlite.prepare('PRAGMA table_info(part_overlaps)').all() as { name: string }[]).map(
          (c) => c.name,
        ),
      ).not.toContain('outcome');
    } finally {
      still.sqlite.close();
    }
  });
});

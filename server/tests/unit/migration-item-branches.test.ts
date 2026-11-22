/**
 * Migration 0012_item_branches (B41; owner decision 36; BUILD_SPEC §5.21 B41):
 * a nullable JSON column, `items.branches`, holding an item's reported
 * branches. On a copy of a database created by 0000–0011 and populated with
 * every kind of B40 report (the item's own report or clear, a packet's, a
 * lead run's, a claim's), each item's B40 reported branch — the newest of
 * them, the item's own winning a tie — moves into the set, a newest clear
 * leaves it empty, and every other column is unchanged.
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

const T1 = '2026-11-19T10:00:00.000Z';
const T2 = '2026-11-19T11:00:00.000Z';
const T3 = '2026-11-19T12:00:00.000Z';

/** A migrations folder holding only 0000–0011 (`main` after B40). */
function beforeB41(dir: string): string {
  const src = migrationsFolder();
  const out = join(dir, 'migrations-b40');
  mkdirSync(join(out, 'meta'), { recursive: true });
  const journal = JSON.parse(readFileSync(join(src, 'meta', '_journal.json'), 'utf8')) as {
    entries: { idx: number; tag: string }[];
  };
  journal.entries = journal.entries.filter((e) => e.idx <= 11);
  for (const { tag } of journal.entries) {
    copyFileSync(join(src, `${tag}.sql`), join(out, `${tag}.sql`));
  }
  writeFileSync(join(out, 'meta', '_journal.json'), JSON.stringify(journal));
  return out;
}

const run = (db: Db, sql: string, ...params: unknown[]) => db.sqlite.prepare(sql).run(...params);

function claim(db: Db, item: string, branch: string, at: string, label: string | null) {
  run(
    db,
    `INSERT INTO events (at, actor_kind, client, label, item_id, project_key, type, summary, data, mutation_id)
     VALUES (?, 'agent', 'claude', ?, ?, 'GF', 'claim.granted', 'claimed', ?, ?)`,
    at,
    label,
    item,
    JSON.stringify({ branch }),
    `mut_${item}_${at}`,
  );
}

function packet(db: Db, item: string, round: number, branch: string, at: string) {
  run(
    db,
    `INSERT INTO packets (id, item_id, round, content_hash, created_by, state, branch, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'codex · w2', ?, ?, 1, ?, ?)`,
    `pkt_${item}_${round}`,
    item,
    round,
    `hash_${item}_${round}`,
    round === 1 ? 'decided' : 'open',
    branch,
    at,
    at,
  );
}

function leadRun(db: Db, item: string, branch: string, at: string) {
  run(
    db,
    `INSERT INTO runs (id, item_id, client, label, is_lead, state, last_signal_at, last_signal_kind,
       workspace, version, created_at, updated_at)
     VALUES (?, ?, 'claude', 'w1', 1, 'open', ?, 'session', ?, 1, ?, ?)`,
    `run_${item}`,
    item,
    at,
    JSON.stringify({ path: '/w', branch }),
    at,
    at,
  );
}

function report(db: Db, item: string, branch: string | null, at: string) {
  run(
    db,
    'UPDATE items SET branch = ?, branch_by = ?, branch_at = ? WHERE id = ?',
    branch,
    'owner',
    at,
    item,
  );
}

/** One item per B40 source, and the precedence cases. */
function populate(db: Db) {
  insertProject(db, 'GF');
  for (let i = 1; i <= 7; i++) insertItem(db, { id: `GF-${i}`, status: 'progress' });
  report(db, 'GF-1', 'gf-1-owner', T1); // the item's own report
  claim(db, 'GF-2', 'gf-2-claim', T1, 'w3'); // a claim, then a newer packet: the packet
  packet(db, 'GF-2', 1, 'gf-2-old', T1);
  packet(db, 'GF-2', 2, 'gf-2-packet', T2);
  claim(db, 'GF-3', 'gf-3-claim', T1, null); // a claim, then the owner cleared it: none
  report(db, 'GF-3', null, T3);
  leadRun(db, 'GF-4', 'gf-4-run', T2); // a lead run's workspace branch
  // GF-5 has no branch at all.
  claim(db, 'GF-6', 'gf-6-claim', T2, 'w3'); // a tie: the item's own report wins
  report(db, 'GF-6', 'gf-6-owner', T2);
  claim(db, 'GF-7', 'gf-7-claim', T3, null); // a claim newer than the owner's report
  report(db, 'GF-7', 'gf-7-owner', T1);
}

describe('0012_item_branches', () => {
  let tmp: TempDir;
  beforeEach(() => {
    tmp = tempDir('docket-migrate-');
  });
  afterEach(() => {
    tmp.cleanup();
  });

  it('moves each item’s B40 reported branch into items.branches, leaving every other column as it was', () => {
    const file = join(tmp.dir, 'docket.db');
    const db = openDb(file);
    let before: Record<string, unknown>[];
    try {
      migrate(drizzle(db.sqlite), { migrationsFolder: beforeB41(tmp.dir) });
      populate(db);
      before = db.sqlite.prepare('SELECT * FROM items ORDER BY id').all() as Record<
        string,
        unknown
      >[];
      expect(Object.keys(before[0]!)).not.toContain('branches');
    } finally {
      db.sqlite.close();
    }
    const copy = join(tmp.dir, 'copy.db');
    copyFileSync(file, copy);
    const migrated = openDb(copy);
    try {
      migrateDb(migrated);
      expect(migrationStatus(migrated)).toEqual({ current: true, applied: 19, expected: 19 });
      const after = migrated.sqlite.prepare('SELECT * FROM items ORDER BY id').all() as Record<
        string,
        unknown
      >[];
      // Every other column is unchanged.
      expect(after.map(({ branches: _, ...row }) => row)).toEqual(before);
      const sets = Object.fromEntries(
        after.map((r) => [r.id, r.branches === null ? null : JSON.parse(r.branches as string)]),
      );
      expect(sets).toEqual({
        'GF-1': [{ name: 'gf-1-owner', by: 'owner', at: T1 }],
        'GF-2': [{ name: 'gf-2-packet', by: 'codex · w2', at: T2 }],
        'GF-3': null,
        'GF-4': [{ name: 'gf-4-run', by: 'claude · w1', at: T2 }],
        'GF-5': null,
        'GF-6': [{ name: 'gf-6-owner', by: 'owner', at: T2 }],
        'GF-7': [{ name: 'gf-7-claim', by: 'claude', at: T3 }],
      });
      expect(migrated.sqlite.pragma('foreign_key_check')).toEqual([]);
      // Migrating again is a no-op.
      migrateDb(migrated);
      expect(migrationStatus(migrated).applied).toBe(19);
    } finally {
      migrated.sqlite.close();
    }
  });
});

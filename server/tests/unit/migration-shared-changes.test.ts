/**
 * Migration 0010_shared_changes (B38; owner decision 36; BUILD_SPEC §4,
 * §5.21): six new tables and nullable or defaulted columns on `items`,
 * `packets` and `projects`. It is additive and forward-only, so this proves,
 * on a copy of a database created by 0000–0009 and populated with projects,
 * items in every open status, a link, a run and a packet, that every existing
 * row comes through unchanged (reading as not declared, no changed files, the
 * radar off on `main`), that the new tables enforce their rules, and that the
 * original file is untouched.
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
  before0032,
  insertItem,
  insertProject,
  tempDir,
  without0010,
  type TempDir,
} from '../helpers.js';

const ts = '2026-11-19T00:00:00.000Z';
const BEFORE = [
  '0000_init',
  '0001_search_fts',
  '0002_recovery',
  '0003_agent_setup',
  '0004_agent_proposals',
  '0005_docket_rename',
  '0006_onboarding',
  '0007_onboarding_guide_key',
  '0008_connection_drift_key',
  '0009_step_details',
];

/** A migrations folder holding only 0000–0009 (`main` before B38). */
function beforeB38(dir: string): string {
  const src = migrationsFolder();
  const out = join(dir, 'migrations-b37');
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
const all = (db: Db, table: string) =>
  db.sqlite.prepare(`SELECT * FROM ${table} ORDER BY 1`).all() as Record<string, unknown>[];

/** A populated pre-B38 database: two projects, items in each open status, a link, a run, a packet. */
function populate(db: Db) {
  insertProject(db, 'GF');
  insertProject(db, 'RCP');
  const statuses = ['inbox', 'planning', 'ready', 'progress', 'review', 'done'];
  statuses.forEach((status, i) => insertItem(db, { id: `GF-${i + 1}`, status }));
  insertItem(db, { id: 'RCP-1', status: 'progress' });
  run(
    db,
    `INSERT INTO links (id, from_id, to_id, type, satisfied_when, created_by, version, created_at, updated_at)
     VALUES ('lnk_1', 'GF-4', 'GF-3', 'blocks', 'merged', 'owner', 1, ?, ?)`,
    ts,
    ts,
  );
  run(
    db,
    `INSERT INTO runs (id, item_id, client, label, is_lead, state, last_signal_at, last_signal_kind,
       version, created_at, updated_at)
     VALUES ('run_1', 'GF-4', 'claude', 'w1', 1, 'open', ?, 'session', 1, ?, ?)`,
    ts,
    ts,
    ts,
  );
  run(
    db,
    `INSERT INTO packets (id, item_id, round, content_hash, built_from_commit, estimate, how, checked,
       gaps, created_by, state, version, created_at, updated_at)
     VALUES ('pkt_1', 'GF-5', 1, 'abcd', '4be1c09', '5 min', '["Open it"]', '[]', '[]', 'claude',
       'open', 1, ?, ?)`,
    ts,
    ts,
  );
}

const EXISTING = ['projects', 'items', 'links', 'runs', 'packets'];
const NEW_TABLES = [
  'item_shared_changes',
  'part_leases',
  'part_overlaps',
  'radar_findings',
  'shared_parts',
  'undeclared_holds',
];

describe('0010_shared_changes', () => {
  let tmp: TempDir;
  beforeEach(() => {
    tmp = tempDir('docket-migrate-');
  });
  afterEach(() => {
    tmp.cleanup();
  });

  it('adds the tables and columns on a copy of a populated database, leaving every row as it was', () => {
    const original = join(tmp.dir, 'docket.db');
    const db = openDb(original);
    let before: Record<string, Record<string, unknown>[]>;
    try {
      migrate(drizzle(db.sqlite), { migrationsFolder: beforeB38(tmp.dir) });
      populate(db);
      before = Object.fromEntries(EXISTING.map((t) => [t, all(db, t)]));
      expect(Object.keys(before.items![0]!)).not.toContain('shared_none_at');
    } finally {
      db.sqlite.close();
    }

    const copy = join(tmp.dir, 'docket-copy.db');
    copyFileSync(original, copy);
    const migrated = openDb(copy);
    try {
      migrateDb(migrated);
      expect(migrationStatus(migrated)).toEqual({ current: true, applied: 34, expected: 34 });

      // Every existing row is unchanged, plus the new columns at their defaults (0032, decision
      // 67, made the Tasks Implementation, inferred: before0032 undoes that).
      expect(all(migrated, 'items').map(before0032)).toEqual(
        // 0011_radar_branches (B40) adds the reported and discovered branch columns.
        before.items!.map((r) => ({
          ...r,
          shared_none_at: null,
          branch: null,
          branch_by: null,
          branch_at: null,
          radar_branch: null,
          radar_branch_matches: null,
          // 0012_item_branches (B41): no B40 branch to move, so none.
          branches: null,
          // 0023 (decision 48): not split from anything.
          split_from: null,
          // 0028 (decision 58): no known gaps.
          known_gaps: null,
          // 0030 (decision 64): no finish line marked.
          finish_line: null,
          // 0031 (decision 65): nobody asked for shaping.
          shaping: null,
        })),
      );
      expect(all(migrated, 'packets')).toEqual(
        before.packets!.map((r) => ({
          ...r,
          changed_files: null,
          branch: null,
          held_undeclared: null,
          criteria_changed_at: null,
        })),
      );
      expect(all(migrated, 'projects')).toEqual(
        before.projects!.map((r) => ({
          ...r,
          repo_path: null,
          main_branch: 'main',
          radar_last_run_at: null,
          radar_off_reason: null,
          radar_last_duration_ms: null,
          overlap_handling: null,
          coordinators: null,
        })),
      );
      expect(all(migrated, 'links')).toEqual(before.links);
      expect(without0010(all(migrated, 'runs'))).toEqual(before.runs);
      expect(migrated.sqlite.pragma('foreign_key_check')).toEqual([]);
      for (const t of NEW_TABLES) expect(all(migrated, t), t).toEqual([]);

      // The registry: one key per project, kind-prefixed, paths a JSON array.
      const part = (id: string, project: string, key: string, kind: string, paths = '[]') =>
        run(
          migrated,
          `INSERT INTO shared_parts (id, project_key, key, kind, paths, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'owner', ?, ?)`,
          id,
          project,
          key,
          kind,
          paths,
          ts,
          ts,
        );
      part('spt_1', 'GF', 'model:Token', 'model', '["src/Token.cs"]');
      part('spt_2', 'RCP', 'model:Token', 'model');
      expect(() => part('spt_3', 'GF', 'model:Token', 'model')).toThrow(/UNIQUE/);
      expect(() => part('spt_4', 'GF', 'table:decks', 'model')).toThrow(/shared_parts_key/);
      expect(() => part('spt_5', 'GF', 'model:', 'model')).toThrow(/shared_parts_key/);
      expect(() => part('spt_6', 'GF', 'class:Token', 'class')).toThrow(/shared_parts_kind/);
      expect(() => part('spt_7', 'GF', 'table:x', 'table', '{"a":1}')).toThrow(
        /shared_parts_paths/,
      );
      expect(
        migrated.sqlite.prepare("SELECT single_writer FROM shared_parts WHERE id = 'spt_1'").get(),
      ).toEqual({ single_writer: 0 });

      // Declarations: one row per item and part.
      const declare = (id: string, item: string, key: string, change = 'change') =>
        run(
          migrated,
          `INSERT INTO item_shared_changes (id, item_id, part_key, change, declared_by, declared_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'claude', ?, ?, ?)`,
          id,
          item,
          key,
          change,
          ts,
          ts,
          ts,
        );
      declare('isc_1', 'GF-3', 'model:Token');
      declare('isc_2', 'GF-4', 'model:Token');
      expect(() => declare('isc_3', 'GF-3', 'model:Token')).toThrow(/UNIQUE/);
      expect(() => declare('isc_4', 'GF-2', 'model:Token', 'rename')).toThrow(
        /item_shared_changes_change/,
      );

      // Overlaps: the pair in ID order, one live row per pair, decided states need a time.
      const overlap = (
        id: string,
        a: string,
        b: string,
        state = 'open',
        decided: string | null = null,
      ) =>
        run(
          migrated,
          `INSERT INTO part_overlaps (id, project_key, item_a, item_b, claimed_first, parts, state,
             raised_at, decided_at, created_at, updated_at)
           VALUES (?, 'GF', ?, ?, ?, '["model:Token"]', ?, ?, ?, ?, ?)`,
          id,
          a,
          b,
          b,
          state,
          ts,
          decided,
          ts,
          ts,
        );
      overlap('pov_1', 'GF-3', 'GF-4');
      expect(() => overlap('pov_2', 'GF-3', 'GF-4')).toThrow(/UNIQUE/);
      expect(() => overlap('pov_3', 'GF-4', 'GF-3')).toThrow(/part_overlaps_order/);
      expect(() => overlap('pov_4', 'GF-2', 'GF-5', 'compatible')).toThrow(/part_overlaps_decided/);
      overlap('pov_5', 'GF-2', 'GF-5', 'compatible', ts);
      run(migrated, "UPDATE part_overlaps SET state = 'resolved' WHERE id = 'pov_1'");
      overlap('pov_6', 'GF-3', 'GF-4'); // a resolved pair may overlap again

      // Leases: one live lease per part; an ended lease has a reason.
      const lease = (id: string, ended: string | null = null, reason: string | null = null) =>
        run(
          migrated,
          `INSERT INTO part_leases (id, project_key, part_key, item_id, run_id, taken_at, expires_at,
             ended_at, end_reason, created_at, updated_at)
           VALUES (?, 'GF', 'model:Token', 'GF-4', 'run_1', ?, ?, ?, ?, ?, ?)`,
          id,
          ts,
          ts,
          ended,
          reason,
          ts,
          ts,
        );
      lease('pls_1');
      expect(() => lease('pls_2')).toThrow(/UNIQUE/);
      expect(() => lease('pls_3', ts, null)).toThrow(/part_leases_ended/);
      lease('pls_4', ts, 'released');

      // Holds: one open per item; decided holds carry a time.
      const hold = (id: string, item: string, state = 'open', decided: string | null = null) =>
        run(
          migrated,
          `INSERT INTO undeclared_holds (id, item_id, packet_id, via, parts, files, state, decided_at,
             created_at, updated_at)
           VALUES (?, ?, 'pkt_1', 'submit_packet', '["table:decks"]', '["db/0003.sql"]', ?, ?, ?, ?)`,
          id,
          item,
          state,
          decided,
          ts,
          ts,
        );
      hold('udh_1', 'GF-5');
      expect(() => hold('udh_2', 'GF-5')).toThrow(/UNIQUE/);
      expect(() => hold('udh_3', 'GF-4', 'added')).toThrow(/undeclared_holds_decided/);
      hold('udh_4', 'GF-4', 'sent_back', ts);

      // Radar findings: one open finding per branch pair.
      const finding = (id: string, a: string, b: string) =>
        run(
          migrated,
          `INSERT INTO radar_findings (id, project_key, branch_a, branch_b, item_a, item_b, files,
             seen_at, created_at, updated_at)
           VALUES (?, 'GF', ?, ?, 'GF-4', NULL, '["src/Token.cs"]', ?, ?, ?)`,
          id,
          a,
          b,
          ts,
          ts,
          ts,
        );
      finding('rdf_1', 'gf-4-token', 'main');
      expect(() => finding('rdf_2', 'gf-4-token', 'main')).toThrow(/UNIQUE/);
      expect(() => finding('rdf_3', 'main', 'main')).toThrow(/radar_findings_branches/);

      // Deleting an item cascades to its declarations, overlaps, leases, holds and findings.
      run(migrated, "DELETE FROM items WHERE id = 'GF-4'");
      for (const [table, n] of [
        ['item_shared_changes', 1],
        ['part_overlaps', 1],
        ['part_leases', 0],
        ['undeclared_holds', 1],
        ['radar_findings', 0],
      ] as const) {
        expect(all(migrated, table), table).toHaveLength(n);
      }

      // Migrating again is a no-op.
      migrateDb(migrated);
      expect(migrationStatus(migrated).applied).toBe(34);
    } finally {
      migrated.sqlite.close();
    }

    // The original file was not touched.
    const untouched = openDb(original);
    try {
      for (const t of EXISTING) expect(all(untouched, t), t).toEqual(before[t]);
      expect(
        untouched.sqlite
          .prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'shared_parts'")
          .get(),
      ).toEqual({ n: 0 });
    } finally {
      untouched.sqlite.close();
    }
  });
});

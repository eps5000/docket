/**
 * Migration 0009_step_details (B33; owner decision 33; BUILD_SPEC §4, §5.5):
 * `work_steps` gains `details_md` and `source` (nullable) and
 * `details_version` (NOT NULL DEFAULT 0). It is additive and forward-only, so
 * this proves on a copy of a database created by 0000–0008 and populated with
 * a plan (steps across two plan versions, a run on a current step, subagent
 * logs) that every existing row comes through unchanged, reads as having no
 * details, and that the original file is untouched.
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

const ts = '2026-11-18T00:00:00.000Z';
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
];

/** A migrations folder holding only 0000–0008 (`main` before B33). */
function beforeB33(dir: string): string {
  const src = migrationsFolder();
  const out = join(dir, 'migrations-b31');
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

function step(db: Db, id: string, plan: number, position: number, state: string, by = 'claude') {
  run(
    db,
    `INSERT INTO work_steps (id, item_id, plan_version_no, position, text, state, was_text,
       change_reason, added_by, state_by, state_at, version, created_at, updated_at)
     VALUES (?, 'RCP-1', ?, ?, ?, ?, NULL, NULL, ?, ?, ?, 1, ?, ?)`,
    id,
    plan,
    position,
    `Step ${id}`,
    state,
    by,
    state === 'todo' ? null : by,
    state === 'todo' ? null : ts,
    ts,
    ts,
  );
}

/** A populated pre-B33 database: two plan versions, an owner step, a run and subagent logs. */
function populate(db: Db) {
  insertProject(db, 'RCP');
  insertItem(db, { id: 'RCP-1', status: 'progress' });
  insertItem(db, { id: 'RCP-2' });
  for (const v of [1, 2]) {
    run(
      db,
      `INSERT INTO plan_versions (id, item_id, version_no, reason, created_by, created_at, updated_at)
       VALUES (?, 'RCP-1', ?, ?, 'claude', ?, ?)`,
      `pv_${v}`,
      v,
      v === 1 ? null : 'Split the export step',
      ts,
      ts,
    );
  }
  step(db, 'wst_old', 1, 2, 'todo'); // removed by the revision: keeps plan version 1
  step(db, 'wst_a', 2, 0, 'done');
  step(db, 'wst_b', 2, 1, 'current');
  step(db, 'wst_c', 2, 2, 'todo', 'owner');
  run(
    db,
    `INSERT INTO runs (id, item_id, client, label, is_lead, state, last_signal_at, last_signal_kind,
       current_step_id, version, created_at, updated_at)
     VALUES ('run_1', 'RCP-1', 'claude', 'w1', 1, 'open', ?, 'session', 'wst_b', 1, ?, ?)`,
    ts,
    ts,
    ts,
  );
  run(
    db,
    `INSERT INTO subagent_logs (id, item_id, work_step_id, name, outcome, provenance, created_at, updated_at)
     VALUES ('sub_1', 'RCP-1', 'wst_b', 'units-worker', 'Added 31 tests', 'observed', ?, ?)`,
    ts,
    ts,
  );
}

const steps = (db: Db) =>
  db.sqlite.prepare('SELECT * FROM work_steps ORDER BY id').all() as Record<string, unknown>[];

describe('0009_step_details', () => {
  let tmp: TempDir;
  beforeEach(() => {
    tmp = tempDir('docket-migrate-');
  });
  afterEach(() => {
    tmp.cleanup();
  });

  it('adds the three columns on a copy of a populated database, leaving every row as it was', () => {
    const original = join(tmp.dir, 'docket.db');
    const db = openDb(original);
    let before: Record<string, unknown>[];
    let otherTables: unknown[];
    try {
      migrate(drizzle(db.sqlite), { migrationsFolder: beforeB33(tmp.dir) });
      populate(db);
      before = steps(db);
      otherTables = ['runs', 'subagent_logs', 'plan_versions', 'items'].map((t) =>
        db.sqlite.prepare(`SELECT * FROM ${t} ORDER BY 1`).all(),
      );
      expect(Object.keys(before[0]!)).not.toContain('details_md');
    } finally {
      db.sqlite.close();
    }

    const copy = join(tmp.dir, 'docket-copy.db');
    copyFileSync(original, copy);
    const migrated = openDb(copy);
    try {
      migrateDb(migrated);
      expect(migrationStatus(migrated)).toEqual({ current: true, applied: 27, expected: 27 });
      const after = steps(migrated);
      expect(after).toEqual(
        before.map((row) => ({ ...row, details_md: null, source: null, details_version: 0 })),
      );
      expect(
        ['runs', 'subagent_logs', 'plan_versions', 'items'].map((t) =>
          (
            migrated.sqlite.prepare(`SELECT * FROM ${t} ORDER BY 1`).all() as Record<
              string,
              unknown
            >[]
          )
            // 0010_shared_changes (B38) adds items.shared_none_at, and 0011_radar_branches
            // (B40) the branch columns, 0012_item_branches (B41) items.branches; 0010's test checks them.
            .map(
              ({
                shared_none_at: _,
                branch: _b,
                branch_by: _bb,
                branch_at: _ba,
                radar_branch: _rb,
                radar_branch_matches: _rbm,
                branches: _br,
                unpushed_outcome: _uo,
                worktree_check: _wc,
                restart_deadline_at: _rd,
                producer: _p,
                producer_hold_until: _ph,
                status_update: _su,
                park_activity: _pa,
                coordinator_park: _cp,
                wait_flags: _wf,
                coordinators: _co,
                split_from: _sf,
                criteria_changed_at: _cc,
                withdrawn_at: _wa,
                withdrawn_by: _wb,
                withdrawn_reason: _wr,
                ...row
              }) => row,
            ),
        ),
      ).toEqual(otherTables);
      expect(migrated.sqlite.pragma('foreign_key_check')).toEqual([]);

      // The new columns: nullable text, and an integer that defaults to 0 and refuses null.
      const cols = migrated.sqlite.pragma('table_info(work_steps)') as {
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
      }[];
      const col = (name: string) => cols.find((c) => c.name === name)!;
      expect(col('details_md')).toMatchObject({ type: 'TEXT', notnull: 0, dflt_value: null });
      expect(col('source')).toMatchObject({ type: 'TEXT', notnull: 0, dflt_value: null });
      expect(col('details_version')).toMatchObject({
        type: 'INTEGER',
        notnull: 1,
        dflt_value: '0',
      });
      expect(() =>
        run(migrated, "UPDATE work_steps SET details_version = NULL WHERE id = 'wst_a'"),
      ).toThrow(/NOT NULL constraint failed: work_steps.details_version/);
      run(
        migrated,
        "UPDATE work_steps SET details_md = '## Notes', source = 'GF-12', details_version = 1 WHERE id = 'wst_b'",
      );

      // Migrating again is a no-op.
      migrateDb(migrated);
      expect(migrationStatus(migrated).applied).toBe(27);
    } finally {
      migrated.sqlite.close();
    }

    // The original file was not touched.
    const untouched = openDb(original);
    try {
      expect(steps(untouched)).toEqual(before);
    } finally {
      untouched.sqlite.close();
    }
  });
});

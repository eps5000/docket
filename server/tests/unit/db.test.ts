import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrateDb, migrationStatus } from '../../src/db/client.js';
import { createTestDb, insertItem, insertProject, type TestDb } from '../helpers.js';

let t: TestDb;
beforeEach(() => {
  t = createTestDb();
  insertProject(t.db, 'RCP');
});
afterEach(() => t.cleanup());

const pragma = (name: string) => t.db.sqlite.pragma(name, { simple: true });
const run = (sql: string, ...params: unknown[]) => t.db.sqlite.prepare(sql).run(...params);
const ts = '2026-11-14T00:00:00.000Z';

describe('database client', () => {
  it('opens in WAL mode with foreign keys and a 5 s busy timeout', () => {
    expect(pragma('journal_mode')).toBe('wal');
    expect(pragma('foreign_keys')).toBe(1);
    expect(pragma('busy_timeout')).toBe(5000);
  });

  it('applies every migration, and migrating again is a no-op', () => {
    expect(migrationStatus(t.db)).toEqual({ current: true, applied: 2, expected: 2 });
    migrateDb(t.db);
    expect(migrationStatus(t.db).applied).toBe(2);
  });

  it('creates every BUILD_SPEC §4 table', () => {
    const tables = (
      t.db.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    for (const name of [
      'projects',
      'items',
      'acceptance_criteria',
      'labels',
      'item_labels',
      'links',
      'plan_versions',
      'work_steps',
      'subagent_logs',
      'agent_checks',
      'hr_items',
      'packets',
      'packet_items',
      'packet_attachments',
      'review_decisions',
      'runs',
      'questions',
      'owner_notes',
      'commits',
      'artifacts',
      'documents',
      'document_versions',
      'events',
      'idempotency',
      'decision_records',
      'owner_sessions',
      'settings',
      'search_fts',
    ]) {
      expect(tables, name).toContain(name);
    }
  });
});

describe('limits and enums are enforced by the schema', () => {
  it.each([
    ['a title over 200 characters', `UPDATE items SET title = '${'x'.repeat(201)}'`],
    ['an empty title', "UPDATE items SET title = ''"],
    [
      'a description over 20,000 characters',
      `UPDATE items SET description_md = '${'x'.repeat(20_001)}'`,
    ],
    ['priority 4', 'UPDATE items SET priority = 4'],
    ['negative effort', 'UPDATE items SET effort = -1'],
    ['an unknown status', "UPDATE items SET status = 'blocked'"],
    ['an unknown type', "UPDATE items SET type = 'Spike'"],
  ])('rejects %s', (_name, sql) => {
    insertItem(t.db, { id: 'RCP-1' });
    expect(() => run(sql)).toThrow(/CHECK constraint failed/);
  });

  it.each(['R', 'RECIPE', 'rcp', 'RC1'])('rejects project key %s', (key) => {
    expect(() =>
      run(
        "INSERT INTO projects (id, key, name, short_name, color, created_at, updated_at) VALUES (?, ?, 'x', 'x', '#000', ?, ?)",
        `prj_${key}`,
        key,
        ts,
        ts,
      ),
    ).toThrow(/CHECK constraint failed/);
  });

  it.each(['UI', 'ui refresh', 'x'.repeat(41)])('rejects label name %j', (name) => {
    expect(() =>
      run(
        "INSERT INTO labels (id, project_key, name, created_at, updated_at) VALUES ('lbl_1', 'RCP', ?, ?, ?)",
        name,
        ts,
        ts,
      ),
    ).toThrow(/CHECK constraint failed/);
  });

  it('rejects step text over 500 characters and decision titles over 120', () => {
    insertItem(t.db, { id: 'RCP-1' });
    expect(() =>
      run(
        "INSERT INTO hr_items (id, item_id, position, text, added_by, created_at, updated_at) VALUES ('hr_1', 'RCP-1', 0, ?, 'owner', ?, ?)",
        'x'.repeat(501),
        ts,
        ts,
      ),
    ).toThrow(/CHECK constraint failed/);
    expect(() =>
      run(
        "INSERT INTO decision_records (id, project_key, scope_kind, title, decision_md, authority, author, created_at, updated_at) VALUES ('dec_x', 'RCP', 'project', ?, 'd', 'owner', 'owner', ?, ?)",
        'x'.repeat(121),
        ts,
        ts,
      ),
    ).toThrow(/CHECK constraint failed/);
  });

  it('allows one active lead run per item', () => {
    insertItem(t.db, { id: 'RCP-1' });
    const lead = (id: string, state: string) =>
      run(
        "INSERT INTO runs (id, item_id, client, is_lead, state, last_signal_at, last_signal_kind, created_at, updated_at) VALUES (?, 'RCP-1', 'claude', 1, ?, ?, 'session', ?, ?)",
        id,
        state,
        ts,
        ts,
        ts,
      );
    lead('run_1', 'finished');
    lead('run_2', 'open');
    expect(() => lead('run_3', 'open')).toThrow(/UNIQUE constraint failed/);
  });
});

describe('search_fts stays in sync', () => {
  const search = (q: string) =>
    (
      t.db.sqlite
        .prepare('SELECT id FROM search_fts WHERE search_fts MATCH ? ORDER BY id')
        .all(q) as { id: string }[]
    ).map((r) => r.id);

  it('follows item inserts, edits, labels and deletes', () => {
    insertItem(t.db, { id: 'RCP-1', title: 'Aisle grouping' });
    expect(search('aisle')).toEqual(['RCP-1']);
    run("UPDATE items SET title = 'Unit merging', jira_key = 'RECIPE-42' WHERE id = 'RCP-1'");
    expect(search('aisle')).toEqual([]);
    expect(search('merging')).toEqual(['RCP-1']);
    expect(search('"RECIPE-42"')).toEqual(['RCP-1']);
    run(
      "INSERT INTO labels (id, project_key, name, created_at, updated_at) VALUES ('lbl_m', 'RCP', 'mobile', ?, ?)",
      ts,
      ts,
    );
    run(
      "INSERT INTO item_labels (id, item_id, label_id, created_at, updated_at) VALUES ('il_1', 'RCP-1', 'lbl_m', ?, ?)",
      ts,
      ts,
    );
    expect(search('labels:mobile')).toEqual(['RCP-1']);
    run("UPDATE labels SET name = 'handheld' WHERE id = 'lbl_m'");
    expect(search('labels:mobile')).toEqual([]);
    expect(search('labels:handheld')).toEqual(['RCP-1']);
    run("DELETE FROM item_labels WHERE id = 'il_1'");
    expect(search('labels:handheld')).toEqual([]);
    run("DELETE FROM items WHERE id = 'RCP-1'");
    expect(search('merging')).toEqual([]);
  });
});

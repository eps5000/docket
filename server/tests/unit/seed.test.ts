import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client.js';
import { SEED_TABLES, loadSampleSeed, protoInstant, seedId } from '../../src/db/seed/loader.js';
import { createTestDb, type TestDb } from '../helpers.js';

const NOW = new Date('2026-11-14T12:00:00.000Z');
const MIN = 60_000;

/** A stable dump of the given tables: every row, ordered by key, hashed. */
export function dumpHash(db: Db, tables: readonly string[]): string {
  const hash = createHash('sha256');
  for (const table of tables) {
    const order = table === 'events' ? 'seq' : 'id';
    const rows = db.sqlite.prepare(`SELECT * FROM "${table}" ORDER BY "${order}"`).all();
    hash.update(`${table}\n${JSON.stringify(rows)}\n`);
  }
  return hash.digest('hex');
}

let a: TestDb;
let b: TestDb;

beforeEach(() => {
  a = createTestDb();
  b = createTestDb();
});
afterEach(() => {
  a.cleanup();
  b.cleanup();
});

const seed = (t: TestDb, now = NOW) => loadSampleSeed(t.db, { now, docsDir: join(t.dir, 'docs') });
const one = <T>(t: TestDb, sql: string, ...params: unknown[]) =>
  t.db.sqlite.prepare(sql).get(...params) as T;
const all = <T>(t: TestDb, sql: string, ...params: unknown[]) =>
  t.db.sqlite.prepare(sql).all(...params) as T[];

describe('sample seed', () => {
  it('is deterministic: two fresh databases get identical rows', () => {
    const countsA = seed(a);
    const countsB = seed(b);
    expect(countsA).toEqual(countsB);
    expect(dumpHash(a.db, SEED_TABLES)).toBe(dumpHash(b.db, SEED_TABLES));
    // Generated document bytes are identical too.
    const path = one<{ path: string }>(
      a,
      'SELECT path FROM document_versions ORDER BY id LIMIT 1',
    ).path;
    expect(readFileSync(join(a.dir, 'docs', path))).toEqual(
      readFileSync(join(b.dir, 'docs', path)),
    );
  });

  it('keeps IDs stable whatever the clock; only times move', () => {
    seed(a, NOW);
    seed(b, new Date(NOW.getTime() + 3 * 24 * 60 * MIN));
    const ids = (t: TestDb) =>
      all<{ id: string }>(t, 'SELECT id FROM hr_items UNION ALL SELECT id FROM runs ORDER BY 1');
    expect(ids(a)).toEqual(ids(b));
  });

  it('loads every project, item and decision record', () => {
    const counts = seed(a);
    expect(counts).toMatchObject({ projects: 2, items: 25, labels: 4, decision_records: 3 });
    for (const table of SEED_TABLES) expect(counts[table], table).toBeGreaterThan(0);
    expect(
      one<{ next_seq: number }>(a, "SELECT next_seq FROM projects WHERE key = 'RCP'").next_seq,
    ).toBe(30);
    expect(
      one<{ next_seq: number }>(a, "SELECT next_seq FROM projects WHERE key = 'DOC'").next_seq,
    ).toBe(11);
  });

  it('refuses to load into a database that has data', () => {
    seed(a);
    expect(() => seed(a)).toThrow(/not empty/);
  });

  it('maps RCP-14 per BUILD_SPEC §8', () => {
    seed(a);
    const item = one<Record<string, unknown>>(a, "SELECT * FROM items WHERE id = 'RCP-14'");
    expect(item).toMatchObject({
      type: 'Story',
      title: 'Generate shopping list from week plan',
      status: 'progress',
      priority: 1,
      epic_id: 'RCP-1',
      effort: 5,
      project_key: 'RCP',
      outcome_md:
        'When a week plan is saved, the user can produce one merged shopping list grouped by aisle and export it.',
      planned_start: '2026-11-12',
      planned_end: '2026-11-19',
      dates_set_by: 'claude',
    });
    expect(
      all(a, "SELECT text FROM acceptance_criteria WHERE item_id = 'RCP-14' ORDER BY position"),
    ).toHaveLength(3);
    expect(
      all<{ name: string }>(
        a,
        "SELECT l.name FROM item_labels il JOIN labels l ON l.id = il.label_id WHERE il.item_id = 'RCP-14'",
      ),
    ).toEqual([{ name: 'mobile' }]);

    const lead = one<Record<string, unknown>>(
      a,
      "SELECT * FROM runs WHERE item_id = 'RCP-14' AND is_lead = 1",
    );
    expect(lead).toMatchObject({
      client: 'claude',
      label: 'orca-w3',
      state: 'open',
      last_signal_kind: 'session',
    });
    expect(Date.parse(lead.last_signal_at as string)).toBe(NOW.getTime() - 40_000);
    // "lease until 12:02" on an 11:00 clock: 62 minutes from now.
    expect(Date.parse(lead.lease_expires_at as string)).toBe(NOW.getTime() + 62 * MIN);

    const steps = all<{
      text: string;
      state: string;
      plan_version_no: number;
      was_text: string | null;
    }>(
      a,
      "SELECT text, state, plan_version_no, was_text FROM work_steps WHERE item_id = 'RCP-14' ORDER BY position",
    );
    expect(steps.map((s) => s.state)).toEqual(['done', 'current', 'todo', 'todo']);
    expect(steps.every((s) => s.plan_version_no === 3)).toBe(true);
    expect(steps[2]!.was_text).toBe('Export to Reminders app');
    expect(lead.current_step_id).toBe(seedId('wst', 'RCP-14', 1));
    expect(all(a, "SELECT * FROM plan_versions WHERE item_id = 'RCP-14'")).toHaveLength(3);
    expect(all(a, "SELECT * FROM agent_checks WHERE item_id = 'RCP-14'")).toHaveLength(3);

    const logs = all<{ provenance: string; name: string; child_run_id: string | null }>(
      a,
      "SELECT provenance, name, child_run_id FROM subagent_logs WHERE item_id = 'RCP-14' ORDER BY id",
    );
    expect(logs).toHaveLength(2);
    const observed = logs.find((l) => l.provenance === 'observed')!;
    expect(observed.name).toBe('units-worker');
    expect(
      one<{ parent_run_id: string; client: string }>(
        a,
        'SELECT parent_run_id, client FROM runs WHERE id = ?',
        observed.child_run_id,
      ),
    ).toEqual({ parent_run_id: lead.id, client: 'codex' });
    expect(logs.find((l) => l.provenance === 'relayed')!.child_run_id).toBeNull();

    expect(all(a, "SELECT text, state, added_by FROM hr_items WHERE item_id = 'RCP-14'")).toEqual([
      {
        text: "Export one week's list and check it reads well in your notes app.",
        state: 'declared',
        added_by: 'claude',
      },
    ]);
    expect(
      all(
        a,
        "SELECT d.name, v.version_no FROM documents d JOIN document_versions v ON v.document_id = d.id WHERE d.item_id = 'RCP-14'",
      ),
    ).toEqual([{ name: 'aggregation-rules.md', version_no: 1 }]);
  });

  it('adds decision records dec_1 to dec_3', () => {
    seed(a);
    expect(
      all(
        a,
        'SELECT id, project_key, scope_kind, scope_id, authority, author, status, title FROM decision_records ORDER BY id',
      ),
    ).toEqual([
      {
        id: 'dec_1',
        project_key: 'RCP',
        scope_kind: 'epic',
        scope_id: 'RCP-1',
        authority: 'owner',
        author: 'owner',
        status: 'active',
        title: 'Units are metric internally; convert on display',
      },
      {
        id: 'dec_2',
        project_key: 'DOC',
        scope_kind: 'project',
        scope_id: null,
        authority: 'agent',
        author: 'codex',
        status: 'active',
        title: 'API reference pages show one request and one response example per endpoint',
      },
      {
        id: 'dec_3',
        project_key: 'RCP',
        scope_kind: 'label',
        scope_id: 'ui-refresh',
        authority: 'agent',
        author: 'claude',
        status: 'active',
        title: 'Use design tokens v2 spacing (8 px grid)',
      },
    ]);
    expect(all(a, "SELECT type FROM events WHERE type = 'decision.published'")).toHaveLength(3);
  });

  it('sets the RCP-19 → RCP-16 link to merged and leaves the rest on the project default', () => {
    seed(a);
    expect(
      all(
        a,
        'SELECT from_id, to_id, type, satisfied_when FROM links WHERE satisfied_when IS NOT NULL',
      ),
    ).toEqual([{ from_id: 'RCP-19', to_id: 'RCP-16', type: 'blocks', satisfied_when: 'merged' }]);
    expect(all(a, 'SELECT DISTINCT default_satisfied_when AS d FROM projects')).toEqual([
      { d: 'done' },
    ]);
    expect(one<{ n: number }>(a, "SELECT count(*) AS n FROM links WHERE type = 'blocks'").n).toBe(
      12,
    );
    expect(one<{ n: number }>(a, "SELECT count(*) AS n FROM links WHERE type = 'relates'").n).toBe(
      2,
    );
  });

  it('maps packets, review decisions, commits and the open question', () => {
    seed(a);
    const packets = all<{
      item_id: string;
      round: number;
      state: string;
      built_from_commit: string | null;
      content_hash: string;
    }>(
      a,
      'SELECT item_id, round, state, built_from_commit, content_hash FROM packets ORDER BY item_id, round',
    );
    expect(packets.map((p) => [p.item_id, p.round, p.state, p.built_from_commit])).toEqual([
      ['RCP-12', 1, 'decided', null],
      ['RCP-12', 2, 'open', '9c0e7f2'],
      ['RCP-19', 1, 'open', 'b41d2e0'],
    ]);
    expect(packets[1]!.content_hash.slice(0, 4)).toBe('9c0e');
    // Each open packet holds the item's `ready` human review items.
    const packetItems = (item: string, round: number) =>
      all<{ hr_item_id: string }>(
        a,
        'SELECT pi.hr_item_id FROM packet_items pi JOIN packets p ON p.id = pi.packet_id WHERE p.item_id = ? AND p.round = ? ORDER BY pi.id',
        item,
        round,
      ).map((r) => r.hr_item_id);
    expect(packetItems('RCP-12', 2).sort()).toEqual(
      [seedId('hr', 'RCP-12', 0), seedId('hr', 'RCP-12', 1)].sort(),
    );
    expect(packetItems('RCP-19', 1)).toEqual([seedId('hr', 'RCP-19', 0)]);
    expect(
      all(a, 'SELECT kind, "into", result_ref FROM review_decisions ORDER BY id').map(
        (r) => (r as { kind: string }).kind,
      ),
    ).toEqual(['changes', 'changes']);
    expect(one(a, 'SELECT result_ref FROM review_decisions WHERE "into" = \'bug\'')).toEqual({
      result_ref: 'RCP-17',
    });
    // RCP-19's packet is out of date: a newer commit was reported after it.
    expect(
      all(a, "SELECT sha, message FROM commits WHERE item_id = 'RCP-19' ORDER BY reported_at"),
    ).toEqual([
      { sha: 'b41d2e0', message: null },
      { sha: 'c77a9f1', message: 'Fix typo in the Units table' },
    ]);
    expect(one(a, "SELECT asked_by, answer FROM questions WHERE item_id = 'DOC-4'")).toEqual({
      asked_by: 'codex',
      answer: null,
    });
    expect(one(a, "SELECT state FROM runs WHERE item_id = 'DOC-4' AND is_lead = 1")).toEqual({
      state: 'needs_input',
    });
    expect(one(a, "SELECT from_review FROM items WHERE id = 'RCP-17'")).toEqual({
      from_review: JSON.stringify({
        item_id: 'RCP-12',
        round: 1,
        hr_item_id: seedId('hr', 'RCP-12', 1),
      }),
    });
    expect(one(a, "SELECT follow_up_item_id FROM hr_items WHERE item_id = 'RCP-11'")).toEqual({
      follow_up_item_id: 'RCP-29',
    });
  });

  it('shifts times so relative states look current', () => {
    seed(a);
    const stale = one<{ last_signal_at: string }>(
      a,
      "SELECT last_signal_at FROM runs WHERE item_id = 'RCP-15' AND is_lead = 1",
    );
    expect(Date.parse(stale.last_signal_at)).toBe(NOW.getTime() - 47 * MIN);
    const events = all<{ at: string; seq: number }>(a, 'SELECT at, seq FROM events ORDER BY seq');
    const times = events.map((e) => e.at);
    expect([...times].sort()).toEqual(times);
    expect(Date.parse(times[times.length - 1]!)).toBeLessThanOrEqual(NOW.getTime());
  });

  it('indexes items for full-text search', () => {
    seed(a);
    expect(
      all(a, "SELECT id FROM search_fts WHERE search_fts MATCH 'shopping' ORDER BY id"),
    ).toEqual([
      // Titles and outcomes both count.
      { id: 'RCP-1' },
      { id: 'RCP-14' },
      { id: 'RCP-19' },
      { id: 'RCP-27' },
    ]);
    expect(all(a, "SELECT id FROM search_fts WHERE search_fts MATCH 'labels:regression'")).toEqual([
      { id: 'RCP-17' },
    ]);
  });
});

describe('protoInstant', () => {
  it.each([
    ['40s', Date.UTC(2026, 10, 6, 10, 59, 20)],
    ['09:10', Date.UTC(2026, 10, 6, 9, 10)],
    ['changed 10:05', Date.UTC(2026, 10, 6, 10, 5)],
    ['Nov 5', Date.UTC(2026, 10, 5, 12, 0)],
    ['Nov 5 16:10', Date.UTC(2026, 10, 5, 16, 10)],
    ['2d', Date.UTC(2026, 10, 4, 11, 0)],
  ])('%s', (text, expected) => {
    expect(protoInstant(text)).toBe(expected);
  });
});

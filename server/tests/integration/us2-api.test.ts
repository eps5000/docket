/**
 * US2 read API against the sample seed (tasks.md T077; BUILD_SPEC §7;
 * spec US2 acceptance 1–2, 6; FR-061, FR-067).
 *
 * `bootstrap`, `needs-you`, `work`, `items/:id`, `agents`, `search` and
 * `stream`, each through the HTTP API with an owner session, each answer
 * checked against its shared response schema, and each timed (SC-013).
 * A summary table is printed at the end (PR evidence).
 */
import {
  agentsResponse,
  runCustodyResponse,
  bootstrapResponse,
  burndownResponse,
  itemDetailResponse,
  needsYouResponse,
  searchResponse,
  workResponse,
  type AgentsResponse,
  type BootstrapResponse,
  type ItemDetailResponse,
  type NeedsYouResponse,
  type SearchResponse,
  type WorkResponse,
} from '@docket/shared';
import type { z } from 'zod';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadSampleSeed } from '../../src/db/seed/loader.js';
import { NOW } from '../us1-helpers.js';
import { TestClock } from '../helpers.js';
import { createTestServer, parseSetCookies, readUntil, type TestServer } from './harness.js';

let s: TestServer;
let cookie: string;

/** The slowest any read route may answer on the seed (SC-013 asks < 1 s for the whole view). */
const BUDGET_MS = 300;
const results: { route: string; result: string; ms: number }[] = [];

beforeEach(async () => {
  s = createTestServer({ clock: new TestClock(new Date(NOW)), keepAliveMs: 60_000 });
  loadSampleSeed(s.runtime.db, { now: s.clock.now(), docsDir: s.runtime.config.paths.docs });
  const res = await s.request('/api/session/unlock', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: s.runtime.secrets.ownerKey() }),
  });
  const cookies = parseSetCookies(res);
  cookie = `docket_owner=${cookies.docket_owner!.value}; docket_csrf=${cookies.docket_csrf!.value}`;
});
afterEach(async () => {
  await s.cleanup();
});
afterAll(() => {
  const rows = results.map((r) => `| ${r.route} | ${r.result} | ${r.ms} ms |`);
  console.log(['| Route | Result | Time |', '|---|---|---|', ...rows].join('\n'));
});

async function get<T>(path: string, schema: z.ZodType<T>, label = `GET ${path}`): Promise<T> {
  const started = performance.now();
  const res = await s.request(path, { headers: { cookie } });
  const body = (await res.json()) as unknown;
  const took = Math.round(performance.now() - started);
  expect(res.status, `${label}: ${JSON.stringify(body)}`).toBe(200);
  const parsed = schema.safeParse(body);
  expect(parsed.success, `${label} matches its schema`).toBe(true);
  expect(took, `${label} answers within ${BUDGET_MS} ms`).toBeLessThan(BUDGET_MS);
  results.push({ route: label, result: '200, schema ok', ms: took });
  return parsed.data!;
}

const sql = () => s.runtime.db.sqlite;

describe('GET /api/bootstrap', () => {
  it('returns projects, labels, the for-you count, run counts, timing and health', async () => {
    const b: BootstrapResponse = await get('/api/bootstrap', bootstrapResponse);
    expect(b.projects.map((p) => p.key)).toEqual(['DOC', 'RCP']);
    expect(b.labels.map((l) => `${l.project}:${l.name}`).sort()).toEqual([
      'DOC:api-docs',
      'RCP:mobile',
      'RCP:regression',
      'RCP:ui-refresh',
    ]);
    // Two packets ready plus one open question (FR-061).
    expect(b.counts.for_you).toBe(3);
    expect(b.counts.planning).toBe(5);
    expect(b.counts.runs).toEqual({ live: 1, reported: 1, stale: 1, needs_input: 1, failed: 1 });
    expect(b.counts.problems).toBeGreaterThanOrEqual(4);
    expect(b.settings).toEqual({
      live_window_s: 120,
      stale_after_s: 1800,
      lease_s: 3600,
      undo_window_s: 60,
    });
    expect(b.health.status).toBe('ready');
    expect(b.server_time).toBe(NOW.toISOString());
  });
});

describe('GET /api/needs-you', () => {
  it('shows "3 for you": two packets and one question, and nothing else is for you', async () => {
    const n: NeedsYouResponse = await get('/api/needs-you', needsYouResponse);
    expect(n.for_you_now.map((r) => `${r.kind}:${r.item_id}`)).toEqual([
      'packet:RCP-19',
      'packet:RCP-12',
      'question:DOC-4',
    ]);
    const rcp12 = n.for_you_now.find((r) => r.item_id === 'RCP-12');
    expect(rcp12).toMatchObject({ kind: 'packet', round: 2, to_verify: 2, stale: false });
    // RCP-19's packet is out of date: a commit was reported after it was written.
    const rcp19 = n.for_you_now.find((r) => r.item_id === 'RCP-19');
    expect(rcp19).toMatchObject({ kind: 'packet', round: 1, to_verify: 1, stale: true });
    const q = n.for_you_now.find((r) => r.kind === 'question');
    expect(q).toMatchObject({ asked_by: 'codex' });
    expect(q && q.kind === 'question' && q.text).toContain('per serving or per 100 g');
  });

  it('lists problems with a reason and what they involve, the most blocking first', async () => {
    const n = await get('/api/needs-you?scope=all', needsYouResponse);
    const kinds = n.problems.map((p) => `${p.kind}:${p.item_id}`);
    expect(kinds).toEqual(
      expect.arrayContaining([
        'stale_run:RCP-15',
        'failed_run:RCP-18',
        'date_risk:RCP-16',
        'cycle:DOC-7',
      ]),
    );
    const stale = n.problems.find((p) => p.kind === 'stale_run')!;
    expect(stale.reason).toBe(
      "Lead silent for 47m · the lease expires in 13m · treated as unknown, not finished · another agent's claim was rejected 2m ago",
    );
    expect(stale.run_id).toBeTruthy();
    const failed = n.problems.find((p) => p.kind === 'failed_run')!;
    expect(failed.reason).toMatch(/^Run failed: .+ Nothing retries automatically\.$/);
    const cycle = n.problems.find((p) => p.kind === 'cycle')!;
    expect(cycle.related).toEqual(['DOC-7', 'DOC-8']);
    expect(cycle.reason).toContain('DOC-7 ⇄ DOC-8');
    const date = n.problems.find((p) => p.kind === 'date_risk')!;
    expect(date.reason).toBe(
      'Planned start Nov 9 is before its blocker DOC-4 is planned to finish (Nov 10).',
    );
    // RCP-15 holds up RCP-21; nothing else holds up more.
    expect(n.problems[0]!.kind).toBe('stale_run');
    // No recovery rows yet (US11), and no problem is "for you".
    for (const p of n.problems) {
      expect([
        'orphaned_resources',
        'unpushed_work',
        'parked_too_long',
        'resume_unattended',
      ]).not.toContain(p.kind);
    }
  });

  it('lists deferred reviews, the Planning queue and run counts', async () => {
    const n = await get('/api/needs-you', needsYouResponse);
    expect(n.deferred.map((d) => d.item_id).sort()).toEqual(['DOC-2', 'RCP-11']);
    expect(n.deferred.find((d) => d.item_id === 'RCP-11')!.follow_up).toEqual({
      id: 'RCP-29',
      status: 'inbox',
    });
    expect(n.deferred.find((d) => d.item_id === 'DOC-2')!.follow_up).toBeNull();
    expect(n.planning_queue.map((i) => i.id)).toEqual([
      'RCP-2',
      'RCP-23',
      'DOC-9',
      'RCP-24',
      'RCP-27',
    ]);
    expect(n.agent_counts).toEqual({ live: 1, reported: 1, stale: 1, needs_input: 1, failed: 1 });
  });

  it('scopes to one project', async () => {
    const n = await get(
      '/api/needs-you?scope=DOC',
      needsYouResponse,
      'GET /api/needs-you?scope=DOC',
    );
    expect(n.for_you_now.map((r) => r.item_id)).toEqual(['DOC-4']);
    expect(n.problems.map((p) => p.item_id)).toEqual(['DOC-7']);
    expect(n.planning_queue.map((i) => i.id)).toEqual(['DOC-9']);
    expect(n.agent_counts).toEqual({ needs_input: 1 });
  });

  it('drops a question once it is answered', async () => {
    sql()
      .prepare(
        "UPDATE questions SET answer = 'Per serving.', answered_at = ? WHERE item_id = 'DOC-4'",
      )
      .run(NOW.toISOString());
    const n = await get('/api/needs-you', needsYouResponse);
    expect(n.for_you_now.map((r) => r.item_id)).toEqual(['RCP-19', 'RCP-12']);
  });
});

describe('GET /api/work', () => {
  it('Board: tickets only (no epics), with for-you, packet-ready and chip counts', async () => {
    const w: WorkResponse = await get('/api/work', workResponse);
    expect(w.layout).toBe('board');
    expect(w.timeline).toBeNull();
    expect(w.items.some((i) => i.type === 'Epic')).toBe(false);
    expect(w.items).toHaveLength(22);
    expect(
      w.items
        .filter((i) => i.for_you)
        .map((i) => i.id)
        .sort(),
    ).toEqual(['DOC-4', 'RCP-12', 'RCP-19']);
    expect(
      w.items
        .filter((i) => i.packet_ready)
        .map((i) => i.id)
        .sort(),
    ).toEqual(['RCP-12', 'RCP-19']);
    // With no filter parameters the API keeps the old All: Active with Shows done (B43).
    expect(w.filter_counts).toMatchObject({
      quick: { active: 22 },
      has: { for_you: 3, live_run: 1, planning: 4, deferred_review: 2 },
      show: { done: 2, canceled: 0 },
      archived: 0,
    });
    expect(w.epics.map((e) => e.id).sort()).toEqual(['DOC-10', 'RCP-1', 'RCP-2']);
    const rcp1 = w.epics.find((e) => e.id === 'RCP-1')!;
    expect(rcp1.children.total).toBe(12);
    expect(rcp1.children.done).toBe(1);
    // "N for you" on each epic card: its children with a packet ready or an open question.
    for (const e of w.epics) {
      const kids = w.items.filter((i) => i.epic === e.id && i.for_you).length;
      expect(e.children.for_you, e.id).toBe(kids);
    }
    expect(w.epics.reduce((n, e) => n + e.children.for_you, 0)).toBeGreaterThan(0);
    // Links among the items shown, with the effective rule and whether each clears.
    expect(w.links).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: 'RCP-19', to: 'RCP-16', satisfied_when: 'merged' }),
        expect.objectContaining({ from: 'DOC-7', to: 'DOC-8', type: 'blocks', cleared: false }),
      ]),
    );
    for (const i of w.items) expect(i.last_activity_at).toBeTruthy();
  });

  it('filters: Blocked, For you, Ready to start, an epic and a label', async () => {
    const blocked = await get(
      '/api/work?filter=blocked&layout=list',
      workResponse,
      'GET /api/work?filter=blocked&layout=list',
    );
    // Decision 57: Blocked is only a wait that needs attention: the seed's dependency loop.
    expect(blocked.items.every((i) => i.blocked && i.wait?.kind === 'blocked')).toBe(true);
    expect(blocked.items.map((i) => i.id).sort()).toEqual(['DOC-7', 'DOC-8']);
    expect(blocked.items.map((i) => i.wait?.reason)).toEqual(['cycle', 'cycle']);
    // The rest wait their turn behind moving work: a live lead, or a packet in review.
    const queued = await get('/api/work?quick=queued&layout=list', workResponse);
    expect(queued.items.every((i) => i.wait?.kind === 'queued')).toBe(true);
    expect(queued.items.map((i) => i.id)).toEqual(expect.arrayContaining(['RCP-16', 'RCP-22']));
    expect(queued.items.find((i) => i.id === 'RCP-16')!.wait!.text).toBe(
      'Starts after RCP-19’s design and 1 more',
    );
    const forYou = await get('/api/work?filter=for_you', workResponse);
    expect(forYou.items.map((i) => i.id).sort()).toEqual(['DOC-4', 'RCP-12', 'RCP-19']);
    const startable = await get('/api/work?filter=ready_to_start', workResponse);
    for (const i of startable.items) {
      expect(i.status).toBe('ready');
      expect(i.blocked).toBe(false);
      expect(i.lead).toBeNull();
    }
    const epic = await get('/api/work?epic=RCP-2', workResponse);
    expect(epic.items.map((i) => i.id).sort()).toEqual(['RCP-15', 'RCP-21', 'RCP-25']);
    const label = await get('/api/work?label=ui-refresh&scope=RCP', workResponse);
    expect(label.items.map((i) => i.id).sort()).toEqual(['RCP-12', 'RCP-23', 'RCP-25', 'RCP-27']);
  });

  it('B43: the quick filter, checks that narrow, shows that add back, and the counts', async () => {
    sql().prepare("UPDATE items SET status = 'canceled' WHERE id = 'RCP-27'").run();
    const active = await get('/api/work?quick=active', workResponse);
    expect(active.items.map((i) => i.id)).not.toContain('RCP-11');
    expect(active.items.map((i) => i.id)).not.toContain('RCP-27');
    expect(active.items.every((i) => i.status !== 'done' && i.status !== 'canceled')).toBe(true);
    expect(active.filter_counts.quick.active).toBe(active.items.length);
    expect(active.filter_counts.show).toEqual({ done: 2, canceled: 1 });

    // Shows done and Shows canceled add those items back: Active with both is everything.
    const everything = await get('/api/work?show=done,canceled', workResponse);
    expect(everything.items).toHaveLength(active.items.length + 3);
    expect(everything.items.map((i) => i.id)).toEqual(
      expect.arrayContaining(['RCP-11', 'DOC-2', 'RCP-27']),
    );

    // In progress, and a check that narrows it (AND).
    const progress = await get('/api/work?quick=progress', workResponse);
    expect(progress.items.every((i) => i.status === 'progress')).toBe(true);
    expect(progress.items.length).toBe(active.filter_counts.quick.progress);
    const live = await get('/api/work?quick=progress&has=live_run', workResponse);
    expect(live.items.map((i) => i.id)).toEqual(['RCP-14']);
    // Counts are faceted: each chip counts what it would show with the ticked checks kept.
    expect(live.filter_counts.quick.progress).toBe(1);
    expect(live.filter_counts.has.live_run).toBe(1);

    // Has a problem: items with an open problem (the seed's date risk on RCP-16).
    const problems = await get('/api/work?has=has_problem', workResponse);
    expect(problems.items.map((i) => i.id)).toContain('RCP-16');
    expect(problems.filter_counts.has.has_problem).toBe(problems.items.length);

    // Counts follow the epic scope.
    const epic = await get('/api/work?epic=RCP-2&show=done', workResponse);
    expect(epic.filter_counts.quick.active).toBe(epic.items.length);

    // An unknown key is a validation error.
    const bad = await s.request('/api/work?has=nope', { headers: { cookie } });
    expect(bad.status).toBe(400);
  });

  it('archived items leave every view but the Archived filter', async () => {
    sql().prepare("UPDATE items SET archived_at = ? WHERE id = 'DOC-2'").run(NOW.toISOString());
    const all = await get('/api/work', workResponse);
    expect(all.items.map((i) => i.id)).not.toContain('DOC-2');
    expect(all.filter_counts.archived).toBe(1);
    const archived = await get('/api/work?filter=archived', workResponse);
    expect(archived.items.map((i) => i.id)).toEqual(['DOC-2']);
  });

  it('Timeline (US8): dated tickets, the seed’s RCP-16 date risk, undated items and forecast lanes', async () => {
    const w = await get('/api/work?layout=timeline&scope=RCP', workResponse);
    const t = w.timeline!;
    expect(t).not.toBeNull();
    const rcp16 = t.rows.find((r) => r.id === 'RCP-16')!;
    expect(rcp16.blockers.filter((b) => b.risky).map((b) => b.id)).not.toEqual([]);
    expect(t.rows.some((r) => r.type === 'Epic')).toBe(false);
    expect(t.undated).toContain('RCP-20');
    expect(t.forecasts.map((f) => f.project)).toEqual(['RCP']);
    expect(t.forecasts[0]!.forecast.available).toBe(false);
  });

  it('burn-down (US8): 28 days, open effort and the unestimated count', async () => {
    const b = await get('/api/burndown?scope=RCP', burndownResponse);
    expect(b.series).toHaveLength(28);
    expect(b.window_days).toBe(28);
    expect(b.open_effort).toBeGreaterThan(0);
    expect(b.not_estimated).toBeGreaterThan(0);
    expect(b.forecast).toMatchObject({ available: false });
  });
});

describe('GET /api/items/:id', () => {
  it('a ticket: the full item, checklist, runs, plan history, decisions and activity', async () => {
    const d: ItemDetailResponse = await get('/api/items/RCP-14', itemDetailResponse);
    expect(d.item).toMatchObject({ id: 'RCP-14', status: 'progress', epic: 'RCP-1' });
    expect(d.item.lead).toMatchObject({ client: 'claude', label: 'orca-w3', run_state: 'live' });
    expect(d.item.checklist.work.length).toBeGreaterThan(0);
    expect(d.item.runs[0]).toMatchObject({ is_lead: true, run_state: 'live' });
    expect(d.children).toEqual([]);
    expect(d.plan_history.map((v) => v.version_no)).toEqual([1, 2, 3]);
    expect(d.plan_history[2]!.reason).toBe('Reminders API not reachable from the container');
    // RCP-14 is in epic RCP-1, which has the owner's metric-units decision.
    expect(d.decisions.map((x) => x.id)).toEqual(['dec_1']);
    expect(d.activity.length).toBeGreaterThan(0);
    const seqs = d.activity.map((a) => Number(a.cursor));
    expect([...seqs].sort((a, b) => b - a)).toEqual(seqs);
    expect(d.activity.every((a) => a.item_id === 'RCP-14' && a.project === 'RCP')).toBe(true);
    expect(d.open_packet).toBeNull();
    expect(d.label_briefs).toEqual([]);
  });

  it('a ticket in review: the open packet, and label decisions in scope', async () => {
    const d = await get('/api/items/RCP-12', itemDetailResponse);
    expect(d.open_packet).toMatchObject({ round: 2, stale: false, to_verify: 2 });
    // "about 10 min" on the packet banner comes from the packet's own estimate.
    const est = s.runtime.db.sqlite
      .prepare("SELECT estimate FROM packets WHERE item_id = 'RCP-12' AND state = 'open'")
      .get() as { estimate: string | null };
    expect(d.open_packet!.estimate).toBe(est.estimate);
    expect(d.from_review).toBeNull();
    expect(d.decisions.map((x) => x.id).sort()).toEqual(['dec_1', 'dec_3']);
    const owner = d.decisions.findIndex((x) => x.authority === 'owner');
    expect(owner).toBe(0);
  });

  it('a ticket made by a review decision: the from-review banner data', async () => {
    const hr = s.runtime.db.sqlite
      .prepare("SELECT id, text FROM hr_items WHERE item_id = 'RCP-12' LIMIT 1")
      .get() as { id: string; text: string };
    s.runtime.db.sqlite
      .prepare("UPDATE items SET from_review = ? WHERE id = 'RCP-17'")
      .run(JSON.stringify({ item_id: 'RCP-12', round: 1, hr_item_id: hr.id }));
    const d = await get('/api/items/RCP-17', itemDetailResponse);
    expect(d.from_review).toEqual({
      item_id: 'RCP-12',
      round: 1,
      hr_item_id: hr.id,
      text: hr.text,
    });
  });

  it('an epic: its children and its own decisions', async () => {
    const d = await get('/api/items/RCP-1', itemDetailResponse);
    expect(d.item.type).toBe('Epic');
    expect(d.children).toHaveLength(12);
    expect(d.children.every((c) => c.epic === 'RCP-1')).toBe(true);
    // Each child says whether it's for you, matching Work's for-you rows ("n for you", UI_SPEC §6.3).
    const w = await get('/api/work', workResponse);
    const forYou = new Set(w.items.filter((i) => i.for_you).map((i) => i.id));
    for (const c of d.children) expect(c.for_you, c.id).toBe(forYou.has(c.id));
    expect(d.decisions.map((x) => x.id)).toEqual(['dec_1']);
  });

  it('the owner reading an item delivers nothing to the agent (§5.7)', async () => {
    sql()
      .prepare(
        "INSERT INTO owner_notes (id, item_id, text, created_at, updated_at) VALUES ('on_1', 'DOC-4', 'Use per serving.', ?, ?)",
      )
      .run(NOW.toISOString(), NOW.toISOString());
    const d = await get('/api/items/DOC-4', itemDetailResponse);
    expect(d.notes_unread).toBe(1);
    expect(d.item.open_question?.text).toContain('per serving');
    expect(
      sql().prepare("SELECT read_by_agent_at FROM owner_notes WHERE id = 'on_1'").get(),
    ).toEqual({ read_by_agent_at: null });
  });

  it('an unknown item is not_found', async () => {
    const res = await s.request('/api/items/RCP-999', { headers: { cookie } });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('not_found');
    results.push({ route: 'GET /api/items/RCP-999', result: '404 not_found', ms: 0 });
  });
});

describe('GET /api/runs/:id/custody', () => {
  it('finds an exact historical ended run omitted from the bounded Agents view without a wake', async () => {
    const old = sql().prepare("SELECT id FROM runs WHERE state = 'failed' LIMIT 1").get() as {
      id: string;
    };
    const oldAt = '2000-01-01T00:00:00.000Z';
    sql()
      .prepare('UPDATE runs SET updated_at = ?, orchestrator = ? WHERE id = ?')
      .run(oldAt, JSON.stringify({ dispatch_id: 'ctx_historical' }), old.id);
    const insert = sql().prepare(
      `INSERT INTO runs
       (id, item_id, client, is_lead, state, last_signal_at, last_signal_kind, created_at, updated_at)
       VALUES (?, 'RCP-18', 'synthetic', 0, 'finished', ?, 'report', ?, ?)`,
    );
    for (let n = 0; n < 210; n += 1) {
      const at = new Date(Date.parse(NOW.toISOString()) + n * 1000).toISOString();
      insert.run(`run_recent_${n}`, at, at, at);
    }
    const recent = await get('/api/agents', agentsResponse);
    expect(recent.rows.some((row) => row.run_id === old.id)).toBe(false);

    const before = sql()
      .prepare('SELECT version, last_signal_at, updated_at FROM runs WHERE id = ?')
      .get(old.id);
    const exact = await get(`/api/runs/${old.id}/custody`, runCustodyResponse);
    expect(exact).toEqual({
      run_id: old.id,
      item_id: 'RCP-18',
      dispatch_id: 'ctx_historical',
      run_state: 'failed',
      lease: 'released',
      at: oldAt,
    });
    expect(
      sql()
        .prepare('SELECT version, last_signal_at, updated_at FROM runs WHERE id = ?')
        .get(old.id),
    ).toEqual(before);
  });

  it('returns no custody for an unknown run and does not expose private run fields', async () => {
    const missing = await s.request('/api/runs/run_missing/custody', { headers: { cookie } });
    expect(missing.status).toBe(404);
    const row = sql().prepare('SELECT id FROM runs LIMIT 1').get() as { id: string };
    const raw = await s.request(`/api/runs/${row.id}/custody`, { headers: { cookie } });
    expect(raw.status).toBe(200);
    const response = (await raw.json()) as Record<string, unknown>;
    expect(runCustodyResponse.safeParse(response).success).toBe(true);
    expect(Object.keys(response).sort()).toEqual(
      ['at', 'dispatch_id', 'item_id', 'lease', 'run_id', 'run_state'].sort(),
    );
  });
});

describe('GET /api/agents', () => {
  it('sorts needs input, stale, failed, live, reported, then the rest by recency', async () => {
    const a: AgentsResponse = await get('/api/agents', agentsResponse);
    const head = a.rows.slice(0, 5).map((r) => `${r.run_state}:${r.item_id}`);
    expect(head).toEqual([
      'needs_input:DOC-4',
      'stale:RCP-15',
      'failed:RCP-18',
      'live:RCP-14',
      'reported:RCP-23',
    ]);
    const byItem = (id: string) => a.rows.find((r) => r.item_id === id && r.row_kind === 'run')!;
    expect(byItem('RCP-14')).toMatchObject({ lease: 'held', provenance: null });
    expect(byItem('DOC-4')).toMatchObject({ lease: 'paused', doing: 'Waiting on your answer' });
    expect(byItem('RCP-15')).toMatchObject({ lease: 'expired' });
    expect(byItem('RCP-18')).toMatchObject({ lease: 'released' });
    // A report without a session signal is agent-reported, never shown as a heartbeat.
    expect(byItem('RCP-23')).toMatchObject({ provenance: 'agent' });
    // Subagent log entries are "log entry" rows with their provenance.
    const log = a.rows.find((r) => r.row_kind === 'subagent_log');
    expect(log).toMatchObject({ run_state: null, item_id: 'RCP-14' });
    expect(['observed', 'relayed']).toContain(log!.provenance);
    // The rest are ended runs and log entries, newest first.
    const rest = a.rows.slice(5);
    expect(
      rest.every((r) => r.run_state === null || ['finished', 'interrupted'].includes(r.run_state)),
    ).toBe(true);
    expect([...rest.map((r) => r.at)].sort().reverse()).toEqual(rest.map((r) => r.at));
  });

  it('scopes to one project', async () => {
    const a = await get('/api/agents?scope=DOC', agentsResponse, 'GET /api/agents?scope=DOC');
    expect(a.rows.every((r) => r.project === 'DOC')).toBe(true);
    expect(a.rows[0]).toMatchObject({ item_id: 'DOC-4', run_state: 'needs_input' });
  });
});

describe('GET /api/search', () => {
  it('finds items, labels and views', async () => {
    const r: SearchResponse = await get('/api/search?q=pantry', searchResponse);
    expect(r.items.map((i) => i.id)).toEqual(expect.arrayContaining(['RCP-2', 'RCP-15', 'RCP-25']));
    const ui = await get('/api/search?q=ui', searchResponse);
    expect(ui.labels).toEqual([{ project: 'RCP', name: 'ui-refresh' }]);
    const views = await get('/api/search?q=work', searchResponse);
    expect(views.views.map((v) => v.key)).toEqual(['work', 'timeline']);
  });

  it('puts an exact ID first, and finds archived and imported items by Jira key', async () => {
    const exact = await get('/api/search?q=RCP-14', searchResponse);
    expect(exact.items[0]).toMatchObject({ id: 'RCP-14', archived: false });
    sql().prepare("UPDATE items SET archived_at = ? WHERE id = 'DOC-2'").run(NOW.toISOString());
    const archived = await get('/api/search?q=skeleton', searchResponse);
    expect(archived.items.map((i) => [i.id, i.archived])).toEqual([['DOC-2', true]]);
    const key = (
      sql().prepare("SELECT jira_key FROM items WHERE id = 'DOC-7'").get() as {
        jira_key: string;
      }
    ).jira_key;
    expect(key).toBeTruthy();
    const jira = await get(
      `/api/search?q=${encodeURIComponent(key)}`,
      searchResponse,
      'GET /api/search?q=<jira key>',
    );
    expect(jira.items[0]).toMatchObject({ id: 'DOC-7', jira_key: key });
  });

  it('finds a sub-task key held in a step source: the parent item, with the step named (B35)', async () => {
    const steps = sql()
      .prepare(
        "SELECT id, text, item_id FROM work_steps WHERE item_id IN ('RCP-14', 'RCP-15') ORDER BY item_id, position",
      )
      .all() as { id: string; text: string; item_id: string }[];
    const mine = steps.find((x) => x.item_id === 'RCP-14')!;
    const other = steps.find((x) => x.item_id === 'RCP-15')!;
    const setSource = sql().prepare('UPDATE work_steps SET source = ? WHERE id = ?');
    setSource.run('GAMEFLOW-227', mine.id);
    // A longer key that only starts with the query doesn't match.
    setSource.run('Jira GAMEFLOW-2270', other.id);
    const r = await get(
      '/api/search?q=gameflow-227',
      searchResponse,
      'GET /api/search?q=<sub-task key>',
    );
    expect(r.items[0]).toMatchObject({
      id: 'RCP-14',
      matched: 'step_source',
      step: { id: mine.id, text: mine.text, source: 'GAMEFLOW-227' },
    });
    expect(r.items.map((i) => i.id)).not.toContain('RCP-15');
    // Inside a longer source, as a whole word.
    setSource.run('from Jira GAMEFLOW-2270 (sub-task)', other.id);
    const longer = await get('/api/search?q=GAMEFLOW-2270', searchResponse);
    expect(longer.items[0]).toMatchObject({ id: 'RCP-15', matched: 'step_source' });

    // An exact item Jira key still ranks first, with no step.
    sql().prepare("UPDATE items SET jira_key = 'GAMEFLOW-227' WHERE id = 'DOC-7'").run();
    const both = await get('/api/search?q=GAMEFLOW-227', searchResponse);
    expect(both.items.map((i) => i.id).slice(0, 2)).toEqual(['DOC-7', 'RCP-14']);
    expect(both.items[0]!.matched).toBeUndefined();
    expect(both.items[1]!.matched).toBe('step_source');
  });

  it('answers nothing for punctuation alone', async () => {
    const r = await get('/api/search?q=%22%2A', searchResponse, 'GET /api/search?q="*');
    expect(r.items).toEqual([]);
  });
});

describe('GET /api/stream', () => {
  it('pushes an agent change, with for_you false for a claim and true for a question', async () => {
    const res = await s.request('/api/stream', { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    setTimeout(() => {
      const agent = {
        kind: 'agent' as const,
        client: 'claude',
        label: null,
        session_id: 'sess-claude',
        run_id: null,
      };
      s.runtime.write.run({ actor: agent, operation: 'claim_lead', args: {} }, (w) =>
        s.runtime.services.runs.claim(w, { id: 'RCP-17' }),
      );
      s.runtime.write.run({ actor: agent, operation: 'test', args: {} }, (w) => {
        w.event({
          type: 'question.asked',
          summary: 'claude asked a question',
          item_id: 'RCP-17',
          project_key: 'RCP',
        });
        return null;
      });
    }, 50);
    const text = await readUntil(res, (t) => t.includes('question.asked'));
    const messages = text
      .split('\n\n')
      .filter((b) => b.includes('event: change'))
      .map((b) => JSON.parse(/^data: (.*)$/m.exec(b)![1]!) as Record<string, unknown>);
    const claim = messages.find((m) => m.type === 'claim.granted');
    expect(claim).toMatchObject({ for_you: false });
    expect(claim!.objects).toEqual(expect.arrayContaining([{ kind: 'item', id: 'RCP-17' }]));
    expect(messages.find((m) => m.type === 'question.asked')).toMatchObject({ for_you: true });
    results.push({ route: 'GET /api/stream', result: '200 SSE, for_you only on question', ms: 0 });
  });
});

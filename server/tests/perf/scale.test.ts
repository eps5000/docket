/**
 * Performance at the stated scale (tasks.md T143; SC-013; BUILD_SPEC §10):
 * 20 projects, 5,000 items and 100,000 events. Owner views must answer in
 * under 1 s, and agent calls must have a p95 under 500 ms.
 *
 * On demand only (not in every CI run): `pnpm --filter @docket/server perf`
 * (vitest.perf.config.ts). It prints a timing table for the PR. With
 * DOCKET_PERF_KEEP=<dir> it also keeps the data set (database, documents,
 * secrets), to load into a throwaway volume and time the screens in a browser.
 *
 * The data: the sample seed (2 projects), plus 18 generated projects built
 * through the domain services (items with epics, labels, effort and planned
 * dates; `blocks` links, cross-project ones included). Statuses are then
 * spread (a fixture write, with a status event for each move), and the
 * event log is padded to 100,000 rows with realistic item events spread
 * over a year. Owner views go through the UI API with an owner session;
 * agent calls go through the official MCP SDK client, as a real agent's do.
 */
import { cpSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Actor } from '../../src/domain/write.js';
import { startHarness, type ContractHarness } from '../contract/harness.js';
import { ORIGIN, parseSetCookies } from '../integration/harness.js';

const PROJECTS = 20;
const ITEMS = 5_000;
const EVENTS = 100_000;
const OWNER_BUDGET_MS = 1_000;
const AGENT_P95_MS = 500;
const RUNS_PER_CALL = 30;

let h: ContractHarness;
let cookie = '';
let csrf = '';
const rows: {
  kind: 'owner' | 'agent';
  name: string;
  n: number;
  p50: number;
  p95: number;
  max: number;
}[] = [];

const sql = () => h.server.runtime.db.sqlite;
const count = (table: string) =>
  (sql().prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

function stats(samples: number[]) {
  const s = [...samples].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)]!;
  return { n: s.length, p50: at(0.5), p95: at(0.95), max: s[s.length - 1]! };
}

/** Generate the data set (see the header). */
function generate(): void {
  const runtime = h.server.runtime;
  const now = h.server.clock.now();
  const nowIso = now.toISOString();
  const agent: Actor = {
    kind: 'agent',
    client: 'claude',
    label: 'perf',
    session_id: 'sess-perf',
    run_id: null,
  };
  const write = <T>(fn: Parameters<typeof runtime.write.run>[1]) =>
    runtime.write.run({ actor: agent, operation: 'perf', args: {}, idempotencyKey: null }, fn)
      .result as T;

  const insertProject = sql().prepare(
    `INSERT INTO projects (id, key, name, short_name, color, next_seq, default_satisfied_when, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, '#3b5bdb', 1, 'done', 1, ?, ?)`,
  );
  const existing = count('projects');
  const keys: string[] = [];
  for (let p = 0; existing + keys.length < PROJECTS; p++) {
    const key = `PX${String.fromCharCode(65 + p)}`;
    insertProject.run(`prj_${key}`, key, `Perf project ${p}`, `Perf ${p}`, nowIso, nowIso);
    keys.push(key);
  }

  const perProject = Math.ceil((ITEMS - count('items')) / keys.length);
  const day = (offset: number) =>
    new Date(now.getTime() + offset * 86_400_000).toISOString().slice(0, 10);
  const all: string[] = [];
  for (const [pi, key] of keys.entries()) {
    const epics: string[] = [];
    for (let e = 0; e < 6 && all.length < ITEMS; e++) {
      const { id } = write<{ id: string }>((w) =>
        runtime.services.items.create(w, {
          project: key,
          type: 'Epic',
          title: `Epic ${e} of ${key}: a deliverable the owner would recognise`,
          priority: 2,
          status: 'planning',
          outcome_md: 'Users can do the thing this epic delivers.',
        } as never),
      );
      epics.push(id);
    }
    for (let i = epics.length; i < perProject && count('items') < ITEMS; i++) {
      const dated = i % 4 === 0;
      const { id } = write<{ id: string }>((w) =>
        runtime.services.items.create(w, {
          project: key,
          type: (['Story', 'Task', 'Bug'] as const)[i % 3],
          title: `Item ${i} in ${key}: implement part ${i} of the feature`,
          priority: ((i % 3) + 1) as 1 | 2 | 3,
          status: 'planning',
          epic: epics[i % epics.length],
          labels: [`area-${i % 5}`, ...(i % 7 === 0 ? ['ui-refresh'] : [])],
          effort: (i % 8) + 1,
          description_md: `Detailed description for item ${i}. `.repeat(4),
          acceptance: ['It works as described', 'Tests cover it'],
          ...(dated ? { planned_start: day((i % 30) - 10), planned_end: day((i % 30) - 3) } : {}),
        } as never),
      );
      all.push(id);
    }
    // Chains of `blocks` links inside the project, and a few across projects.
    const items = all.slice(-(perProject - epics.length));
    for (let i = 1; i < items.length; i += 3) {
      write((w) =>
        runtime.services.links.link(w, { from: items[i - 1]!, to: items[i]!, type: 'blocks' }),
      );
    }
    if (pi > 0) {
      write((w) =>
        runtime.services.links.link(w, {
          from: all[pi * 10]!,
          to: items[items.length - 1]!,
          type: 'blocks',
        }),
      );
    }
  }

  // Spread statuses: 35% done, 10% review, 15% in progress, 25% ready, the rest planning.
  const setStatus = sql().prepare(
    'UPDATE items SET status = ?, version = version + 1 WHERE id = ?',
  );
  const insertEvent = sql().prepare(
    `INSERT INTO events (at, actor_kind, client, label, project_key, item_id, type, summary, data, mutation_id)
     VALUES (?, 'agent', 'claude', 'perf', ?, ?, ?, ?, ?, ?)`,
  );
  const yearAgo = now.getTime() - 365 * 86_400_000;
  sql().transaction(() => {
    all.forEach((id, i) => {
      const r = i % 20;
      const status =
        r < 7 ? 'done' : r < 9 ? 'review' : r < 12 ? 'progress' : r < 17 ? 'ready' : 'planning';
      if (status === 'planning') return;
      setStatus.run(status, id);
      insertEvent.run(
        new Date(now.getTime() - (i % 25) * 86_400_000).toISOString(),
        id.split('-')[0],
        id,
        'item.status_changed',
        `${id} moved to ${status}`,
        JSON.stringify({ status: { old: 'planning', new: status } }),
        `mut_perf_s${i}`,
      );
    });
    // Pad the log to 100,000 events: edits and notes, spread over a year.
    const missing = EVENTS - count('events');
    for (let k = 0; k < missing; k++) {
      const id = all[k % all.length]!;
      const at = new Date(yearAgo + Math.floor(((now.getTime() - 60_000 - yearAgo) * k) / missing));
      const edit = k % 3 !== 0;
      insertEvent.run(
        at.toISOString(),
        id.split('-')[0],
        id,
        edit ? 'item.updated' : 'note.added',
        edit ? `claude updated ${id}: description` : `claude noted on ${id}: progress`,
        JSON.stringify(
          edit
            ? { changed: { description_md: { old: 'a', new: 'b' } } }
            : { text: 'Progress: tests pass locally.' },
        ),
        `mut_perf_e${k}`,
      );
    }
  })();
}

async function owner(path: string): Promise<{ status: number; ms: number }> {
  const t0 = performance.now();
  const res = await h.server.app.request(`${ORIGIN}${path}`, {
    headers: { cookie, 'x-csrf-token': csrf },
  });
  await res.text();
  return { status: res.status, ms: performance.now() - t0 };
}

beforeAll(async () => {
  const t0 = performance.now();
  h = await startHarness({ log: () => {} });
  generate();
  const unlock = await h.server.app.request(`${ORIGIN}/api/session/unlock`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ key: h.server.runtime.secrets.ownerKey() }),
  });
  const cookies = parseSetCookies(unlock);
  cookie = Object.entries(cookies)
    .map(([k, v]) => `${k}=${v.value}`)
    .join('; ');
  csrf = ((await unlock.json()) as { csrf_token?: string }).csrf_token ?? '';
  console.log(
    `Generated in ${((performance.now() - t0) / 1000).toFixed(1)} s: ${count('projects')} projects, ${count('items')} items, ${count('events')} events, ${count('links')} links`,
  );
}, 600_000);

afterAll(async () => {
  const fmt = (n: number) => n.toFixed(1).padStart(7);
  const lines = [
    '',
    `| Kind | Call | n | p50 ms | p95 ms | max ms |`,
    `|---|---|---|---|---|---|`,
    ...rows.map(
      (r) => `| ${r.kind} | ${r.name} | ${r.n} | ${fmt(r.p50)} | ${fmt(r.p95)} | ${fmt(r.max)} |`,
    ),
  ];
  console.log(lines.join('\n'));
  // DOCKET_PERF_KEEP=<dir>: keep the data set, to time the screens in a browser against it.
  const keep = process.env.DOCKET_PERF_KEEP;
  if (keep && h) {
    mkdirSync(keep, { recursive: true });
    sql().prepare('VACUUM INTO ?').run(join(keep, 'tasklite.db'));
    const paths = h.server.runtime.config.paths;
    cpSync(paths.docs, join(keep, 'docs'), { recursive: true });
    cpSync(paths.secrets, join(keep, 'secrets'), { recursive: true });
    console.log(`Kept the data set in ${keep}`);
  }
  await h?.close();
});

describe('scale (T143, SC-013): 20 projects, 5,000 items, 100,000 events', () => {
  it('has the data set', () => {
    expect(count('projects')).toBe(PROJECTS);
    expect(count('items')).toBeGreaterThanOrEqual(ITEMS);
    expect(count('events')).toBeGreaterThanOrEqual(EVENTS);
  });

  const someEpic = () =>
    (
      sql()
        .prepare("SELECT id FROM items WHERE type = 'Epic' AND project_key = 'PXF' LIMIT 1")
        .get() as {
        id: string;
      }
    ).id;
  const someItem = () =>
    (
      sql()
        .prepare(
          "SELECT id FROM items WHERE type <> 'Epic' AND project_key = 'PXF' AND status = 'progress' LIMIT 1",
        )
        .get() as { id: string }
    ).id;

  it('owner views answer in under 1 s', async () => {
    const views: [string, string][] = [
      ['bootstrap', '/api/bootstrap'],
      ['Needs you (all)', '/api/needs-you?scope=all'],
      ['Work board (all)', '/api/work?scope=all'],
      ['Work list (all)', '/api/work?scope=all&layout=list'],
      ['Work map (all)', '/api/work?scope=all&layout=map'],
      ['Work timeline (all)', '/api/work?scope=all&layout=timeline'],
      ['Work board (one project)', '/api/work?scope=PXF'],
      ['Work map (one epic)', `/api/work?scope=all&layout=map&epic=${someEpic()}`],
      ['Burn-down (all)', '/api/burndown?scope=all'],
      ['Epic page', `/api/items/${someEpic()}`],
      ['Ticket page', `/api/items/${someItem()}`],
      ['Label page', '/api/labels/PXF/area-1'],
      ['Agents', '/api/agents'],
      ['Workspaces', '/api/workspaces'],
      ['Settings', '/api/settings'],
      ['Decisions (one project)', '/api/decisions?project=PXF'],
      ['Palette search', '/api/search?q=feature'],
    ];
    const slow: string[] = [];
    for (const [name, path] of views) {
      await owner(path); // warm the statement cache once
      const samples: number[] = [];
      for (let i = 0; i < 5; i++) {
        const r = await owner(path);
        expect(r.status, `${name} ${path}`).toBe(200);
        samples.push(r.ms);
      }
      const s = stats(samples);
      rows.push({ kind: 'owner', name, ...s });
      if (s.max >= OWNER_BUDGET_MS) slow.push(`${name}: ${s.max.toFixed(0)} ms`);
    }
    expect(slow).toEqual([]);
  }, 600_000);

  it('agent calls have a p95 under 500 ms', async () => {
    const ready = sql()
      .prepare(
        `SELECT i.id FROM items i WHERE i.status = 'ready' AND i.type <> 'Epic' AND i.project_key LIKE 'PX%'
           AND NOT EXISTS (SELECT 1 FROM links l WHERE l.to_id = i.id AND l.type = 'blocks')
         ORDER BY i.id LIMIT ?`,
      )
      .all(RUNS_PER_CALL) as { id: string }[];
    const item = someItem();
    const reads: [string, Record<string, unknown>][] = [
      ['whoami', {}],
      ['list_projects', {}],
      ['search_items', { project: 'PXF', filter: 'ready_to_start', limit: 5 }],
      ['search_items', { filter: 'ready_to_start', limit: 25 }],
      ['search_items', { text: 'feature part', limit: 25 }],
      ['get_item', { id: item, view: 'summary' }],
      ['get_item', { id: item }],
      ['get_context', { id: item }],
      ['dependency_subgraph', { id: someEpic(), depth: 3 }],
      ['get_changes', { limit: 50 }],
      ['recovery_report', {}],
    ];
    const slow: string[] = [];
    const time = async (name: string, args: Record<string, unknown>) => {
      const t0 = performance.now();
      const res = await h.call(name, args);
      const ms = performance.now() - t0;
      expect(
        res.isError,
        `${name} ${JSON.stringify(args)}: ${JSON.stringify(res.content)}`,
      ).toBeFalsy();
      return ms;
    };
    for (const [name, args] of reads) {
      await time(name, args);
      const samples: number[] = [];
      for (let i = 0; i < RUNS_PER_CALL; i++) samples.push(await time(name, args));
      const s = stats(samples);
      const label = `${name} ${JSON.stringify(args)}`;
      rows.push({ kind: 'agent', name: label, ...s });
      if (s.p95 >= AGENT_P95_MS) slow.push(`${label}: p95 ${s.p95.toFixed(0)} ms`);
    }

    // The write loop of US1, once per ready item: claim, plan, step, heartbeat, release.
    const writes: Record<string, number[]> = {
      claim_lead: [],
      set_plan: [],
      update_step: [],
      heartbeat: [],
      release_lead: [],
    };
    for (const { id } of ready) {
      const t0 = performance.now();
      const claim = await h.call('claim_lead', { id, agent_label: 'perf' });
      writes.claim_lead!.push(performance.now() - t0);
      expect(claim.isError, JSON.stringify(claim.content)).toBeFalsy();
      const runId = (claim.structuredContent as { run_id: string }).run_id;
      const t1 = performance.now();
      const plan = await h.call('set_plan', {
        id,
        run_id: runId,
        reason: 'Perf run',
        steps: [{ text: 'Write the test' }, { text: 'Make it pass' }],
      });
      writes.set_plan!.push(performance.now() - t1);
      expect(plan.isError, JSON.stringify(plan.content)).toBeFalsy();
      const stepId = (plan.structuredContent as { work: { id: string }[] }).work[0]!.id;
      writes.update_step!.push(
        await time('update_step', { id, run_id: runId, step_id: stepId, state: 'current' }),
      );
      writes.heartbeat!.push(await time('heartbeat', { run_id: runId, note: 'working' }));
      writes.release_lead!.push(await time('release_lead', { id, run_id: runId, reason: 'perf' }));
    }
    for (const [name, samples] of Object.entries(writes)) {
      const s = stats(samples);
      rows.push({ kind: 'agent', name, ...s });
      if (s.p95 >= AGENT_P95_MS) slow.push(`${name}: p95 ${s.p95.toFixed(0)} ms`);
    }
    expect(slow).toEqual([]);
  }, 600_000);
});

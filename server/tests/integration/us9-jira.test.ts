/**
 * Jira import end to end over the UI API (tasks.md T139; spec US9;
 * FR-090–FR-092; SC-011; BUILD_SPEC §9).
 *
 * The Jira site is the synthetic fixture (tests/fixtures/jira/site.mjs),
 * reached through a stubbed global `fetch` that refuses every other host:
 * nothing here touches a network.
 *
 * - **The dry run writes nothing:** checksums of every table and every file
 *   in the data directory before and after (over HTTP, where only the owner
 *   session's last-seen time may move; and through the service directly,
 *   where even the database files are byte-identical).
 * - **The commit is atomic:** a failure late in the transaction leaves no
 *   project, item, link, label, event or document behind; a good one writes
 *   it all, with `jira_key`, `imported`, events stamped at import time and
 *   Jira's dates kept as data. Attachments download afterwards; a failed
 *   one is listed and doesn't undo anything.
 * - **The token appears nowhere:** the whole data directory (database, WAL,
 *   documents, logs), every service log line and every API response are
 *   searched for it, raw and as the Basic credential.
 * - **SC-011:** the 500-issue fixture dry-runs in under 2 minutes and the
 *   report accounts for every issue.
 * - B15's tombstones: a deleted project's key is refused while its
 *   documents are still being removed, and reusable afterwards.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { JiraImport } from '@docket/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadSampleSeed } from '../../src/db/seed/loader.js';
import { readContext } from '../../src/domain/contracts.js';
import { OWNER_ACTOR } from '../../src/domain/write.js';
import { createJiraSite, type JiraSite } from '../fixtures/jira/site.mjs';
import { insertProject } from '../helpers.js';
import { createTestServer, parseSetCookies, type TestServer } from './harness.js';

/** Unique per run, and nothing like a known token format: only a by-value search finds it. */
const TOKEN = `jira-int-${randomBytes(12).toString('hex')}`;
const EMAIL = 'owner@example.test';

let site: JiraSite;
let s: TestServer;
let logs: string[];
let cookie: string;
let responses: string[];

async function unlock(server: TestServer): Promise<string> {
  const res = await server.request('/api/session/unlock', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: server.runtime.secrets.ownerKey() }),
  });
  expect(res.status).toBe(200);
  const c = parseSetCookies(res);
  return `docket_owner=${c.docket_owner!.value}; docket_csrf=${c.docket_csrf!.value}`;
}

async function api(path: string, init: { method?: string; body?: unknown } = {}) {
  const csrf = /docket_csrf=([^;]+)/.exec(cookie)![1]!;
  const res = await s.request(path, {
    method: init.method ?? 'GET',
    headers: { cookie, 'x-docket-csrf': csrf, 'content-type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  responses.push(text);
  return {
    status: res.status,
    body: JSON.parse(text) as Record<string, unknown> & {
      import: JiraImport;
      error?: { code: string; message: string };
    },
  };
}

function dryRunBody(over: Record<string, unknown> = {}) {
  return {
    site_url: site.origin,
    email: EMAIL,
    api_token: TOKEN,
    jira_project: 'TL',
    target: { kind: 'new', key: 'TLI', name: 'Till import' },
    ...over,
  };
}

async function waitFor(
  id: string,
  states: JiraImport['state'][],
  timeoutMs = 30_000,
): Promise<JiraImport> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const { status, body } = await api(`/api/import/jira/${id}`);
    expect(status).toBe(200);
    if (states.includes(body.import.state)) return body.import;
    if (Date.now() > until) throw new Error(`import ${id} stayed ${body.import.state}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

async function dryRun(over: Record<string, unknown> = {}): Promise<JiraImport> {
  const { status, body } = await api('/api/import/jira/dry-run', {
    method: 'POST',
    body: dryRunBody(over),
  });
  expect(status, JSON.stringify(body)).toBe(200);
  return body.import;
}

// ---- Checksums ----

const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

/** Every table's rows, hashed in rowid order. `skip` names tables left out (session bookkeeping). */
function tableChecksums(server: TestServer, skip: string[] = []): Record<string, string> {
  const sql = server.runtime.db.sqlite;
  const tables = (
    sql
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[]
  ).map((t) => t.name);
  const out: Record<string, string> = {};
  for (const t of tables) {
    if (skip.includes(t)) continue;
    let rows: unknown[];
    try {
      rows = sql.prepare(`SELECT * FROM "${t}" ORDER BY rowid`).all();
    } catch {
      rows = sql.prepare(`SELECT * FROM "${t}"`).all();
    }
    out[t] = sha(
      JSON.stringify(rows, (_k, v: unknown) => (Buffer.isBuffer(v) ? v.toString('hex') : v)),
    );
  }
  return out;
}

/** Every file under the data directory (relative path → sha256). */
function fileChecksums(
  dir: string,
  skip: (rel: string) => boolean = () => false,
): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      const rel = relative(dir, full).replace(/\\/g, '/');
      if (statSync(full).isDirectory()) walk(full);
      else if (!skip(rel)) out[rel] = sha(readFileSync(full));
    }
  };
  walk(dir);
  return out;
}

const isDbFile = (rel: string) => /^tasklite\.db(-wal|-shm)?$/.test(rel);
/** SQLite's shared-memory index: every reader updates its read marks there. It holds no data. */
const isShm = (rel: string) => rel === 'docket.db-shm';

/** Every file under `dir` whose bytes contain any needle. */
function filesContaining(dir: string, needles: string[]): string[] {
  const found: string[] = [];
  const bytes = needles.flatMap((n) => [Buffer.from(n, 'utf8'), Buffer.from(n, 'utf16le')]);
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else {
        const data = readFileSync(full);
        if (bytes.some((b) => data.includes(b))) found.push(relative(dir, full));
      }
    }
  };
  walk(dir);
  return found;
}

const count = (sql: string, ...args: unknown[]) =>
  (s.runtime.db.sqlite.prepare(sql).get(...args) as { n: number }).n;

beforeEach(async () => {
  site = createJiraSite({ email: EMAIL, token: TOKEN, slowDelayMs: 300 });
  vi.stubGlobal('fetch', site.fetch);
  logs = [];
  responses = [];
  s = createTestServer({ log: (l) => logs.push(l) });
  cookie = await unlock(s);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await s.cleanup();
});

describe('the dry run writes nothing (FR-090)', () => {
  it('over HTTP: every table (but the owner session) and every file are unchanged', async () => {
    loadSampleSeed(s.runtime.db, { now: s.clock.now(), docsDir: s.runtime.config.paths.docs });
    const tables = tableChecksums(s, ['owner_sessions']);
    const files = fileChecksums(s.dataDir, isDbFile);
    const started = await dryRun();
    expect(started).toMatchObject({
      state: 'running',
      jira_project: 'TL',
      target: { kind: 'new', key: 'TLI' },
    });
    const ready = await waitFor(started.import_id, ['ready']);
    expect(ready.report!.totals).toEqual({ issues: 22, would_import: 20, skipped: 2, lossy: 15 });
    expect(tableChecksums(s, ['owner_sessions'])).toEqual(tables);
    expect(fileChecksums(s.dataDir, isDbFile)).toEqual(files);
    expect(count("SELECT count(*) AS n FROM projects WHERE key = 'TLI'")).toBe(0);
  });

  it('through the service: the whole data directory, database and WAL included, is byte-identical', async () => {
    const before = fileChecksums(s.dataDir, isShm);
    const tables = tableChecksums(s);
    const svc = s.runtime.services.jiraImport;
    const r = () => readContext(s.runtime.db, OWNER_ACTOR, s.clock.now());
    const started = svc.dryRun(r(), {
      ...dryRunBody({ jira_project: 'BIG' }),
      target: { kind: 'new', key: 'BIG', name: 'Big' },
    });
    let current = svc.get(r(), { import_id: started.import_id });
    while (current.state === 'running') {
      await new Promise((res) => setTimeout(res, 10));
      current = svc.get(r(), { import_id: started.import_id });
    }
    expect(current.state).toBe('ready');
    expect(fileChecksums(s.dataDir, isShm)).toEqual(before);
    expect(tableChecksums(s)).toEqual(tables);
  });
});

describe('SC-011: a 500-issue project', () => {
  it('dry-runs in under 2 minutes and accounts for every issue', async () => {
    const t0 = performance.now();
    const started = await dryRun({
      jira_project: 'BIG',
      target: { kind: 'new', key: 'BIG', name: 'Big' },
    });
    const ready = await waitFor(started.import_id, ['ready'], 120_000);
    const seconds = (performance.now() - t0) / 1000;
    const r = ready.report!;
    expect(seconds).toBeLessThan(120);
    expect(r.totals.issues).toBe(500);
    expect(r.totals.would_import + r.totals.skipped).toBe(500);
    expect(r.lossy_items).toHaveLength(r.totals.lossy + r.totals.skipped);
    const steps = r.mapping
      .filter((m) => m.task_lite === 'Work step')
      .reduce((n, m) => n + m.count, 0);
    const items = r.mapping
      .filter((m) => m.jira.startsWith('Type: ') && !['Work step', 'Skipped'].includes(m.task_lite))
      .reduce((n, m) => n + m.count, 0);
    expect(items + steps + r.totals.skipped).toBe(500);
    // Evidence for the PR: the timing (it includes one real 1 s Retry-After wait) and the summary.
    console.log(
      `SC-011: 500-issue dry run in ${seconds.toFixed(2)} s · ${JSON.stringify(r.totals)} · ${items} items, ${steps} work steps · ` +
        `${r.attachments.count} attachments (${r.attachments.bytes} bytes), ${r.attachments.skipped.length} skipped · cycles ${r.cycles.length} · ` +
        `fields used ${r.fields_used.map((f) => `${f.field} → ${f.jira_field ?? 'not found'}`).join(', ')}`,
    );
  });
});

describe('the commit (FR-091)', () => {
  it('writes everything together, then downloads attachments, listing failures', async () => {
    const { import_id } = await dryRun();
    await waitFor(import_id, ['ready']);
    s.clock.advance(5 * 60_000);
    const importedAt = s.clock.now().toISOString();
    // Every commit reaches the SSE bus, the post-commit document writes too (B18).
    const published: number[][] = [];
    const onChange = (seqs: number[]) => published.push(seqs);
    s.runtime.bus.on('change', onChange);
    const commit = await api(`/api/import/jira/${import_id}/commit`, { method: 'POST' });
    expect(commit.status, JSON.stringify(commit.body)).toBe(200);
    expect(commit.body.mutation_id).toMatch(/^mut_/);
    expect(commit.body.import.state).toBe('committing');
    const done = await waitFor(import_id, ['committed']);
    s.runtime.bus.off('change', onChange);
    const docSeqs = (
      s.runtime.db.sqlite
        .prepare(
          "SELECT seq FROM events WHERE type = 'document.added' AND project_key = 'TLI' AND mutation_id != ?",
        )
        .all(commit.body.mutation_id) as { seq: number }[]
    ).map((e) => e.seq);
    expect(docSeqs.length).toBeGreaterThan(0);
    expect(published.flat()).toEqual(expect.arrayContaining(docSeqs));
    expect(done.result).toEqual({
      imported: 17,
      project: 'TLI',
      failed_attachments: [{ name: 'trace.log (TL-2)', reason: 'Jira answered 500' }],
      report_document_id: expect.stringMatching(/^doc_/),
    });

    // Records: the project, every item with its Jira key, imported, in key order.
    const items = s.runtime.db.sqlite
      .prepare(
        "SELECT id, type, title, status, priority, epic_id, jira_key, imported, closed_by, closed_at, planned_start, planned_end, effort, dates_set_by, created_at FROM items WHERE project_key = 'TLI' ORDER BY CAST(substr(id, 5) AS INTEGER)",
      )
      .all() as Record<string, unknown>[];
    expect(items).toHaveLength(17);
    expect(
      items.every(
        (i) => i.imported === 1 && typeof i.jira_key === 'string' && i.created_at === importedAt,
      ),
    ).toBe(true);
    const byJira = new Map(items.map((i) => [i.jira_key as string, i]));
    expect(byJira.get('TL-1')).toMatchObject({
      id: 'TLI-1',
      type: 'Epic',
      status: 'inbox',
      priority: 1,
    });
    expect(byJira.get('TL-2')).toMatchObject({
      id: 'TLI-2',
      type: 'Story',
      status: 'progress',
      epic_id: 'TLI-1',
      effort: 5,
      planned_start: '2026-11-20',
      planned_end: '2026-12-01',
      dates_set_by: 'Jira import',
    });
    expect(byJira.get('TL-4')).toMatchObject({
      status: 'done',
      closed_by: 'imported',
      closed_at: importedAt,
    });
    // In progress, but no lead claim and no run.
    expect(count("SELECT count(*) AS n FROM runs WHERE item_id LIKE 'TLI-%'")).toBe(0);
    // Sub-tasks: plan version 1 of TL-2's work steps.
    expect(
      s.runtime.db.sqlite
        .prepare("SELECT text, state FROM work_steps WHERE item_id = 'TLI-2' ORDER BY position")
        .all(),
    ).toEqual([
      { text: 'Add Luhn check', state: 'done' },
      { text: 'Show inline errors', state: 'current' },
      { text: 'Copy review', state: 'todo' },
    ]);
    // Links, cycle included.
    expect(count("SELECT count(*) AS n FROM links WHERE from_id LIKE 'TLI-%'")).toBe(8);
    expect(count("SELECT count(*) AS n FROM labels WHERE project_key = 'TLI'")).toBe(4);
    // Search finds the Jira key.
    const found = await api('/api/search?q=TL-2');
    expect(JSON.stringify(found.body)).toContain('TLI-2');

    // Events: stamped at import time; Jira's own dates are data.
    const events = s.runtime.db.sqlite
      .prepare("SELECT type, at, summary, data FROM events WHERE project_key = 'TLI' ORDER BY seq")
      .all() as { type: string; at: string; summary: string; data: string }[];
    const commitEvents = events.filter((e) => e.at === importedAt);
    expect(commitEvents.map((e) => e.type)).toContain('project.updated');
    const created = events.find(
      (e) => e.type === 'item.created' && e.summary.startsWith('Imported TL-4 '),
    )!;
    expect(created.at).toBe(importedAt);
    expect(JSON.parse(created.data).jira).toMatchObject({
      created: '2026-03-04T08:00:00.000+0000',
      resolved: '2026-03-06T08:00:00.000+0000',
    });
    const comments = events.filter((e) => e.type === 'note.added');
    expect(comments.map((e) => e.summary)).toEqual([
      'Imported comment · Riley Example · 2026-03-04: Can we reuse the `validateCard` helper?',
      'Imported comment · Jo Sample · 2026-03-05: Third comment, read from the second page.\n\n> **Info:** FYI',
    ]);
    expect(comments.every((e) => e.at === importedAt)).toBe(true);

    // Attachments: stored as documents on their items, by documents.stage (sha256).
    const docs = s.runtime.db.sqlite
      .prepare(
        "SELECT d.item_id, d.name, d.kind, v.size, v.sha256, v.version_no FROM documents d JOIN document_versions v ON v.document_id = d.id WHERE d.project_key = 'TLI' ORDER BY d.name, v.version_no",
      )
      .all() as {
      item_id: string | null;
      name: string;
      kind: string;
      size: number;
      sha256: string;
      version_no: number;
    }[];
    expect(docs.filter((d) => d.item_id).map((d) => [d.item_id, d.name, d.size])).toEqual([
      ['TLI-2', 'card-form.png', 96],
      ['TLI-1', 'plan.md', 120],
    ]);
    // The report: an import_report document on the project, v1 in the commit, v2 with the attachment results.
    const reports = docs.filter((d) => d.kind === 'import_report');
    expect(reports.map((d) => [d.item_id, d.version_no])).toEqual([
      [null, 1],
      [null, 2],
    ]);
    const v2 = s.runtime.db.sqlite
      .prepare(
        "SELECT v.path FROM document_versions v JOIN documents d ON d.id = v.document_id WHERE d.kind = 'import_report' AND v.version_no = 2",
      )
      .get() as { path: string };
    const stored = JSON.parse(readFileSync(join(s.runtime.config.paths.docs, v2.path), 'utf8'));
    expect(stored).toMatchObject({
      kind: 'jira_import_report',
      jira_project: 'TL',
      project: 'TLI',
      items: { 'TL-1': 'TLI-1', 'TL-2': 'TLI-2' },
      attachments: {
        stored: 2,
        failed: [{ name: 'trace.log (TL-2)', reason: 'Jira answered 500' }],
      },
    });
    expect(stored.report.totals).toEqual({ issues: 22, would_import: 20, skipped: 2, lossy: 15 });

    // A second commit is refused; the session is done.
    const again = await api(`/api/import/jira/${import_id}/commit`, { method: 'POST' });
    expect(again.status).toBe(409);
  });

  it('is all or nothing: a failure late in the transaction leaves no trace', async () => {
    await s.cleanup();
    s = createTestServer({
      log: (l) => logs.push(l),
      services: {
        documents: {
          put: () => {
            throw new Error('disk full while storing the report');
          },
        },
      },
    });
    cookie = await unlock(s);
    loadSampleSeed(s.runtime.db, { now: s.clock.now(), docsDir: s.runtime.config.paths.docs });
    const { import_id } = await dryRun();
    await waitFor(import_id, ['ready']);
    const tables = tableChecksums(s, ['owner_sessions']);
    const res = await api(`/api/import/jira/${import_id}/commit`, { method: 'POST' });
    expect(res.status).toBe(500);
    expect(tableChecksums(s, ['owner_sessions'])).toEqual(tables);
    expect(count("SELECT count(*) AS n FROM projects WHERE key = 'TLI'")).toBe(0);
    expect(
      count("SELECT count(*) AS n FROM items WHERE jira_key IS NOT NULL AND project_key = 'TLI'"),
    ).toBe(0);
    // The session is still ready: the owner can try again.
    expect((await api(`/api/import/jira/${import_id}`)).body.import.state).toBe('ready');
  });

  it('imports into an existing empty project, and refuses one that has items', async () => {
    insertProject(s.runtime.db, 'EMP');
    const { import_id } = await dryRun({ target: { kind: 'existing', key: 'EMP' } });
    await waitFor(import_id, ['ready']);
    expect((await api(`/api/import/jira/${import_id}/commit`, { method: 'POST' })).status).toBe(
      200,
    );
    await waitFor(import_id, ['committed']);
    expect(
      count("SELECT count(*) AS n FROM items WHERE project_key = 'EMP' AND imported = 1"),
    ).toBe(17);
    const full = await api('/api/import/jira/dry-run', {
      method: 'POST',
      body: dryRunBody({ target: { kind: 'existing', key: 'EMP' } }),
    });
    expect(full.status).toBe(409);
    expect(full.body.error!.message).toBe(
      "Project EMP isn't empty (17 items). Import into a new project instead.",
    );
  });
});

describe('the token appears nowhere (FR-092; Principle VI)', () => {
  it('after a dry run, a commit, attachments and a cancel: not in the data directory, the logs or any response', async () => {
    const basic = Buffer.from(`${EMAIL}:${TOKEN}`).toString('base64');
    const needles = [TOKEN, basic, Buffer.from(TOKEN).toString('base64')];
    const { import_id } = await dryRun();
    await waitFor(import_id, ['ready']);
    await api(`/api/import/jira/${import_id}/commit`, { method: 'POST' });
    await waitFor(import_id, ['committed']);
    // A second session, canceled mid-read; and a failed sign-in.
    const slow = await dryRun({
      jira_project: 'SLOW',
      target: { kind: 'new', key: 'SLO', name: 'Slow' },
    });
    expect((await api(`/api/import/jira/${slow.import_id}`, { method: 'DELETE' })).body).toEqual({
      canceled: true,
    });
    const bad = await dryRun({
      api_token: `${TOKEN}-wrong`,
      target: { kind: 'new', key: 'BAD', name: 'Bad' },
    });
    const failed = await waitFor(bad.import_id, ['failed']);
    expect(failed.error).toBe("Couldn't sign in to Jira. Check the email and API token.");
    // A validation error with the token in the body.
    const invalid = await api('/api/import/jira/dry-run', {
      method: 'POST',
      body: dryRunBody({ site_url: 'http://jira.example.test' }),
    });
    expect(invalid.status).toBe(400);

    s.runtime.db.sqlite.pragma('wal_checkpoint(PASSIVE)');
    expect(filesContaining(s.dataDir, needles)).toEqual([]);
    expect(logs.filter((l) => needles.some((n) => l.includes(n)))).toEqual([]);
    expect(responses.filter((r) => needles.some((n) => r.includes(n)))).toEqual([]);
    // Jira itself saw the credential only in the Authorization header (the request log keeps none).
    expect(site.requests.some((r) => r.path.includes(TOKEN))).toBe(false);
  });
});

describe('sessions: cancel, expiry, errors', () => {
  it('cancel stops a running dry run and drops the session', async () => {
    const { import_id } = await dryRun({
      jira_project: 'SLOW',
      target: { kind: 'new', key: 'SLO', name: 'Slow' },
    });
    let seen: JiraImport;
    const until = Date.now() + 10_000;
    do {
      await new Promise((r) => setTimeout(r, 20));
      seen = (await api(`/api/import/jira/${import_id}`)).body.import;
    } while ((seen.progress?.done === 0 || seen.progress?.total === null) && Date.now() < until);
    expect(seen.progress).toMatchObject({ phase: 'reading', total: 120 });
    expect((await api(`/api/import/jira/${import_id}`, { method: 'DELETE' })).status).toBe(200);
    const gone = await api(`/api/import/jira/${import_id}`);
    expect(gone.status).toBe(404);
    expect(gone.body.error!.message).toMatch(/Run a new dry run/);
    const reads = site.requests.filter((r) => r.path === '/rest/api/3/search/jql').length;
    await new Promise((r) => setTimeout(r, 700));
    expect(site.requests.filter((r) => r.path === '/rest/api/3/search/jql').length).toBe(reads);
  });

  it('expires an hour after the dry run: the session and its token are gone', async () => {
    const { import_id, expires_at } = await dryRun();
    expect(Date.parse(expires_at) - s.clock.now().getTime()).toBe(60 * 60_000);
    await waitFor(import_id, ['ready']);
    s.clock.advance(60 * 60_000 + 1);
    expect((await api(`/api/import/jira/${import_id}`)).status).toBe(404);
    expect((await api(`/api/import/jira/${import_id}/commit`, { method: 'POST' })).status).toBe(
      404,
    );
  });

  it('reports the dialog errors: sign-in, unknown project, http site, taken key', async () => {
    const unknown = await dryRun({ jira_project: 'NOPE' });
    expect((await waitFor(unknown.import_id, ['failed'])).error).toBe(
      'Project NOPE not found or not visible to this account.',
    );
    const http = await api('/api/import/jira/dry-run', {
      method: 'POST',
      body: dryRunBody({ site_url: 'http://jira.example.test' }),
    });
    expect(http.status).toBe(400);
    insertProject(s.runtime.db, 'TLI');
    const taken = await api('/api/import/jira/dry-run', { method: 'POST', body: dryRunBody() });
    expect(taken.status).toBe(409);
    expect(taken.body.error!.message).toBe(
      "Project TLI already exists. Pick another key, or import into TLI if it's empty.",
    );
    const unreachable = await dryRun({
      site_url: 'https://other.example.test',
      target: { kind: 'new', key: 'OTH', name: 'Other' },
    });
    expect((await waitFor(unreachable.import_id, ['failed'])).error).toBe(
      "Couldn't reach https://other.example.test. Check the Jira site address.",
    );
  });
});

describe("a deleted project's key (B15 tombstones)", () => {
  it('is refused while its documents are being removed, and reusable afterwards', async () => {
    await s.cleanup();
    // The delete commits, but its documents folder stays (the removal hasn't run yet).
    s = createTestServer({
      log: (l) => logs.push(l),
      services: { projects: { removeDeletedDocs: () => Promise.resolve([]) } },
    });
    cookie = await unlock(s);
    loadSampleSeed(s.runtime.db, { now: s.clock.now(), docsDir: s.runtime.config.paths.docs });
    const docs = join(s.runtime.config.paths.docs, 'RCP');
    expect(existsSync(docs)).toBe(true);
    const nextSeq = (
      s.runtime.db.sqlite.prepare("SELECT next_seq FROM projects WHERE key = 'RCP'").get() as {
        next_seq: number;
      }
    ).next_seq;
    expect(
      (await api('/api/projects/RCP', { method: 'DELETE', body: { confirm_key: 'RCP' } })).status,
    ).toBe(200);
    expect(existsSync(docs)).toBe(true);

    const refused = await api('/api/import/jira/dry-run', {
      method: 'POST',
      body: dryRunBody({ target: { kind: 'new', key: 'RCP', name: 'Recipes again' } }),
    });
    expect(refused.status).toBe(409);
    expect(refused.body.error!.message).toBe(
      'Project RCP was deleted and its documents are still being removed. Try again in a minute, or pick another key.',
    );

    // A dry run that started before the cleanup finished is checked again at commit.
    rmSync(docs, { recursive: true, force: true });
    const { import_id } = await dryRun({
      target: { kind: 'new', key: 'RCP', name: 'Recipes again' },
    });
    await waitFor(import_id, ['ready']);
    mkdirSync(docs);
    expect((await api(`/api/import/jira/${import_id}/commit`, { method: 'POST' })).status).toBe(
      409,
    );
    rmSync(docs, { recursive: true, force: true });

    const commit = await api(`/api/import/jira/${import_id}/commit`, { method: 'POST' });
    expect(commit.status).toBe(200);
    await waitFor(import_id, ['committed']);
    const project = s.runtime.db.sqlite
      .prepare("SELECT name, deleted_at FROM projects WHERE key = 'RCP'")
      .get();
    expect(project).toEqual({ name: 'Recipes again', deleted_at: null });
    // Numbering continues: no ID an agent may hold for a deleted item is reused.
    const first = s.runtime.db.sqlite
      .prepare("SELECT id FROM items WHERE project_key = 'RCP' AND jira_key = 'TL-1'")
      .get() as { id: string };
    expect(first.id).toBe(`RCP-${nextSeq}`);
    const settings = await api('/api/settings');
    expect(JSON.stringify(settings.body)).toContain('Recipes again');
  });
});

/**
 * SC-018 (tasks.md T165; spec US15 Independent Test; owner decision 31):
 * onboarding a Spec Kit repo after a Jira import creates no duplicates.
 *
 * 1. The owner imports the Jira fixture (tests/fixtures/jira, project TL)
 *    into a new project CK over the UI API, through a stubbed `fetch`.
 * 2. An official MCP SDK client calls `onboard_project` and follows the
 *    guide's steps over the fixture repo (tests/fixtures/onboarding/
 *    specs-repo). Reconciling is the agent's job, so `onboardRepo` below
 *    scripts what a correct agent does: match by Jira key, then source path,
 *    then title; enrich matches; create the rest in Planning with
 *    dependencies; attach specs and plans; publish the constitution's and
 *    ADR's decisions; propose Workflow notes; ask; finish.
 * 3. Asserted: every Jira-matched task enriched its item (no duplicate titles
 *    or Jira keys), everything created is in Planning, the documents are
 *    attached, a Workflow proposal exists, the review card's counts are
 *    exact, and a second run creates nothing.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { syncBundledFiles } from '../../src/jobs/bundled.js';
import { expectOk, startHarness, type ContractHarness } from '../contract/harness.js';
import { createJiraSite } from '../fixtures/jira/site.mjs';
import { ORIGIN, parseSetCookies } from './harness.js';
import { askForm } from '../helpers.js';

const REPO = join(import.meta.dirname, '..', 'fixtures', 'onboarding', 'specs-repo');
const read = (rel: string) => readFileSync(join(REPO, rel), 'utf8').replace(/\r\n/g, '\n');
const KEY = 'CK';
const TOKEN = `sc018-${randomBytes(8).toString('hex')}`;
const EMAIL = 'owner@example.test';

type S = Record<string, unknown>;
let h: ContractHarness;

async function ownerApi() {
  const req = (path: string, init?: RequestInit) =>
    Promise.resolve(h.server.app.request(`${ORIGIN}${path}`, init));
  const res = await req('/api/session/unlock', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: h.server.runtime.secrets.ownerKey() }),
  });
  const c = parseSetCookies(res);
  const cookie = `docket_owner=${c.docket_owner!.value}; docket_csrf=${c.docket_csrf!.value}`;
  return async (method: string, path: string, body?: unknown) => {
    const r = await req(path, {
      method,
      headers: {
        cookie,
        ...(method === 'GET' ? {} : { 'x-docket-csrf': c.docket_csrf!.value }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    return { status: r.status, body: (text ? JSON.parse(text) : {}) as S };
  };
}

async function importJira(owner: Awaited<ReturnType<typeof ownerApi>>, origin: string) {
  const dry = await owner('POST', '/api/import/jira/dry-run', {
    site_url: origin,
    email: EMAIL,
    api_token: TOKEN,
    jira_project: 'TL',
    target: { kind: 'new', key: KEY, name: 'Checkout' },
  });
  expect(dry.status, JSON.stringify(dry.body)).toBe(200);
  const id = (dry.body.import as { import_id: string }).import_id;
  const wait = async (states: string[]) => {
    for (let i = 0; i < 2_000; i++) {
      const got = await owner('GET', `/api/import/jira/${id}`);
      const s = got.body.import as { state: string } | undefined;
      if (!s) throw new Error(JSON.stringify(got));
      if (states.includes(s.state)) return s;
      await new Promise((r) => setTimeout(r, 15));
    }
    throw new Error(`import ${id} never reached ${states.join('/')}`);
  };
  await wait(['ready']);
  expect((await owner('POST', `/api/import/jira/${id}/commit`)).status).toBe(200);
  await wait(['committed']);
}

// ---- The fixture repo, as an agent would read it ----

interface Task {
  path: string;
  id: string;
  title: string;
  done: boolean;
  jira: string | null;
  acceptance: string;
  deps: string[];
}
interface Spec {
  dir: string;
  title: string;
  jira: string | null;
  tasks: Task[];
}

function readSpecs(): Spec[] {
  return ['001-checkout', '002-receipts'].map((dir) => {
    const spec = read(`specs/${dir}/spec.md`);
    const tasks: Task[] = [];
    for (const line of read(`specs/${dir}/tasks.md`).split('\n')) {
      const t = /^- \[( |x)\] (T\d+) (.+?)(?: [([](TL-\d+)[)\]])?$/.exec(line);
      if (t) {
        tasks.push({
          path: `specs/${dir}/tasks.md#${t[2]}`,
          id: t[2]!,
          title: t[3]!,
          done: t[1] === 'x',
          jira: t[4] ?? null,
          acceptance: '',
          deps: [],
        });
        continue;
      }
      const task = tasks.at(-1);
      const acc = /^ {2}- Acceptance: (.+)$/.exec(line);
      if (task && acc) task.acceptance = acc[1]!;
      const deps = /^ {2}- Depends on: (.+)$/.exec(line);
      if (task && deps) {
        task.deps = deps[1]!.split(',').map((d) => {
          const [a, b] = d.trim().split('/');
          return b ? `specs/${a}/tasks.md#${b}` : `specs/${dir}/tasks.md#${a}`;
        });
      }
    }
    return {
      dir,
      title: /^# Feature: (.+)$/m.exec(spec)![1]!,
      jira: /Jira epic: (TL-\d+)/.exec(spec)?.[1] ?? null,
      tasks,
    };
  });
}

// ---- A correct agent, scripted ----

interface Report {
  session_id: string;
  created: string[];
  enriched: string[];
  skipped: string[];
  calls: number;
}

async function onboardRepo(opts: { ask: boolean }): Promise<Report> {
  let calls = 0;
  const call = async (name: string, args: S): Promise<CallToolResult> => {
    calls += 1;
    return h.call(name, args);
  };
  const ok = async <T = S>(name: string, args: S) =>
    expectOk(await call(name, args)).structured as T;
  const report: Omit<Report, 'calls'> = { session_id: '', created: [], enriched: [], skipped: [] };

  const started = await ok<{ session_id: string; guide: string; existing: S }>('onboard_project', {
    key: KEY,
    idempotency_key: `onb-${Date.now()}-${Math.random()}`,
  });
  report.session_id = started.session_id;
  expect(started.guide).toContain(`project ${KEY}`);

  type Row = { id: string; title: string; type: string; jira_key: string | null };
  const search = async (text: string, type?: string) =>
    (
      await ok<{ items: Row[] }>('search_items', {
        project: KEY,
        text,
        ...(type ? { type: [type] } : {}),
        limit: 50,
      })
    ).items;
  const item = async (id: string) =>
    (
      await ok<{
        item: {
          id: string;
          version: number;
          title: string;
          description_md: string;
          acceptance: string[];
          jira_key: string | null;
          documents: { name: string }[];
        };
      }>('get_item', { id, view: 'full' })
    ).item;

  /** Step 2: by Jira key (confirmed exactly), then by source path, then by title. */
  async function match(unit: { jira: string | null; path: string; title: string }, type?: string) {
    if (unit.jira) {
      for (const row of await search(unit.jira, type)) {
        if ((await item(row.id)).jira_key === unit.jira) return row.id;
      }
    }
    const bySource = await search(unit.path, type);
    if (bySource.length === 1) return bySource[0]!.id;
    const lower = unit.title.toLowerCase();
    return (await search(unit.title, type)).find((r) => r.title.toLowerCase() === lower)?.id;
  }

  /** Enrich a match: keep its text, add what's missing and the source line. Status untouched. */
  async function enrich(id: string, path: string, acceptance: string | null) {
    const it = await item(id);
    if (it.description_md.includes(`Source: ${path}`)) return; // A previous run did it.
    const description = [it.description_md.trim(), `Source: ${path}`].filter(Boolean).join('\n\n');
    await ok('update_item', {
      id,
      expected_version: it.version,
      description_md: description,
      ...(acceptance && it.acceptance.length === 0 ? { acceptance: [acceptance] } : {}),
    });
    report.enriched.push(id);
  }

  const ids = new Map<string, string>(); // source path -> item ID
  let newEpic: string | null = null;
  for (const spec of readSpecs()) {
    // The epic.
    const specPath = `specs/${spec.dir}/spec.md`;
    let epic = await match({ jira: spec.jira, path: specPath, title: spec.title }, 'Epic');
    if (epic) {
      await enrich(epic, specPath, null);
    } else {
      epic = (
        await ok<{ item: { id: string } }>('create_item', {
          project: KEY,
          type: 'Epic',
          title: spec.title,
          status: 'planning',
          description_md: `Feature spec.\n\nSource: ${specPath}`,
          idempotency_key: `epic-${spec.dir}-${report.session_id}`,
        })
      ).item.id;
      report.created.push(epic);
      newEpic = epic;
    }
    // Specs and plans, attached once.
    const docs = (await item(epic)).documents.map((d) => d.name);
    for (const file of ['spec.md', 'plan.md']) {
      const name = `${spec.dir}-${file}`;
      if (docs.includes(name)) continue;
      await ok('put_document', {
        item_id: epic,
        name,
        kind: 'planning',
        content_text: read(`specs/${spec.dir}/${file}`),
      });
    }
    // The tasks.
    for (const task of spec.tasks) {
      if (task.done) {
        report.skipped.push(`${task.path} (done)`);
        continue;
      }
      const found = await match(task);
      if (found) {
        await enrich(found, task.path, task.acceptance);
        ids.set(task.path, found);
        continue;
      }
      const created = (
        await ok<{ item: { id: string } }>('create_item', {
          project: KEY,
          type: 'Task',
          title: task.title,
          epic,
          status: 'planning',
          acceptance: [task.acceptance],
          description_md: `From the ${spec.title} tasks.\n\nSource: ${task.path}`,
          blocked_by: task.deps.map((d) => ids.get(d)!),
          idempotency_key: `task-${task.path}-${report.session_id}`,
        })
      ).item.id;
      ids.set(task.path, created);
      report.created.push(created);
    }
  }

  // Decisions from the constitution and the ADR, once each.
  const existing = (
    await ok<{ items: { title: string }[] }>('list_decisions', { project: KEY })
  ).items.map((d) => d.title);
  const constitution = read('.specify/memory/constitution.md');
  const decisions = [...constitution.matchAll(/^## [IVX]+\. (.+)\n(.+)$/gm)].map((m) => ({
    title: m[1]!,
    decision: m[2]!,
  }));
  decisions.push({
    title: "Use the provider's hosted card fields",
    decision: /## Decision\n(.+)/.exec(read('docs/adr/0001-payment-provider.md'))![1]!,
  });
  for (const d of decisions) {
    if (existing.includes(d.title)) continue;
    await ok('publish_decision', { project: KEY, scope: { kind: 'project' }, ...d });
  }

  // Workflow notes, answered from the README.
  const workflow = (
    await ok<{ files: { version_id: string | null; content: string | null }[] }>(
      'get_agent_files',
      { project: KEY, file: 'workflow' },
    )
  ).files[0]!;
  const notes = [
    '## Moving work to Ready',
    '- Only the owner moves items to Ready.',
    '',
    '## Branches and commits',
    '- One branch per ticket, named `tl-<n>-short-name`; squash-merge into `main`.',
    '',
    '## Checks to run',
    '- `pnpm test`, `pnpm lint` and `pnpm typecheck` before a packet or done.',
    '',
  ].join('\n');
  if (workflow.content !== notes) {
    await ok('propose_agent_file_change', {
      project: KEY,
      file: 'workflow',
      content: notes,
      reason: 'Conventions from the README.',
      based_on_version_id: workflow.version_id,
    });
  }

  const questions: string[] = [];
  if (opts.ask && newEpic) {
    await ok('ask_owner', {
      id: newEpic,
      ...askForm(
        'TL-5 is closed in Jira but T010 is still open in the receipts tasks: is the rounding bug fixed?',
      ),
    });
    questions.push('Should fraud scoring (TL-6) stay in this release?');
  }

  await ok('finish_onboarding', {
    session_id: report.session_id,
    summary: [
      `Created ${report.created.length}, enriched ${report.enriched.length}.`,
      `Skipped: ${report.skipped.join(', ') || 'none'}.`,
    ].join(' '),
    questions,
  });
  return { ...report, calls };
}

// ---- The test ----

let site: ReturnType<typeof createJiraSite>;
beforeEach(async () => {
  site = createJiraSite({ email: EMAIL, token: TOKEN });
  vi.stubGlobal('fetch', site.fetch);
  h = await startHarness({ seed: false });
  syncBundledFiles(h.server.runtime);
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await h.close();
});

const all = <T>(q: string, ...args: unknown[]) =>
  h.server.runtime.db.sqlite.prepare(q).all(...args) as T[];

describe('SC-018: onboarding a Spec Kit repo after a Jira import', () => {
  it('enriches every Jira match, creates the rest in Planning, and a second run duplicates nothing', async () => {
    const owner = await ownerApi();
    await importJira(owner, site.origin);
    const imported = all<{ id: string; jira_key: string; title: string; status: string }>(
      'SELECT id, jira_key, title, status FROM items WHERE project_key = ? ORDER BY id',
      KEY,
    );
    const byJira = new Map(imported.map((i) => [i.jira_key, i]));
    expect(imported.length).toBeGreaterThan(10);

    // ---- First run ----
    const first = await onboardRepo({ ask: true });
    console.log(
      `SC-018 first run: ${first.calls} calls; created ${first.created.join(', ')}; enriched ${first.enriched.join(', ')}; skipped ${first.skipped.join(', ')}`,
    );

    // Every Jira-matched unit enriched its imported item: TL-1 (the spec's epic), TL-2 and
    // TL-11 by key, TL-5 by key, TL-3 and TL-6 by title.
    const matched = ['TL-1', 'TL-2', 'TL-3', 'TL-5', 'TL-6', 'TL-11'].map((k) => byJira.get(k)!.id);
    expect([...first.enriched].sort()).toEqual([...matched].sort());
    for (const id of matched) {
      const [row] = all<{ description_md: string }>(
        'SELECT description_md FROM items WHERE id = ?',
        id,
      );
      expect(row!.description_md, id).toMatch(/Source: specs\//);
    }
    // TL-7 is a sub-task (a work step of TL-2), and T002 is done: skipped, not created.
    expect(first.skipped).toEqual(['specs/001-checkout/tasks.md#T002 (done)']);

    // Created: the Receipts epic and four tasks, all in Planning; nothing anywhere is Ready
    // that wasn't before, and no status changed.
    expect(first.created).toHaveLength(5);
    const created = all<{ id: string; type: string; status: string; title: string }>(
      `SELECT id, type, status, title FROM items WHERE id IN (${first.created.map(() => '?').join(',')})`,
      ...first.created,
    );
    expect(created.every((i) => i.status === 'planning')).toBe(true);
    expect(created.map((i) => i.title).sort()).toEqual(
      [
        'Emit checkout analytics events',
        'Handle 3-D Secure challenges',
        'Receipt email template',
        'Receipts',
        'Send the receipt after payment',
      ].sort(),
    );
    for (const i of imported) {
      const [now] = all<{ status: string }>('SELECT status FROM items WHERE id = ?', i.id);
      expect(now!.status, i.id).toBe(i.status);
    }
    // Dependencies: 3-D Secure waits on the sandbox (TL-3); the receipt send on three blockers.
    const blockers = (title: string) =>
      all<{ from_id: string }>(
        `SELECT l.from_id FROM links l JOIN items i ON i.id = l.to_id
          WHERE i.title = ? AND i.project_key = ? AND l.type = 'blocks' ORDER BY l.from_id`,
        title,
        KEY,
      ).map((l) => l.from_id);
    expect(blockers('Handle 3-D Secure challenges')).toEqual([byJira.get('TL-3')!.id]);
    expect(blockers('Send the receipt after payment')).toHaveLength(3);

    // No duplicate titles or Jira keys in the project.
    const dupes = () =>
      all(
        `SELECT lower(title) AS t, count(*) AS n FROM items WHERE project_key = ?
          GROUP BY lower(title) HAVING n > 1
         UNION ALL
         SELECT jira_key, count(*) FROM items WHERE project_key = ? AND jira_key IS NOT NULL
          GROUP BY jira_key HAVING count(*) > 1`,
        KEY,
        KEY,
      );
    expect(dupes()).toEqual([]);

    // Documents: both specs and plans, attached to their epics as planning documents.
    expect(
      all<{ name: string; kind: string }>(
        'SELECT name, kind FROM documents WHERE project_key = ? AND kind = ? ORDER BY name',
        KEY,
        'planning',
      ),
    ).toEqual([
      { name: '001-checkout-plan.md', kind: 'planning' },
      { name: '001-checkout-spec.md', kind: 'planning' },
      { name: '002-receipts-plan.md', kind: 'planning' },
      { name: '002-receipts-spec.md', kind: 'planning' },
    ]);
    // The Workflow proposal waits for the owner.
    const proposals = all<{ id: string; state: string }>(
      "SELECT id, state FROM agent_file_proposals WHERE project_key = ? AND file_key = 'workflow'",
      KEY,
    );
    expect(proposals).toEqual([{ id: expect.any(String), state: 'pending' }]);

    // The review card: exact counts, the summary, the questions, the proposal.
    const card = (
      (await owner('GET', `/api/needs-you?scope=${KEY}`)).body.onboarding_reviews as S[]
    )[0]!;
    expect(card).toMatchObject({
      project: KEY,
      state: 'ready_for_review',
      changes: { created: 6, enriched: 6, documents: 4, decisions: 3, proposals: 1 },
      questions: ['Should fraud scoring (TL-6) stay in this release?'],
      workflow_proposal_id: proposals[0]!.id,
    });
    expect(card.summary).toBe(
      'Created 5, enriched 6. Skipped: specs/001-checkout/tasks.md#T002 (done).',
    );
    // Its links: Work filtered to exactly those items (tickets; the epics row holds epics).
    const work = async (change: string) =>
      (
        await owner(
          'GET',
          `/api/work?scope=${KEY}&layout=list&onboarding=${String(card.id)}&onboarding_change=${change}`,
        )
      ).body as { items: { id: string }[]; epics: { id: string }[] };
    const createdView = await work('created');
    const release = all<{ id: string }>(
      "SELECT id FROM items WHERE epic_id = ? AND type = 'Release'",
      created.find((i) => i.type === 'Epic')!.id,
    )[0]!.id;
    expect([...createdView.items, ...createdView.epics].map((i) => i.id).sort()).toEqual(
      [...first.created, release].sort(),
    );
    const enrichedView = await work('enriched');
    expect([...enrichedView.items, ...enrichedView.epics].map((i) => i.id).sort()).toEqual(
      [...matched].sort(),
    );

    // The owner reviews: approves the notes and marks the card reviewed.
    expect(
      (await owner('POST', `/api/agent-file-proposals/${proposals[0]!.id}/approve`, {})).status,
    ).toBe(200);
    expect((await owner('POST', `/api/onboarding/${String(card.id)}/reviewed`, {})).status).toBe(
      200,
    );

    // ---- Second run: reconciles against the first; creates and changes nothing ----
    const itemsBefore = all('SELECT id, version FROM items WHERE project_key = ? ORDER BY id', KEY);
    const second = await onboardRepo({ ask: false });
    console.log(
      `SC-018 second run: ${second.calls} calls; created ${second.created.length}; enriched ${second.enriched.length}`,
    );
    expect(second.session_id).not.toBe(first.session_id);
    expect(second.created).toEqual([]);
    expect(second.enriched).toEqual([]);
    expect(all('SELECT id, version FROM items WHERE project_key = ? ORDER BY id', KEY)).toEqual(
      itemsBefore,
    );
    expect(dupes()).toEqual([]);
    const secondCard = (
      (await owner('GET', `/api/onboarding?project=${KEY}&state=ready_for_review`)).body
        .sessions as S[]
    )[0]!;
    expect(secondCard.changes).toEqual({
      created: 0,
      enriched: 0,
      documents: 0,
      decisions: 0,
      proposals: 0,
    });
  });
});

/**
 * US15 contract (tasks.md T164; owner decision 31; BUILD_SPEC §5.20; MCP_SPEC
 * §5.11; FR-135–FR-140): onboarding through the official MCP SDK clients, and
 * the owner's side through the UI API.
 *
 * - `onboard_project` creates (name required; `created_by`) or adopts, starts
 *   a session, returns the guide in the structured result and verbatim in the
 *   text block, and counts what the project holds. The same client gets its
 *   own session back; another client is `forbidden`. A deleted key still
 *   being cleaned up is `conflict`.
 * - Session tagging: the client's events on the project carry
 *   `data.onboarding_session`; the owner's, another client's and other
 *   projects' don't. Nothing can be moved to Ready during the session.
 * - `finish_onboarding` counts the changes; the owner sees one card, the
 *   for-you count and Work's filter; *Mark reviewed* ends the chip.
 * - The guide is the agent file `guide:onboarding`: editable per project,
 *   served by the prompt, never installed or proposable.
 * - Agents can't create projects in Settings, change project settings or
 *   delete projects (FR-140).
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TOOL_NAMES } from '@docket/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { readContext } from '../../src/domain/contracts.js';
import {
  DEFAULT_BUNDLED_ROOT,
  ONBOARDING_GUIDE_TEMPLATE,
  syncBundledFiles,
} from '../../src/jobs/bundled.js';
import { ORIGIN, PROTECTED_MODE, parseSetCookies } from '../integration/harness.js';
import {
  expectConflict,
  expectForbidden,
  expectNotFound,
  expectOk,
  expectToolError,
  expectValidation,
  startHarness,
  textOf,
  type ContractHarness,
} from './harness.js';

let h: ContractHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

type S = Record<string, unknown>;

const BUNDLED_GUIDE = readFileSync(join(DEFAULT_BUNDLED_ROOT, ONBOARDING_GUIDE_TEMPLATE), 'utf8');

async function start(env?: Record<string, string>): Promise<ContractHarness> {
  h = await startHarness({ env });
  syncBundledFiles(h.server.runtime);
  return h;
}

/** An owner session on the harness app, and a JSON request helper. */
async function ownerApi() {
  const app = h!.server.app;
  const req = (path: string, init?: RequestInit) =>
    Promise.resolve(app.request(`${ORIGIN}${path}`, init));
  const res = await req('/api/session/unlock', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: h!.server.runtime.secrets.ownerKey() }),
  });
  const cookies = parseSetCookies(res);
  const cookie = `docket_owner=${cookies.docket_owner!.value}; docket_csrf=${cookies.docket_csrf!.value}`;
  return async (method: string, path: string, body?: unknown) => {
    const r = await req(path, {
      method,
      headers: {
        cookie,
        ...(method === 'GET' ? {} : { 'x-docket-csrf': cookies.docket_csrf!.value }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    return { status: r.status, body: (text ? JSON.parse(text) : {}) as S };
  };
}

const sql = () => h!.server.runtime.db.sqlite;
const count = (q: string, ...args: unknown[]) =>
  (
    sql()
      .prepare(q)
      .get(...args) as { n: number }
  ).n;
const eventsOf = (type: string) =>
  (
    sql()
      .prepare('SELECT type, client, data FROM events WHERE type = ? ORDER BY seq')
      .all(type) as {
      type: string;
      client: string | null;
      data: string;
    }[]
  ).map((e) => ({ ...e, data: JSON.parse(e.data) as S }));
const tagOfLast = (type: string) => eventsOf(type).at(-1)?.data.onboarding_session;

describe('onboard_project (MCP_SPEC §5.11)', () => {
  it('creates the project on a free key, marked created by the agent, and returns the whole guide', async () => {
    await start();
    const r = expectOk(
      await h!.call('onboard_project', { key: 'GF', name: 'Gameflow', color: '#2b8a3e' }),
    );
    const out = r.structured as {
      project: S;
      session_id: string;
      guide: string;
      existing: S;
    };
    expect(out.project).toEqual({ key: 'GF', name: 'Gameflow', created: true });
    expect(out.session_id).toMatch(/^onb_/);
    expect(out.existing).toEqual({ items: 0, jira_items: 0, documents: 0 });
    const guide = BUNDLED_GUIDE.replaceAll('{{KEY}}', 'GF');
    expect(out.guide).toBe(guide);
    expect(out.guide).not.toContain('{{');
    // The text block: one header line, then the guide verbatim (a text-only model reads it).
    const lines = r.text.split('\n');
    expect(lines[0]).toContain(out.session_id);
    expect(lines[0]).toContain('created');
    expect(lines.slice(1).join('\n')).toBe(guide);

    const project = sql().prepare("SELECT * FROM projects WHERE key = 'GF'").get() as S;
    expect(project).toMatchObject({ name: 'Gameflow', color: '#2b8a3e', created_by: 'claude' });
    expect(eventsOf('project.created').map((e) => e.client)).toEqual(['claude']);
    expect(eventsOf('onboarding.started')).toHaveLength(1);
    expect(
      sql().prepare('SELECT client, started_by, state, project_key FROM onboarding_sessions').all(),
    ).toEqual([
      { client: 'claude', started_by: 'claude', state: 'in_progress', project_key: 'GF' },
    ]);

    // The owner sees the chip: created_by on the project rows.
    const owner = await ownerApi();
    const boot = await owner('GET', '/api/bootstrap');
    expect((boot.body.projects as S[]).find((p) => p.key === 'GF')).toMatchObject({
      created_by: 'claude',
    });
    expect((boot.body.projects as S[]).find((p) => p.key === 'RCP')).toMatchObject({
      created_by: null,
    });
  });

  it('a free key needs a name, and nothing is stored without one', async () => {
    await start();
    const err = expectValidation(await h!.call('onboard_project', { key: 'GF' }));
    expect(err.message).toBe(
      'No project GF yet: pass name to create it, or check the key with list_projects.',
    );
    expect(err.details).toEqual({ fields: { name: 'is required to create a project' } });
    expect(count("SELECT count(*) AS n FROM projects WHERE key = 'GF'")).toBe(0);
    expect(count('SELECT count(*) AS n FROM onboarding_sessions')).toBe(0);
  });

  it('adopts an existing project (name ignored), counting what it holds', async () => {
    await start();
    sql()
      .prepare(
        "UPDATE items SET jira_key = 'OLD-' || substr(id, 5) WHERE id IN ('RCP-11', 'RCP-12')",
      )
      .run();
    const r = expectOk(await h!.call('onboard_project', { key: 'RCP', name: 'Ignored' }));
    const out = r.structured as { project: S; existing: S; guide: string };
    expect(out.project).toEqual({ key: 'RCP', name: expect.any(String), created: false });
    expect(out.project.name).not.toBe('Ignored');
    expect(out.existing).toEqual({
      items: count("SELECT count(*) AS n FROM items WHERE project_key = 'RCP'"),
      jira_items: 2,
      documents: count("SELECT count(*) AS n FROM documents WHERE project_key = 'RCP'"),
    });
    expect(out.guide).toBe(BUNDLED_GUIDE.replaceAll('{{KEY}}', 'RCP'));
    expect(eventsOf('project.created')).toEqual([]);
    expect(r.text.split('\n')[0]).toContain('adopted');
  });

  it('the same client gets its own session back; another client is forbidden', async () => {
    await start();
    const first = expectOk(await h!.call('onboard_project', { key: 'RCP' })).structured as S;
    const seqBefore = count('SELECT max(seq) AS n FROM events');
    const again = expectOk(await h!.call('onboard_project', { key: 'RCP' })).structured as S;
    expect(again.session_id).toBe(first.session_id);
    expect(again.guide).toBe(first.guide);
    expect(count('SELECT max(seq) AS n FROM events')).toBe(seqBefore);
    expect(count('SELECT count(*) AS n FROM onboarding_sessions')).toBe(1);

    const other = expectForbidden(await h!.call('onboard_project', { key: 'RCP' }, h!.b));
    expect(other.message).toMatch(
      /^claude is onboarding RCP \(since .+\)\. Wait for it to finish, or ask the owner\.$/,
    );
    expect(other.current).toMatchObject({ session_id: first.session_id, started_by: 'claude' });
  });

  it('a replay with the same idempotency_key returns the original result', async () => {
    await start();
    const args = { key: 'GF', name: 'Gameflow', idempotency_key: 'onb-1' };
    const one = expectOk(await h!.call('onboard_project', args)).structured as S;
    const two = expectOk(await h!.call('onboard_project', args)).structured as S;
    expect(two.session_id).toBe(one.session_id);
    expect(count("SELECT count(*) AS n FROM projects WHERE key = 'GF'")).toBe(1);
  });

  it("a deleted project's key is refused while its cleanup hasn't finished, then reused", async () => {
    await start();
    const owner = await ownerApi();
    const created = await owner('POST', '/api/projects', { key: 'OLD', name: 'Old one' });
    expect(created.status).toBe(200);
    expect((await owner('DELETE', '/api/projects/OLD', { confirm_key: 'OLD' })).status).toBe(200);
    mkdirSync(join(h!.server.runtime.config.paths.docs, 'OLD'), { recursive: true });
    const err = expectToolError(
      await h!.call('onboard_project', { key: 'OLD', name: 'New one' }),
      'conflict',
    );
    expect(err.message).toMatch(/was deleted and its documents are still being removed/);
    await h!.server.runtime.services.projects.removeDeletedDocs(
      readContext(h!.server.runtime.db, { kind: 'system', client: null, label: null }, new Date()),
    );
    const ok = expectOk(await h!.call('onboard_project', { key: 'OLD', name: 'New one' }));
    expect((ok.structured as { project: S }).project).toEqual({
      key: 'OLD',
      name: 'New one',
      created: true,
    });
  });
});

describe('session tagging and safety', () => {
  it("tags the client's events on the project, and only those", async () => {
    await start();
    const { session_id } = expectOk(await h!.call('onboard_project', { key: 'RCP' }))
      .structured as { session_id: string };
    expectOk(
      await h!.call('create_item', {
        project: 'RCP',
        type: 'Task',
        title: 'Onboarded task',
        status: 'planning',
        idempotency_key: 'c1',
      }),
    );
    expect(tagOfLast('item.created')).toBe(session_id);
    // Another client's change on the same project: not the session's.
    expectOk(
      await h!.call('create_item', { project: 'RCP', type: 'Task', title: 'Codex task' }, h!.b),
    );
    expect(tagOfLast('item.created')).toBeUndefined();
    // The same client on another project: not tagged.
    const other = sql()
      .prepare("SELECT key FROM projects WHERE key <> 'RCP' AND deleted_at IS NULL LIMIT 1")
      .get() as { key: string } | undefined;
    if (other) {
      expectOk(
        await h!.call('create_item', { project: other.key, type: 'Task', title: 'Elsewhere' }),
      );
      expect(tagOfLast('item.created')).toBeUndefined();
    }
    // The owner's change: not tagged.
    const owner = await ownerApi();
    expect(
      (await owner('POST', '/api/items', { title: 'Owner capture', type: 'Task', project: 'RCP' }))
        .status,
    ).toBe(200);
    expect(tagOfLast('item.created')).toBeUndefined();
  });

  it('refuses moving anything to Ready during the session, from the onboarding client', async () => {
    await start();
    const planning = sql()
      .prepare(
        "SELECT id, version FROM items WHERE project_key = 'RCP' AND status = 'planning' LIMIT 1",
      )
      .get() as { id: string; version: number };
    expectOk(await h!.call('onboard_project', { key: 'RCP' }));
    const err = expectForbidden(await h!.call('set_status', { id: planning.id, status: 'ready' }));
    expect(err.message).toBe(
      `You're onboarding RCP: leave ${planning.id} in planning. The owner moves items to Ready after reviewing the onboarding.`,
    );
    expect(
      (sql().prepare('SELECT status FROM items WHERE id = ?').get(planning.id) as S).status,
    ).toBe('planning');
  });

  it('agents never create projects in Settings, change project settings or delete projects (FR-140)', async () => {
    // Protected mode: the agent token is no owner session (decision 32).
    await start(PROTECTED_MODE);
    // No MCP tool does it.
    expect(TOOL_NAMES.filter((t) => /project/.test(t))).toEqual([
      'list_projects',
      'onboard_project',
    ]);
    const rt = h!.server.runtime;
    const agent = { kind: 'agent' as const, client: 'claude', label: null };
    const as = <T>(fn: Parameters<typeof rt.write.run<T>>[1]) =>
      rt.write.run({ actor: agent, operation: 'test', args: {} }, fn);
    expect(() =>
      as((w) => rt.services.projects.create(w, { key: 'GF', name: 'Gameflow' })),
    ).toThrow(/Only the owner creates projects in Settings/);
    expect(() =>
      as((w) =>
        rt.services.projects.setDefaultSatisfiedWhen(w, {
          key: 'RCP',
          default_satisfied_when: 'merged',
          expected_version: 1,
        } as never),
      ),
    ).toThrow(/Only the owner sets a project's blocker rule/);
    expect(() =>
      as((w) => rt.services.projects.delete(w, { key: 'RCP', confirm_key: 'RCP' })),
    ).toThrow(/Only the owner deletes a project/);
    // Nor through the owner routes: the agent's bearer token isn't an owner session.
    const token = rt.secrets.agentToken();
    for (const [method, path, body] of [
      ['POST', '/api/projects', { key: 'GF', name: 'Gameflow' }],
      ['PATCH', '/api/projects/RCP', { default_satisfied_when: 'merged', expected_version: 1 }],
      ['DELETE', '/api/projects/RCP', { confirm_key: 'RCP' }],
    ] as const) {
      const res = await h!.server.app.request(`${ORIGIN}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
    expect(
      count("SELECT count(*) AS n FROM projects WHERE key = 'RCP' AND deleted_at IS NULL"),
    ).toBe(1);
  });
});

describe('finish_onboarding and the owner review', () => {
  it('counts the changes, raises one card, filters Work, and Mark reviewed ends the chip', async () => {
    await start();
    const owner = await ownerApi();
    const bootBefore = (await owner('GET', '/api/bootstrap')).body.counts as { for_you: number };
    const { session_id } = expectOk(
      await h!.call('onboard_project', { key: 'GF', name: 'Gameflow' }),
    ).structured as { session_id: string };

    // Two created items (an epic and a task), one document, one decision, one Workflow proposal.
    const epic = (
      expectOk(
        await h!.call('create_item', {
          project: 'GF',
          type: 'Epic',
          title: 'Checkout',
          status: 'planning',
        }),
      ).structured as { item: { id: string } }
    ).item.id;
    const task = (
      expectOk(
        await h!.call('create_item', {
          project: 'GF',
          type: 'Task',
          title: 'Card form',
          epic,
          status: 'planning',
          description_md: 'Source: specs/001/tasks.md#T001',
        }),
      ).structured as { item: { id: string; version: number } }
    ).item;
    expectOk(
      await h!.call('put_document', {
        item_id: epic,
        name: 'spec.md',
        kind: 'planning',
        content_text: '# Spec',
      }),
    );
    expectOk(
      await h!.call('publish_decision', {
        project: 'GF',
        scope: { kind: 'project' },
        title: 'Metric units',
        decision: 'Store metric.',
      }),
    );
    const proposal = expectOk(
      await h!.call('propose_agent_file_change', {
        project: 'GF',
        file: 'workflow',
        content: '## Checks to run\n- pnpm test',
        reason: 'From the repo.',
        based_on_version_id: null,
      }),
    ).structured as { proposal_id: string };
    // An owner item in the project, enriched by the agent.
    const owned = (
      await owner('POST', '/api/items', { title: 'Owner idea', type: 'Task', project: 'GF' })
    ).body.item as { id: string; version: number };
    expectOk(
      await h!.call('update_item', {
        id: owned.id,
        expected_version: owned.version,
        acceptance: ['It works'],
      }),
    );

    // Not the session's client: refused.
    expectForbidden(await h!.call('finish_onboarding', { session_id, summary: 'Mine.' }, h!.b));
    expectNotFound(await h!.call('finish_onboarding', { session_id: 'onb_nope', summary: 'x' }));
    const done = expectOk(
      await h!.call('finish_onboarding', {
        session_id,
        summary: '  Created 2, enriched 1.  ',
        questions: ['Is checkout in scope for v1?'],
      }),
    );
    const changes = { created: 2, enriched: 1, documents: 1, decisions: 1, proposals: 1 };
    expect(done.structured).toEqual({ session_id, state: 'ready_for_review', changes });
    expect(eventsOf('onboarding.finished')).toHaveLength(1);
    // Again: conflict, with the session as current.
    const again = expectConflict(
      await h!.call('finish_onboarding', { session_id, summary: 'Again.' }),
    );
    expect((again.current as S).state).toBe('ready_for_review');
    // After the session, Ready is the normal rule again (the agent may move its items).
    expectOk(await h!.call('set_status', { id: task.id, status: 'ready' }));
    expect(tagOfLast('item.status_changed')).toBeUndefined();

    // The owner: one card, the for-you count, the list.
    const needs = (await owner('GET', '/api/needs-you?scope=all')).body;
    const cards = needs.onboarding_reviews as S[];
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      id: session_id,
      project: 'GF',
      project_name: 'Gameflow',
      started_by: 'claude',
      state: 'ready_for_review',
      summary: 'Created 2, enriched 1.',
      questions: ['Is checkout in scope for v1?'],
      changes,
      workflow_proposal_id: proposal.proposal_id,
    });
    const boot = (await owner('GET', '/api/bootstrap')).body.counts as { for_you: number };
    expect(boot.for_you).toBe(bootBefore.for_you + 1);
    const listed = (await owner('GET', '/api/onboarding?project=GF')).body.sessions as S[];
    expect(listed.map((s) => s.id)).toEqual([session_id]);

    // Work's filter: exactly what the session created, or enriched.
    const work = async (change?: string) =>
      (
        await owner(
          'GET',
          `/api/work?scope=GF&layout=list&onboarding=${session_id}${change ? `&onboarding_change=${change}` : ''}`,
        )
      ).body as { items: { id: string }[]; epics: { id: string }[] };
    const created = await work('created');
    expect(created.items.map((i) => i.id)).toEqual([task.id]);
    expect(created.epics.map((e) => e.id)).toEqual([epic]);
    expect((await work('enriched')).items.map((i) => i.id)).toEqual([owned.id]);
    expect((await work()).items.map((i) => i.id).sort()).toEqual([owned.id, task.id].sort());
    expect((await owner('GET', '/api/work?scope=GF&onboarding=onb_nope')).status).toBe(404);

    // Mark reviewed: the card and the chip go; again is a no-op.
    const reviewed = await owner('POST', `/api/onboarding/${session_id}/reviewed`, {});
    expect(reviewed.status).toBe(200);
    expect((reviewed.body.session as S).state).toBe('reviewed');
    expect(eventsOf('onboarding.reviewed')).toHaveLength(1);
    expect((await owner('POST', `/api/onboarding/${session_id}/reviewed`, {})).status).toBe(200);
    expect(eventsOf('onboarding.reviewed')).toHaveLength(1);
    expect((await owner('GET', '/api/needs-you?scope=all')).body.onboarding_reviews as S[]).toEqual(
      [],
    );
    const projects = (await owner('GET', '/api/bootstrap')).body.projects as S[];
    expect(projects.find((p) => p.key === 'GF')!.created_by).toBeNull();
    const settings = (await owner('GET', '/api/settings')).body.projects as S[];
    expect(settings.find((p) => p.key === 'GF')!.created_by).toBeNull();
    // The column keeps who created it.
    expect(
      (sql().prepare("SELECT created_by FROM projects WHERE key = 'GF'").get() as S).created_by,
    ).toBe('claude');
  });

  it('Mark reviewed refuses a session still in progress, and an unknown one', async () => {
    await start();
    const owner = await ownerApi();
    const { session_id } = expectOk(await h!.call('onboard_project', { key: 'RCP' }))
      .structured as { session_id: string };
    const early = await owner('POST', `/api/onboarding/${session_id}/reviewed`, {});
    expect(early.status).toBe(409);
    expect((await owner('POST', '/api/onboarding/onb_nope/reviewed', {})).status).toBe(404);
  });
});

describe('New project (Settings; FR-135)', () => {
  it('creates a project with the key and tombstone rules, and refuses a taken key', async () => {
    await start();
    const owner = await ownerApi();
    const res = await owner('POST', '/api/projects', {
      key: 'GF',
      name: 'Gameflow',
      color: '#0b7285',
      default_satisfied_when: 'merged',
    });
    expect(res.status).toBe(200);
    expect(res.body.project).toMatchObject({
      key: 'GF',
      name: 'Gameflow',
      color: '#0b7285',
      default_satisfied_when: 'merged',
      created_by: null,
    });
    expect(eventsOf('project.created').map((e) => e.client)).toEqual([null]);
    const taken = await owner('POST', '/api/projects', { key: 'GF', name: 'Again' });
    expect(taken.status).toBe(409);
    expect((taken.body.error as S).message).toMatch(/^Project GF already exists/);
    // A default colour from the key when none is given.
    const plain = await owner('POST', '/api/projects', { key: 'PL', name: 'Plain' });
    expect((plain.body.project as S).color).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe('the guide is an agent file (guide:onboarding; FR-137)', () => {
  it('is editable per project, served by the tool and the prompt, and never installed or proposed', async () => {
    await start();
    const owner = await ownerApi();
    const key = encodeURIComponent('guide:onboarding');
    const detail = await owner('GET', `/api/agent-files/${key}?project=RCP`);
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({
      key: 'guide:onboarding',
      kind: 'guide',
      name: 'Onboarding guide',
    });

    const put = await owner('PUT', `/api/agent-files/${key}`, {
      layer: 'project',
      project: 'RCP',
      content: '# RCP guide for {{KEY}}\n- Match by title.\n',
      expected_version: 0,
    });
    expect(put.status).toBe(200);
    const rcp = expectOk(await h!.call('onboard_project', { key: 'RCP' })).structured as S;
    expect(rcp.guide).toBe('# RCP guide for RCP\n- Match by title.\n');
    const prompt = await h!.a.getPrompt({ name: 'onboard', arguments: { project_key: 'RCP' } });
    expect(prompt.messages[0]!.content).toEqual({ type: 'text', text: rcp.guide });
    // Another project (or a new key) still gets the default.
    const gf = await h!.a.getPrompt({ name: 'onboard', arguments: { project_key: 'GF' } });
    expect(gf.messages[0]!.content).toEqual({
      type: 'text',
      text: BUNDLED_GUIDE.replaceAll('{{KEY}}', 'GF'),
    });

    // Not an installed file: get_agent_files doesn't list it, and it can't be proposed.
    const files = expectOk(await h!.call('get_agent_files', { project: 'RCP' }));
    expect(files.text).not.toContain('guide');
    expect(
      (files.structured as { files: { key: string }[] }).files.map((f) => f.key),
    ).not.toContain('guide:onboarding');
    expectValidation(
      await h!.call('propose_agent_file_change', {
        project: 'RCP',
        file: 'guide:onboarding',
        content: '# Mine',
        reason: 'Better.',
        based_on_version_id: 'afv_x',
      }),
    );
    const install = await owner('POST', '/api/installs', {
      project: 'RCP',
      client: 'claude',
      target_kind: 'repo',
      method: 'command',
      path: '/tmp/repo',
    });
    expect(install.status, JSON.stringify(install.body)).toBe(200);
    expect(JSON.stringify(install.body)).not.toContain('guide:onboarding');
  });

  it('a guide that is not loaded is unavailable, with what to do', async () => {
    h = await startHarness();
    const r = await h.call('onboard_project', { key: 'GF', name: 'Gameflow' });
    expect(textOf(r)).toBe(
      'unavailable: The onboarding guide is not loaded yet; it loads when Docket starts. Ask the owner to restart Docket.',
    );
    expect(count("SELECT count(*) AS n FROM projects WHERE key = 'GF'")).toBe(0);
  });
});

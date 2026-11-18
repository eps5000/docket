/**
 * US13 contract (tasks.md T153, T157; owner decision 29): the agent files
 * and Workflow notes through the owner's UI API, exactly as Settings →
 * Agent setup calls it, and `get_context` over MCP delivering a project's
 * Workflow notes within the budgets (FR-123, acceptance scenario 3).
 *
 * Agents can't change agent files: the routes need the owner session (the
 * agent's bearer token gets 401), and the only MCP tools read or propose (decision 30, FR-130).
 *
 * The compact `get_context` text at each budget is printed (PR evidence).
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { syncBundledFiles } from '../../src/jobs/bundled.js';
import { ORIGIN, parseSetCookies } from '../integration/harness.js';
import { expectOk, startHarness, tokens, type ContractHarness } from './harness.js';

let h: ContractHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const transcript: string[] = [];
afterAll(() => {
  if (transcript.length > 0) console.log(transcript.join('\n'));
});

type S = Record<string, unknown>;

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

const WORKER = encodeURIComponent('skill:docket-worker');
const NOTES = [
  '- Branch per item: `rcp-<n>-<slug>`; PRs against `main`.',
  '- Run `pnpm test` before submit_for_review.',
  '- RCP-999 is the old tracker ID; ignore it.',
].join('\n');

describe('get_context delivers the project’s Workflow notes (T157)', () => {
  it('includes them for an item in the project, within every budget', async () => {
    h = await startHarness();
    const owner = await ownerApi();
    const limits = { small: 1_000, medium: 3_000, large: 8_000 } as const;

    // No notes yet: version 0, and get_context has no workflow section.
    expect((await owner('GET', '/api/projects/RCP/workflow')).body).toEqual({
      project: 'RCP',
      version_no: 0,
      content_md: '',
      versions: [],
    });
    const before = expectOk(await h.call('get_context', { id: 'RCP-14' }));
    expect(before.text).not.toContain('workflow:');

    // The owner writes them. The item-reference check warns on RCP-999 (MCP_SPEC §3.4).
    const put = await owner('PUT', '/api/projects/RCP/workflow', {
      content_md: NOTES,
      expected_version: 0,
      note: 'First notes.',
    });
    expect(put.status).toBe(200);
    expect(put.body.workflow).toMatchObject({ project: 'RCP', version_no: 1, content_md: NOTES });
    expect(put.body.warnings).toEqual(["RCP-999 doesn't exist"]);
    expect(typeof put.body.mutation_id).toBe('string');

    for (const budget of ['small', 'medium', 'large'] as const) {
      const ctx = expectOk(await h.call('get_context', { id: 'RCP-14', budget }));
      const n = tokens(ctx.text);
      transcript.push(
        `> get_context {"id":"RCP-14","budget":"${budget}"}  (${n} tokens)`,
        ctx.text,
        '',
      );
      expect(n, budget).toBeLessThanOrEqual(limits[budget]);
      expect(ctx.text).toContain('workflow: RCP v1');
      // Placed after the links, before the planning documents (§5.15 order).
      const lines = ctx.text.split('\n');
      const wf = lines.findIndex((l) => l.startsWith('workflow: RCP v1'));
      const docs = lines.findIndex((l) => l.startsWith('planning_docs:'));
      const blocked = lines.findIndex((l) => l.startsWith('blocked_by'));
      expect(blocked).toBeLessThan(wf);
      if (docs >= 0) expect(wf).toBeLessThan(docs);
    }
    const medium = expectOk(await h.call('get_context', { id: 'RCP-14' }));
    expect(medium.text).toContain(`workflow: RCP v1\n  ${NOTES.split('\n').join('\n  ')}`);

    // Another project's item doesn't get them.
    const doc = expectOk(await h.call('get_context', { id: 'DOC-4' }));
    expect(doc.text).not.toContain('workflow:');

    // Stale versions conflict; clearing leaves get_context without the section; undo restores.
    expect(
      (await owner('PUT', '/api/projects/RCP/workflow', { content_md: 'x', expected_version: 0 }))
        .status,
    ).toBe(409);
    const clear = await owner('PUT', '/api/projects/RCP/workflow', {
      content_md: '',
      expected_version: 1,
    });
    expect(clear.body.workflow).toMatchObject({ version_no: 2, content_md: '' });
    expect(expectOk(await h.call('get_context', { id: 'RCP-14' })).text).not.toContain('workflow:');
    expect(
      (await owner('POST', `/api/mutations/${String(clear.body.mutation_id)}/undo`, {})).status,
    ).toBe(200);
    expect(expectOk(await h.call('get_context', { id: 'RCP-14' })).text).toContain(
      'workflow: RCP v1',
    );
  });
});

describe('agent files over the owner API (T153)', () => {
  it('lists, edits, overrides, reverts and undoes; flags a bundled upgrade', async () => {
    h = await startHarness();
    const owner = await ownerApi();
    const runtime = h.server.runtime;
    expect(syncBundledFiles(runtime).added).toHaveLength(6);

    const list = await owner('GET', '/api/agent-files');
    expect(list.status).toBe(200);
    const files = list.body.files as S[];
    expect(files.map((f) => f.key)).toEqual([
      'skill:docket-coordinator',
      'skill:docket-lead-subagents',
      'skill:docket-planner',
      'skill:docket-review-packet',
      'skill:docket-worker',
      'agents_block',
    ]);
    expect(files.every((f) => f.effective_layer === 'bundled' && f.bundled_updated === false)).toBe(
      true,
    );

    // Edit service-wide: a new version with the note; the bundled one is kept for the diff.
    const bundled = await owner('GET', `/api/agent-files/${WORKER}`);
    const bundledText = ((bundled.body.layers as S).bundled as { versions: { content: string }[] })
      .versions[0]!.content;
    const edited = `${bundledText}\n## Our rules\n- Squash on merge.\n`;
    const put = await owner('PUT', `/api/agent-files/${WORKER}`, {
      layer: 'service',
      content: edited,
      expected_version: 0,
      note: 'Squash on merge.',
    });
    expect(put.status).toBe(200);
    expect(put.body.file).toMatchObject({ effective_layer: 'service', project: null });
    expect(
      (
        (await owner('PUT', `/api/agent-files/${WORKER}`, {
          layer: 'service',
          content: 'x',
          expected_version: 0,
        })) as { status: number }
      ).status,
    ).toBe(409);

    // A project override: the project's effective set says where each file comes from.
    const override = await owner('PUT', `/api/agent-files/${WORKER}`, {
      layer: 'project',
      project: 'RCP',
      content: `${edited}- RCP uses Spec Kit.\n`,
      expected_version: 0,
      note: 'Spec Kit.',
    });
    expect(override.status).toBe(200);
    const rcp = (await owner('GET', '/api/agent-files?project=RCP')).body.files as S[];
    expect(rcp.find((f) => f.key === 'skill:docket-worker')).toMatchObject({
      effective_layer: 'project',
    });
    expect(rcp.find((f) => f.key === 'agents_block')).toMatchObject({ effective_layer: 'bundled' });
    const doc = (await owner('GET', '/api/agent-files?project=DOC')).body.files as S[];
    expect(doc.find((f) => f.key === 'skill:docket-worker')).toMatchObject({
      effective_layer: 'service',
    });

    // Revert the override, then undo the revert.
    const rev = await owner('POST', `/api/agent-files/${WORKER}/revert`, {
      layer: 'project',
      project: 'RCP',
    });
    expect(rev.body.file).toMatchObject({ effective_layer: 'service', project: 'RCP' });
    expect(
      (await owner('POST', `/api/mutations/${String(rev.body.mutation_id)}/undo`, {})).status,
    ).toBe(200);
    expect(
      ((await owner('GET', `/api/agent-files/${WORKER}?project=RCP`)).body as S).effective_layer,
    ).toBe('project');

    // An upgrade changes the bundled worker skill: flagged, the edit is kept.
    runtime.write.run(
      { actor: { kind: 'system', client: null, label: null }, operation: 'test', args: {} },
      (w) =>
        runtime.services.agentFiles.syncBundled(w, {
          files: [{ key: 'skill:docket-worker', content: `${bundledText}\nUpgraded.\n` }],
        }),
    );
    const flagged = (await owner('GET', '/api/agent-files')).body.files as S[];
    expect(flagged.find((f) => f.key === 'skill:docket-worker')).toMatchObject({
      effective_layer: 'service',
      bundled_updated: true,
    });
    const view = (await owner('GET', `/api/agent-files/${WORKER}`)).body;
    expect(view.bundled_updated).toMatchObject({ edited_layer: 'service' });
    const service = (view.layers as S).service as { versions: { content: string }[] };
    expect(service.versions[0]!.content).toBe(edited);

    // Bad keys and unknown files.
    expect((await owner('GET', '/api/agent-files/skill%3ABad_Name')).status).toBe(400);
    expect((await owner('GET', '/api/agent-files/skill%3Anope')).status).toBe(404);
  });

  it('agents can’t change agent files: owner session only, and the only MCP tools read or propose', async () => {
    h = await startHarness();
    const token = h.server.runtime.secrets.agentToken();
    const res = await h.server.app.request(`${ORIGIN}/api/agent-files/${WORKER}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ layer: 'service', content: 'x', expected_version: 0 }),
    });
    expect(res.status).toBe(401);
    const wf = await h.server.app.request(`${ORIGIN}/api/projects/RCP/workflow`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ content_md: 'x', expected_version: 0 }),
    });
    expect(wf.status).toBe(401);
    const tools = (await h.a.listTools()).tools.map((t) => t.name);
    // Decision 30 (FR-130): agents read and propose; no tool writes agent files or Workflow notes.
    expect(tools.filter((t) => /agent_?file|workflow|skill|install/i.test(t))).toEqual([
      'get_agent_files',
      'propose_agent_file_change',
    ]);
  });
});

/**
 * US14 contract, proposals (tasks.md T160; owner decision 30; FR-128–FR-130;
 * BUILD_SPEC §5.19), through the official MCP client SDK and the owner's UI
 * API exactly as the Agent files page calls it:
 * - `get_agent_files`: the listing (no text), one file with its full text,
 *   Workflow notes always listed, unknown file and project;
 * - `propose_agent_file_change`: nothing changes until the owner acts; the
 *   proposal is listed and counted in Needs you; 5 pending per target; the
 *   same run replaces its own older proposal; secrets refused and nothing
 *   stored; the base must be a version of the file;
 * - agents can't approve: no MCP tool decides, and the owner routes refuse
 *   the agent's token;
 * - approve (and edit, then approve) → a new version of the project's copy
 *   or the default, authored "proposed by … · approved by owner", undoable;
 *   `get_context` and the next install use it; decline isn't undoable;
 * - the three-way basis: `changed_since` when the target moved on.
 */
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { TOOL_NAMES } from '@docket/shared';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { syncBundledFiles } from '../../src/jobs/bundled.js';
import { tempDir } from '../helpers.js';
import { ORIGIN, parseSetCookies } from '../integration/harness.js';
import {
  expectNotFound,
  expectOk,
  expectValidation,
  startHarness,
  tokens,
  type ContractHarness,
  type HarnessOptions,
} from './harness.js';

type S = Record<string, unknown>;

let h: ContractHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const transcript: string[] = [];
afterAll(() => {
  if (transcript.length > 0) console.log(transcript.join('\n'));
});

async function start(opts: HarnessOptions = {}) {
  h = await startHarness(opts);
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
  const cookie = `tl_owner=${cookies.tl_owner!.value}; tl_csrf=${cookies.tl_csrf!.value}`;
  return async (method: string, path: string, body?: unknown) => {
    const r = await req(path, {
      method,
      headers: {
        cookie,
        ...(method === 'GET' ? {} : { 'x-tasklite-csrf': cookies.tl_csrf!.value }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    return { status: r.status, body: (text ? JSON.parse(text) : {}) as S };
  };
}

const WORKER = 'skill:tasklite-worker';
const files = (r: { structured: S }) => r.structured.files as S[];

/** Claim a Ready seed item as `orca-w3`; returns the run. */
async function claim(id = 'RCP-17', label = 'orca-w3'): Promise<string> {
  const ok = expectOk(await h!.call('claim_lead', { id, agent_label: label }));
  return ok.structured.run_id as string;
}

/** Read the worker skill as the agent would before proposing. */
async function readWorker(project = 'RCP') {
  const r = expectOk(await h!.call('get_agent_files', { project, file: WORKER }));
  return files(r)[0]!;
}

const count = (sql: string, ...args: unknown[]) =>
  (h!.server.runtime.db.sqlite.prepare(sql).get(...args) as { n: number }).n;

describe('get_agent_files (MCP_SPEC §5.10)', () => {
  it('lists every file without text, Workflow notes included, then one file in full', async () => {
    await start();
    const list = expectOk(await h!.call('get_agent_files', { project: 'RCP' }));
    const keys = files(list).map((f) => f.key);
    expect(keys).toContain(WORKER);
    expect(keys).toContain('agents_block');
    expect(keys.at(-1)).toBe('workflow');
    expect(files(list).every((f) => f.content === null)).toBe(true);
    // No notes yet: no version, the empty text's hash, the project's own.
    expect(files(list).at(-1)).toEqual({
      key: 'workflow',
      kind: 'workflow',
      version_id: null,
      sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      source: 'project',
      content: null,
    });
    expect(list.text.split('\n')).toHaveLength(keys.length + 1);
    transcript.push('', '--- get_agent_files RCP (listing) ---', list.text);

    const one = expectOk(await h!.call('get_agent_files', { project: 'RCP', file: WORKER }));
    expect(files(one)).toHaveLength(1);
    const shipped = readFileSync(
      new URL('../../../skills/tasklite-worker/SKILL.md', import.meta.url),
      'utf8',
    );
    expect(files(one)[0]).toMatchObject({ key: WORKER, source: 'default', content: shipped });
    // The text block carries the text verbatim, after its header line.
    expect(one.text).toContain(`content (${shipped.length} characters, verbatim):\n${shipped}`);

    const notes = expectOk(await h!.call('get_agent_files', { project: 'RCP', file: 'workflow' }));
    expect(files(notes)[0]).toMatchObject({ key: 'workflow', content: '' });
  });

  it('refuses an unknown file and an unknown project', async () => {
    await start();
    const bad = expectValidation(
      await h!.call('get_agent_files', { project: 'RCP', file: 'skill:not-shipped' }),
    );
    expect(bad.message).toContain('No agent file skill:not-shipped');
    expectNotFound(await h!.call('get_agent_files', { project: 'ZZZ' }));
  });
});

describe('propose_agent_file_change (FR-128)', () => {
  it('stores a pending proposal and changes nothing else; Needs you counts it', async () => {
    await start();
    const owner = await ownerApi();
    const run = await claim();
    const before = await readWorker();
    const content = `${before.content as string}\n- Run the linter before each commit.\n`;
    const r = expectOk(
      await h!.call('propose_agent_file_change', {
        project: 'RCP',
        file: WORKER,
        content,
        reason: '  Lint before each commit; RCP-17 broke CI.  ',
        based_on_version_id: before.version_id,
        run_id: run,
      }),
    );
    expect(r.structured).toEqual({ proposal_id: expect.stringMatching(/^afp_/), state: 'pending' });
    expect(tokens(r.text)).toBeLessThanOrEqual(60);
    transcript.push('', '--- propose_agent_file_change ---', r.text);

    // Nothing changed: the project still uses the default, same version.
    expect(await readWorker()).toEqual(before);

    const listed = await owner('GET', '/api/agent-file-proposals?project=RCP');
    expect(listed.status).toBe(200);
    expect(listed.body.proposals).toEqual([
      {
        id: r.structured.proposal_id,
        project: 'RCP',
        file_key: WORKER,
        name: 'tasklite-worker',
        content,
        reason: 'Lint before each commit; RCP-17 broke CI.',
        based_on_version_id: before.version_id,
        current_version_id: before.version_id,
        changed_since: false,
        run_id: run,
        item_id: 'RCP-17',
        proposed_by: 'claude · orca-w3',
        state: 'pending',
        created_at: expect.any(String),
        decided_at: null,
        decided_note: null,
        result_version_id: null,
      },
    ]);
    const needs = await owner('GET', '/api/needs-you?scope=RCP');
    expect(needs.body.agent_file_proposals).toBe(1);
    expect((await owner('GET', '/api/needs-you?scope=all')).body.agent_file_proposals).toBe(1);
    // The Activity of the run's item says so.
    const item = await owner('GET', '/api/items/RCP-17');
    expect(
      (item.body.activity as { summary: string }[]).some((a) =>
        a.summary.startsWith('claude · orca-w3 proposed a change to tasklite-worker (RCP'),
      ),
    ).toBe(true);
  });

  it('keeps 5 pending per file and target; the same run replaces its own older one', async () => {
    await start();
    const base = await readWorker();
    const propose = (n: number, extra: S = {}) =>
      h!.call('propose_agent_file_change', {
        project: 'RCP',
        file: WORKER,
        content: `${base.content as string}\nchange ${n}\n`,
        reason: `Change ${n}`,
        based_on_version_id: base.version_id,
        ...extra,
      });
    const run = await claim();
    const first = expectOk(await propose(0, { run_id: run }));
    const second = expectOk(await propose(1, { run_id: run }));
    // Replaced: one pending from this run, the newer one.
    expect(
      count(
        "SELECT count(*) AS n FROM agent_file_proposals WHERE run_id = ? AND state = 'pending'",
        run,
      ),
    ).toBe(1);
    expect(
      count(
        'SELECT count(*) AS n FROM agent_file_proposals WHERE id = ?',
        first.structured.proposal_id,
      ),
    ).toBe(0);
    expect(second.structured.proposal_id).not.toBe(first.structured.proposal_id);

    // Four more without a run: 5 pending, then the sixth is refused.
    for (const n of [2, 3, 4, 5]) expectOk(await propose(n));
    const sixth = expectValidation(await propose(6));
    expect(sixth.message).toContain('5 proposals for tasklite-worker (RCP');
    expect(sixth.details).toMatchObject({ pending: 5, limit: 5 });
    // A different target (the default) has its own 5.
    expectOk(await propose(7, { project: undefined }));
    // The same run replacing its own still works at the limit.
    expectOk(await propose(8, { run_id: run }));
    expect(
      count(
        "SELECT count(*) AS n FROM agent_file_proposals WHERE project_key = 'RCP' AND state = 'pending'",
      ),
    ).toBe(5);
  });

  it('refuses a secret (nothing stored), a base from another file, and workflow without a project', async () => {
    await start();
    const base = await readWorker();
    const secret = expectValidation(
      await h!.call('propose_agent_file_change', {
        project: 'RCP',
        file: WORKER,
        content: `${base.content as string}\nUse ghp_${'a'.repeat(36)} to push.\n`,
        reason: 'Push with this token',
        based_on_version_id: base.version_id,
        idempotency_key: 'afp-secret-1',
      }),
    );
    expect(secret.message).toMatch(/Looks like a secret/);
    expect(count('SELECT count(*) AS n FROM agent_file_proposals')).toBe(0);
    expect(count('SELECT count(*) AS n FROM idempotency')).toBe(0);

    const block = files(
      expectOk(await h!.call('get_agent_files', { project: 'RCP', file: 'agents_block' })),
    )[0]!;
    const wrongBase = expectValidation(
      await h!.call('propose_agent_file_change', {
        project: 'RCP',
        file: WORKER,
        content: 'x',
        reason: 'r',
        based_on_version_id: block.version_id,
      }),
    );
    expect(wrongBase.message).toContain("isn't a version of tasklite-worker");

    expectValidation(
      await h!.call('propose_agent_file_change', {
        file: 'workflow',
        content: '- notes',
        reason: 'r',
        based_on_version_id: null,
      }),
    );
    // An item reference that doesn't exist is accepted, with a warning (MCP_SPEC §3.4).
    const warned = expectOk(
      await h!.call('propose_agent_file_change', {
        project: 'RCP',
        file: 'workflow',
        content: '- RCP-999 is the old tracker ID.',
        reason: 'Explain RCP-999',
        based_on_version_id: null,
      }),
    );
    expect(warned.structured.warnings).toEqual(["RCP-999 doesn't exist"]);
  });
});

describe('agents can’t decide (FR-130)', () => {
  it('has no MCP tool that approves or writes, and the owner routes refuse the agent token', async () => {
    await start();
    expect(
      TOOL_NAMES.filter((n) => /approve|decline|decide|put_agent|write_agent/.test(n)),
    ).toEqual([]);
    const { tools } = await h!.a.listTools();
    expect(tools.map((t) => t.name).filter((n) => n.includes('agent_file'))).toEqual([
      'get_agent_files',
      'propose_agent_file_change',
    ]);
    const token = h!.server.runtime.secrets.agentToken();
    for (const [method, path] of [
      ['GET', '/api/agent-file-proposals'],
      ['POST', '/api/agent-file-proposals/afp_1/approve'],
      ['POST', '/api/agent-file-proposals/afp_1/decline'],
      ['PUT', '/api/agent-files/skill%3Atasklite-worker'],
    ] as const) {
      const r = await h!.server.app.request(`${ORIGIN}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: method === 'GET' ? undefined : '{}',
      });
      expect(r.status, `${method} ${path}`).toBe(401);
    }
  });
});

describe('the owner decides (FR-129)', () => {
  it('approve saves the project’s copy with the proposer and approver; undo reverses both', async () => {
    await start();
    const owner = await ownerApi();
    const run = await claim();
    const base = await readWorker();
    const content = `${base.content as string}\n- Lint first.\n`;
    const { proposal_id } = expectOk(
      await h!.call('propose_agent_file_change', {
        project: 'RCP',
        file: WORKER,
        content,
        reason: 'Lint first',
        based_on_version_id: base.version_id,
        run_id: run,
      }),
    ).structured as { proposal_id: string };

    const ok = await owner('POST', `/api/agent-file-proposals/${proposal_id}/approve`, {});
    expect(ok.status).toBe(200);
    const decided = ok.body.proposal as S;
    expect(decided).toMatchObject({
      state: 'approved',
      result_version_id: expect.stringMatching(/^afv_/),
    });

    // The project's copy, authored by both.
    const after = await readWorker();
    expect(after).toMatchObject({
      source: 'project',
      content,
      version_id: decided.result_version_id,
    });
    const detail = await owner('GET', `/api/agent-files/${encodeURIComponent(WORKER)}?project=RCP`);
    const layers = detail.body.layers as { project: { versions: S[] } };
    expect(layers.project.versions[0]).toMatchObject({
      author: 'proposed by claude · orca-w3 · approved by owner',
      note: 'Lint first',
      content,
    });
    expect((await owner('GET', '/api/needs-you?scope=RCP')).body.agent_file_proposals).toBe(0);

    // Undo: the copy goes, the proposal waits again.
    const undo = await owner('POST', `/api/mutations/${ok.body.mutation_id as string}/undo`, {});
    expect(undo.status).toBe(200);
    expect(await readWorker()).toMatchObject({ source: 'default', version_id: base.version_id });
    const again = await owner('GET', '/api/agent-file-proposals?project=RCP&state=pending');
    expect((again.body.proposals as S[]).map((p) => p.id)).toEqual([proposal_id]);

    // A second decision on a decided proposal is a conflict.
    await owner('POST', `/api/agent-file-proposals/${proposal_id}/approve`, {});
    const twice = await owner('POST', `/api/agent-file-proposals/${proposal_id}/decline`, {});
    expect(twice.status).toBe(409);
  });

  it('edit, then approve saves the owner’s text; a default proposal saves the default', async () => {
    await start();
    const owner = await ownerApi();
    const base = await readWorker();
    const { proposal_id } = expectOk(
      await h!.call('propose_agent_file_change', {
        file: WORKER,
        content: `${base.content as string}\n- Agent's line.\n`,
        reason: 'For every project',
        based_on_version_id: base.version_id,
      }),
    ).structured as { proposal_id: string };
    const mine = `${base.content as string}\n- Owner's better line.\n`;
    const ok = await owner('POST', `/api/agent-file-proposals/${proposal_id}/approve`, {
      content: mine,
      note: 'Reworded',
    });
    expect(ok.status).toBe(200);
    // The default changed, so RCP (no copy) uses it.
    expect(await readWorker()).toMatchObject({ source: 'default', content: mine });
    const detail = await owner('GET', `/api/agent-files/${encodeURIComponent(WORKER)}`);
    const layers = detail.body.layers as { service: { versions: S[] } };
    expect(layers.service.versions[0]).toMatchObject({
      author: 'proposed by claude · edited and approved by owner',
      note: 'Reworded',
    });
    expect((ok.body.proposal as S).decided_note).toBe('Reworded');
  });

  it('decline records the note and can’t be undone', async () => {
    await start();
    const owner = await ownerApi();
    const base = await readWorker();
    const { proposal_id } = expectOk(
      await h!.call('propose_agent_file_change', {
        project: 'RCP',
        file: WORKER,
        content: 'Do whatever.',
        reason: 'Simpler',
        based_on_version_id: base.version_id,
      }),
    ).structured as { proposal_id: string };
    const no = await owner('POST', `/api/agent-file-proposals/${proposal_id}/decline`, {
      note: 'Too vague',
    });
    expect(no.status).toBe(200);
    expect(no.body.proposal).toMatchObject({ state: 'declined', decided_note: 'Too vague' });
    const undo = await owner('POST', `/api/mutations/${no.body.mutation_id as string}/undo`, {});
    expect(undo.status).toBe(400);
    expect(await readWorker()).toEqual(base);
  });

  it('flags a proposal whose target changed since the agent read it (three-way basis)', async () => {
    await start();
    const owner = await ownerApi();
    const base = await readWorker();
    const { proposal_id } = expectOk(
      await h!.call('propose_agent_file_change', {
        project: 'RCP',
        file: WORKER,
        content: `${base.content as string}\n- Agent.\n`,
        reason: 'Add a line',
        based_on_version_id: base.version_id,
      }),
    ).structured as { proposal_id: string };
    // The owner customizes the file for RCP meanwhile.
    const put = await owner('PUT', `/api/agent-files/${encodeURIComponent(WORKER)}`, {
      layer: 'project',
      project: 'RCP',
      content: `${base.content as string}\n- Owner.\n`,
      expected_version: 0,
      note: 'Mine',
    });
    expect(put.status).toBe(200);
    const listed = (await owner('GET', '/api/agent-file-proposals?project=RCP')).body
      .proposals as S[];
    const copy = await readWorker();
    expect(listed[0]).toMatchObject({
      id: proposal_id,
      based_on_version_id: base.version_id,
      current_version_id: copy.version_id,
      changed_since: true,
    });
  });

  it('approve → get_context delivers the Workflow notes, and the next install sends the copy', async () => {
    const tmp = tempDir('tasklite-us14-push-');
    const root = join(tmp.dir, 'code');
    mkdirSync(join(root, 'recipes', '.git'), { recursive: true });
    try {
      await start({ env: { TASKLITE_PUSH_ROOT: root } });
      const owner = await ownerApi();
      const notes = '- Branch per item: `rcp-<n>-<slug>`.';
      const wf = expectOk(
        await h!.call('propose_agent_file_change', {
          project: 'RCP',
          file: 'workflow',
          content: notes,
          reason: 'Agree on branches',
          based_on_version_id: null,
        }),
      ).structured as { proposal_id: string };
      expect(
        (await owner('POST', `/api/agent-file-proposals/${wf.proposal_id}/approve`, {})).status,
      ).toBe(200);
      const ctx = expectOk(await h!.call('get_context', { id: 'RCP-14' }));
      expect(ctx.text).toContain('Branch per item');
      // The notes' version ID is what get_agent_files and the GET route name.
      const read = files(
        expectOk(await h!.call('get_agent_files', { project: 'RCP', file: 'workflow' })),
      )[0]!;
      const wfGet = await owner('GET', '/api/projects/RCP/workflow');
      expect((wfGet.body.versions as S[])[0]!.id).toBe(read.version_id);

      const base = await readWorker();
      const content = `${base.content as string}\n- From a proposal.\n`;
      const skill = expectOk(
        await h!.call('propose_agent_file_change', {
          project: 'RCP',
          file: WORKER,
          content,
          reason: 'Add a line',
          based_on_version_id: base.version_id,
        }),
      ).structured as { proposal_id: string };
      const ok = await owner('POST', `/api/agent-file-proposals/${skill.proposal_id}/approve`, {});
      const versionId = (ok.body.proposal as S).result_version_id;
      const install = await owner('POST', '/api/installs', {
        client: 'claude',
        target_kind: 'repo',
        project: 'RCP',
        path: 'recipes',
        method: 'push',
      });
      expect(install.status).toBe(200);
      expect(
        readFileSync(
          join(root, 'recipes', '.claude', 'skills', 'tasklite-worker', 'SKILL.md'),
          'utf8',
        ),
      ).toBe(content);
      const manifest = readFileSync(
        join(root, 'recipes', '.claude', '.tasklite-manifest.json'),
        'utf8',
      );
      expect(manifest).toContain(
        `"key":"${WORKER}","path":".claude/skills/tasklite-worker/SKILL.md","version_id":"${versionId as string}"`,
      );
    } finally {
      await h?.close();
      h = undefined;
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });
});

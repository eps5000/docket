/**
 * US11 over MCP (tasks.md T097): the worked flows MCP_SPEC §7.12 (parking
 * while you wait) and §7.13 (crash recovery), and MCP_SPEC §10 tests 17–20,
 * through the official SDK client against a seeded server. The owner's side
 * goes through the UI API with an owner session.
 *
 * The crash simulation is a real restart: the first runtime is closed, a new
 * one opens the same data directory, and the boot sweep runs, as
 * `server/src/index.ts` does. New SDK clients then work from
 * `recovery_report` alone (SC-014).
 *
 * The compact text of `park_run`, a resuming `heartbeat` and
 * `recovery_report` is printed (PR evidence).
 */
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Hono } from 'hono';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { restartSweep } from '../../src/jobs/sweeper.js';
import { createRuntime, type Runtime } from '../../src/runtime.js';
import { ORIGIN, STRUCTURED_FOR_ALL, parseSetCookies } from '../integration/harness.js';
import {
  CLIENT_A,
  expectConflict,
  expectForbidden,
  expectNotFound,
  expectOk,
  expectValidation,
  startHarness,
  type ContractHarness,
} from './harness.js';

let h: ContractHarness | undefined;
let restarted: Runtime | undefined;
afterEach(async () => {
  await restarted?.close();
  restarted = undefined;
  await h?.close();
  h = undefined;
});

const transcript: string[] = [];
afterAll(() => {
  if (transcript.length > 0) console.log(transcript.join('\n'));
});

type S = Record<string, unknown>;
const minutes = (n: number) => n * 60_000;

/** Call a tool, keep its compact text for the transcript, return the structured result. */
async function step(name: string, args: S, client: Client): Promise<S> {
  const res = (await client.callTool({ name, arguments: args })) as CallToolResult;
  const { structured, text } = expectOk(res);
  transcript.push(`> ${name} ${JSON.stringify(args)}`, text, '');
  return structured;
}
const call = async (client: Client, name: string, args: S) =>
  (await client.callTool({ name, arguments: args })) as CallToolResult;

/** An owner session on an app, and a JSON request helper. */
async function ownerApi(app: Hono, ownerKey: string) {
  const req = (path: string, init?: RequestInit) =>
    Promise.resolve(app.request(`${ORIGIN}${path}`, init));
  const res = await req('/api/session/unlock', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: ownerKey }),
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
    return { status: r.status, body: (await r.json()) as S };
  };
}

/** An SDK client on `app` with the agent token. */
async function connectTo(app: Hono, runtime: Runtime, info = CLIENT_A): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), {
    fetch: (url, init) => Promise.resolve(app.request(String(url), init)),
    requestInit: { headers: { authorization: `Bearer ${runtime.secrets.agentToken()}` } },
  });
  const client = new Client(info);
  await client.connect(transport);
  for (let i = 0; i < 200 && !runtime.mcp.hasStream(transport.sessionId ?? ''); i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  return client;
}

/**
 * Crash and restart: every client is dropped, the runtime closes, a new one
 * opens the same data directory (env overrides apply to it) and runs the
 * boot sweep.
 */
async function restart(harness: ContractHarness, env: Record<string, string> = {}) {
  await Promise.allSettled([harness.a.close(), harness.b.close()]);
  await harness.server.runtime.close();
  const runtime = createRuntime({
    dataDir: harness.server.dataDir,
    env: { ...STRUCTURED_FOR_ALL, ...env },
    clock: harness.server.clock.now,
    log: () => {},
  });
  restarted = runtime;
  const { interrupted } = restartSweep(runtime);
  const app = createApp(runtime, { webRoot: join(dirname(harness.server.dataDir), 'web') });
  return { runtime, app, interrupted };
}

const item = (s: S) => s.item as S & { runs: S[]; resume: S | null; checklist: { work: S[] } };
const runOf = (s: S, runId: string) =>
  item(s).runs.find((r) => r.run_id === runId) as S & {
    workspace: S | null;
    parked: S | null;
    resources: S[];
  };

describe('§7.12 parking while you wait (MCP_SPEC §10 test 17)', () => {
  it('claim → report_commit pushed → park_run → resume_ready → heartbeat resumes', async () => {
    h = await startHarness();
    transcript.push('## §7.12 Parking while you wait', '');
    const { run_id } = (await step(
      'claim_lead',
      {
        id: 'RCP-17',
        agent_label: 'orca-w2',
        workspace: {
          path: 'C:/work/rcp-17',
          branch: 'rcp-17-week-reload',
          base_ref: 'origin/main',
          base_sha: '9a10624',
        },
        orchestrator: { name: 'orca', dispatch_id: 'ctx_6f2d' },
        brief: 'Fix the planner jump after reload. Resume from the checklist; claim_lead first.',
      },
      h.a,
    )) as { run_id: string };
    await step('report_commit', { id: 'RCP-17', run_id, sha: 'c1d2e3f', pushed: true }, h.a);
    const parked = await step(
      'park_run',
      {
        run_id,
        reason: 'Waiting for DOC-5 (docs search index) before wiring the reload state in',
        waiting_on: { items: ['DOC-5'] },
      },
      h.a,
    );
    expect(parked).toEqual({ run_state: 'parked', resume_ready: false });

    // Hours later: never stale, lease suspended, claim kept.
    h.server.clock.advance(minutes(180));
    const read = await call(h.b, 'get_item', { id: 'RCP-17' });
    const run = runOf(expectOk(read).structured, run_id);
    expect(run).toMatchObject({ run_state: 'parked', lease_expires_at: null });
    expect(run.workspace).toMatchObject({ state: 'parked', pushed_sha: 'c1d2e3f' });
    expectConflict(await call(h.b, 'claim_lead', { id: 'RCP-17' }));

    // DOC-5 is done (another agent closes it): resume_ready.
    const doc5 = (await step('claim_lead', { id: 'DOC-5' }, h.b)) as { run_id: string };
    await step('set_status', { id: 'DOC-5', status: 'done', run_id: doc5.run_id }, h.b);
    const report = await step('recovery_report', {}, h.b);
    expect(report.parked).toEqual([
      expect.objectContaining({
        resume_ready: true,
        item: expect.objectContaining({ id: 'RCP-17' }),
      }),
    ]);

    const beat = await step('heartbeat', { run_id, note: 'Resuming after DOC-5' }, h.a);
    expect(beat.run_state).toBe('live');
    const after = runOf(expectOk(await call(h.a, 'get_item', { id: 'RCP-17' })).structured, run_id);
    expect(after.parked).toBeNull();
    expect(after.lease_expires_at).not.toBeNull();
    const types = (
      expectOk(await call(h.a, 'get_changes', { cursor: '0', item_id: 'RCP-17' })).structured
        .events as { type: string }[]
    ).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['run.parked', 'run.resumed']));
  });

  it('after DOCKET_PARK_MAX it shows under the owner’s Problems but keeps its claim', async () => {
    h = await startHarness();
    const api = await ownerApi(h.server.app, h.server.runtime.secrets.ownerKey());
    const { run_id } = expectOk(await call(h.a, 'claim_lead', { id: 'RCP-17' })).structured as {
      run_id: string;
    };
    expectOk(
      await call(h.a, 'park_run', {
        run_id,
        reason: 'Waiting for the coordinator',
        waiting_on: { orchestrator: true },
      }),
    );
    h.server.clock.advance(h.server.runtime.config.parkMaxMs);
    const needs = await api('GET', '/api/needs-you?scope=all');
    const problems = needs.body.problems as { kind: string; item_id: string; run_id: string }[];
    expect(problems).toContainEqual(
      expect.objectContaining({ kind: 'parked_too_long', item_id: 'RCP-17', run_id }),
    );
    expectConflict(await call(h.b, 'claim_lead', { id: 'RCP-17' }));
  });

  it('park_run errors: ended run (conflict), unknown waiting item (validation), someone else’s run (forbidden), unknown run (not_found)', async () => {
    h = await startHarness();
    const { run_id } = expectOk(await call(h.a, 'claim_lead', { id: 'RCP-17' })).structured as {
      run_id: string;
    };
    expectValidation(
      await call(h.a, 'park_run', { run_id, reason: 'x', waiting_on: { items: ['RCP-999'] } }),
    );
    expectForbidden(await call(h.b, 'park_run', { run_id, reason: 'x' }));
    expectNotFound(await call(h.a, 'park_run', { run_id: 'run_01JNOPE', reason: 'x' }));
    expectOk(await call(h.a, 'finish_run', { run_id, result: 'finished', summary: 'Done.' }));
    expectConflict(await call(h.a, 'park_run', { run_id, reason: 'x' }));
  });
});

describe('workspace states (MCP_SPEC §10 test 18)', () => {
  it('in_use, parked, at_risk (dirty, unpushed, resources) and safe_to_prune, from the right inputs', async () => {
    h = await startHarness();
    const state = async (path: string) => {
      const r = expectOk(await call(h!.b, 'recovery_report', { limit: 50 })).structured as {
        workspaces: { path: string; state: string }[];
      };
      return r.workspaces.find((w) => w.path === path)?.state;
    };
    const claim = async (id: string, path: string) =>
      (
        expectOk(await call(h!.a, 'claim_lead', { id, workspace: { path, branch: `${id}-b` } }))
          .structured as { run_id: string }
      ).run_id;

    const a = await claim('RCP-17', 'C:/w/a');
    expect(await state('C:/w/a')).toBe('in_use');
    expectOk(
      await call(h.a, 'park_run', { run_id: a, reason: 'Wait', waiting_on: { person: true } }),
    );
    expect(await state('C:/w/a')).toBe('parked');
    // report_commit pushed:true moves pushed_sha.
    expectOk(
      await call(h.a, 'report_commit', { id: 'RCP-17', run_id: a, sha: '4be1c09', pushed: true }),
    );
    expectOk(await call(h.a, 'heartbeat', { run_id: a, workspace: { dirty: false } }));
    const view = expectOk(await call(h.a, 'get_item', { id: 'RCP-17' })).structured;
    expect(runOf(view, a).workspace).toMatchObject({
      head_sha: '4be1c09',
      pushed_sha: '4be1c09',
      dirty: false,
    });
    expectOk(await call(h.a, 'finish_run', { run_id: a, result: 'finished', summary: 'Done.' }));
    expect(await state('C:/w/a')).toBe('safe_to_prune');

    const b = await claim('RCP-25', 'C:/w/dirty');
    expectOk(
      await call(h.a, 'report_commit', { id: 'RCP-25', run_id: b, sha: '6f00e12', pushed: true }),
    );
    expectOk(await call(h.a, 'heartbeat', { run_id: b, workspace: { dirty: true } }));
    expectOk(await call(h.a, 'finish_run', { run_id: b, result: 'finished', summary: 'Done.' }));
    expect(await state('C:/w/dirty')).toBe('at_risk');

    const c = await claim('DOC-5', 'C:/w/unpushed');
    expectOk(
      await call(h.a, 'heartbeat', {
        run_id: c,
        workspace: { head_sha: '77aa001', pushed_sha: '6f00e12', dirty: false },
      }),
    );
    expectOk(await call(h.a, 'finish_run', { run_id: c, result: 'finished', summary: 'Done.' }));
    expect(await state('C:/w/unpushed')).toBe('at_risk');

    const d = await claim('RCP-17', 'C:/w/resources');
    expectOk(
      await call(h.a, 'heartbeat', {
        run_id: d,
        workspace: { head_sha: '4be1c09', pushed_sha: '4be1c09', dirty: false },
        resources_started: [
          { kind: 'container', label: 'postgres test db', locator: { container: 'pg-17' } },
        ],
      }),
    );
    expectOk(await call(h.a, 'finish_run', { run_id: d, result: 'finished', summary: 'Done.' }));
    expect(await state('C:/w/resources')).toBe('at_risk');
  });
});

describe('finish_run warnings and the owner’s Problems (MCP_SPEC §10 test 20)', () => {
  it('warns on unreleased resources and unpushed commits; the owner sees both Problems and acts on them', async () => {
    h = await startHarness();
    const api = await ownerApi(h.server.app, h.server.runtime.secrets.ownerKey());
    const { run_id } = expectOk(
      await call(h.a, 'claim_lead', {
        id: 'RCP-17',
        workspace: { path: 'C:/work/rcp-17', branch: 'rcp-17-week-reload' },
      }),
    ).structured as { run_id: string };
    const hb = expectOk(
      await call(h.a, 'heartbeat', {
        run_id,
        resources_started: [
          { kind: 'dev_server', label: 'dev server :5173', locator: { port: 5173, pid: 4242 } },
        ],
      }),
    );
    const rsc = (hb.structured.resources as { id: string }[])[0]!.id;
    expect(rsc).toMatch(/^rsc_/);
    expectOk(
      await call(h.a, 'report_commit', { id: 'RCP-17', run_id, sha: '6f00e12', pushed: true }),
    );
    expectOk(await call(h.a, 'report_commit', { id: 'RCP-17', run_id, sha: '77aa001' }));
    expectOk(await call(h.a, 'report_commit', { id: 'RCP-17', run_id, sha: '88bb002' }));
    const fin = await step(
      'finish_run',
      { run_id, result: 'finished', summary: 'Stopped with the dev server still up.' },
      h.a,
    );
    expect(fin.warnings).toEqual([
      '1 resource still declared: dev server :5173',
      '2 commits not pushed',
    ]);
    expect(transcript.at(-2)).toContain('! 1 resource still declared: dev server :5173');
    expect(transcript.at(-2)).toContain('! 2 commits not pushed');

    let problems = (await api('GET', '/api/needs-you?scope=all')).body.problems as S[];
    expect(problems).toContainEqual(
      expect.objectContaining({ kind: 'unpushed_work', run_id, item_id: 'RCP-17' }),
    );
    expect(problems.some((p) => p.kind === 'orphaned_resources')).toBe(false);
    h.server.clock.advance(h.server.runtime.config.orphanAfterMs);
    problems = (await api('GET', '/api/needs-you?scope=all')).body.problems as S[];
    expect(problems).toContainEqual(
      expect.objectContaining({ kind: 'orphaned_resources', run_id, resource_ids: [rsc] }),
    );
    const ws = await api('GET', '/api/workspaces?scope=all');
    expect(ws.body.rows).toContainEqual(
      expect.objectContaining({
        path: 'C:/work/rcp-17',
        state: 'at_risk',
        unpushed_commits: 2,
        unreleased_resources: 1,
      }),
    );

    // Mark released and Handled: both undoable owner mutations.
    const rel = await api('POST', `/api/resources/${rsc}/release`, { note: 'Killed pid 4242.' });
    expect(rel.status).toBe(200);
    expect(rel.body).toMatchObject({ resource: { id: rsc, release_note: 'Killed pid 4242.' } });
    const handled = await api('POST', `/api/runs/${run_id}/unpushed-handled`, {});
    expect(handled.status).toBe(200);
    problems = (await api('GET', '/api/needs-you?scope=all')).body.problems as S[];
    expect(problems.filter((p) => p.run_id === run_id)).toEqual([]);
    const undo = await api('POST', `/api/mutations/${handled.body.mutation_id as string}/undo`, {});
    expect(undo.status).toBe(200);
    problems = (await api('GET', '/api/needs-you?scope=all')).body.problems as S[];
    expect(problems.map((p) => p.kind)).toContain('unpushed_work');

    // The agent sees the owner's release as an event.
    const changes = expectOk(await call(h.a, 'get_changes', { cursor: '0', item_id: 'RCP-17' }))
      .structured.events as { type: string; actor: string }[];
    expect(changes).toContainEqual(
      expect.objectContaining({ type: 'resource.released', actor: 'owner' }),
    );
  });
});

describe('§7.13 crash recovery and SC-014 (MCP_SPEC §10 test 19)', () => {
  it('three workers, a restart, then re-dispatch from recovery_report alone', async () => {
    h = await startHarness();
    transcript.push('## §7.13 Crash recovery (SC-014)', '');
    const third = await h.connect({ name: 'gemini-cli', version: '1.0.0' });
    const briefs = {
      'RCP-17':
        'Work Task Lite item RCP-17 using the tasklite-worker skill.\nWorktree: C:/work/rcp-17 · branch rcp-17-week-reload · base origin/main @ 9a10624\nClaim with claim_lead, passing this workspace and this brief verbatim. Then get_context.\r\nConstraints: run `pnpm test`; don’t touch docs/. 🚀  ',
      'RCP-25':
        'Work Task Lite item RCP-25. Worktree C:/work/rcp-25. If you must wait, park_run; don’t end silently.',
      'RCP-18':
        'Work Task Lite item RCP-18 (resume the failed import). Worktree C:/work/rcp-18. Dev server on :5173.',
    };

    // 1. Active: RCP-17, a plan with 2 of 4 steps done, pushed and clean.
    const active = (await step(
      'claim_lead',
      {
        id: 'RCP-17',
        agent_label: 'orca-w1',
        workspace: {
          path: 'C:/work/rcp-17',
          branch: 'rcp-17-week-reload',
          base_ref: 'origin/main',
          base_sha: '9a10624',
        },
        orchestrator: { name: 'orca', dispatch_id: 'ctx_a1', task_id: 'task_17' },
        brief: briefs['RCP-17'],
        external: { orca: { worktree_id: 'wt_17' } },
      },
      h.a,
    )) as { run_id: string };
    const plan = (await step(
      'set_plan',
      {
        id: 'RCP-17',
        run_id: active.run_id,
        steps: [
          { text: 'Reproduce the jump after reload' },
          { text: 'Store the selected week in the URL' },
          { text: 'Restore it on load' },
          { text: 'Test with a reload' },
        ],
        reason: 'First plan',
      },
      h.a,
    )) as { work: { id: string }[] };
    for (const s of plan.work.slice(0, 2)) {
      expectOk(
        await call(h.a, 'update_step', {
          id: 'RCP-17',
          run_id: active.run_id,
          step_id: s.id,
          state: 'done',
        }),
      );
    }
    expectOk(
      await call(h.a, 'report_commit', {
        id: 'RCP-17',
        run_id: active.run_id,
        sha: '4be1c09',
        pushed: true,
      }),
    );
    expectOk(await call(h.a, 'heartbeat', { run_id: active.run_id, workspace: { dirty: false } }));

    // 2. Parked on an item: RCP-25 waits for DOC-5.
    const parked = (await step(
      'claim_lead',
      {
        id: 'RCP-25',
        agent_label: 'orca-w2',
        workspace: { path: 'C:/work/rcp-25', branch: 'rcp-25-pantry-screens' },
        orchestrator: { name: 'orca', dispatch_id: 'ctx_b2' },
        brief: briefs['RCP-25'],
      },
      h.b,
    )) as { run_id: string };
    await step(
      'park_run',
      {
        run_id: parked.run_id,
        reason: 'Waiting for DOC-5 to land',
        waiting_on: { items: ['DOC-5'] },
      },
      h.b,
    );

    // 3. At risk: RCP-18 with a dev server and a commit not pushed.
    const risky = (await step(
      'claim_lead',
      {
        id: 'RCP-18',
        agent_label: 'orca-w3',
        workspace: { path: 'C:/work/rcp-18', branch: 'rcp-18-import-url' },
        orchestrator: { name: 'orca', dispatch_id: 'ctx_c3' },
        brief: briefs['RCP-18'],
      },
      third,
    )) as { run_id: string };
    await step(
      'heartbeat',
      {
        run_id: risky.run_id,
        resources_started: [
          { kind: 'dev_server', label: 'dev server :5173', locator: { port: 5173, pid: 9876 } },
        ],
      },
      third,
    );
    expectOk(
      await call(third, 'report_commit', {
        id: 'RCP-18',
        run_id: risky.run_id,
        sha: '6f00e12',
        pushed: true,
      }),
    );
    expectOk(
      await call(third, 'report_commit', { id: 'RCP-18', run_id: risky.run_id, sha: '77aa001' }),
    );
    expectOk(await call(third, 'heartbeat', { run_id: risky.run_id, workspace: { dirty: true } }));
    await third.close();

    // Crash: the service restarts and nobody sends signals.
    const orphanAfter = '2m';
    const { runtime, app, interrupted } = await restart(h, { DOCKET_ORPHAN_AFTER: orphanAfter });
    expect(interrupted.sort()).toEqual(
      expect.arrayContaining([active.run_id, risky.run_id].sort()),
    );
    expect(interrupted).not.toContain(parked.run_id);
    transcript.push(
      `-- restart: boot sweep interrupted ${interrupted.length} open runs; the parked run stays parked --`,
      '',
    );

    // The coordinator: recovery_report { include_briefs: true }, nothing else.
    const coordinator = await connectTo(app, runtime, {
      name: 'orca-coordinator',
      version: '1.0.0',
    });
    const report = (await step('recovery_report', { include_briefs: true }, coordinator)) as {
      interrupted: {
        item: { id: string };
        run: {
          run_id: string;
          workspace: S;
          orchestrator: S;
          external?: S;
          resources: S[];
          brief_document_version_id: string;
        };
        end_reason: string;
        checklist: { done: number; total: number };
        brief?: string;
      }[];
      parked: { item: { id: string }; resume_ready: boolean }[];
      workspaces: { path: string; state: string; unreleased_resources: number }[];
      orphaned_resources: { resource: { label: string; locator: S }; item_id: string }[];
    };
    const byItem = (id: string) => report.interrupted.find((e) => e.item.id === id)!;
    const r17 = byItem('RCP-17');
    expect(r17).toMatchObject({ end_reason: 'service_restart', checklist: { done: 2, total: 4 } });
    expect(r17.brief).toBe(briefs['RCP-17']); // byte-identical
    expect(r17.run.workspace).toMatchObject({
      path: 'C:/work/rcp-17',
      branch: 'rcp-17-week-reload',
      pushed_sha: '4be1c09',
      dirty: false,
      state: 'at_risk',
    });
    expect(r17.run.orchestrator).toEqual({
      name: 'orca',
      dispatch_id: 'ctx_a1',
      task_id: 'task_17',
      run_id: null,
    });
    expect(r17.run.external).toEqual({ orca: { worktree_id: 'wt_17' } });
    const r18 = byItem('RCP-18');
    expect(r18.brief).toBe(briefs['RCP-18']);
    expect(r18.run.workspace).toMatchObject({
      head_sha: '77aa001',
      pushed_sha: '6f00e12',
      dirty: true,
      state: 'at_risk',
    });
    expect(r18.run.resources).toEqual([
      expect.objectContaining({ label: 'dev server :5173', released_at: null }),
    ]);
    expect(report.parked).toEqual([
      expect.objectContaining({
        item: expect.objectContaining({ id: 'RCP-25' }),
        resume_ready: false,
      }),
    ]);
    expect(report.workspaces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'C:/work/rcp-18',
          state: 'at_risk',
          unreleased_resources: 1,
        }),
        expect.objectContaining({ path: 'C:/work/rcp-17', state: 'at_risk' }),
        expect.objectContaining({ path: 'C:/work/rcp-25', state: 'parked' }),
      ]),
    );
    expect(report.orphaned_resources).toEqual([]); // not yet: ORPHAN_AFTER after the run ended
    const allBriefs = report.interrupted.filter((e) => e.item.id in briefs).map((e) => e.brief);
    expect(allBriefs).toEqual(
      report.interrupted
        .filter((e) => e.item.id in briefs)
        .map((e) => briefs[e.item.id as keyof typeof briefs]),
    );

    // Re-dispatch RCP-17 from the report alone: claim_lead with the stored brief and workspace, then continue.
    const worker = await connectTo(app, runtime, { name: 'claude-code', version: '2.0.0' });
    const resumed = (await step(
      'claim_lead',
      {
        id: 'RCP-17',
        agent_label: 'orca-w4',
        workspace: {
          path: r17.run.workspace.path as string,
          branch: r17.run.workspace.branch as string,
        },
        orchestrator: { name: 'orca', dispatch_id: 'ctx_a1-retry' },
        brief_document_version_id: r17.run.brief_document_version_id,
      },
      worker,
    )) as { run_id: string; item: { status: string } };
    expect(resumed.item.status).toBe('progress');
    const got = expectOk(
      await call(worker, 'get_item', { id: 'RCP-17', run_id: resumed.run_id }),
    ).structured;
    const work = item(got).checklist.work as { id: string; state: string }[];
    const next = work.find((s) => s.state !== 'done')!;
    expect(work.indexOf(next)).toBe(2); // continues from the third step
    expectOk(
      await call(worker, 'update_step', {
        id: 'RCP-17',
        run_id: resumed.run_id,
        step_id: next.id,
        state: 'current',
      }),
    );
    // The brief it was given is the same document version, unchanged.
    expect(runOf(got, resumed.run_id).brief_document_version_id).toBe(
      r17.run.brief_document_version_id,
    );

    // Within ORPHAN_AFTER the dev server shows as orphaned, to the coordinator and to the owner.
    h.server.clock.advance(minutes(2));
    const later = (await step('recovery_report', {}, coordinator)) as typeof report;
    expect(later.interrupted.map((e) => e.item.id)).not.toContain('RCP-17'); // re-dispatched
    expect(later.orphaned_resources).toEqual([
      expect.objectContaining({
        item_id: 'RCP-18',
        resource: expect.objectContaining({
          label: 'dev server :5173',
          locator: { port: 5173, pid: 9876 },
        }),
      }),
    ]);
    const api = await ownerApi(app, runtime.secrets.ownerKey());
    const problems = (await api('GET', '/api/needs-you?scope=all')).body.problems as S[];
    expect(problems.map((p) => `${p.kind as string}:${p.item_id as string}`)).toEqual(
      expect.arrayContaining(['orphaned_resources:RCP-18', 'unpushed_work:RCP-18']),
    );
    // The resumed RCP-17 worktree is in use again.
    const ws = await api('GET', '/api/workspaces?scope=all');
    expect(ws.body.rows).toContainEqual(
      expect.objectContaining({ path: 'C:/work/rcp-17', state: 'in_use' }),
    );
    await Promise.allSettled([coordinator.close(), worker.close()]);
  });
});

/**
 * Tool registration and the stubs (tasks.md T040–T041), through the official
 * MCP client SDK:
 * - every tool answers `unavailable` ("Not implemented yet: <tool>") once
 *   its arguments are valid, and malformed calls get `validation` first;
 * - the SDK client receives errors as isError results without throwing
 *   (B3 resolution 8);
 * - unknown keys are named with a suggestion (B3 resolution 4);
 * - idempotency: replay → `replayed: true`; same key, other arguments →
 *   `validation` (MCP_SPEC §3, §10 item 5);
 * - the run_id signal hook, the call log, and client identity.
 */
import { readFileSync } from 'node:fs';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { TOOL_NAMES, ToolError, type EventRow, type ToolName } from '@docket/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { notImplemented } from '../../src/domain/contracts.js';
import { HANDLER_GROUPS } from '../../src/mcp/tools/index.js';
import type { RunSignal, ToolHandlers } from '../../src/mcp/register.js';
import { TOOLS } from '@docket/shared';
import {
  VALID_ARGS,
  expectNotFound,
  expectOk,
  expectToolError,
  expectUnavailable,
  expectValidation,
  startHarness,
  textOf,
  tokens,
  type ContractHarness,
} from './harness.js';

let h: ContractHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

/** Tools US1 (T076), US3 (T094), US11 (T100), US4 (T107), US5 (T115), US6 (T120) and US7 (T124) implemented: since US7, all of them. */
export const US1_TOOLS: readonly ToolName[] = [
  'whoami',
  'list_projects',
  'search_items',
  'get_item',
  'get_changes',
  'create_item',
  'update_item',
  'set_status',
  'claim_lead',
  'release_lead',
  'start_run',
  'heartbeat',
  'finish_run',
  'set_plan',
  'update_step',
  'log_subagent',
  'set_checks',
  'update_check',
  'add_note',
  'link_artifact',
  'report_commit',
  // US3 (B9, T094).
  'declare_human_review',
  'update_human_review',
  'submit_packet',
  'get_review',
  'deferred_reviews',
  // US11 (B10, T100).
  'park_run',
  'update_run_status',
  'recovery_report',
  // US4 (B11, T107).
  'link_items',
  'unlink_items',
  'dependency_subgraph',
  // US5 (B12, T115).
  'get_context',
  'publish_decision',
  'list_decisions',
  'withdraw_decision',
  // US6 (B13, T120).
  'ask_owner',
  // US7 (B14, T124).
  'put_document',
  'upsert_label',
  // US14 (B27a, T160).
  'get_agent_files',
  'propose_agent_file_change',
  // US15 (B30, T164); content in us15-onboarding.test.ts.
  'onboard_project',
  'finish_onboarding',
  // Decision 33 (B33, T170); content in checklist-details.test.ts.
  'get_step',
  // Decision 34 (B36, T177); content in us17-batch.test.ts.
  'apply_batch',
  // Decision 36 (B38, T182; B39, T183); content in us18-shared-contracts.test.ts.
  'declare_shared_changes',
  'list_shared_parts',
  'take_lease',
  'release_lease',
  // Decision 37 (B42, T186); content in b42-problems.test.ts.
  'propose_resolution',
  // Decision 40 (B48); content in digest.test.ts.
  'get_digest',
];
const STUB_TOOLS = TOOL_NAMES.filter((n) => !US1_TOOLS.includes(n));

describe('stubs', () => {
  it('no tool is a stub any more: B39 (T183) implemented the leases', () => {
    expect(STUB_TOOLS).toEqual([]);
  });

  it.each(['take_lease', 'release_lease'] as const)(
    '%s refuses a malformed part key with validation',
    async (name) => {
      h = await startHarness();
      expectValidation(await h.call(name, { id: 'RCP-14', part: 'Recipe' }));
    },
  );

  it('claim_lead accepts instructions (decision 30) and still claims; a bad report is refused', async () => {
    h = await startHarness();
    const sha = 'b'.repeat(64);
    const ok = expectOk(
      await h.call('claim_lead', {
        id: 'RCP-17',
        agent_label: 'orca-w3',
        instructions: {
          install_id: 'ins_1',
          files: [
            { key: 'agents_block', sha256: sha },
            { key: 'skill:docket-worker', sha256: sha.toUpperCase(), content: '# edited\n' },
          ],
        },
      }),
    );
    expect(ok.structured.run_id).toMatch(/^run_/);
    const bad = expectValidation(
      await h.call('claim_lead', {
        id: 'RCP-17',
        instructions: { files: [{ key: 'workflow', sha256: 'short' }] },
      }),
    );
    expect(Object.keys(bad.details?.fields as object).sort()).toEqual([
      'instructions.files[0].key',
      'instructions.files[0].sha256',
    ]);
  });

  it('a service that is still a stub answers unavailable: "Not implemented yet"', async () => {
    h = await startHarness({
      services: { items: { upsertLabel: notImplemented('items.upsertLabel') } },
    });
    const result = await h.call('upsert_label', VALID_ARGS.upsert_label);
    const err = expectUnavailable(result);
    expect(err).toEqual({ code: 'unavailable', message: 'Not implemented yet: upsert_label' });
    expect(textOf(result)).toBe('unavailable: Not implemented yet: upsert_label');
  });

  it('each stub lives in its group file (server/src/mcp/tools/<group>.ts)', () => {
    for (const tool of TOOLS) expect(HANDLER_GROUPS[tool.group], tool.name).toContain(tool.name);
    expect(Object.values(HANDLER_GROUPS).flat().sort()).toEqual([...TOOL_NAMES].sort());
  });
});

describe('validation runs before the handler', () => {
  it('create_item without a title gets validation, even from a stub', async () => {
    h = await startHarness();
    const err = expectValidation(await h.call('create_item', { project: 'RCP', type: 'Task' }));
    expect(err.message).toBe(
      'Invalid arguments for create_item: title is required. Fix it and retry.',
    );
    expect(err.details).toEqual({ fields: { title: 'is required' } });
  });

  it('an unknown key is named, with the closest valid field, in the message and details', async () => {
    h = await startHarness();
    const err = expectValidation(
      await h.call('update_item', { id: 'RCP-14', expected_verison: 7, title: 'x' }),
    );
    expect(err.message).toContain(
      'Unknown field "expected_verison"; did you mean "expected_version"?',
    );
    expect(err.details?.unknown).toEqual([
      { field: 'expected_verison', suggestion: 'expected_version' },
    ]);
  });

  it('a value over its limit gets validation', async () => {
    h = await startHarness();
    const err = expectValidation(
      await h.call('create_item', { project: 'RCP', type: 'Task', title: 't'.repeat(201) }),
    );
    expect(err.details).toEqual({ fields: { title: 'must be at most 200 characters' } });
  });

  it('an unknown tool is a JSON-RPC error, not a tool result (§6)', async () => {
    h = await startHarness();
    await expect(h.call('delete_everything')).rejects.toBeInstanceOf(McpError);
  });
});

describe('errors reach the SDK client as results (B3 resolution 8)', () => {
  it('unavailable and validation errors are isError results; the client does not throw', async () => {
    h = await startHarness({
      services: { items: { upsertLabel: notImplemented('items.upsertLabel') } },
    });
    // listTools cached every outputSchema, so the client validates structuredContent.
    await h.a.listTools();
    const unavailable = await h.a.callTool({
      name: 'upsert_label',
      arguments: VALID_ARGS.upsert_label,
    });
    expect(unavailable.isError).toBe(true);
    expect(unavailable.structuredContent).toEqual({
      code: 'unavailable',
      message: 'Not implemented yet: upsert_label',
    });
    const validation = await h.a.callTool({
      name: 'create_item',
      arguments: { project: 'RCP', type: 'Task' },
    });
    expect(validation.isError).toBe(true);
    expect((validation.structuredContent as { code: string }).code).toBe('validation');
  });

  it('a handler result that breaks its output schema becomes internal, with a logged ref', async () => {
    const lines: string[] = [];
    h = await startHarness({
      toolHandlers: {
        list_projects: (() => ({ projects: 'oops' })) as unknown as ToolHandlers['list_projects'],
      },
    });
    const log = h.server.runtime.log;
    h.server.runtime.log = (line) => {
      lines.push(line);
      log(line);
    };
    const err = expectToolError(await h.call('list_projects'), 'internal');
    expect(err.message).toMatch(/^Unexpected error \(ref e_[0-9A-Z]+\)\. It has been logged\.$/);
    expect(lines.some((l) => l.includes(String(err.details?.ref)))).toBe(true);
  });
});

/** A real write for add_note, so the idempotency hook can be exercised before US1 exists. */
const addNoteThatWrites: ToolHandlers['add_note'] = (args, ctx) =>
  ctx.mutate((w) => {
    const seq = w.event({
      type: 'note.added',
      summary: args.text,
      item_id: args.id,
      project_key: 'RCP',
    });
    const event: EventRow = {
      cursor: String(seq),
      at: w.now,
      actor: ctx.actor.client ?? 'agent',
      item_id: args.id,
      type: 'note.added',
      summary: args.text,
    };
    return { event };
  });

describe('idempotency (§3; §10 item 5)', () => {
  const countEvents = (hh: ContractHarness) =>
    (
      hh.server.runtime.db.sqlite
        .prepare("SELECT count(*) AS n FROM events WHERE type = 'note.added'")
        .get() as {
        n: number;
      }
    ).n;

  it('replaying the same key and arguments returns the original result, marked replayed', async () => {
    h = await startHarness({ toolHandlers: { add_note: addNoteThatWrites } });
    const before = countEvents(h);
    const args = { id: 'RCP-14', text: 'Merged units across recipes.', idempotency_key: 'note-1' };
    const first = expectOk(await h.call('add_note', args));
    expect(first.structured.replayed).toBeUndefined();
    const again = expectOk(await h.call('add_note', args));
    expect(again.structured).toEqual({ ...first.structured, replayed: true });
    expect(again.text).toBe(`${first.text} · replayed`);
    expect(countEvents(h)).toBe(before + 1);
  });

  it('the same key with different arguments gets validation', async () => {
    h = await startHarness({ toolHandlers: { add_note: addNoteThatWrites } });
    await h.call('add_note', { id: 'RCP-14', text: 'First.', idempotency_key: 'note-2' });
    const err = expectValidation(
      await h.call('add_note', { id: 'RCP-14', text: 'Different.', idempotency_key: 'note-2' }),
    );
    expect(err.message).toBe(
      'This idempotency_key was already used with different arguments; use a new key for a new operation.',
    );
  });

  it('keys are scoped per client', async () => {
    h = await startHarness({ toolHandlers: { add_note: addNoteThatWrites } });
    const args = { id: 'RCP-14', text: 'Same text.', idempotency_key: 'shared-key' };
    expectOk(await h.call('add_note', args, h.a));
    const other = expectOk(await h.call('add_note', args, h.b));
    expect(other.structured.replayed).toBeUndefined();
  });

  it('stubs store nothing, so a retried stub call just answers unavailable again', async () => {
    h = await startHarness({
      services: { items: { upsertLabel: notImplemented('items.upsertLabel') } },
    });
    const args = { ...VALID_ARGS.upsert_label, idempotency_key: 'stub-1' };
    expectUnavailable(await h.call('upsert_label', args));
    expectUnavailable(await h.call('upsert_label', args));
    expectUnavailable(await h.call('upsert_label', { ...args, brief_md: 'Desktop too.' }));
    const n = (
      h.server.runtime.db.sqlite.prepare('SELECT count(*) AS n FROM idempotency').get() as {
        n: number;
      }
    ).n;
    expect(n).toBe(0);
  });

  it('a secret in the arguments is rejected before anything is stored (§3.4)', async () => {
    h = await startHarness({ toolHandlers: { add_note: addNoteThatWrites } });
    const before = countEvents(h);
    const err = expectValidation(
      await h.call('add_note', {
        id: 'RCP-14',
        text: 'token ghp_abcdefghijklmnopqrstuvwxyz0123',
        idempotency_key: 'sec-1',
      }),
    );
    expect(err.message).toMatch(/^Looks like a secret/);
    expect(countEvents(h)).toBe(before);
  });
});

describe('the run_id signal hook', () => {
  it('a call from the run’s own session is a session signal; from another session, report', async () => {
    let seen: RunSignal | null = null;
    h = await startHarness({
      toolHandlers: {
        whoami: (_args, ctx) => {
          seen = ctx.signal;
          throw new ToolError('unavailable', 'Not implemented yet: whoami');
        },
      },
    });
    const sessionA = h.server.runtime.mcp.sessions().find((s) => s.client === 'claude')!.session_id;
    const run = h.server.runtime.db.sqlite.prepare('SELECT id FROM runs LIMIT 1').get() as {
      id: string;
    };
    h.server.runtime.db.sqlite
      .prepare('UPDATE runs SET session_id = ? WHERE id = ?')
      .run(sessionA, run.id);

    await h.call('whoami', { run_id: run.id }, h.a);
    expect(seen).toEqual({ run_id: run.id, kind: 'session', known: true });
    await h.call('whoami', { run_id: run.id }, h.b);
    expect(seen).toEqual({ run_id: run.id, kind: 'report', known: true });
    await h.call('whoami', { run_id: 'run_unknown' }, h.a);
    expect(seen).toEqual({ run_id: 'run_unknown', kind: 'report', known: false });
    await h.call('whoami', {}, h.a);
    expect(seen).toBeNull();
  });
});

describe('the call log', () => {
  it('writes one line per call: tool, client, label, run, duration, result; never arguments', async () => {
    h = await startHarness();
    const secretish = 'a-very-distinctive-note-text';
    await h.call('add_note', { id: 'RCP-14', text: secretish, run_id: 'run_01JA' });
    await h.call('claim_lead', { id: 'RCP-17', agent_label: 'orca-w3' }, h.b);
    await h.call('create_item', { project: 'RCP', type: 'Task' });
    const log = h.server.runtime.callLog.read();
    expect(log).not.toContain(secretish);
    const lines = log
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(Object.keys(line)).toEqual([
        'time',
        'tool',
        'client',
        'label',
        'run',
        'duration_ms',
        'result',
      ]);
    }
    expect(
      lines.map(({ tool, client, label, run, result }) => ({ tool, client, label, run, result })),
    ).toEqual([
      // A mutation naming a run that doesn't exist (US1: not_found).
      { tool: 'add_note', client: 'claude', label: null, run: 'run_01JA', result: 'not_found' },
      { tool: 'claim_lead', client: 'codex', label: 'orca-w3', run: null, result: 'ok' },
      { tool: 'create_item', client: 'claude', label: null, run: null, result: 'validation' },
    ]);
  });
});

describe('harness', () => {
  it('connects two clients with different clientInfo, recorded as distinct sessions', async () => {
    h = await startHarness({ seed: false });
    const clients = h.server.runtime.mcp.sessions().map((s) => [s.client, s.client_name]);
    expect(clients.sort()).toEqual([
      ['claude', 'claude-code'],
      ['codex', 'codex-mcp-client'],
    ]);
  });

  it('measures tokens as characters ÷ 4, rounded up', () => {
    expect(tokens('')).toBe(0);
    expect(tokens('abcd')).toBe(1);
    expect(tokens('abcde')).toBe(2);
  });

  it('seeds a fresh database per harness', async () => {
    h = await startHarness();
    const items = (
      h.server.runtime.db.sqlite.prepare('SELECT count(*) AS n FROM items').get() as { n: number }
    ).n;
    expect(items).toBeGreaterThan(0);
    const raw = readFileSync(new URL('../../../design/sample-data.json', import.meta.url), 'utf8');
    expect(items).toBe((JSON.parse(raw) as { items: unknown[] }).items.length);
  });

  it('VALID_ARGS covers every tool and passes each input schema', () => {
    expect(Object.keys(VALID_ARGS).sort()).toEqual([...TOOL_NAMES].sort());
    for (const tool of TOOLS) {
      const r = tool.input.safeParse(VALID_ARGS[tool.name as ToolName]);
      expect(r.success, `${tool.name}: ${r.success ? '' : r.error.message}`).toBe(true);
    }
  });
});

describe('recovery tools over MCP (B5: park_run, recovery_report and the new fields)', () => {
  it('tools/list shows park_run as a write that is not idempotent, recovery_report as read-only', async () => {
    h = await startHarness();
    const { tools } = await h.a.listTools();
    const byName = (n: string) => tools.find((t) => t.name === n)!;
    expect(byName('park_run').annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
    });
    expect(byName('recovery_report').annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
    });
    // §5.9 recovery_report, then §5.10's two agent file tools (decision 30), §5.11's two
    // (decision 31), §5.12's get_step (decision 33), §5.13's apply_batch (decision 34) and
    // §5.15's four (decision 36) and §5.16's propose_resolution (decision 37).
    expect(tools.map((t) => t.name).slice(-12)).toEqual([
      'recovery_report',
      'get_agent_files',
      'propose_agent_file_change',
      'onboard_project',
      'finish_onboarding',
      'get_step',
      'apply_batch',
      'declare_shared_changes',
      'list_shared_parts',
      'take_lease',
      'release_lease',
      'propose_resolution',
    ]);
    expect(tools.findIndex((t) => t.name === 'park_run')).toBe(
      tools.findIndex((t) => t.name === 'finish_run') + 1,
    );
  });

  it('park_run and recovery_report are implemented (US11): an unknown run is not_found, the report answers', async () => {
    h = await startHarness();
    expectNotFound(await h.call('park_run', { run_id: 'run_01JA', reason: 'Waiting for RCP-12' }));
    expectOk(await h.call('recovery_report', {}));
    expectOk(
      await h.call('recovery_report', { project: 'RCP', since: '2026-11-08T00:00:00Z', limit: 10 }),
    );
  });

  it('heartbeat accepts the new fields; resources need a real run (US11)', async () => {
    h = await startHarness();
    const args = {
      run_id: 'run_01JA',
      workspace: { head_sha: '77aa001', pushed_sha: '6f00e12', dirty: true },
      resources_started: [
        { kind: 'dev_server', label: 'dev server :5173', locator: { port: 5173 } },
      ],
      resources_released: [{ resource_id: 'rsc_1', note: 'stopped' }],
    };
    expectNotFound(await h.call('heartbeat', args));
  });

  it('claim_lead, start_run and report_commit accept and store the new fields (US11)', async () => {
    h = await startHarness();
    const claim = expectOk(
      await h.call('claim_lead', {
        id: 'RCP-17',
        workspace: { path: 'C:/work/rcp-17', branch: 'rcp-17', base_ref: 'origin/main' },
        orchestrator: { name: 'orca', dispatch_id: 'ctx_1' },
        brief: 'Fix the jump after reload.',
        external: { orca: { worktree_id: 'wt_17' } },
      }),
    );
    const run_id = claim.structured.run_id as string;
    const item = expectOk(await h.call('get_item', { id: 'RCP-17', view: 'full' }));
    const run = (
      item.structured.item as {
        runs: { run_id: string; brief_document_version_id: string | null }[];
      }
    ).runs.find((r) => r.run_id === run_id)!;
    expect(run.brief_document_version_id).toMatch(/^dv_/);
    expectOk(
      await h.call('start_run', {
        id: 'RCP-17',
        parent_run_id: run_id,
        brief_document_version_id: run.brief_document_version_id,
      }),
    );
    expectOk(await h.call('report_commit', { id: 'RCP-17', sha: '4be1c09', pushed: true }));
  });

  it('an unknown key gets validation with a did-you-mean', async () => {
    h = await startHarness();
    const park = expectValidation(
      await h.call('park_run', { run_id: 'run_01JA', reason: 'x', waiting_onn: {} }),
    );
    expect(park.message).toContain('Unknown field "waiting_onn"; did you mean "waiting_on"?');
    const report = expectValidation(await h.call('recovery_report', { include_brief: true }));
    expect(report.message).toContain(
      'Unknown field "include_brief"; did you mean "include_briefs"?',
    );
    const nested = expectValidation(
      await h.call('claim_lead', { id: 'RCP-17', workspace: { branh: 'x' } }),
    );
    expect(nested.message).toContain(
      'Unknown field "workspace.branh"; did you mean "workspace.branch"?',
    );
  });

  it('an oversized brief gets validation', async () => {
    h = await startHarness();
    const err = expectValidation(
      await h.call('claim_lead', { id: 'RCP-17', brief: 'x'.repeat(20_001) }),
    );
    expect(err.details?.fields).toEqual({ brief: 'must be at most 20000 characters' });
  });

  it('brief and brief_document_version_id together get validation', async () => {
    h = await startHarness();
    const err = expectValidation(
      await h.call('start_run', {
        id: 'RCP-14',
        parent_run_id: 'run_01JA',
        brief: 'Do it.',
        brief_document_version_id: 'dv_1',
      }),
    );
    expect(err.message).toBe(
      'Invalid arguments for start_run: brief_document_version_id pass brief or brief_document_version_id, not both. Fix it and retry.',
    );
  });

  it('external over 2 KB and more than 10 resources per heartbeat get validation', async () => {
    h = await startHarness();
    expectValidation(
      await h.call('claim_lead', { id: 'RCP-17', external: { orca: 'x'.repeat(2_100) } }),
    );
    const resource = { kind: 'port', label: 'port 3000', locator: { port: 3000 } };
    const err = expectValidation(
      await h.call('heartbeat', {
        run_id: 'run_01JA',
        resources_started: Array.from({ length: 11 }, () => resource),
      }),
    );
    expect(err.details?.fields).toEqual({ resources_started: 'must have at most 10 entries' });
  });
});

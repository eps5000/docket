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
import { TOOL_NAMES, ToolError, type EventRow, type ToolName } from '@tasklite/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { HANDLER_GROUPS } from '../../src/mcp/tools/index.js';
import type { RunSignal, ToolHandlers } from '../../src/mcp/register.js';
import { TOOLS } from '@tasklite/shared';
import {
  VALID_ARGS,
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

/** Tools US1 (T076) and US3 (T094) implemented; the rest stay stubs until their slice. */
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
];
const STUB_TOOLS = TOOL_NAMES.filter((n) => !US1_TOOLS.includes(n));

describe('stubs', () => {
  it.each(STUB_TOOLS)('%s answers unavailable: "Not implemented yet"', async (name) => {
    h ??= await startHarness();
    const result = await h.call(name, VALID_ARGS[name]);
    const err = expectUnavailable(result);
    expect(err).toEqual({ code: 'unavailable', message: `Not implemented yet: ${name}` });
    expect(textOf(result)).toBe(`unavailable: Not implemented yet: ${name}`);
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
    h = await startHarness();
    // listTools cached every outputSchema, so the client validates structuredContent.
    await h.a.listTools();
    const unavailable = await h.a.callTool({ name: 'get_context', arguments: { id: 'RCP-12' } });
    expect(unavailable.isError).toBe(true);
    expect(unavailable.structuredContent).toEqual({
      code: 'unavailable',
      message: 'Not implemented yet: get_context',
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
    h = await startHarness();
    const args = { ...VALID_ARGS.ask_owner, idempotency_key: 'stub-1' };
    expectUnavailable(await h.call('ask_owner', args));
    expectUnavailable(await h.call('ask_owner', args));
    expectUnavailable(await h.call('ask_owner', { ...args, question: 'Other question?' }));
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
      idempotentHint: false,
    });
    expect(byName('recovery_report').annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
    });
    expect(tools.map((t) => t.name).slice(-1)).toEqual(['recovery_report']);
    expect(tools.findIndex((t) => t.name === 'park_run')).toBe(
      tools.findIndex((t) => t.name === 'finish_run') + 1,
    );
  });

  it.each([
    ['park_run', { run_id: 'run_01JA', reason: 'Waiting for RCP-12' }],
    ['recovery_report', {}],
    ['recovery_report', { project: 'RCP', since: '2026-11-08T00:00:00Z', limit: 10 }],
  ])('%s answers unavailable through contracts.ts', async (name, args) => {
    h ??= await startHarness();
    expect(expectUnavailable(await h.call(name, args))).toEqual({
      code: 'unavailable',
      message: `Not implemented yet: ${name}`,
    });
  });

  it('heartbeat accepts the new fields; declaring resources keeps its stub (US11)', async () => {
    h = await startHarness();
    const args = {
      run_id: 'run_01JA',
      workspace: { head_sha: '77aa001', pushed_sha: '6f00e12', dirty: true },
      resources_started: [
        { kind: 'dev_server', label: 'dev server :5173', locator: { port: 5173 } },
      ],
      resources_released: [{ resource_id: 'rsc_1', note: 'stopped' }],
    };
    expect(expectUnavailable(await h.call('heartbeat', args)).message).toBe(
      'Not implemented yet: heartbeat',
    );
  });

  it('claim_lead, start_run and report_commit accept the new fields (US11 stores them)', async () => {
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
    expectOk(
      await h.call('start_run', {
        id: 'RCP-17',
        parent_run_id: run_id,
        brief_document_version_id: 'dv_1',
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

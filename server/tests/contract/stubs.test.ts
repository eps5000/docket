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

describe('stubs', () => {
  it.each(TOOL_NAMES)('%s answers unavailable: "Not implemented yet"', async (name) => {
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
    const unavailable = await h.a.callTool({ name: 'whoami', arguments: {} });
    expect(unavailable.isError).toBe(true);
    expect(unavailable.structuredContent).toEqual({
      code: 'unavailable',
      message: 'Not implemented yet: whoami',
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
    const args = { ...VALID_ARGS.add_note, idempotency_key: 'stub-1' };
    expectUnavailable(await h.call('add_note', args));
    expectUnavailable(await h.call('add_note', args));
    expectUnavailable(await h.call('add_note', { ...args, text: 'Other text.' }));
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
      { tool: 'add_note', client: 'claude', label: null, run: 'run_01JA', result: 'unavailable' },
      { tool: 'claim_lead', client: 'codex', label: 'orca-w3', run: null, result: 'unavailable' },
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

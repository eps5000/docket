/**
 * Result modes (MCP_SPEC §3 Results; BUILD_SPEC §12 V6; owner decision 28).
 *
 * A session's mode is decided at `initialize` from `clientInfo.name`:
 * - listed in TASKLITE_TEXT_ONLY_CLIENTS (default `claude-code`, the name
 *   Claude Code 2.1.318 reports) → text-only: `tools/list` has no
 *   `outputSchema`, and results carry the text block alone, errors still
 *   `isError` with the full message;
 * - any other client → structured, unchanged.
 *
 * These run with the shipped default (PRODUCT_RESULT_MODES), unlike the
 * other suites, which give every client structured results.
 */
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { renderError, toolErrorSchema } from '@docket/shared';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CLIENT_A,
  PRODUCT_RESULT_MODES,
  expectNotFound,
  expectOk,
  startHarness,
  textOf,
  type ContractHarness,
} from './harness.js';

let h: ContractHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

/** A text-only result: one text block, no `structuredContent`. */
function expectTextOnly(result: CallToolResult): string {
  expect(result).not.toHaveProperty('structuredContent');
  return textOf(result);
}

const call = async (client: Client, name: string, args: Record<string, unknown> = {}) =>
  (await client.callTool({ name, arguments: args })) as CallToolResult;

const modeOf = (harness: ContractHarness, client: Client) =>
  harness.server.runtime.mcp.session(
    (client.transport as { sessionId?: string } | undefined)?.sessionId ?? '',
  )?.result_mode;

describe('the shipped default: claude-code is text-only', () => {
  it('a client named like Claude Code gets text-only results', async () => {
    h = await startHarness({ env: PRODUCT_RESULT_MODES });
    expect(CLIENT_A.name).toBe('claude-code');
    expect(modeOf(h, h.a)).toBe('text');

    // tools/list: no outputSchema, everything else as for a structured client.
    const text = (await h.a.listTools()).tools;
    const structured = (await h.b.listTools()).tools;
    expect(text.every((t) => t.outputSchema === undefined)).toBe(true);
    expect(text).toEqual(structured.map(({ outputSchema: _, ...t }) => t));

    // Reads and writes: the text block alone, the same text a structured client gets.
    const ctxA = expectTextOnly(await call(h.a, 'get_context', { id: 'RCP-14' }));
    expect(ctxA).toBe(expectOk(await call(h.b, 'get_context', { id: 'RCP-14' })).text);
    const search = expectTextOnly(
      await call(h.a, 'search_items', { project: 'RCP', filter: 'ready_to_start', limit: 1 }),
    );
    // The header line, then one row per item, ID first (§3.1).
    const best = /^(\S+) /.exec(search.split('\n')[1]!)![1]!;
    const claim = expectTextOnly(
      await call(h.a, 'claim_lead', { id: best, agent_label: 'orca-w3' }),
    );
    expect(claim).toMatch(new RegExp(`^Claimed ${best} · run run_`));
    expect(h.server.runtime.mcp.sessions().find((s) => s.result_mode === 'text')?.client).toBe(
      'claude',
    );
  });

  it('errors stay isError, with the full message in the text', async () => {
    h = await startHarness({ env: PRODUCT_RESULT_MODES });
    const text = await call(h.a, 'get_item', { id: 'RCP-99' });
    expect(text.isError).toBe(true);
    const body = expectTextOnly(text);

    // The structured client's ToolError, for comparison: the text is its full rendering.
    const err = expectNotFound(await call(h.b, 'get_item', { id: 'RCP-99' }));
    expect(body).toBe(renderError(err));
    expect(body).toBe(`not_found: ${err.message}`);

    // A validation error with field details and a conflict with `current`: all in the text.
    const bad = await call(h.a, 'create_item', { project: 'RCP', type: 'Task', title: '' });
    expect(bad.isError).toBe(true);
    expect(expectTextOnly(bad)).toMatch(/^validation: /);
    const held = await call(h.a, 'claim_lead', { id: 'RCP-14' });
    expect(held.isError).toBe(true);
    const conflict = expectTextOnly(held);
    expect(conflict).toMatch(/^conflict: RCP-14 is led by /);
    expect(conflict).toContain('current: {');
  });

  it('another client name gets structured results, unchanged', async () => {
    h = await startHarness({ env: PRODUCT_RESULT_MODES });
    for (const info of [
      { name: 'codex-mcp-client', version: '0.50.0' },
      // Matching is exact: other Claude-family names keep structured output.
      { name: 'claude', version: '1.0.0' },
      { name: 'claude-code-sdk-test', version: '1.0.0' },
      { name: 'eval-harness', version: '1.0.0' },
    ]) {
      const client = await h.connect(info);
      expect(modeOf(h, client), info.name).toBe('structured');
      const tools = (await client.listTools()).tools;
      expect(
        tools.every((t) => t.outputSchema !== undefined),
        info.name,
      ).toBe(true);
      const ok = expectOk(await call(client, 'whoami'));
      expect(ok.structured.client).toBeTruthy();
      const err = await call(client, 'get_item', { id: 'RCP-99' });
      expect(toolErrorSchema.safeParse(err.structuredContent).success, info.name).toBe(true);
    }
  });
});

describe('TASKLITE_TEXT_ONLY_CLIENTS', () => {
  it('names the text-only clients exactly, ignoring case', async () => {
    h = await startHarness({ env: { TASKLITE_TEXT_ONLY_CLIENTS: 'My-Agent' } });
    const mine = await h.connect({ name: 'my-agent', version: '1.0.0' });
    expect(modeOf(h, mine)).toBe('text');
    expectTextOnly(await call(mine, 'whoami'));
    // claude-code is no longer listed, so it is structured.
    expect(modeOf(h, h.a)).toBe('structured');
    expectOk(await call(h.a, 'whoami'));
  });

  it('none gives every client structured results', async () => {
    h = await startHarness({ env: { TASKLITE_TEXT_ONLY_CLIENTS: 'none' } });
    expect(modeOf(h, h.a)).toBe('structured');
    expect((await h.a.listTools()).tools.every((t) => t.outputSchema !== undefined)).toBe(true);
    expectOk(await call(h.a, 'whoami'));
  });
});

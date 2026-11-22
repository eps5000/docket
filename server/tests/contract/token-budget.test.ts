/**
 * What a client receives for Docket's tools (owner decision 40; MCP_SPEC §3
 * Compact definitions), through a real `tools/list`. Definitions are resent to
 * the model on every call, so a total budget and a per-tool cap keep them from
 * creeping back. Tokens are characters ÷ 4, as in MCP_SPEC §3.2.
 *
 * Before decision 40 (49 tools, measured on main at 5e462d0): 39,545 tokens for
 * a structured client (Codex got this one too), 12,990 for text-only Claude Code.
 */
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PRODUCT_RESULT_MODES, startHarness, tokens, type ContractHarness } from './harness.js';

export const BEFORE_STRUCTURED = 39_545;
export const BEFORE_TEXT = 12_990;
/** The target: at least 60% below what a client received. */
const STRUCTURED_BUDGET = Math.floor(BEFORE_STRUCTURED * 0.4);
const TEXT_BUDGET = 11_800;
const PER_TOOL_CAP = 750;

const size = (list: readonly Tool[]) => tokens(JSON.stringify(list));

let h: ContractHarness;
let text: Tool[];
let codex: Tool[];
let structured: Tool[];

beforeAll(async () => {
  h = await startHarness({ seed: false, env: PRODUCT_RESULT_MODES });
  text = (await h.a.listTools()).tools;
  codex = (await h.b.listTools()).tools;
  const other = await h.connect({ name: 'another-client', version: '1.0.0' });
  structured = (await other.listTools()).tools;
});
afterAll(async () => {
  await h.close();
});

describe('tool definition budgets (decision 40)', () => {
  it('reports before and after', () => {
    const row = (name: string, before: number, after: number) =>
      `${name}: ${before} → ${after} (${Math.round((1 - after / before) * 100)}% less)`;
    console.log(
      [
        row('Claude Code (text-only)', BEFORE_TEXT, size(text)),
        row('Codex (text-only since decision 40)', BEFORE_STRUCTURED, size(codex)),
        row('Other clients (structured)', BEFORE_STRUCTURED, size(structured)),
      ].join('\n'),
    );
  });

  it(`a structured client gets at most ${STRUCTURED_BUDGET} tokens: 60% less than before`, () => {
    expect(size(structured)).toBeLessThanOrEqual(STRUCTURED_BUDGET);
  });

  it(`text-only clients (Claude Code, Codex) get at most ${TEXT_BUDGET} tokens`, () => {
    expect(size(text)).toBeLessThanOrEqual(TEXT_BUDGET);
    expect(size(codex)).toBe(size(text));
    expect(size(codex)).toBeLessThanOrEqual(STRUCTURED_BUDGET);
  });

  it(`no tool costs more than ${PER_TOOL_CAP} tokens`, () => {
    const over = structured
      .map((t) => [t.name, tokens(JSON.stringify(t))] as const)
      .filter(([, n]) => n > PER_TOOL_CAP);
    expect(over).toEqual([]);
  });

  it('keeps what an agent needs to call a tool: required fields, enums and limits', () => {
    const byName = (name: string) => text.find((t) => t.name === name)!;
    type Field = { enum?: unknown[]; maxLength?: number; default?: unknown };
    const props = (name: string) => byName(name).inputSchema.properties as Record<string, Field>;
    expect(byName('set_status').inputSchema.required).toEqual(['id', 'status']);
    expect(props('set_status').status!.enum).toContain('done');
    expect(props('create_item').title!.maxLength).toBe(200);
    expect(props('get_context').budget!.default).toBe('medium');
    expect(byName('claim_lead').description).toContain('seam_conflict');
    expect(byName('claim_lead').description).toContain('design_review');
    expect(byName('recovery_report').description).toContain('never prune');
  });
});

/**
 * The contract test harness (MCP_SPEC §10; tasks.md T043).
 *
 * - An in-process server (the real app and runtime) with a fresh database
 *   per test, seeded from design/sample-data.json unless `seed: false`.
 * - Two official MCP SDK clients with different `clientInfo` (`claude-code`
 *   and `codex-mcp-client`), connected over Streamable HTTP with the agent
 *   token, each with its server→client (`GET`) stream open. Their HTTP goes
 *   straight into the Hono app (no socket).
 * - Every client gets structured results unless `env` says otherwise
 *   (integration/harness.ts STRUCTURED_FOR_ALL); `PRODUCT_RESULT_MODES`
 *   restores the shipped default, where `claude-code` is text-only.
 * - `tokens(text)`: the budget measure, characters ÷ 4 (§3.2).
 * - Assertions for each ToolError code that also check the error is
 *   well-formed (§6).
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  renderError,
  toolErrorSchema,
  type ErrorCode,
  type ToolErrorShape,
  type ToolName,
} from '@docket/shared';
import { expect } from 'vitest';
import { loadSampleSeed } from '../../src/db/seed/loader.js';
import type { ServiceOverrides } from '../../src/domain/services.js';
import type { ToolHandlers } from '../../src/mcp/register.js';
import { TestClock } from '../helpers.js';
import { ORIGIN, createTestServer, type TestServer } from '../integration/harness.js';

/** "Now" for contract tests: the prototype clock, so seed times are as in the spec examples. */
export const CONTRACT_NOW = new Date('2026-11-06T11:00:00.000Z');

export const CLIENT_A = { name: 'claude-code', version: '1.0.0' };
export const CLIENT_B = { name: 'codex-mcp-client', version: '0.50.0' };

export interface ContractHarness {
  server: TestServer;
  /** Signed in as `claude-code` (normalised client `claude`). */
  a: Client;
  /** Signed in as `codex-mcp-client` (normalised client `codex`). */
  b: Client;
  /** Another client with its own session. */
  connect(clientInfo: { name: string; version: string }): Promise<Client>;
  /** `tools/call` through client `a` unless another is given. */
  call(
    name: ToolName | string,
    args?: Record<string, unknown>,
    client?: Client,
  ): Promise<CallToolResult>;
  close(): Promise<void>;
}

export interface HarnessOptions {
  seed?: boolean;
  /** Also seed the 300-item STR stress project (B35), about the size of the Gameflow pilot. */
  stress?: boolean;
  toolHandlers?: Partial<ToolHandlers>;
  /** Replace service methods (domain/contracts.ts), as a slice's implementation would. */
  services?: ServiceOverrides;
  /** The service's log lines (default: the console). */
  log?: (line: string) => void;
  /** Environment overrides for the server's configuration. */
  env?: Record<string, string>;
}

/**
 * The shipped DOCKET_TEXT_ONLY_CLIENTS default (BUILD_SPEC §2): an empty
 * value counts as unset, so `claude-code` and `codex-mcp-client` sessions are
 * text-only.
 */
export const PRODUCT_RESULT_MODES = { DOCKET_TEXT_ONLY_CLIENTS: '' } as const;

export async function startHarness(opts: HarnessOptions = {}): Promise<ContractHarness> {
  const server = createTestServer({
    clock: new TestClock(new Date(CONTRACT_NOW)),
    toolHandlers: opts.toolHandlers,
    services: opts.services,
    log: opts.log,
    env: opts.env,
  });
  if (opts.seed !== false) {
    loadSampleSeed(server.runtime.db, {
      now: server.clock.now(),
      docsDir: server.runtime.config.paths.docs,
      ...(opts.stress ? { stress: true } : {}),
    });
  }
  const token = server.runtime.secrets.agentToken();
  const clients: Client[] = [];

  const connect = async (clientInfo: { name: string; version: string }) => {
    const transport = new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), {
      fetch: (url, init) => Promise.resolve(server.app.request(String(url), init)),
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    });
    const client = new Client(clientInfo);
    await client.connect(transport);
    clients.push(client);
    // The SDK opens its GET stream after initialize; wait for it, so a run this
    // client starts is live from its first call (BUILD_SPEC §5.4).
    for (let i = 0; i < 200 && !server.runtime.mcp.hasStream(transport.sessionId ?? ''); i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    return client;
  };

  const a = await connect(CLIENT_A);
  const b = await connect(CLIENT_B);
  return {
    server,
    a,
    b,
    connect,
    call: async (name, args = {}, client = a) =>
      (await client.callTool({ name, arguments: args })) as CallToolResult,
    close: async () => {
      await Promise.allSettled(clients.map((c) => c.close()));
      await server.cleanup();
    },
  };
}

// ---- Measuring ----

/** The token measure for budgets (MCP_SPEC §3.2): characters ÷ 4, rounded up. */
export function tokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** The single text block of a result. */
export function textOf(result: CallToolResult): string {
  expect(result.content).toHaveLength(1);
  const [block] = result.content;
  expect(block?.type).toBe('text');
  return (block as { text: string }).text;
}

// ---- ToolError assertions ----

/** Assert a well-formed ToolError result with `code` (§6), and return it. */
export function expectToolError(result: CallToolResult, code: ErrorCode): ToolErrorShape {
  expect(result.isError, `expected an error result, got ${JSON.stringify(result)}`).toBe(true);
  const parsed = toolErrorSchema.safeParse(result.structuredContent);
  expect(
    parsed.success,
    `structuredContent is not a ToolError: ${JSON.stringify(result.structuredContent)}`,
  ).toBe(true);
  const err = parsed.data as ToolErrorShape;
  expect(err.code).toBe(code);
  // One or two sentences: what happened, then what to do.
  expect(err.message.length).toBeGreaterThan(0);
  // The stubs' fixed "Not implemented yet: <tool>" (tasks.md T041) is the one exception.
  if (!err.message.startsWith('Not implemented yet: ')) expect(err.message).toMatch(/[.?!)]$/);
  // The text block is the compact rendering of the same error, and holds the message.
  const text = textOf(result);
  expect(text).toBe(renderError(err));
  expect(text).toContain(err.message);
  return err;
}

export const expectValidation = (r: CallToolResult) => expectToolError(r, 'validation');
export const expectConflict = (r: CallToolResult) => {
  const err = expectToolError(r, 'conflict');
  expect(err.current, 'conflict carries the current state').toBeDefined();
  return err;
};
export const expectNotFound = (r: CallToolResult) => expectToolError(r, 'not_found');
export const expectForbidden = (r: CallToolResult) => expectToolError(r, 'forbidden');
export const expectUnavailable = (r: CallToolResult) => expectToolError(r, 'unavailable');
export const expectInternal = (r: CallToolResult) => {
  const err = expectToolError(r, 'internal');
  expect(err.details?.ref).toMatch(/^e_/);
  return err;
};

/** A successful result: structured content plus its compact text. */
export function expectOk(result: CallToolResult): {
  structured: Record<string, unknown>;
  text: string;
} {
  expect(result.isError ?? false, `expected success, got ${JSON.stringify(result)}`).toBe(false);
  expect(result.structuredContent).toBeDefined();
  return { structured: result.structuredContent as Record<string, unknown>, text: textOf(result) };
}

// ---- Valid arguments ----

/** Minimal valid arguments for every tool, against the seed data (IDs per the §3.1 example). */
export const VALID_ARGS: Record<ToolName, Record<string, unknown>> = {
  whoami: {},
  list_projects: {},
  search_items: { project: 'RCP', filter: 'ready_to_start' },
  get_item: { id: 'RCP-14' },
  get_context: { id: 'RCP-14' },
  dependency_subgraph: { id: 'RCP-14' },
  deferred_reviews: { project: 'RCP' },
  get_changes: {},
  get_digest: { project: 'RCP' },
  create_item: { project: 'RCP', type: 'Task', title: 'Pantry inventory schema' },
  update_item: { id: 'RCP-14', expected_version: 7, title: 'Generate the shopping list' },
  set_status: { id: 'RCP-14', status: 'ready' },
  link_items: { from: 'RCP-19', to: 'RCP-16', type: 'blocks', satisfied_when: 'merged' },
  unlink_items: { link_id: 'lnk_1' },
  upsert_label: { project: 'RCP', name: 'mobile', brief_md: 'Phone-first.' },
  claim_lead: { id: 'RCP-17', agent_label: 'orca-w3' },
  release_lead: { id: 'RCP-14', run_id: 'run_01JA', reason: 'Stopping before the work is done.' },
  start_run: { id: 'RCP-14', parent_run_id: 'run_01JA', agent_label: 'units-worker' },
  heartbeat: { run_id: 'run_01JA' },
  finish_run: { run_id: 'run_01JA', result: 'finished', summary: 'Built the list.' },
  park_run: {
    run_id: 'run_01JA',
    reason: 'Waiting for RCP-12 (planner) to merge',
    waiting_on: { items: ['RCP-12'] },
  },
  set_plan: { id: 'RCP-17', steps: [{ text: 'Reproduce the jump after reload' }] },
  update_step: { id: 'RCP-14', step_id: 'wst_a', state: 'done' },
  log_subagent: {
    id: 'RCP-14',
    name: 'explorer',
    outcome: 'Mapped 214 units',
    provenance: 'relayed',
  },
  set_checks: { id: 'RCP-14', checks: [{ text: 'Planner tests pass' }] },
  update_check: { id: 'RCP-14', check_id: 'chk_a', state: 'pass', evidence: 'vitest: 212 passed' },
  declare_human_review: { id: 'RCP-14', items: ['Export one week and read it in your notes app.'] },
  update_human_review: {
    id: 'RCP-14',
    hr_item_id: 'hr_a',
    expected_version: 1,
    text: 'Export one week.',
  },
  add_note: { id: 'RCP-14', text: 'Merged units across recipes.' },
  put_document: {
    item_id: 'RCP-2',
    name: 'pantry-prd.md',
    kind: 'planning',
    content_text: '# Pantry',
  },
  link_artifact: {
    id: 'RCP-19',
    kind: 'pr',
    label: 'PR #52',
    url: 'https://example.test/pr/52',
    state: 'merged',
  },
  report_commit: { id: 'RCP-14', sha: '4be1c09', branch: 'rcp-14-list' },
  submit_packet: {
    id: 'RCP-12',
    built_from_commit: '9c0e7f2',
    estimate: '10 min',
    how: ['Open the preview build.'],
    checked: [{ text: '214 tests pass', provenance: 'ci', evidence: 'CI build #91' }],
  },
  get_review: { id: 'RCP-12' },
  ask_owner: { id: 'RCP-14', question: 'Per serving or per 100 g?' },
  publish_decision: {
    project: 'RCP',
    scope: { kind: 'epic', id: 'RCP-1' },
    title: 'Units are stored metric',
    decision: 'Store g and ml; convert on display.',
  },
  list_decisions: { project: 'RCP' },
  withdraw_decision: { decision_id: 'dec_9', reason: 'No longer applies.' },
  recovery_report: { include_briefs: true },
  get_agent_files: { project: 'RCP' },
  propose_agent_file_change: {
    project: 'RCP',
    file: 'skill:docket-worker',
    content: '---\nname: docket-worker\n---\n',
    reason: 'Run the linter before each commit.',
    based_on_version_id: 'afv_1',
  },
  onboard_project: { key: 'GF', name: 'Gameflow', color: '#2b8a3e' },
  finish_onboarding: {
    session_id: 'onb_1',
    summary: 'Created 12 items in Planning from the Spec Kit tasks.',
    questions: ['Is the level editor in scope for V1?'],
  },
  get_step: { id: 'RCP-14', step_id: 'wst_a' },
  apply_batch: {
    operations: [
      { op: 'update_item', args: { id: 'RCP-14', expected_version: 7, outcome_md: 'One list.' } },
    ],
  },
  // Decision 36 (MCP_SPEC §5.15; B38).
  declare_shared_changes: {
    id: 'RCP-14',
    changes: [{ part: 'model:Recipe', change: 'change', note: 'Adds units' }],
    new_parts: [{ key: 'model:Recipe', paths: ['server/src/models/recipe.ts'] }],
  },
  list_shared_parts: { project: 'RCP' },
  take_lease: { id: 'RCP-14', part: 'model:Recipe' },
  release_lease: { id: 'RCP-14', part: 'model:Recipe' },
  propose_resolution: {
    id: 'RCP-14',
    kind: 'split',
    plan_md: '1. Split the pantry work into two stories.',
    reason: 'The branch is too far behind main to rebase in one go.',
  },
};

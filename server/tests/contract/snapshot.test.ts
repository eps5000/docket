/**
 * Contract snapshot (MCP_SPEC §10 item 1; tasks.md T042), through the
 * official MCP client SDK against the in-process server:
 * - `initialize` returns the §2 instructions verbatim and advertises only
 *   `tools` (`listChanged: false`);
 * - `tools/list` has exactly the 36 §5 tools, in order, each with its §5
 *   description verbatim, its fields, defaults and limits, and the §3
 *   annotations.
 *
 * Expected copy is extracted from docs/MCP_SPEC.md at test time, never from
 * a copy. The full `tools/list` is also kept as a file snapshot
 * (__snapshots__/tools-list.json), so any schema change shows in review.
 */
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  SPEC,
  specDescriptions,
  specInstructions,
  specToolPart,
} from '../../../shared/tests/spec.js';
import { startHarness, type ContractHarness } from './harness.js';

let h: ContractHarness;
let tools: Tool[];
const byName = (name: string) => tools.find((t) => t.name === name)!;

beforeAll(async () => {
  h = await startHarness({ seed: false });
  tools = (await h.a.listTools()).tools;
});
afterAll(async () => {
  await h.close();
});

type JsonObject = {
  type?: string;
  properties?: Record<string, JsonObject>;
  required?: string[];
  anyOf?: JsonObject[];
  items?: JsonObject;
  enum?: unknown[];
  default?: unknown;
  maxLength?: number;
  additionalProperties?: boolean;
};
const input = (name: string) => byName(name).inputSchema as JsonObject;
const result = (name: string) => (byName(name).outputSchema as JsonObject).anyOf![0]!;

describe('initialize', () => {
  it('returns the server instructions verbatim (MCP_SPEC §2)', () => {
    expect(h.a.getInstructions()).toBe(specInstructions());
  });

  it('identifies as tasklite and advertises only tools, with listChanged false (§1)', () => {
    expect(h.a.getServerVersion()?.name).toBe('tasklite');
    expect(h.a.getServerCapabilities()).toEqual({ tools: { listChanged: false } });
  });
});

describe('tools/list: names and descriptions (§5)', () => {
  it('lists exactly 36 tools, in MCP_SPEC §5 order', () => {
    expect(tools).toHaveLength(36);
    expect(tools.map((t) => t.name)).toEqual(specDescriptions().map(([name]) => name));
  });

  it.each(specDescriptions())(
    '%s: description matches MCP_SPEC.md verbatim',
    (name, description) => {
      expect(byName(name).description).toBe(description);
    },
  );
});

/** The §3 annotation table: read tools, `get_item`, the retry-safe four, nothing destructive. */
const READ_TOOLS = [
  'whoami',
  'list_projects',
  'search_items',
  'get_context',
  'dependency_subgraph',
  'deferred_reviews',
  'get_changes',
  'get_review',
  'list_decisions',
];
const IDEMPOTENT = ['heartbeat', 'report_commit', 'update_step', 'update_check'];

describe('tools/list: annotations (§3)', () => {
  it.each(specDescriptions().map(([n]) => n))('%s', (name) => {
    expect(byName(name).annotations).toEqual({
      readOnlyHint: READ_TOOLS.includes(name),
      destructiveHint: false,
      idempotentHint: IDEMPOTENT.includes(name),
    });
  });

  it('get_item is not read-only: it marks owner notes and answers as delivered', () => {
    expect(byName('get_item').annotations?.readOnlyHint).toBe(false);
  });
});

/**
 * Input fields per tool, from the §5 Input lines: [required, optional].
 * `run_id` and `idempotency_key` are checked separately. B3 resolution 2 adds
 * `agent_label` to search_items.
 */
const INPUTS: Record<string, [string[], string[]]> = {
  whoami: [[], []],
  list_projects: [[], []],
  search_items: [
    [],
    [
      'project',
      'text',
      'filter',
      'status',
      'type',
      'label',
      'epic',
      'include_archived',
      'fields',
      'agent_label',
      'cursor',
      'limit',
    ],
  ],
  get_item: [['id'], ['view', 'fields', 'agent_label']],
  get_context: [['id'], ['budget']],
  dependency_subgraph: [['id'], ['depth', 'direction', 'delay_days']],
  deferred_reviews: [[], ['project', 'cursor', 'limit']],
  get_changes: [[], ['cursor', 'project', 'item_id', 'types', 'limit']],
  create_item: [
    ['project', 'type', 'title'],
    [
      'description_md',
      'outcome_md',
      'acceptance',
      'priority',
      'epic',
      'labels',
      'status',
      'planned_start',
      'planned_end',
      'effort',
      'blocked_by',
    ],
  ],
  update_item: [
    ['id', 'expected_version'],
    [
      'title',
      'description_md',
      'outcome_md',
      'acceptance',
      'priority',
      'epic',
      'labels',
      'add_labels',
      'remove_labels',
      'planned_start',
      'planned_end',
      'effort',
    ],
  ],
  set_status: [
    ['id', 'status'],
    ['expected_version', 'reason'],
  ],
  link_items: [['from', 'to', 'type'], ['satisfied_when']],
  unlink_items: [[], ['link_id', 'from', 'to', 'type']],
  upsert_label: [['project', 'name'], ['brief_md']],
  claim_lead: [['id'], ['agent_label']],
  release_lead: [['id', 'run_id', 'reason'], []],
  start_run: [['id', 'parent_run_id'], ['agent_label']],
  heartbeat: [['run_id'], ['current_step_id', 'note']],
  finish_run: [['run_id', 'result', 'summary'], ['error']],
  set_plan: [['id'], ['reason', 'mode', 'steps', 'remove']],
  update_step: [['id', 'step_id', 'state'], ['note']],
  log_subagent: [
    ['id', 'name', 'outcome', 'provenance'],
    ['step_id', 'evidence', 'child_run_id'],
  ],
  set_checks: [['id'], ['mode', 'checks', 'remove']],
  update_check: [
    ['id', 'check_id', 'state'],
    ['evidence', 'provenance'],
  ],
  declare_human_review: [['id', 'items'], []],
  update_human_review: [
    ['id', 'hr_item_id', 'expected_version'],
    ['text', 'remove'],
  ],
  add_note: [['id', 'text'], []],
  put_document: [
    ['name', 'kind'],
    ['item_id', 'project', 'content_text', 'content_base64', 'mime'],
  ],
  link_artifact: [
    ['id', 'kind', 'label'],
    ['url', 'state'],
  ],
  report_commit: [
    ['id', 'sha'],
    ['branch', 'message', 'pr_url'],
  ],
  submit_packet: [
    ['id', 'built_from_commit', 'estimate', 'how', 'checked'],
    ['hr_item_ids', 'gaps', 'attachments'],
  ],
  get_review: [['id'], []],
  ask_owner: [['id', 'question'], []],
  publish_decision: [
    ['project', 'scope', 'title', 'decision'],
    ['rationale', 'supersedes'],
  ],
  list_decisions: [['project'], ['scope', 'in_scope_of', 'include_inactive', 'cursor', 'limit']],
  withdraw_decision: [['decision_id', 'reason'], []],
};

/** Result fields per tool, from the §5 Output lines (all required). */
const OUTPUTS: Record<string, string[]> = {
  whoami: [
    'client',
    'session_id',
    'server_version',
    'server_time',
    'limits',
    'live_window_s',
    'stale_after_s',
    'lease_s',
  ],
  list_projects: ['projects'],
  search_items: ['items', 'next_cursor'],
  get_item: ['item'],
  get_context: ['context'],
  dependency_subgraph: ['nodes', 'edges', 'cycles', 'at_risk'],
  deferred_reviews: ['items', 'next_cursor'],
  get_changes: ['events', 'next_cursor'],
  create_item: ['item'],
  update_item: ['item'],
  set_status: ['item'],
  link_items: ['link_id', 'from', 'to', 'type', 'satisfied_when', 'updated'],
  unlink_items: ['removed'],
  upsert_label: ['project', 'name', 'brief_md'],
  claim_lead: ['run_id', 'item', 'lease_expires_at'],
  release_lead: ['item'],
  start_run: ['run_id'],
  heartbeat: ['run_state', 'lease_expires_at'],
  finish_run: ['run_state'],
  set_plan: ['plan_version', 'work'],
  update_step: ['step'],
  log_subagent: ['logged'],
  set_checks: ['checks'],
  update_check: ['check'],
  declare_human_review: ['human_review'],
  update_human_review: ['human_review'],
  add_note: ['event'],
  put_document: ['document_id', 'version_no', 'document_version_id', 'sha256', 'size'],
  link_artifact: ['artifact'],
  report_commit: ['recorded', 'stale_packets'],
  submit_packet: ['packet_id', 'round', 'display_id', 'item'],
  get_review: ['rounds'],
  ask_owner: ['question_id'],
  publish_decision: ['decision'],
  list_decisions: ['items', 'next_cursor'],
  withdraw_decision: ['decision'],
};

const MUTATING = specDescriptions()
  .map(([n]) => n)
  .filter((n) => !READ_TOOLS.includes(n) && n !== 'get_item');

describe('tools/list: input schemas (§3, §5)', () => {
  it('covers every tool', () => {
    expect(Object.keys(INPUTS).sort()).toEqual(tools.map((t) => t.name).sort());
  });

  it.each(Object.entries(INPUTS))('%s: fields and optionality', (name, [required, optional]) => {
    const schema = input(name);
    expect(schema.type).toBe('object');
    expect(schema.additionalProperties, 'strict inputs (B3 resolution 4)').toBe(false);
    const common = MUTATING.includes(name) ? ['run_id', 'idempotency_key'] : ['run_id'];
    const props = Object.keys(schema.properties ?? {});
    expect(props.sort()).toEqual([...new Set([...required, ...optional, ...common])].sort());
    expect((schema.required ?? []).sort()).toEqual(required.sort());
  });

  it.each(Object.keys(INPUTS))('%s: every field is named in its MCP_SPEC Input line', (name) => {
    const spec = specToolPart(name, 'Input');
    // Accepted by every tool (§3, §5), and agent_label on search_items (§5.2 note on mine).
    const implied = new Set([
      'run_id',
      'idempotency_key',
      ...(name === 'search_items' ? ['agent_label'] : []),
    ]);
    for (const field of Object.keys(input(name).properties ?? {})) {
      if (implied.has(field)) continue;
      expect(spec, `${name}.${field}`).toMatch(
        new RegExp(`\`${field}\\??[\`:]|[{,] ${field}\\??[,:}]`),
      );
    }
  });

  it('every mutating tool accepts idempotency_key (≤ 100) and run_id; reads accept run_id only', () => {
    expect(MUTATING).toHaveLength(26);
    for (const t of tools) {
      const props = input(t.name).properties!;
      expect(props.run_id, t.name).toBeDefined();
      if (MUTATING.includes(t.name)) expect(props.idempotency_key?.maxLength, t.name).toBe(100);
      else expect(props.idempotency_key, t.name).toBeUndefined();
    }
  });

  it('defaults follow §5', () => {
    const defaults: [string, string, unknown][] = [
      ['search_items', 'include_archived', true],
      ['search_items', 'limit', 25],
      ['get_item', 'view', 'standard'],
      ['get_context', 'budget', 'medium'],
      ['dependency_subgraph', 'depth', 2],
      ['dependency_subgraph', 'direction', 'both'],
      ['deferred_reviews', 'limit', 25],
      ['get_changes', 'limit', 100],
      ['create_item', 'priority', 2],
      ['create_item', 'status', 'inbox'],
      ['set_plan', 'mode', 'patch'],
      ['set_checks', 'mode', 'patch'],
      ['list_decisions', 'include_inactive', false],
      ['list_decisions', 'limit', 25],
    ];
    for (const [tool, field, value] of defaults) {
      expect(input(tool).properties![field]!.default, `${tool}.${field}`).toEqual(value);
    }
    expect(input('set_checks').properties!.checks!.items!.properties!.provenance!.default).toBe(
      'agent',
    );
  });

  it('enums match the §3 table', () => {
    const table = (name: string) => {
      const row = new RegExp(`^ *\\| \`${name}\` \\| (.*) \\|$`, 'm').exec(SPEC)![1]!;
      return [...row.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    };
    expect(input('search_items').properties!.status!.items!.enum).toEqual(table('status'));
    expect(input('search_items').properties!.type!.items!.enum).toEqual(table('type'));
    expect(input('update_check').properties!.provenance!.enum).toEqual(table('provenance'));
    expect(input('create_item').properties!.priority!.enum).toEqual([1, 2, 3]);
  });

  it('text limits match the §3 table', () => {
    const limit = (label: string) => {
      const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return Number(
        new RegExp(`^  \\| ${escaped} \\| ([\\d,]+) \\|$`, 'm').exec(SPEC)![1]!.replace(/,/g, ''),
      );
    };
    const props = (tool: string) => input(tool).properties!;
    expect(props('create_item').title!.maxLength).toBe(limit('`title`'));
    expect(props('set_plan').steps!.items!.properties!.text!.maxLength).toBe(
      limit('step, check and human review item text'),
    );
    expect(props('set_checks').checks!.items!.properties!.text!.maxLength).toBe(
      limit('step, check and human review item text'),
    );
    expect(props('declare_human_review').items!.items!.maxLength).toBe(
      limit('step, check and human review item text'),
    );
    expect(props('add_note').text!.maxLength).toBe(limit('`note`, `outcome` (summary lines)'));
    expect(props('ask_owner').question!.maxLength).toBe(limit('`question`'));
    expect(props('create_item').description_md!.maxLength).toBe(
      limit('`description_md`, `outcome_md`'),
    );
    expect(props('update_item').outcome_md!.maxLength).toBe(
      limit('`description_md`, `outcome_md`'),
    );
    expect(props('upsert_label').brief_md!.maxLength).toBe(limit('`brief_md`'));
  });
});

describe('tools/list: output schemas (§4, §5, §6)', () => {
  it.each(Object.entries(OUTPUTS))('%s: result fields', (name, fields) => {
    const schema = result(name);
    const extras = MUTATING.includes(name) ? ['replayed', 'warnings'] : [];
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual([...fields, ...extras].sort());
    expect((schema.required ?? []).sort()).toEqual([...fields].sort());
  });

  it.each(Object.keys(OUTPUTS))(
    '%s: every result field is named in its MCP_SPEC Output line',
    (name) => {
      const spec = specToolPart(name, 'Output');
      for (const field of OUTPUTS[name]!)
        expect(spec, `${name}.${field}`).toMatch(new RegExp(`\\b${field}\\b`));
    },
  );

  it('every outputSchema is the result or a ToolError (B3 resolution 8)', () => {
    for (const t of tools) {
      const schema = t.outputSchema as JsonObject;
      expect(schema.type).toBe('object');
      expect(schema.anyOf).toHaveLength(2);
      const error = schema.anyOf![1]!;
      expect(error.required).toEqual(['code', 'message']);
      expect(error.properties!.code!.enum).toEqual([
        'validation',
        'conflict',
        'not_found',
        'forbidden',
        'unavailable',
        'internal',
      ]);
    }
  });

  it('every schema compiles in the SDK client validator (Ajv)', () => {
    const ajv = new AjvJsonSchemaValidator();
    for (const t of tools) {
      expect(() => ajv.getValidator(t.inputSchema), `${t.name} input`).not.toThrow();
      expect(() => ajv.getValidator(t.outputSchema!), `${t.name} output`).not.toThrow();
    }
  });
});

describe('the whole contract', () => {
  it('matches the reviewed tools/list snapshot', async () => {
    await expect(`${JSON.stringify(tools, null, 2)}\n`).toMatchFileSnapshot(
      './__snapshots__/tools-list.json',
    );
  });
});

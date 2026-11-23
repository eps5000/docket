/**
 * Contract snapshot (MCP_SPEC §10 item 1; tasks.md T042), through the
 * official MCP client SDK against the in-process server:
 * - `initialize` returns the §2 instructions verbatim and advertises
 *   `tools` and `prompts` (each `listChanged: false`);
 * - `tools/list` has exactly the 50 §5 tools, in order, each with its §5
 *   description verbatim, its fields, defaults and limits, and the §3
 *   annotations;
 * - `prompts/list` has exactly the §5.11 `onboard` prompt, with its
 *   description and arguments verbatim (decision 31; B29), and `prompts/get`
 *   answers the stub text until B30.
 *
 * - text-only sessions (MCP_SPEC §3 Results; owner decision 28): the same
 *   instructions and the same tools (names, descriptions, input schemas,
 *   annotations) with no `outputSchema`.
 *
 * Expected copy is extracted from docs/MCP_SPEC.md at test time, never from
 * a copy. The full `tools/list` is also kept as a file snapshot
 * (__snapshots__/tools-list.json), and `prompts/list` likewise
 * (__snapshots__/prompts-list.json), so any change shows in review.
 */
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { McpError, type Prompt, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TOOLS, TOOL_ERROR_JSON_SCHEMA, getTool, resultJsonSchema } from '@docket/shared';
import {
  DEFAULT_BUNDLED_ROOT,
  ONBOARDING_GUIDE_TEMPLATE,
  syncBundledFiles,
} from '../../src/jobs/bundled.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  SPEC,
  specDescriptions,
  specInstructions,
  specPromptArguments,
  specPromptDescription,
  specToolPart,
} from '../../../shared/tests/spec.js';
import { PRODUCT_RESULT_MODES, startHarness, type ContractHarness } from './harness.js';

let h: ContractHarness;
let tools: Tool[];
let prompts: Prompt[];
const byName = (name: string) => tools.find((t) => t.name === name)!;

beforeAll(async () => {
  h = await startHarness({ seed: false });
  tools = (await h.a.listTools()).tools;
  prompts = (await h.a.listPrompts()).prompts;
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
/** The full result shape: clients get a compact one (decision 40), reviewed below. */
const result = (name: string) => resultJsonSchema(getTool(name)!) as JsonObject;

describe('initialize', () => {
  it('returns the server instructions verbatim (MCP_SPEC §2)', () => {
    expect(h.a.getInstructions()).toBe(specInstructions());
  });

  it('identifies as docket and advertises tools and prompts, each with listChanged false (§1)', () => {
    expect(h.a.getServerVersion()?.name).toBe('docket');
    expect(h.a.getServerCapabilities()).toEqual({
      tools: { listChanged: false },
      prompts: { listChanged: false },
    });
  });
});

describe('tools/list: names and descriptions (§5)', () => {
  it('lists exactly 51 tools, in MCP_SPEC §5 order', () => {
    expect(tools).toHaveLength(51);
    expect(tools.map((t) => t.name)).toEqual(specDescriptions().map(([name]) => name));
  });

  it.each(specDescriptions())(
    '%s: description matches MCP_SPEC.md verbatim',
    (name, description) => {
      expect(byName(name).description).toBe(description);
    },
  );
});

/**
 * The §3 annotation table: the 14 read tools, `get_item`, the retry-safe
 * four, nothing destructive. `park_run` is a write and not retry-safe;
 * `recovery_report` is read-only (B5); `get_agent_files` is read-only and
 * `propose_agent_file_change` a write that is not retry-safe (B26); `get_step`
 * is read-only (B33); `list_shared_parts` is read-only, and `declare_shared_changes`,
 * `take_lease` and `release_lease` are writes that are not retry-safe (B38).
 */
const READ_TOOLS = [
  'whoami',
  'list_projects',
  'search_items',
  'get_context',
  'dependency_subgraph',
  'deferred_reviews',
  'get_changes',
  'get_digest',
  'get_review',
  'list_decisions',
  'recovery_report',
  'get_agent_files',
  'get_step',
  'list_shared_parts',
];
const IDEMPOTENT = ['heartbeat', 'report_commit', 'update_step', 'update_check'];

describe('tools/list: annotations (§3)', () => {
  it.each(specDescriptions().map(([n]) => n))('%s', (name) => {
    expect(byName(name).annotations).toEqual({
      readOnlyHint: READ_TOOLS.includes(name),
      destructiveHint: false,
      // Left out where it's false, MCP's default (decision 40).
      ...(IDEMPOTENT.includes(name) ? { idempotentHint: true } : {}),
    });
  });

  it('get_item is not read-only: it marks owner notes and answers as delivered', () => {
    expect(byName('get_item').annotations?.readOnlyHint).toBe(false);
  });

  it('the §3 counts hold: 14 read tools, 36 mutating', () => {
    expect(SPEC).toContain('`true` for the 14 read tools');
    expect(SPEC).toContain('accepted only by the 36 mutating tools');
    expect(READ_TOOLS).toHaveLength(14);
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
  get_changes: [[], ['cursor', 'project', 'item_id', 'types', 'limit', 'wait_s']],
  get_digest: [['project'], ['cursor']],
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
    ['expected_version', 'reason', 'changed_files', 'branch'],
  ],
  link_items: [['from', 'to', 'type'], ['satisfied_when']],
  unlink_items: [[], ['link_id', 'from', 'to', 'type']],
  upsert_label: [['project', 'name'], ['brief_md']],
  claim_lead: [
    ['id'],
    [
      'agent_label',
      'workspace',
      'orchestrator',
      'brief',
      'brief_document_version_id',
      'external',
      'instructions',
      'branch',
      'producer',
    ],
  ],
  release_lead: [['id', 'run_id', 'reason'], ['release_story']],
  start_run: [
    ['id', 'parent_run_id'],
    ['agent_label', 'workspace', 'orchestrator', 'brief', 'brief_document_version_id', 'external'],
  ],
  heartbeat: [
    ['run_id'],
    ['current_step_id', 'note', 'workspace', 'resources_started', 'resources_released', 'external'],
  ],
  finish_run: [['run_id', 'result', 'summary'], ['error']],
  park_run: [['run_id', 'reason'], ['waiting_on']],
  update_run_status: [
    ['id', 'coordinator'],
    ['current_action', 'park_reason', 'waiting_on', 'park_minutes', 'resume'],
  ],
  set_plan: [['id'], ['reason', 'mode', 'steps', 'remove']],
  update_step: [
    ['id', 'step_id', 'state'],
    ['note', 'details', 'expected_details_version'],
  ],
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
    ['branch', 'message', 'pr_url', 'pushed'],
  ],
  submit_packet: [
    ['id', 'built_from_commit', 'estimate', 'how', 'checked'],
    ['hr_item_ids', 'gaps', 'attachments', 'changed_files', 'branch'],
  ],
  get_review: [['id'], []],
  ask_owner: [['id', 'question'], []],
  publish_decision: [
    ['project', 'scope', 'title', 'decision'],
    ['rationale', 'supersedes'],
  ],
  list_decisions: [['project'], ['scope', 'in_scope_of', 'include_inactive', 'cursor', 'limit']],
  withdraw_decision: [['decision_id', 'reason'], []],
  recovery_report: [[], ['project', 'since', 'include_briefs', 'cursor', 'limit']],
  get_agent_files: [['project'], ['file']],
  propose_agent_file_change: [['file', 'content', 'reason', 'based_on_version_id'], ['project']],
  onboard_project: [['key'], ['name', 'color']],
  finish_onboarding: [['session_id', 'summary'], ['questions']],
  get_step: [['id', 'step_id'], []],
  apply_batch: [['operations'], []],
  declare_shared_changes: [['id'], ['changes', 'none', 'new_parts', 'branch', 'branches']],
  list_shared_parts: [['project'], ['include_archived']],
  take_lease: [['id', 'part'], []],
  release_lease: [['id', 'part'], []],
  propose_resolution: [
    ['kind', 'plan_md', 'reason'],
    ['problem', 'id'],
  ],
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
  get_digest: [
    'project',
    'cursor',
    'since',
    'ready',
    'runs',
    'blocked',
    'owner',
    'problems',
    'leases',
    'conflicts',
    'changed',
  ],
  create_item: ['item'],
  update_item: ['item'],
  set_status: ['item'],
  link_items: ['link_id', 'from', 'to', 'type', 'satisfied_when', 'updated'],
  unlink_items: ['removed'],
  upsert_label: ['project', 'name', 'brief_md'],
  claim_lead: ['run_id', 'item', 'lease_expires_at'],
  release_lead: ['item'],
  start_run: ['run_id'],
  heartbeat: ['run_state', 'lease_expires_at', 'resources'],
  finish_run: ['run_state'],
  park_run: ['run_state', 'resume_ready'],
  update_run_status: ['id', 'run_state', 'updated_by', 'resume_ready'],
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
  recovery_report: [
    'interrupted',
    'stale',
    'parked',
    'workspaces',
    'orphaned_resources',
    'next_cursor',
  ],
  get_agent_files: ['project', 'files'],
  propose_agent_file_change: ['proposal_id', 'state'],
  onboard_project: ['project', 'session_id', 'guide', 'existing'],
  finish_onboarding: ['session_id', 'state', 'changes'],
  get_step: ['step', 'history'],
  apply_batch: ['applied', 'failed', 'results'],
  declare_shared_changes: ['declaration', 'registered', 'overlaps'],
  list_shared_parts: ['project', 'parts'],
  take_lease: ['part', 'item_id', 'held_until', 'renewed'],
  release_lease: ['part', 'item_id', 'released'],
  propose_resolution: ['resolution', 'superseded'],
};

/** Optional result fields, from the §5 Output lines (decisions 36 and 39: what's held). */
const OPTIONAL_OUTPUTS: Record<string, string[]> = {
  submit_packet: ['held_undeclared', 'held_design'],
  declare_shared_changes: ['design_hold'],
  update_run_status: ['parked_until'], // decision 44: while a coordinator's park holds
  park_run: ['wait'], // decision 45: left out only on a replay stored before it
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

  it('every mutating tool accepts idempotency_key and run_id; reads accept run_id only', () => {
    expect(MUTATING).toHaveLength(36);
    for (const t of tools) {
      const props = input(t.name).properties!;
      expect(props.run_id, t.name).toBeDefined();
      // Their limits are in §3 and enforced by validation; the definitions stay lean (decision 40).
      if (MUTATING.includes(t.name))
        expect(props.idempotency_key, t.name).toEqual({ type: 'string' });
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
      ['report_commit', 'pushed', false],
      ['recovery_report', 'include_briefs', false],
      ['recovery_report', 'limit', 25],
      ['list_shared_parts', 'include_archived', false],
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

  it('recovery limits follow MCP_SPEC §5.4 (brief ≤ 20,000; ≤ 10 resources per call; label ≤ 120)', () => {
    const props = (tool: string) => input(tool).properties!;
    const spec = (tool: string) => specToolPart(tool, 'Input');
    expect(spec('claim_lead')).toContain('`brief?` (text, ≤ 20,000)');
    expect(props('claim_lead').brief!.maxLength).toBe(20_000);
    expect(props('start_run').brief!.maxLength).toBe(20_000);
    expect(spec('heartbeat')).toContain('label (≤ 120)');
    expect(spec('heartbeat')).toContain('(≤ 10 per call)');
    const started = props('heartbeat').resources_started as JsonObject & { maxItems?: number };
    expect(started.maxItems).toBe(10);
    expect(started.items!.properties!.label!.maxLength).toBe(120);
    expect(started.items!.properties!.kind!.enum).toEqual([
      'process',
      'dev_server',
      'session',
      'container',
      'temp_dir',
      'port',
      'other',
    ]);
    expect(spec('park_run')).toContain('`reason` (≤ 500)');
    expect(props('park_run').reason!.maxLength).toBe(500);
    for (const tool of ['claim_lead', 'start_run', 'heartbeat']) {
      expect(props(tool).external!.type, tool).toBe('object');
      for (const nested of ['workspace', 'orchestrator'] as const) {
        const obj = props(tool)[nested];
        if (obj) expect(obj.additionalProperties, `${tool}.${nested}`).toBe(false);
      }
    }
  });

  it('agent file limits follow MCP_SPEC §5.4 and §5.10 (decision 30; B26)', () => {
    type Limits = JsonObject & {
      maxItems?: number;
      pattern?: string;
      minLength?: number;
    };
    const claim = input('claim_lead').properties!.instructions as Limits;
    expect(claim.additionalProperties).toBe(false);
    expect(claim.required).toEqual(['files']);
    expect(specToolPart('claim_lead', 'Input')).toContain(
      '`instructions?: { install_id?, files: [{ key, sha256, content? }] }`',
    );
    const files = claim.properties!.files as Limits;
    expect(files.maxItems).toBe(20);
    const file = files.items! as Limits;
    expect(file.additionalProperties).toBe(false);
    expect(file.required?.sort()).toEqual(['key', 'sha256']);
    expect((file.properties!.sha256 as Limits).pattern).toBe('^[0-9a-fA-F]{64}$');
    expect(file.properties!.content!.maxLength).toBe(50_000);
    expect(input('start_run').properties!.instructions).toBeUndefined();

    const propose = input('propose_agent_file_change').properties!;
    expect(specToolPart('propose_agent_file_change', 'Input')).toContain(
      '`content` (≤ 50,000; Workflow ≤ 10,000), `reason` (≤ 500)',
    );
    expect(propose.content!.maxLength).toBe(50_000);
    expect(propose.reason!.maxLength).toBe(500);
    expect(propose.based_on_version_id!.anyOf?.map((s) => s.type)).toEqual(['string', 'null']);
    expect((input('get_agent_files').properties!.file as Limits).pattern).toBe(
      '^(agents_block|workflow|skill:[a-z0-9-]{1,60})$',
    );
    const listed = result('get_agent_files').properties!.files!.items!.properties!;
    expect(listed.kind!.enum).toEqual(['skill', 'agents_block', 'workflow']);
    expect(listed.source!.enum).toEqual(['default', 'project']);
  });

  it('onboarding limits follow MCP_SPEC §5.11 (decision 31; B29)', () => {
    type Limits = JsonObject & { maxItems?: number; pattern?: string };
    const onboard = input('onboard_project').properties!;
    expect(specToolPart('onboard_project', 'Input')).toContain(
      '`key` (2–5 uppercase letters, the project key rule), `name?` (≤ 100; required when creating), `color?` (`#rrggbb`)',
    );
    expect((onboard.key as Limits).pattern).toBe('^[A-Z]{2,5}$');
    expect(onboard.name!.maxLength).toBe(100);
    expect((onboard.color as Limits).pattern).toBe('^#[0-9a-fA-F]{6}$');
    const finish = input('finish_onboarding').properties!;
    expect(specToolPart('finish_onboarding', 'Input')).toContain(
      '`summary` (≤ 4,000), `questions?: string[]` (≤ 20, each ≤ 500)',
    );
    expect(finish.summary!.maxLength).toBe(4_000);
    const questions = finish.questions as Limits;
    expect(questions.maxItems).toBe(20);
    expect(questions.items!.maxLength).toBe(500);
    const done = result('finish_onboarding').properties!;
    expect([...(done.changes!.required ?? [])].sort()).toEqual([
      'created',
      'decisions',
      'documents',
      'enriched',
      'proposals',
    ]);
    const started = result('onboard_project').properties!;
    expect([...(started.project!.required ?? [])].sort()).toEqual(['created', 'key', 'name']);
    expect([...(started.existing!.required ?? [])].sort()).toEqual([
      'documents',
      'items',
      'jira_items',
    ]);
  });

  it('the run_state and recovery enums match the §3 table', () => {
    const table = (name: string) => {
      const row = new RegExp(`^ *\\| \`${name}\` [^|]*\\| (.*) \\|$`, 'm').exec(SPEC)![1]!;
      return [...row.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    };
    const run = result('recovery_report').properties!.interrupted!.items!.properties!;
    expect(run.run!.properties!.run_state!.enum).toEqual(table('run_state'));
    expect(run.end_reason!.enum).toEqual(table('end_reason'));
    expect(
      result('recovery_report').properties!.workspaces!.items!.properties!.state!.enum,
    ).toEqual(table('workspace_state'));
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
    const extras = [
      ...(MUTATING.includes(name) ? ['replayed', 'warnings'] : []),
      ...(OPTIONAL_OUTPUTS[name] ?? []),
    ];
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual([...fields, ...extras].sort());
    expect((schema.required ?? []).sort()).toEqual([...fields].sort());
  });

  it.each(Object.keys(OUTPUTS))(
    '%s: every result field is named in its MCP_SPEC Output line',
    (name) => {
      const spec = specToolPart(name, 'Output');
      for (const field of [...OUTPUTS[name]!, ...(OPTIONAL_OUTPUTS[name] ?? [])])
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
    }
    // The full ToolError, as §6 defines it.
    const full = TOOL_ERROR_JSON_SCHEMA as JsonObject;
    expect(full.properties!.code!.enum).toEqual([
      'validation',
      'conflict',
      'not_found',
      'forbidden',
      'unavailable',
      'internal',
      'seam_conflict',
      'not_declared',
      'lease_held',
      'design_review',
    ]);
  });

  it('a compact outputSchema names the top-level fields and their types only (decision 40)', () => {
    for (const t of tools) {
      const compact = (t.outputSchema as JsonObject).anyOf![0]!;
      expect(Object.keys(compact.properties ?? {}).sort(), t.name).toEqual(
        Object.keys(result(t.name).properties ?? {}).sort(),
      );
      for (const field of Object.values(compact.properties ?? {})) {
        expect(
          Object.keys(field).every((k) => k === 'type'),
          t.name,
        ).toBe(true);
      }
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

  it('matches the reviewed full result schemas (decision 40: clients get a compact form)', async () => {
    const full = Object.fromEntries(TOOLS.map((t) => [t.name, resultJsonSchema(t)]));
    await expect(`${JSON.stringify(full, null, 2)}\n`).toMatchFileSnapshot(
      './__snapshots__/tool-results.json',
    );
  });
});

describe('prompts/list and prompts/get (§1, §5.11; decision 31)', () => {
  it('lists exactly the onboard prompt, with its description and arguments verbatim', () => {
    expect(prompts.map((p) => p.name)).toEqual(['onboard']);
    const onboard = prompts[0]!;
    expect(onboard.description).toBe(specPromptDescription('onboard'));
    expect(onboard.arguments?.map((a) => [a.name, a.required, a.description])).toEqual(
      specPromptArguments('onboard'),
    );
  });

  it('matches the reviewed prompts/list snapshot', async () => {
    await expect(JSON.stringify(prompts, null, 2) + '\n').toMatchFileSnapshot(
      './__snapshots__/prompts-list.json',
    );
  });

  it('prompts/get returns one user message: the bundled guide with the key filled in (B30)', async () => {
    syncBundledFiles(h.server.runtime);
    const got = await h.a.getPrompt({
      name: 'onboard',
      arguments: { project_key: 'GF', project_name: 'Gameflow' },
    });
    expect(got.description).toBe(specPromptDescription('onboard'));
    const guide = readFileSync(join(DEFAULT_BUNDLED_ROOT, ONBOARDING_GUIDE_TEMPLATE), 'utf8');
    expect(got.messages).toEqual([
      { role: 'user', content: { type: 'text', text: guide.replaceAll('{{KEY}}', 'GF') } },
    ]);
    // project_name is optional.
    const keyOnly = await h.a.getPrompt({ name: 'onboard', arguments: { project_key: 'GF' } });
    expect(keyOnly.messages).toHaveLength(1);
  });

  it('a missing or malformed project_key, an unknown argument or prompt is InvalidParams', async () => {
    const bad: { name: string; arguments: Record<string, string> }[] = [
      { name: 'onboard', arguments: {} },
      { name: 'onboard', arguments: { project_key: 'gf' } },
      { name: 'onboard', arguments: { project_key: 'GF', projectname: 'x' } },
      { name: 'setup', arguments: { project_key: 'GF' } },
    ];
    for (const params of bad) {
      const err = await h.a.getPrompt(params).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err, JSON.stringify(params)).toBeInstanceOf(McpError);
      expect((err as McpError).code, JSON.stringify(params)).toBe(-32602);
    }
  });
});

describe('text-only sessions (§3 Results)', () => {
  let t: ContractHarness;
  let textTools: Tool[];
  let structuredTools: Tool[];
  let other: Client;
  beforeAll(async () => {
    // The shipped default: `claude-code` (a) and `codex-mcp-client` (b) are text-only.
    // A fresh structured list: the tests above sort `required` arrays in place.
    t = await startHarness({ seed: false, env: PRODUCT_RESULT_MODES });
    textTools = (await t.a.listTools()).tools;
    other = await t.connect({ name: 'another-client', version: '1.0.0' });
    structuredTools = (await other.listTools()).tools;
  });
  afterAll(async () => {
    await t.close();
  });

  it('returns the same server instructions verbatim (§2)', () => {
    expect(t.a.getInstructions()).toBe(specInstructions());
    expect(t.a.getServerCapabilities()).toEqual({
      tools: { listChanged: false },
      prompts: { listChanged: false },
    });
  });

  it('lists the same prompts, and prompts/get answers the same (§3: result modes leave prompts alone)', async () => {
    syncBundledFiles(t.server.runtime);
    expect((await t.a.listPrompts()).prompts).toEqual((await other.listPrompts()).prompts);
    const args = { name: 'onboard', arguments: { project_key: 'GF' } };
    expect(await t.a.getPrompt(args)).toEqual(await other.getPrompt(args));
  });

  it('lists the same 51 tools, in order, with the §5 descriptions verbatim', () => {
    expect(t.b.getServerVersion()?.name).toBe('docket');
    expect(textTools.map((x) => x.name)).toEqual(specDescriptions().map(([name]) => name));
    for (const [name, description] of specDescriptions()) {
      expect(textTools.find((x) => x.name === name)!.description, name).toBe(description);
    }
  });

  it('has no outputSchema on any tool', () => {
    for (const tool of textTools) expect(tool, tool.name).not.toHaveProperty('outputSchema');
  });

  it('keeps the structured input schemas and annotations exactly', () => {
    expect(structuredTools.every((x) => x.outputSchema !== undefined)).toBe(true);
    for (const [i, tool] of textTools.entries()) {
      expect(tool.inputSchema, tool.name).toEqual(structuredTools[i]!.inputSchema);
      expect(tool.annotations, tool.name).toEqual(structuredTools[i]!.annotations);
    }
  });

  it('is the structured tools/list without outputSchema, and nothing else', () => {
    // The structured list itself is the reviewed file snapshot (above).
    expect(textTools).toEqual(structuredTools.map(({ outputSchema: _, ...rest }) => rest));
  });
});

describe('step details follow MCP_SPEC §5.12 (decision 33; B33)', () => {
  type Limits = JsonObject & { minimum?: number };
  it('set_plan steps take details (≤ 10,000, nullable) and source (≤ 100, nullable)', () => {
    expect(specToolPart('set_plan', 'Input')).toContain('after?: step_id, details?, source? }]');
    const step = input('set_plan').properties!.steps!.items!;
    expect(step.additionalProperties).toBe(false);
    const details = step.properties!.details!;
    expect(details.anyOf?.map((s) => [s.type, s.maxLength])).toEqual([
      ['string', 10_000],
      ['null', undefined],
    ]);
    const source = step.properties!.source!;
    expect(source.anyOf?.map((s) => [s.type, s.maxLength])).toEqual([
      ['string', 100],
      ['null', undefined],
    ]);
  });

  it('update_step takes details and expected_details_version', () => {
    expect(specToolPart('update_step', 'Input')).toContain(
      '`details?` (≤ 10,000; replaces them, and `null` clears them), `expected_details_version?`',
    );
    const props = input('update_step').properties!;
    expect(props.details!.anyOf?.map((s) => s.maxLength)).toEqual([10_000, undefined]);
    expect((props.expected_details_version as Limits).minimum).toBe(0);
  });

  it('get_step returns the step with its details and the history', () => {
    const out = result('get_step').properties!;
    expect([...(out.step!.required ?? [])]).toEqual(
      expect.arrayContaining(['source', 'has_details', 'details_md', 'details_version']),
    );
    const entry = out.history!.items!;
    expect([...(entry.required ?? [])].sort()).toEqual(['at', 'by', 'change']);
    expect(entry.properties!.change!.enum).toEqual(['added', 'text', 'state', 'details', 'source']);
    // Elsewhere a WorkStep carries source and has_details, and details only optionally.
    const work = result('set_plan').properties!.work!.items!;
    expect(work.required).toEqual(expect.arrayContaining(['source', 'has_details']));
    expect(work.required).not.toContain('details_md');
  });
});

describe('shared changes follow MCP_SPEC §5.15 (decision 36; B38)', () => {
  type Limits = JsonObject & { maxItems?: number; minItems?: number; const?: unknown };
  it('declare_shared_changes: changes (1–50, notes ≤ 500) or none, new_parts (≤ 20) without single_writer', () => {
    expect(specToolPart('declare_shared_changes', 'Input')).toContain(
      "`changes?: [{ part, change: 'add'|'change'|'remove', note?, design_impact?, design_note?, disputed? }]` (1–50; `note` and `design_note` ≤ 500; B46) or `none?: true`",
    );
    const props = input('declare_shared_changes').properties!;
    const changes = props.changes as Limits;
    expect([changes.minItems, changes.maxItems]).toEqual([1, 50]);
    const change = changes.items!;
    expect(change.additionalProperties).toBe(false);
    expect(change.properties!.change!.enum).toEqual(['add', 'change', 'remove']);
    expect(change.properties!.note!.maxLength).toBe(500);
    expect(change.properties!.part!.maxLength).toBe(200);
    expect((props.none as Limits).const).toBe(true);
    const parts = props.new_parts as Limits;
    expect(parts.maxItems).toBe(20);
    expect(Object.keys(parts.items!.properties!).sort()).toEqual(['key', 'kind', 'note', 'paths']);
    expect(parts.items!.properties!.kind!.enum).toEqual([
      'table',
      'model',
      'endpoint',
      'file',
      'other',
    ]);
    expect((parts.items!.properties!.paths as Limits).maxItems).toBe(20);
  });

  it('changed_files is at most 2,000 paths on submit_packet and set_status; branch ≤ 200 there and on claim_lead', () => {
    for (const tool of ['submit_packet', 'set_status']) {
      const props = input(tool).properties!;
      expect((props.changed_files as Limits).maxItems, tool).toBe(2_000);
      expect(props.branch!.maxLength, tool).toBe(200);
    }
    expect(input('claim_lead').properties!.branch!.maxLength).toBe(200);
    // B40: declare_shared_changes reports the item's branch too (optional, ≤ 200).
    const declare = input('declare_shared_changes');
    expect(declare.properties!.branch!.maxLength).toBe(200);
    expect(declare.required).not.toContain('branch');
    expect(specToolPart('declare_shared_changes', 'Input')).toContain('`branch?` (≤ 200, B40)');
    // B41: or branches, up to 10 of them (an empty list clears).
    const branches = declare.properties!.branches as Limits & { items?: Limits };
    expect(branches.maxItems).toBe(10);
    expect(branches.minItems).toBeUndefined();
    expect(branches.items!.maxLength).toBe(200);
    expect(declare.required).not.toContain('branches');
    expect(specToolPart('declare_shared_changes', 'Input')).toContain(
      '`branches?: string[]` (0–10, each ≤ 200, B41)',
    );
  });

  it('get_context may carry shared; submit_packet may carry held_undeclared', () => {
    const ctx = result('get_context').properties!.context!;
    expect(Object.keys(ctx.properties!)).toContain('shared');
    expect(ctx.required).not.toContain('shared');
    expect(Object.keys(ctx.properties!.shared!.properties!).sort()).toEqual([
      'declaration',
      'design_hold',
      'in_flight',
      'leases',
      'outcomes',
      'overlapping',
      'radar',
      'truncated',
    ]);
    expect(result('submit_packet').required).not.toContain('held_undeclared');
  });
});

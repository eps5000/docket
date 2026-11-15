/**
 * Tool input and output schemas (MCP_SPEC §3–§5; tasks.md T032–T037):
 * strictness, the per-tool common fields, defaults, limits and the
 * either/or rules, plus the JSON Schema that MCP clients receive.
 */
import { describe, expect, it } from 'vitest';
import {
  getTool,
  inputJsonSchema,
  outputJsonSchema,
  toolAnnotations,
  TOOLS,
} from '../src/mcp/index.js';

const parse = (name: string, args: unknown) => getTool(name)!.input.safeParse(args);
const ok = (name: string, args: unknown) => {
  const r = parse(name, args);
  if (!r.success) throw new Error(`${name}: ${JSON.stringify(r.error.issues)}`);
  return r.data as Record<string, unknown>;
};
const fails = (name: string, args: unknown) => {
  const r = parse(name, args);
  expect(r.success, `${name} should reject ${JSON.stringify(args)}`).toBe(false);
  return r.success ? [] : r.error.issues;
};

describe('the registry', () => {
  it('has 36 tools with unique names: 9 read, 1 delivering (get_item), 26 mutating', () => {
    expect(TOOLS).toHaveLength(36);
    expect(new Set(TOOLS.map((t) => t.name)).size).toBe(36);
    const kinds = TOOLS.reduce<Record<string, number>>(
      (acc, t) => ({ ...acc, [t.kind]: (acc[t.kind] ?? 0) + 1 }),
      {},
    );
    expect(kinds).toEqual({ read: 9, delivering: 1, mutating: 26 });
  });

  it('groups tools into the seven server files', () => {
    const groups = Object.fromEntries(
      ['read', 'items', 'runs', 'checklist', 'evidence', 'review', 'decisions'].map((g) => [
        g,
        TOOLS.filter((t) => t.group === g).length,
      ]),
    );
    expect(groups).toEqual({
      read: 8,
      items: 6,
      runs: 5,
      checklist: 7,
      evidence: 4,
      review: 3,
      decisions: 3,
    });
  });

  it('annotates per §3: reads read-only, get_item not, four idempotent tools, nothing destructive', () => {
    expect(toolAnnotations(getTool('search_items'))).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
    });
    expect(toolAnnotations(getTool('get_item'))).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    });
    expect(toolAnnotations(getTool('heartbeat'))).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    });
    expect(TOOLS.filter((t) => toolAnnotations(t).idempotentHint).map((t) => t.name)).toEqual([
      'heartbeat',
      'update_step',
      'update_check',
      'report_commit',
    ]);
    expect(TOOLS.some((t) => toolAnnotations(t).destructiveHint)).toBe(false);
  });
});

describe('common fields', () => {
  it('every tool accepts run_id (B3 resolution 1)', () => {
    for (const t of TOOLS) {
      expect(Object.keys(inputJsonSchema(t).properties as object), t.name).toContain('run_id');
    }
  });

  it('only mutating tools accept idempotency_key', () => {
    for (const t of TOOLS) {
      const props = Object.keys(inputJsonSchema(t).properties as object);
      expect(props.includes('idempotency_key'), t.name).toBe(t.kind === 'mutating');
    }
  });

  it('run_id is required where §5 lists it (release_lead, heartbeat, finish_run)', () => {
    for (const t of TOOLS) {
      const required = (inputJsonSchema(t).required as string[] | undefined) ?? [];
      expect(required.includes('run_id'), t.name).toBe(
        ['release_lead', 'heartbeat', 'finish_run'].includes(t.name),
      );
    }
  });

  it('idempotency_key is at most 100 characters', () => {
    ok('add_note', { id: 'RCP-14', text: 'hi', idempotency_key: 'k'.repeat(100) });
    fails('add_note', { id: 'RCP-14', text: 'hi', idempotency_key: 'k'.repeat(101) });
  });

  it('inputs are strict: an unknown key is rejected (B3 resolution 4)', () => {
    const issues = fails('update_item', { id: 'RCP-14', expected_verison: 3 });
    expect(issues.some((i) => i.code === 'unrecognized_keys')).toBe(true);
    fails('whoami', { verbose: true });
    fails('set_plan', { id: 'RCP-14', steps: [{ txt: 'a' }] });
  });

  it('mutating outputs may carry replayed and warnings (B3 resolution 5)', () => {
    for (const t of TOOLS.filter((x) => x.kind === 'mutating')) {
      const props = Object.keys(
        (outputJsonSchema(t).anyOf as { properties: object }[])[0]!.properties,
      );
      expect(props, t.name).toEqual(expect.arrayContaining(['replayed', 'warnings']));
    }
  });
});

describe('defaults (§5)', () => {
  it.each([
    ['create_item', { project: 'RCP', type: 'Task', title: 'x' }, { priority: 2, status: 'inbox' }],
    ['search_items', {}, { include_archived: true, limit: 25 }],
    ['get_item', { id: 'RCP-14' }, { view: 'standard' }],
    ['get_context', { id: 'RCP-14' }, { budget: 'medium' }],
    ['dependency_subgraph', { id: 'RCP-14' }, { depth: 2, direction: 'both' }],
    ['deferred_reviews', {}, { limit: 25 }],
    ['get_changes', {}, { limit: 100 }],
    ['set_plan', { id: 'RCP-14' }, { mode: 'patch' }],
    ['set_checks', { id: 'RCP-14', checks: [{ text: 'tests' }] }, { mode: 'patch' }],
    ['list_decisions', { project: 'RCP' }, { include_inactive: false, limit: 25 }],
  ] as const)('%s', (name, args, expected) => {
    expect(ok(name, args)).toMatchObject(expected);
  });

  it('set_checks entries default provenance to agent', () => {
    const data = ok('set_checks', { id: 'RCP-14', checks: [{ text: 'tests' }] });
    expect(data.checks).toEqual([{ text: 'tests', provenance: 'agent' }]);
  });
});

describe('limits and formats (§3 Types)', () => {
  it('trims text and rejects empty or over-long values', () => {
    expect(ok('create_item', { project: 'RCP', type: 'Task', title: '  Pantry  ' }).title).toBe(
      'Pantry',
    );
    fails('create_item', { project: 'RCP', type: 'Task', title: '   ' });
    ok('create_item', { project: 'RCP', type: 'Task', title: 't'.repeat(200) });
    fails('create_item', { project: 'RCP', type: 'Task', title: 't'.repeat(201) });
    fails('create_item', {
      project: 'RCP',
      type: 'Task',
      title: 'x',
      description_md: 'd'.repeat(20_001),
    });
    fails('ask_owner', { id: 'RCP-14', question: 'q'.repeat(2_001) });
    fails('add_note', { id: 'RCP-14', text: 'n'.repeat(4_001) });
    fails('upsert_label', { project: 'RCP', name: 'mobile', brief_md: 'b'.repeat(10_001) });
    fails('set_plan', { id: 'RCP-14', steps: [{ text: 's'.repeat(501) }] });
  });

  it('checks IDs, keys, labels, SHAs and dates', () => {
    fails('get_item', { id: 'rcp-14' });
    fails('search_items', { project: 'recipes' });
    fails('upsert_label', { project: 'RCP', name: 'Mobile UI' });
    fails('upsert_label', { project: 'RCP', name: 'a'.repeat(41) });
    ok('report_commit', { id: 'RCP-14', sha: '4be1c09' });
    fails('report_commit', { id: 'RCP-14', sha: '4be1c0' });
    fails('report_commit', { id: 'RCP-14', sha: 'zzzzzzz' });
    ok('create_item', { project: 'RCP', type: 'Task', title: 'x', planned_start: '2026-11-15' });
    fails('create_item', { project: 'RCP', type: 'Task', title: 'x', planned_start: '15/11/2026' });
  });

  it('bounds pages: limit ≤ 50, get_changes ≤ 200, depth 1–5', () => {
    fails('search_items', { limit: 51 });
    ok('get_changes', { limit: 200 });
    fails('get_changes', { limit: 201 });
    fails('dependency_subgraph', { id: 'RCP-14', depth: 6 });
    fails('dependency_subgraph', { id: 'RCP-14', depth: 0 });
  });

  it('bounds lists: 30 plan steps, 30 checks, 1–10 human review items, 1–15 packet steps', () => {
    const steps = (n: number) => Array.from({ length: n }, (_, i) => ({ text: `s${i}` }));
    ok('set_plan', { id: 'RCP-14', steps: steps(30) });
    fails('set_plan', { id: 'RCP-14', steps: steps(31) });
    fails('set_checks', { id: 'RCP-14', checks: steps(31) });
    fails('declare_human_review', { id: 'RCP-14', items: [] });
    fails('declare_human_review', { id: 'RCP-14', items: Array.from({ length: 11 }, () => 'x') });
    const packet = { id: 'RCP-12', built_from_commit: '9c0e7f2', estimate: '10 min', checked: [] };
    fails('submit_packet', { ...packet, how: [] });
    ok('submit_packet', { ...packet, how: ['Open the build'] });
    fails('submit_packet', { ...packet, how: Array.from({ length: 16 }, () => 'x') });
  });

  it('accepts the enums from §3', () => {
    ok('search_items', {
      status: ['inbox', 'planning', 'ready', 'progress', 'review', 'done', 'canceled'],
    });
    fails('search_items', { status: ['doing'] });
    ok('search_items', { type: ['Epic', 'Story', 'Task', 'Bug'] });
    fails('search_items', { type: ['epic'] });
    for (const filter of [
      'ready_to_start',
      'resumable',
      'blocked',
      'waiting_for_review',
      'mine',
      'deferred_review',
    ]) {
      ok('search_items', { filter });
    }
    fails('search_items', { filter: 'for_you' });
    fails('create_item', { project: 'RCP', type: 'Task', title: 'x', priority: 4 });
    fails('create_item', { project: 'RCP', type: 'Task', title: 'x', status: 'ready' });
  });
});

describe('either/or rules', () => {
  it('unlink_items takes link_id or (from, to, type)', () => {
    ok('unlink_items', { link_id: 'lnk_1' });
    ok('unlink_items', { from: 'RCP-19', to: 'RCP-16', type: 'blocks' });
    fails('unlink_items', {});
    fails('unlink_items', { from: 'RCP-19', to: 'RCP-16' });
    fails('unlink_items', { link_id: 'lnk_1', from: 'RCP-19' });
  });

  it('put_document takes item_id or project, and content_text or content_base64', () => {
    ok('put_document', {
      item_id: 'RCP-2',
      name: 'prd.md',
      kind: 'planning',
      content_text: '# PRD',
    });
    ok('put_document', {
      project: 'RCP',
      name: 'a.png',
      kind: 'other',
      content_base64: 'aGVsbG8=',
    });
    fails('put_document', { name: 'prd.md', kind: 'planning', content_text: '# PRD' });
    fails('put_document', {
      item_id: 'RCP-2',
      project: 'RCP',
      name: 'prd.md',
      kind: 'planning',
      content_text: 'x',
    });
    fails('put_document', { item_id: 'RCP-2', name: 'prd.md', kind: 'planning' });
    fails('put_document', {
      item_id: 'RCP-2',
      name: 'a.png',
      kind: 'other',
      content_base64: 'not base64!',
    });
    fails('put_document', {
      item_id: 'RCP-2',
      name: 'x',
      kind: 'import_report',
      content_text: 'x',
    });
  });

  it('update_human_review takes text or remove: true', () => {
    ok('update_human_review', {
      id: 'RCP-12',
      hr_item_id: 'hr_1',
      expected_version: 2,
      text: 'New text',
    });
    ok('update_human_review', {
      id: 'RCP-12',
      hr_item_id: 'hr_1',
      expected_version: 2,
      remove: true,
    });
    fails('update_human_review', { id: 'RCP-12', hr_item_id: 'hr_1', expected_version: 2 });
    fails('update_human_review', {
      id: 'RCP-12',
      hr_item_id: 'hr_1',
      expected_version: 2,
      remove: false,
    });
  });

  it('update_step needs a note for blocked and skipped', () => {
    ok('update_step', { id: 'RCP-14', step_id: 'wst_a', state: 'done' });
    fails('update_step', { id: 'RCP-14', step_id: 'wst_a', state: 'blocked' });
    ok('update_step', { id: 'RCP-14', step_id: 'wst_a', state: 'skipped', note: 'Not needed' });
  });

  it('publish_decision scope needs an id except for project', () => {
    const base = { project: 'RCP', title: 'Metric units', decision: 'Store g and ml.' };
    ok('publish_decision', { ...base, scope: { kind: 'project' } });
    ok('publish_decision', { ...base, scope: { kind: 'epic', id: 'RCP-1' } });
    fails('publish_decision', { ...base, scope: { kind: 'label' } });
  });
});

describe('JSON Schema for MCP', () => {
  it('every inputSchema is a strict object with no $schema', () => {
    for (const t of TOOLS) {
      const schema = inputJsonSchema(t);
      expect(schema.type, t.name).toBe('object');
      expect(schema.additionalProperties, t.name).toBe(false);
      expect(schema).not.toHaveProperty('$schema');
    }
  });

  it('every outputSchema is an object that is the result or a ToolError (B3 resolution 8)', () => {
    for (const t of TOOLS) {
      const schema = outputJsonSchema(t);
      expect(schema.type, t.name).toBe('object');
      const [result, error] = schema.anyOf as {
        type: string;
        properties: Record<string, unknown>;
      }[];
      expect(result!.type).toBe('object');
      expect(Object.keys(error!.properties)).toEqual(['code', 'message', 'details', 'current']);
    }
  });

  it('carries defaults and drops ±2^53 integer bounds', () => {
    const create = inputJsonSchema(getTool('create_item')) as {
      properties: Record<string, Record<string, unknown>>;
    };
    expect(create.properties.priority).toEqual({ default: 2, type: 'number', enum: [1, 2, 3] });
    expect(
      JSON.stringify(TOOLS.map((t) => [inputJsonSchema(t), outputJsonSchema(t)])),
    ).not.toContain('9007199254740991');
  });
});

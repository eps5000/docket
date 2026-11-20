/**
 * Tool input and output schemas (MCP_SPEC §3–§5; tasks.md T032–T037):
 * strictness, the per-tool common fields, defaults, limits and the
 * either/or rules, plus the JSON Schema that MCP clients receive.
 */
import { describe, expect, it } from 'vitest';
import {
  getTool,
  inputJsonSchema,
  normaliseSharedPartKey,
  outputJsonSchema,
  sharedPartKey,
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
  it('has 49 tools with unique names: 13 read, 1 delivering (get_item), 35 mutating', () => {
    expect(TOOLS).toHaveLength(49);
    expect(new Set(TOOLS.map((t) => t.name)).size).toBe(49);
    const kinds = TOOLS.reduce<Record<string, number>>(
      (acc, t) => ({ ...acc, [t.kind]: (acc[t.kind] ?? 0) + 1 }),
      {},
    );
    expect(kinds).toEqual({ read: 13, delivering: 1, mutating: 35 });
  });

  it('groups tools into the thirteen server files', () => {
    const groups = Object.fromEntries(
      [
        'read',
        'items',
        'runs',
        'checklist',
        'evidence',
        'review',
        'decisions',
        'recovery',
        'agent_files',
        'onboarding',
        'batch',
        'shared',
        'problems',
      ].map((g) => [g, TOOLS.filter((t) => t.group === g).length]),
    );
    expect(groups).toEqual({
      read: 8,
      items: 6,
      runs: 6,
      checklist: 8,
      evidence: 4,
      review: 3,
      decisions: 3,
      recovery: 1,
      agent_files: 2,
      onboarding: 2,
      batch: 1,
      shared: 4,
      problems: 1,
    });
    expect(groups).toEqual(
      Object.fromEntries(
        [...new Set(TOOLS.map((t) => t.group))].map((g) => [
          g,
          TOOLS.filter((t) => t.group === g).length,
        ]),
      ),
    );
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

  it('park_run is a write that is not idempotent; recovery_report is read-only (§3, B5)', () => {
    expect(toolAnnotations(getTool('park_run'))).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    });
    expect(toolAnnotations(getTool('recovery_report'))).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
    });
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

  it('run_id is required where §5 lists it (release_lead, heartbeat, finish_run, park_run)', () => {
    for (const t of TOOLS) {
      const required = (inputJsonSchema(t).required as string[] | undefined) ?? [];
      expect(required.includes('run_id'), t.name).toBe(
        ['release_lead', 'heartbeat', 'finish_run', 'park_run'].includes(t.name),
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
    ['report_commit', { id: 'RCP-14', sha: '4be1c09' }, { pushed: false }],
    ['recovery_report', {}, { include_briefs: false, limit: 25 }],
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

describe('recovery inputs (MCP_SPEC §3 "Workspaces, briefs and resources", §5.4, §5.9; B5)', () => {
  const claim = (extra: Record<string, unknown>) => ({ id: 'RCP-23', ...extra });
  const beat = (extra: Record<string, unknown>) => ({ run_id: 'run_A', ...extra });
  const devServer = { kind: 'dev_server', label: 'dev server :5173', locator: { port: 5173 } };

  it('claim_lead and start_run take workspace, orchestrator, brief and external (§7.12)', () => {
    const recovery = {
      workspace: {
        path: 'C:/work/rcp-23',
        branch: 'rcp-23-templates',
        base_ref: 'origin/main',
        base_sha: '9a10624',
        host: 'devbox',
        repo: 'github.com/owner/recipes',
      },
      orchestrator: { name: 'orca', dispatch_id: 'ctx_6f2d', task_id: 'task_7', run_id: 'r_1' },
      brief: 'Implement meal plan templates per the PRD.',
      external: { orca: { worktree_id: 'wt_23' } },
    };
    ok('claim_lead', claim({ agent_label: 'orca-w2', ...recovery }));
    ok('start_run', { id: 'RCP-23', parent_run_id: 'run_A', ...recovery });
    ok('claim_lead', claim({ brief_document_version_id: 'dv_1' }));
    ok('claim_lead', claim({}));
  });

  it('keeps the brief byte for byte: it is not trimmed', () => {
    const brief = '  Indented first line\n\ttabbed\n';
    expect(ok('claim_lead', claim({ brief })).brief).toBe(brief);
  });

  it('brief is at most 20,000 characters', () => {
    ok('claim_lead', claim({ brief: 'x'.repeat(20_000) }));
    fails('claim_lead', claim({ brief: 'x'.repeat(20_001) }));
    fails('start_run', { id: 'RCP-23', parent_run_id: 'run_A', brief: 'x'.repeat(20_001) });
  });

  it('brief and brief_document_version_id are mutually exclusive', () => {
    for (const tool of ['claim_lead', 'start_run']) {
      const base = tool === 'claim_lead' ? claim({}) : { id: 'RCP-23', parent_run_id: 'run_A' };
      const issues = fails(tool, { ...base, brief: 'b', brief_document_version_id: 'dv_1' });
      expect(issues[0]!.path).toEqual(['brief_document_version_id']);
      expect(issues[0]!.message).toBe('Pass brief or brief_document_version_id, not both.');
    }
  });

  it('external is at most 2 KB of JSON (UTF-8 bytes)', () => {
    const sized = (n: number) => ({ o: 'x'.repeat(n - '{"o":""}'.length) });
    ok('claim_lead', claim({ external: sized(2_048) }));
    fails('claim_lead', claim({ external: sized(2_049) }));
    // Multi-byte characters count as bytes, not characters.
    fails('heartbeat', beat({ external: { o: 'é'.repeat(1_100) } }));
    fails('claim_lead', claim({ external: 'not a map' }));
  });

  it('nested recovery objects are strict', () => {
    const wsTypo = fails('claim_lead', claim({ workspace: { pth: 'C:/x' } }));
    expect(wsTypo.some((i) => i.code === 'unrecognized_keys')).toBe(true);
    fails('claim_lead', claim({ orchestrator: { name: 'orca', dispatch: 'x' } }));
    fails('heartbeat', beat({ workspace: { head_sha: '4be1c09', base_sha: '9a10624' } }));
    fails('park_run', { run_id: 'run_A', reason: 'r', waiting_on: { item: ['RCP-12'] } });
    fails('heartbeat', beat({ resources_started: [{ ...devServer, pid: 1 }] }));
  });

  it('checks workspace SHAs, ports and the orchestrator name', () => {
    fails('claim_lead', claim({ workspace: { base_sha: 'main' } }));
    fails('heartbeat', beat({ workspace: { pushed_sha: 'xyz' } }));
    fails('claim_lead', claim({ orchestrator: { dispatch_id: 'ctx_1' } }));
    fails('heartbeat', beat({ resources_started: [{ ...devServer, locator: { port: 70_000 } }] }));
  });

  it('heartbeat takes a workspace patch and up to 10 resources per call, labels ≤ 120', () => {
    ok(
      'heartbeat',
      beat({ workspace: { head_sha: '77aa001', pushed_sha: '6f00e12', dirty: true } }),
    );
    ok('heartbeat', beat({ resources_started: Array.from({ length: 10 }, () => devServer) }));
    fails('heartbeat', beat({ resources_started: Array.from({ length: 11 }, () => devServer) }));
    fails('heartbeat', beat({ resources_started: [{ ...devServer, label: 'x'.repeat(121) }] }));
    fails('heartbeat', beat({ resources_started: [{ ...devServer, kind: 'daemon' }] }));
    fails('heartbeat', beat({ resources_started: [{ ...devServer, locator: {} }] }));
    ok('heartbeat', beat({ resources_released: [{ resource_id: 'rsc_1', note: 'stopped' }] }));
    fails(
      'heartbeat',
      beat({ resources_released: [{ resource_id: 'rsc_1', note: 'x'.repeat(501) }] }),
    );
  });

  it('park_run needs run_id and a reason ≤ 500; waiting_on names items, flags and an ISO until', () => {
    ok('park_run', {
      run_id: 'run_A',
      reason: 'Waiting for RCP-12',
      waiting_on: {
        items: ['RCP-12'],
        orchestrator: true,
        person: false,
        until: '2026-11-16T09:00:00Z',
      },
    });
    fails('park_run', { reason: 'x' });
    fails('park_run', { run_id: 'run_A' });
    fails('park_run', { run_id: 'run_A', reason: 'x'.repeat(501) });
    fails('park_run', { run_id: 'run_A', reason: 'r', waiting_on: { items: ['rcp-12'] } });
    fails('park_run', { run_id: 'run_A', reason: 'r', waiting_on: { until: 'tomorrow' } });
  });

  it('report_commit takes pushed', () => {
    expect(ok('report_commit', { id: 'RCP-23', sha: 'c1d2e3f', pushed: true }).pushed).toBe(true);
    fails('report_commit', { id: 'RCP-23', sha: 'c1d2e3f', pushed: 'yes' });
  });

  it('recovery_report takes project, since, include_briefs and paging', () => {
    ok('recovery_report', {
      project: 'RCP',
      since: '2026-11-08T00:00:00Z',
      include_briefs: true,
      cursor: 'c_1',
      limit: 50,
    });
    fails('recovery_report', { since: '2026-11-08' });
    fails('recovery_report', { limit: 51 });
    fails('recovery_report', { include_brief: true });
  });
});

describe('agent file inputs (MCP_SPEC §5.4 instructions, §5.10; decision 30; B26)', () => {
  const sha = 'a'.repeat(64);
  const claim = (instructions: unknown) => ({ id: 'RCP-23', instructions });

  it('claim_lead takes the docket-check report: install_id, and up to 20 files', () => {
    ok('claim_lead', claim({ install_id: 'ins_1', files: [{ key: 'agents_block', sha256: sha }] }));
    ok('claim_lead', claim({ files: [{ key: 'skill:docket-worker', sha256: sha.toUpperCase() }] }));
    // Empty, with install_id: every installed file is missing.
    ok('claim_lead', claim({ install_id: 'ins_1', files: [] }));
    const twenty = Array.from({ length: 20 }, (_, i) => ({ key: `skill:s${i}`, sha256: sha }));
    ok('claim_lead', claim({ files: twenty }));
    fails('claim_lead', claim({ files: [...twenty, { key: 'skill:s20', sha256: sha }] }));
    fails('claim_lead', claim({ install_id: 'ins_1' }));
  });

  it('a reported file has an installed key, a 64-hex sha256 and content ≤ 50,000, kept as is', () => {
    const file = (f: Record<string, unknown>) =>
      claim({ files: [{ key: 'agents_block', sha256: sha, ...f }] });
    fails('claim_lead', file({ key: 'workflow' }));
    fails('claim_lead', file({ key: 'skill:Bad_Name' }));
    fails('claim_lead', file({ sha256: 'a'.repeat(63) }));
    fails('claim_lead', file({ sha256: 'g'.repeat(64) }));
    ok('claim_lead', file({ content: '' }));
    ok('claim_lead', file({ content: 'x'.repeat(50_000) }));
    fails('claim_lead', file({ content: 'x'.repeat(50_001) }));
    const content = '  indented\n';
    const parsed = ok('claim_lead', file({ content })) as {
      instructions: { files: { content: string }[] };
    };
    expect(parsed.instructions.files[0]!.content).toBe(content);
    const typo = fails('claim_lead', file({ contnet: 'x' }));
    expect(typo.some((i) => i.code === 'unrecognized_keys')).toBe(true);
  });

  it('start_run does not take instructions', () => {
    fails('start_run', { id: 'RCP-23', parent_run_id: 'run_A', instructions: { files: [] } });
  });

  it('get_agent_files needs a project; file is one key', () => {
    ok('get_agent_files', { project: 'RCP' });
    for (const file of ['agents_block', 'workflow', 'skill:docket-worker']) {
      ok('get_agent_files', { project: 'RCP', file });
    }
    fails('get_agent_files', {});
    fails('get_agent_files', { project: 'RCP', file: 'docket-worker' });
    fails('get_agent_files', { project: 'RCP', idempotency_key: 'k' });
  });

  const propose = (extra: Record<string, unknown>) => ({
    project: 'RCP',
    file: 'skill:docket-worker',
    content: '---\nname: docket-worker\n---\n',
    reason: 'Run the linter before each commit.',
    based_on_version_id: 'afv_1',
    ...extra,
  });

  it('propose_agent_file_change: the whole text, kept as is, with a reason and the version read', () => {
    const content = '  starts indented\n';
    expect(ok('propose_agent_file_change', propose({ content })).content).toBe(content);
    ok('propose_agent_file_change', propose({ project: undefined }));
    ok('propose_agent_file_change', propose({ idempotency_key: 'p-1', run_id: 'run_A' }));
    ok('propose_agent_file_change', propose({ content: 'x'.repeat(50_000) }));
    fails('propose_agent_file_change', propose({ content: 'x'.repeat(50_001) }));
    fails('propose_agent_file_change', propose({ content: '  \n' }));
    fails('propose_agent_file_change', propose({ reason: '' }));
    fails('propose_agent_file_change', propose({ reason: 'r'.repeat(501) }));
    fails('propose_agent_file_change', propose({ based_on_version_id: undefined }));
    fails('propose_agent_file_change', propose({ based_on_version_id: null }));
    fails('propose_agent_file_change', propose({ file: 'skills/docket-worker' }));
  });

  it('Workflow notes need a project, are at most 10,000, may be empty, and may start from none', () => {
    const wf = (extra: Record<string, unknown>) => propose({ file: 'workflow', ...extra });
    ok('propose_agent_file_change', wf({ content: '', based_on_version_id: null }));
    ok(
      'propose_agent_file_change',
      wf({ content: 'x'.repeat(10_000), based_on_version_id: 'wf_1' }),
    );
    const long = fails('propose_agent_file_change', wf({ content: 'x'.repeat(10_001) }));
    expect(long[0]!.path).toEqual(['content']);
    const noProject = fails('propose_agent_file_change', wf({ project: undefined }));
    expect(noProject[0]!.path).toEqual(['project']);
  });

  it('get_agent_files is read-only; propose is a write that is not retry-safe', () => {
    expect(toolAnnotations(getTool('get_agent_files'))).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
    });
    expect(toolAnnotations(getTool('propose_agent_file_change'))).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    });
  });
});

describe('onboarding (MCP_SPEC §5.11; decision 31; B29)', () => {
  it('onboard_project: the key follows the project-key rule; name ≤ 100; colour #rrggbb', () => {
    ok('onboard_project', { key: 'GF' });
    ok('onboard_project', { key: 'GAME', name: 'Gameflow', color: '#3b5bdb' });
    ok('onboard_project', { key: 'GF', idempotency_key: 'onb-1', run_id: 'run_A' });
    expect(ok('onboard_project', { key: ' GF ', name: '  Gameflow ' })).toMatchObject({
      key: 'GF',
      name: 'Gameflow',
    });
    ok('onboard_project', { key: 'GF', name: 'x'.repeat(100) });
    fails('onboard_project', { key: 'GF', name: 'x'.repeat(101) });
    fails('onboard_project', { key: 'GF', name: '   ' });
    for (const key of ['G', 'gf', 'GAMEFL', 'G1', '']) fails('onboard_project', { key });
    fails('onboard_project', {});
    for (const color of ['blue', '#3b5bd', '3b5bdb', '#3b5bdbff'])
      fails('onboard_project', { key: 'GF', color });
    const typo = fails('onboard_project', { key: 'GF', nmae: 'Gameflow' });
    expect(typo.some((i) => i.code === 'unrecognized_keys')).toBe(true);
  });

  it('finish_onboarding: a summary ≤ 4,000 and up to 20 questions ≤ 500', () => {
    const finish = (extra: Record<string, unknown>) => ({
      session_id: 'onb_1',
      summary: 'Created 12 items in Planning.',
      ...extra,
    });
    ok('finish_onboarding', finish({}));
    ok('finish_onboarding', finish({ questions: [], idempotency_key: 'f-1' }));
    ok('finish_onboarding', finish({ summary: 'x'.repeat(4_000) }));
    fails('finish_onboarding', finish({ summary: 'x'.repeat(4_001) }));
    fails('finish_onboarding', finish({ summary: ' ' }));
    fails('finish_onboarding', finish({ summary: undefined }));
    fails('finish_onboarding', finish({ session_id: undefined }));
    ok('finish_onboarding', finish({ questions: Array.from({ length: 20 }, () => 'Why?') }));
    fails('finish_onboarding', finish({ questions: Array.from({ length: 21 }, () => 'Why?') }));
    ok('finish_onboarding', finish({ questions: ['q'.repeat(500)] }));
    fails('finish_onboarding', finish({ questions: ['q'.repeat(501)] }));
    fails('finish_onboarding', finish({ questions: [''] }));
  });

  it('both are writes that are not retry-safe', () => {
    for (const name of ['onboard_project', 'finish_onboarding'] as const) {
      expect(getTool(name).kind).toBe('mutating');
      expect(toolAnnotations(getTool(name))).toEqual({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      });
    }
  });
});

describe('step details (MCP_SPEC §5.12; decision 33; B33)', () => {
  it('set_plan steps take details (≤ 10,000; null clears) and source (≤ 100; null clears)', () => {
    const plan = (step: Record<string, unknown>) => ({ id: 'RCP-14', steps: [step] });
    ok('set_plan', plan({ text: 'Merge units', details: '## Why\n\nBecause.', source: 'GF-123' }));
    ok('set_plan', plan({ id: 'wst_a', details: null, source: null }));
    ok('set_plan', plan({ id: 'wst_a', details: 'x'.repeat(10_000) }));
    fails('set_plan', plan({ id: 'wst_a', details: 'x'.repeat(10_001) }));
    ok('set_plan', plan({ id: 'wst_a', source: 's'.repeat(100) }));
    fails('set_plan', plan({ id: 'wst_a', source: 's'.repeat(101) }));
    fails('set_plan', plan({ id: 'wst_a', source: '  ' }));
    // Empty details are allowed (they clear, like null); trimmed.
    expect(
      (
        ok('set_plan', plan({ id: 'wst_a', details: '  body  ' })).steps as { details: string }[]
      )[0]!.details,
    ).toBe('body');
    const typo = fails('set_plan', plan({ id: 'wst_a', detail: 'x' }));
    expect(typo.some((i) => i.code === 'unrecognized_keys')).toBe(true);
  });

  it('update_step takes details and expected_details_version; state stays required', () => {
    const base = { id: 'RCP-14', step_id: 'wst_a', state: 'current' };
    ok('update_step', { ...base, details: 'Notes', expected_details_version: 0 });
    ok('update_step', { ...base, details: null });
    fails('update_step', { ...base, details: 'x'.repeat(10_001) });
    fails('update_step', { ...base, expected_details_version: -1 });
    fails('update_step', { ...base, expected_details_version: 1.5 });
    fails('update_step', { id: 'RCP-14', step_id: 'wst_a', details: 'Notes' });
  });

  it('get_step is a read: id and step_id, plus run_id; no idempotency_key', () => {
    expect(getTool('get_step').kind).toBe('read');
    expect(toolAnnotations(getTool('get_step'))).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
    });
    ok('get_step', { id: 'RCP-14', step_id: 'wst_a' });
    ok('get_step', { id: 'RCP-14', step_id: 'wst_a', run_id: 'run_A' });
    fails('get_step', { id: 'RCP-14' });
    fails('get_step', { id: 'RCP-14', step_id: 'wst_a', idempotency_key: 'k' });
  });

  it('get_step output: the step always carries details_md and details_version', () => {
    const out = outputJsonSchema(getTool('get_step')) as {
      anyOf: { properties: Record<string, { required?: string[] }> }[];
    };
    const step = out.anyOf[0]!.properties.step!;
    expect(step.required).toEqual(
      expect.arrayContaining(['details_md', 'details_version', 'source', 'has_details']),
    );
  });
});

describe('shared changes (MCP_SPEC §5.15; decision 36; B38)', () => {
  it('normalises part keys per kind', () => {
    const cases: [string, string][] = [
      ['Table: Decks', 'table:decks'],
      ['model:Token', 'model:Token'],
      ['endpoint:post /decks/{id}/export/', 'endpoint:POST /decks/{id}/export'],
      ['endpoint:GET /', 'endpoint:GET /'],
      [
        'file:.\\src\\Gameflow.Api\\Data\\Migrations\\Snapshot.cs',
        'file:src/Gameflow.Api/Data/Migrations/Snapshot.cs',
      ],
      ['other:Feature Flags', 'other:feature-flags'],
    ];
    for (const [raw, key] of cases) {
      expect(normaliseSharedPartKey(raw), raw).toMatchObject({ ok: true, key });
      expect(sharedPartKey.parse(raw), raw).toBe(key);
    }
  });

  it('rejects keys that do not parse, naming the rule', () => {
    const bad: [string, RegExp][] = [
      ['Token', /<kind>:<name>/],
      ['class:Token', /unknown kind "class"/],
      ['model:', /needs a name/],
      ['table:deck items', /no spaces/],
      ['endpoint:/decks', /METHOD \/path/],
      ['endpoint:FETCH /decks', /METHOD \/path/],
      ['file:../secrets.txt', /repo-relative/],
      ['file:/etc/passwd', /repo-relative/],
      ['file:C:/repo/a.cs', /repo-relative/],
      ['other:***', /slug/],
      [`model:${'T'.repeat(200)}`, /at most 200/],
    ];
    for (const [raw, msg] of bad) {
      const r = normaliseSharedPartKey(raw);
      expect(r.ok, raw).toBe(false);
      if (!r.ok) expect(r.error, raw).toMatch(msg);
      expect(sharedPartKey.safeParse(raw).success, raw).toBe(false);
    }
  });

  it('declare_shared_changes takes changes or none, never both, and normalises keys', () => {
    const d = ok('declare_shared_changes', {
      id: 'GF-312',
      changes: [{ part: 'Table: Decks', change: 'add', note: 'Export column' }],
      new_parts: [{ key: 'table:decks', kind: 'table', paths: ['./db/migrations/**'] }],
    });
    expect(d.changes).toEqual([{ part: 'table:decks', change: 'add', note: 'Export column' }]);
    expect(d.new_parts).toEqual([
      { key: 'table:decks', kind: 'table', paths: ['db/migrations/**'] },
    ]);
    ok('declare_shared_changes', { id: 'GF-312', none: true });
    // B41: branches (up to 10, an empty list clears) or branch, not both.
    ok('declare_shared_changes', { id: 'GF-312', none: true, branches: ['gf-312-a', 'gf-312-b'] });
    ok('declare_shared_changes', { id: 'GF-312', none: true, branches: [] });
    ok('declare_shared_changes', { id: 'GF-312', none: true, branch: 'gf-312-a' });
    fails('declare_shared_changes', {
      id: 'GF-312',
      none: true,
      branches: Array.from({ length: 11 }, (_, i) => `gf-312-${i}`),
    });
    fails('declare_shared_changes', {
      id: 'GF-312',
      none: true,
      branch: 'gf-312-a',
      branches: ['gf-312-b'],
    });
    fails('declare_shared_changes', { id: 'GF-312', none: true, branches: ['x'.repeat(201)] });
    fails('declare_shared_changes', { id: 'GF-312' });
    fails('declare_shared_changes', { id: 'GF-312', none: false });
    fails('declare_shared_changes', { id: 'GF-312', changes: [] });
    fails('declare_shared_changes', {
      id: 'GF-312',
      none: true,
      changes: [{ part: 'model:Token', change: 'change' }],
    });
    fails('declare_shared_changes', {
      id: 'GF-312',
      none: true,
      new_parts: [{ key: 'model:Token' }],
    });
    fails('declare_shared_changes', {
      id: 'GF-312',
      changes: [
        { part: 'model:Token', change: 'change' },
        { part: 'model:Token', change: 'remove' },
      ],
    });
    fails('declare_shared_changes', {
      id: 'GF-312',
      changes: [{ part: 'model:Token', change: 'rename' }],
    });
    // Agents can't set single-writer (FR-158): new_parts is strict.
    fails('declare_shared_changes', {
      id: 'GF-312',
      changes: [{ part: 'model:Token', change: 'change' }],
      new_parts: [{ key: 'model:Token', single_writer: true }],
    });
    fails('declare_shared_changes', {
      id: 'GF-312',
      changes: [{ part: 'model:Token', change: 'change' }],
      new_parts: [{ key: 'model:Token', kind: 'table' }],
    });
    const many = Array.from({ length: 51 }, (_, i) => ({ part: `model:M${i}`, change: 'add' }));
    fails('declare_shared_changes', { id: 'GF-312', changes: many });
  });

  it('list_shared_parts, take_lease and release_lease', () => {
    expect(ok('list_shared_parts', { project: 'GF' }).include_archived).toBe(false);
    ok('take_lease', { id: 'GF-240', part: 'file:src/Snapshot.cs' });
    ok('release_lease', { id: 'GF-240', part: 'file:src/Snapshot.cs' });
    fails('take_lease', { id: 'GF-240' });
    expect(toolAnnotations(getTool('list_shared_parts'))).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
    });
    for (const name of ['declare_shared_changes', 'take_lease', 'release_lease']) {
      expect(toolAnnotations(getTool(name)!), name).toEqual({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      });
    }
  });

  it('claim_lead takes branch; set_status and submit_packet take changed_files and branch', () => {
    ok('claim_lead', { id: 'GF-312', branch: 'gf-312-export' });
    const st = ok('set_status', {
      id: 'GF-312',
      status: 'done',
      changed_files: ['.\\src\\Decks.cs', 'db/migrations/0003.sql'],
      branch: 'gf-312-export',
    });
    expect(st.changed_files).toEqual(['src/Decks.cs', 'db/migrations/0003.sql']);
    fails('set_status', { id: 'GF-312', status: 'done', changed_files: ['../outside.txt'] });
    const files = Array.from({ length: 2_001 }, (_, i) => `src/f${i}.ts`);
    fails('set_status', { id: 'GF-312', status: 'done', changed_files: files });
    const packet = {
      id: 'GF-312',
      built_from_commit: '4be1c09',
      estimate: '5 min',
      how: ['Open it'],
      checked: [],
    };
    ok('submit_packet', { ...packet, changed_files: files.slice(0, 2_000), branch: 'b' });
    fails('submit_packet', { ...packet, changed_files: files });
  });

  it('the output schemas carry the new error codes and the optional fields', () => {
    const err = (
      outputJsonSchema(getTool('take_lease')) as {
        anyOf: { properties: { code: { enum: string[] } } }[];
      }
    ).anyOf[1]!.properties.code.enum;
    expect(err.slice(-3)).toEqual(['seam_conflict', 'not_declared', 'lease_held']);
    const packet = getTool('submit_packet').output;
    expect(
      packet.safeParse({
        packet_id: 'pkt_1',
        round: 1,
        display_id: 'pkt-1a2b',
        item: undefined,
      }).success,
    ).toBe(false);
    const ctx = getTool('get_context').output.shape.context.shape;
    expect(ctx.shared.safeParse(undefined).success).toBe(true);
  });
});

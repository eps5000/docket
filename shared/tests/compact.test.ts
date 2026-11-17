/**
 * Compact text renderers (MCP_SPEC §3.1; tasks.md T039). Pure functions over
 * fixture objects. The §3.1 examples are read from MCP_SPEC.md at test time,
 * so the spec and the renderers can't drift apart.
 */
import { describe, expect, it } from 'vitest';
import {
  formatTime,
  renderContext,
  renderError,
  renderItem,
  renderItemRow,
  renderResult,
  truncate,
} from '../src/compact.js';
import { TOOLS, type ToolName } from '../src/mcp/tools.js';
import {
  DEC_1,
  NOW,
  RCP14,
  RCP14_CONTEXT,
  RCP14_SUMMARY,
  RCP17_SUMMARY,
  RECOVERY_REPORT,
  RUN_AT_RISK,
  RUN_PARKED,
} from './fixtures.js';
import { specBlock, specInline } from './spec.js';

const opts = { now: NOW };

describe('the MCP_SPEC §3.1 examples render identically', () => {
  it('get_item RCP-14, standard view', () => {
    const expected = specBlock('**Example:** `get_item RCP-14`');
    const actual = renderItem(RCP14, { view: 'standard', ...opts });
    expect(actual).toBe(expected);
  });

  it('get_item RCP-14 through the get_item result renderer', () => {
    const expected = specBlock('**Example:** `get_item RCP-14`');
    expect(renderResult('get_item', { item: RCP14 }, { args: { id: 'RCP-14' }, ...opts })).toBe(
      expected,
    );
  });

  it('a search result row', () => {
    const expected = specInline('**Search results** use one line per item:');
    expect(renderItemRow(RCP17_SUMMARY, opts)).toBe(expected);
  });

  it('a mutation one-liner (claim_lead)', () => {
    const expected = specInline(
      '**Mutations** render one line: what changed and the new version, e.g.',
    );
    const text = renderResult(
      'claim_lead',
      {
        run_id: 'run_01JA…',
        item: { ...RCP14_SUMMARY, version: 8 },
        lease_expires_at: '2026-11-06T12:02:00.000Z',
      },
      { args: { id: 'RCP-14' }, ...opts },
    );
    expect(text).toBe(expected);
  });
});

describe('format rules', () => {
  it('shows HH:MMZ for today (UTC) and MM-DD otherwise', () => {
    expect(formatTime('2026-11-06T12:02:00.000Z', NOW)).toBe('12:02Z');
    expect(formatTime('2026-11-06T00:00:00.000Z', NOW)).toBe('00:00Z');
    expect(formatTime('2026-11-05T23:59:00.000Z', NOW)).toBe('11-05');
    expect(formatTime('2025-11-06T12:00:00.000Z', NOW)).toBe('11-06');
  });

  it('truncates long text at 200 characters with …', () => {
    const long = 'x'.repeat(250);
    const cut = truncate(long);
    expect(cut).toHaveLength(200);
    expect(cut.endsWith('…')).toBe(true);
    expect(truncate('short')).toBe('short');
    expect(truncate('a\nb')).toBe('a b');
  });

  it('truncates long titles in list rows', () => {
    const row = renderItemRow({ ...RCP17_SUMMARY, title: 'T'.repeat(300) }, opts);
    expect(row).toContain(`${'T'.repeat(199)}…`);
    expect(row).not.toContain('T'.repeat(200));
  });

  it('always shows the safety facts, as none when empty', () => {
    const text = renderItem(RCP14, { view: 'standard', ...opts });
    expect(text).toContain('blocked_by: none');
    expect(text).toContain('question: none · notes_unread: none');
  });

  it('uses every checklist marker', () => {
    const states = ['todo', 'current', 'done', 'blocked', 'skipped'] as const;
    const work = states.map((state, i) => ({ ...RCP14.checklist.work[3]!, id: `wst_${i}`, state }));
    const text = renderItem(
      { ...RCP14, checklist: { ...RCP14.checklist, work } },
      { view: 'standard', ...opts },
    );
    expect(text).toContain('  - [ ] wst_0');
    expect(text).toContain('  - [>] wst_1');
    expect(text).toContain('  - [x] wst_2');
    expect(text).toContain('  - [!] wst_3');
    expect(text).toContain('  - [-] wst_4');
  });

  it('shows check states as [pass] [fail] [todo] [skip]', () => {
    const states = ['pass', 'fail', 'todo', 'skipped'] as const;
    const checks = states.map((state, i) => ({
      ...RCP14.checklist.checks[1]!,
      id: `chk_${i}`,
      state,
    }));
    const text = renderItem(
      { ...RCP14, checklist: { ...RCP14.checklist, checks } },
      { view: 'standard', ...opts },
    );
    expect(text).toContain('  - [pass] chk_0');
    expect(text).toContain('  - [fail] chk_1');
    expect(text).toContain('  - [todo] chk_2');
    expect(text).toContain('  - [skip] chk_3');
  });

  it('renders the open question, its answer and unread notes when delivered', () => {
    const text = renderItem(
      {
        ...RCP14,
        open_question: {
          id: 'q_1',
          text: 'Per serving or per 100 g?',
          asked_at: '2026-11-06T09:30:00.000Z',
          answer: 'Per serving; 100 g in a footnote.',
          answered_at: '2026-11-06T10:00:00.000Z',
        },
        unread_owner_notes: [
          { id: 'on_1', text: 'Keep the list printable.', at: '2026-11-05T18:00:00.000Z' },
        ],
      },
      { view: 'standard', ...opts },
    );
    expect(text).toContain('  question: q_1 Per serving or per 100 g? · asked 09:30Z');
    expect(text).toContain('    answer: Per serving; 100 g in a footnote. · 10:00Z');
    expect(text).toContain('  notes_unread:\n  - 11-05 Keep the list printable.');
  });

  it('lists unresolved blockers with what they wait for', () => {
    const text = renderItem(
      {
        ...RCP14,
        blocked: true,
        blocked_by: ['RCP-19'],
        links: {
          ...RCP14.links,
          blocked_by: [
            {
              link_id: 'lnk_c',
              id: 'RCP-19',
              title: 'Units API',
              status: 'done',
              project: 'RCP',
              satisfied_when: 'merged',
              cleared: false,
              waiting_for: 'merge',
            },
            {
              link_id: 'lnk_d',
              id: 'DOC-4',
              title: 'Nutrition doc',
              status: 'done',
              project: 'DOC',
              satisfied_when: 'done',
              cleared: true,
              waiting_for: null,
            },
          ],
        },
      },
      { view: 'standard', ...opts },
    );
    expect(text).toContain(
      '  blocked_by: RCP-19 done waiting for merge · blocks: RCP-24 planning, RCP-27 planning',
    );
  });

  it('appends warnings as ! lines', () => {
    const text = renderResult(
      'add_note',
      {
        event: {
          cursor: 'c_9',
          at: '2026-11-06T10:58:00.000Z',
          actor: 'claude',
          item_id: 'RCP-14',
          type: 'note.added',
          summary: 'note',
        },
        warnings: ["RCP-99 doesn't exist"],
      },
      { args: { id: 'RCP-14' }, ...opts },
    );
    expect(text).toBe("Noted on RCP-14 · 10:58Z\n! RCP-99 doesn't exist");
  });

  it('marks replayed mutation results', () => {
    const text = renderResult(
      'set_status',
      { item: { ...RCP14_SUMMARY, status: 'done', version: 9 }, replayed: true },
      { args: { id: 'RCP-14' }, ...opts },
    );
    expect(text).toBe('Moved RCP-14 to done · v9 · replayed');
  });
});

describe('item views', () => {
  it('summary view counts the question and notes without delivering them', () => {
    const text = renderItem(
      {
        ...RCP14_SUMMARY,
        counts: { work_done: 1, work_total: 4, checks_pass: 1, checks_total: 3 },
        has_open_question: true,
        unread_owner_notes_count: 2,
      },
      { view: 'summary', ...opts },
    );
    expect(text).toBe(
      [
        'RCP-14 Generate shopping list from week plan',
        '  story · P1 · progress · epic RCP-1 Meal planning MVP · labels mobile · v7',
        '  lead claude·orca-w3 live · run run_01JA…',
        '  blocked_by: none · unblocks 2',
        '  work 1/4 done · checks 1/3 pass · human_review declared 1',
        '  question: open, read it with get_item · notes_unread: 2',
      ].join('\n'),
    );
  });

  it('summary view shows none for the safety facts', () => {
    const text = renderItem(
      {
        ...RCP14_SUMMARY,
        counts: { work_done: 0, work_total: 0, checks_pass: 0, checks_total: 0 },
        has_open_question: false,
        unread_owner_notes_count: 0,
      },
      { view: 'summary', ...opts },
    );
    expect(text).toContain('question: none · notes_unread: none');
  });

  it('a fields-trimmed item renders only what it has', () => {
    const text = renderItem(
      { id: 'RCP-14', version: 7, status: 'progress' },
      { view: 'standard', ...opts },
    );
    expect(text).toBe('RCP-14\n  progress · v7');
  });

  it('full view adds runs, commits and activity', () => {
    const text = renderItem(
      {
        ...RCP14,
        commits: [{ sha: '4be1c09aa', branch: 'rcp-14-list', at: '2026-11-06T10:30:00.000Z' }],
        recent_events: [
          {
            cursor: 'c_1',
            at: '2026-11-06T10:52:00.000Z',
            actor: 'claude',
            item_id: 'RCP-14',
            type: 'step.updated',
            summary: 'claude reported progress on work item 2',
          },
        ],
        jira_key: 'MEAL-88',
        closed_by: null,
        dates_set_by: 'owner',
        planned_start: '2026-11-03',
        planned_end: '2026-11-10',
        effort: 3,
      },
      { view: 'full', ...opts },
    );
    expect(text).toContain(
      '  runs:\n  - run_r77 codex·units-worker finished · child of run_01JA… · Conversion table + 31 tests',
    );
    expect(text).toContain('  commits: 4be1c09 rcp-14-list 10:30Z');
    expect(text).toContain(
      '  activity:\n  - 10:52Z claude step.updated claude reported progress on work item 2',
    );
    expect(text).toContain('planned 2026-11-03→2026-11-10 (owner) · effort 3 pts · jira MEAL-88');
  });
});

describe('get_context: Workflow notes (decision 29; MCP_SPEC §5.2)', () => {
  const lines = (ctx: typeof RCP14_CONTEXT) => renderContext(ctx, opts).split('\n');

  it('renders a workflow: section after the label briefs and links, before planning docs', () => {
    const out = lines(RCP14_CONTEXT);
    const at = (prefix: string) => out.findIndex((l) => l.startsWith(prefix));
    expect(out.slice(at('workflow:'), at('workflow:') + 3)).toEqual([
      'workflow: RCP v2',
      '  - Branch per item: rcp-<n>.',
      '  - Run pnpm test before every report_commit.',
    ]);
    expect(at('labels:')).toBeLessThan(at('workflow:'));
    expect(at('blocks:')).toBeLessThan(at('workflow:'));
    expect(at('workflow:')).toBeLessThan(at('planning_docs:'));
  });

  it('omits the section when the project has no notes (workflow: null)', () => {
    expect(lines({ ...RCP14_CONTEXT, workflow: null }).some((l) => l.startsWith('workflow'))).toBe(
      false,
    );
  });

  it('marks truncated notes inline, never silently', () => {
    const workflow = { ...RCP14_CONTEXT.workflow!, truncated: true };
    expect(lines({ ...RCP14_CONTEXT, workflow })).toContain(
      '  …truncated; ask get_context with a larger budget',
    );
    expect(lines({ ...RCP14_CONTEXT, workflow, budget: 'large' })).toContain('  …truncated');
  });
});

describe('errors', () => {
  it('renders the code and message, then details', () => {
    expect(
      renderError({
        code: 'validation',
        message: 'Invalid arguments for create_item: title is required. Fix it and retry.',
        details: {
          fields: { title: 'is required', 'steps[0].text': 'must not be empty' },
          unknown: [],
        },
      }),
    ).toBe(
      'validation: Invalid arguments for create_item: title is required. Fix it and retry.\n  steps[0].text: must not be empty',
    );
  });

  it('renders current state on conflict', () => {
    const text = renderError({
      code: 'conflict',
      message: 'RCP-15 is led by codex · orca-w1 (lease until 11:13 UTC). Pick another item.',
      current: { lead_client: 'codex', lead_label: 'orca-w1' },
    });
    expect(text).toBe(
      'conflict: RCP-15 is led by codex · orca-w1 (lease until 11:13 UTC). Pick another item.\n  current: {"lead_client":"codex","lead_label":"orca-w1"}',
    );
  });

  it('renders a stub error as its message', () => {
    expect(renderError({ code: 'unavailable', message: 'Not implemented yet: whoami' })).toBe(
      'unavailable: Not implemented yet: whoami',
    );
  });
});

/** One representative result per tool, so every renderer is exercised and snapshotted. */
const SAMPLES: Record<ToolName, { result: unknown; args?: Record<string, unknown> }> = {
  whoami: {
    result: {
      client: 'claude',
      session_id: '8d1f0c2e',
      server_version: '0.1.0',
      server_time: '2026-11-06T11:00:00.000Z',
      limits: {
        page_max: 50,
        changes_max: 200,
        document_mcp_bytes: 26214400,
        text_limits: { title: 200, step: 500 },
      },
      live_window_s: 90,
      stale_after_s: 600,
      lease_s: 3600,
    },
  },
  list_projects: {
    result: {
      projects: [
        {
          key: 'RCP',
          name: 'Recipes',
          counts: { open: 12, ready_to_start: 3, in_progress: 2, review: 1, blocked: 2 },
        },
      ],
    },
  },
  search_items: { result: { items: [RCP17_SUMMARY, RCP14_SUMMARY], next_cursor: 'cur_2' } },
  get_item: { result: { item: RCP14 }, args: { id: 'RCP-14' } },
  get_context: { result: { context: RCP14_CONTEXT }, args: { id: 'RCP-14' } },
  dependency_subgraph: {
    args: { id: 'RCP-14' },
    result: {
      nodes: [
        {
          id: 'RCP-14',
          title: RCP14.title,
          status: 'progress',
          blocked: false,
          planned_start: '2026-11-03',
          planned_end: '2026-11-10',
          date_source: 'entered',
          effort: 3,
        },
        {
          id: 'RCP-24',
          title: 'Share the shopping list',
          status: 'planning',
          blocked: true,
          planned_start: '2026-11-08',
          planned_end: null,
          date_source: 'entered',
          effort: null,
        },
      ],
      edges: [{ from: 'RCP-14', to: 'RCP-24', type: 'blocks' }],
      cycles: [],
      at_risk: [
        { id: 'RCP-24', reason: 'planned start 2026-11-08 is before RCP-14 ends 2026-11-10' },
      ],
    },
  },
  deferred_reviews: {
    result: {
      items: [
        {
          item_id: 'RCP-11',
          title: 'Sign-in',
          hr_item_id: 'hr_x',
          text: 'Sign in from a second browser',
          note: 'No second device today',
          deferred_at: '2026-11-02T10:00:00.000Z',
          follow_up: { id: 'RCP-29', status: 'inbox' },
        },
      ],
      next_cursor: null,
    },
  },
  get_changes: {
    result: {
      events: [
        {
          cursor: 'c_41',
          at: '2026-11-06T10:42:00.000Z',
          actor: 'codex',
          item_id: 'RCP-12',
          type: 'packet.submitted',
          summary: 'codex submitted handoff packet round 2',
        },
      ],
      next_cursor: 'c_41',
    },
  },
  create_item: {
    result: {
      item: {
        ...RCP17_SUMMARY,
        id: 'RCP-30',
        title: 'Pantry inventory schema',
        status: 'planning',
        version: 1,
      },
    },
  },
  update_item: {
    result: { item: { ...RCP14_SUMMARY, version: 8 } },
    args: { id: 'RCP-14', expected_version: 7, title: 'x', labels: ['mobile'] },
  },
  set_status: {
    result: { item: { ...RCP14_SUMMARY, status: 'done', version: 9 } },
    args: { id: 'RCP-14' },
  },
  link_items: {
    result: {
      link_id: 'lnk_e',
      from: 'RCP-19',
      to: 'RCP-16',
      type: 'blocks',
      satisfied_when: 'merged',
      updated: true,
    },
  },
  unlink_items: { result: { removed: true }, args: { link_id: 'lnk_e' } },
  upsert_label: { result: { project: 'RCP', name: 'mobile', brief_md: 'Phone-first.' } },
  claim_lead: {
    result: {
      run_id: 'run_01JA…',
      item: { ...RCP14_SUMMARY, version: 8 },
      lease_expires_at: '2026-11-06T12:02:00.000Z',
    },
    args: { id: 'RCP-14' },
  },
  release_lead: {
    result: { item: { ...RCP14_SUMMARY, status: 'ready', lead: null, version: 9 } },
    args: { id: 'RCP-14' },
  },
  start_run: {
    result: { run_id: 'run_child' },
    args: { id: 'RCP-14', parent_run_id: 'run_01JA…' },
  },
  heartbeat: {
    result: {
      run_state: 'live',
      lease_expires_at: '2026-11-06T12:05:00.000Z',
      resources: [{ id: 'rsc_1', label: 'dev server :5173' }],
    },
    args: { run_id: 'run_01JA…' },
  },
  finish_run: {
    result: { run_state: 'finished', warnings: ['1 resource still declared: dev server :5173'] },
    args: { run_id: 'run_01JA…' },
  },
  park_run: {
    result: { run_state: 'parked', resume_ready: false },
    args: { run_id: 'run_A', reason: 'Waiting for RCP-12', waiting_on: { items: ['RCP-12'] } },
  },
  set_plan: { result: { plan_version: 4, work: RCP14.checklist.work }, args: { id: 'RCP-14' } },
  update_step: {
    result: { step: { ...RCP14.checklist.work[1]!, state: 'done' } },
    args: { id: 'RCP-14' },
  },
  log_subagent: {
    result: { logged: true },
    args: { id: 'RCP-14', step_id: 'wst_b', name: 'explorer', provenance: 'relayed' },
  },
  set_checks: { result: { checks: RCP14.checklist.checks }, args: { id: 'RCP-14' } },
  update_check: {
    result: { check: { ...RCP14.checklist.checks[1]!, state: 'pass' } },
    args: { id: 'RCP-14' },
  },
  declare_human_review: {
    result: { human_review: RCP14.checklist.human_review },
    args: { id: 'RCP-14' },
  },
  update_human_review: { result: { human_review: [] }, args: { id: 'RCP-14' } },
  add_note: {
    result: {
      event: {
        cursor: 'c_9',
        at: '2026-11-06T10:58:00.000Z',
        actor: 'claude',
        item_id: 'RCP-14',
        type: 'note.added',
        summary: 'note',
      },
    },
    args: { id: 'RCP-14' },
  },
  put_document: {
    result: {
      document_id: 'doc_b',
      version_no: 2,
      document_version_id: 'dv_b',
      sha256: 'cd34',
      size: 2048,
    },
    args: { name: 'pantry-prd.md' },
  },
  link_artifact: {
    result: {
      artifact: { kind: 'pr', label: 'PR #52', url: 'https://example.test/pr/52', state: 'merged' },
    },
    args: { id: 'RCP-19' },
  },
  report_commit: {
    result: {
      recorded: true,
      stale_packets: [{ item_id: 'RCP-19', packet_id: 'pkt_1', round: 1 }],
    },
    args: { id: 'RCP-19', sha: 'c71e002', pushed: true },
  },
  submit_packet: {
    result: {
      packet_id: 'pkt_2',
      round: 2,
      display_id: 'pkt-9c0e',
      item: { ...RCP14_SUMMARY, id: 'RCP-12', status: 'review', version: 12 },
    },
  },
  get_review: {
    args: { id: 'RCP-12' },
    result: {
      rounds: [
        {
          packet_id: 'pkt_1',
          round: 1,
          state: 'decided',
          stale: false,
          built_from_commit: '7d21aa3',
          submitted_at: '2026-11-05T09:00:00.000Z',
          decided_at: '2026-11-05T16:00:00.000Z',
          items: [
            {
              hr_item_id: 'hr_1',
              text: 'Drag recipes between days on your phone.',
              decision: {
                kind: 'changes',
                note: 'Drop targets are too small on my phone',
                into: 'checklist',
                follow: null,
                result_ref: 'wst_e',
              },
            },
            { hr_item_id: 'hr_2', text: 'Move a recipe using only the keyboard.', decision: null },
          ],
        },
      ],
    },
  },
  ask_owner: { result: { question_id: 'q_2' }, args: { id: 'DOC-4' } },
  publish_decision: {
    result: { decision: { ...DEC_1, id: 'dec_9', authority: 'agent', author: 'claude' } },
  },
  list_decisions: { result: { items: [DEC_1], next_cursor: null } },
  withdraw_decision: {
    result: { decision: { ...DEC_1, id: 'dec_9', authority: 'agent', status: 'withdrawn' } },
  },
  recovery_report: { result: RECOVERY_REPORT, args: { include_briefs: true } },
};

describe('every tool has a renderer', () => {
  it.each(TOOLS.map((t) => t.name))('%s', (name) => {
    const sample = SAMPLES[name];
    // Each sample matches the tool's output schema, so the fixtures stay honest.
    const tool = TOOLS.find((t) => t.name === name)!;
    expect(() => tool.output.parse(sample.result)).not.toThrow();
    const text = renderResult(name, sample.result, { args: sample.args, ...opts });
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toMatch(/^\s*[{[]/); // not a JSON dump
    expect(text).not.toContain('undefined');
    expect(text).not.toMatch(/(^|\s)\?(\s|$)/); // no unfilled summary placeholders
    expect(text).toMatchSnapshot();
  });

  it('mutation results stay within the 60-token budget (characters ÷ 4)', () => {
    for (const tool of TOOLS.filter((t) => t.kind === 'mutating')) {
      const sample = SAMPLES[tool.name];
      const text = renderResult(tool.name, sample.result, { args: sample.args, ...opts });
      expect(Math.ceil(text.length / 4), `${tool.name}: ${text}`).toBeLessThanOrEqual(60);
    }
  });
});

describe('recovery (MCP_SPEC §3 "Workspaces, briefs and resources", §5.4, §5.9)', () => {
  const report = () =>
    renderResult('recovery_report', RECOVERY_REPORT, { args: { include_briefs: true }, ...opts });

  it('renders an interrupted entry exactly like the MCP_SPEC §5.9 example', () => {
    const expected = specInline('An interrupted entry reads like');
    expect(report().split('\n')).toContain(`  ${expected}`);
  });

  it('renders one block per non-empty section, in §5.9 order', () => {
    const lines = report().split('\n');
    expect(lines.filter((l) => /^[a-z_]+:$/.test(l))).toEqual([
      'interrupted:',
      'parked:',
      'workspaces:',
      'orphaned_resources:',
    ]);
    expect(lines[0]).toBe(
      'Recovery: 2 interrupted · 0 stale · 1 parked · 2 workspaces · 1 orphaned resources',
    );
  });

  it('shows what a coordinator needs to restart an at-risk run: unpushed, dirty, resources, brief', () => {
    const text = report();
    expect(text).toContain(
      '  RCP-21 Unit conversion table · interrupted (lease_expired) · 1/3 done · ws C:/work/rcp-21 on rcp-21-units @ 77aa001, pushed 6f00e12 · dirty · brief dv_brief21',
    );
    expect(text).toContain('    run run_21 claude·orca-w4 · orchestrator orca ctx_91ab task_7');
    expect(text).toContain(
      '    resources: rsc_1 dev server :5173 · dev_server · port 5173 · pid 4242 · running',
    );
    expect(text).toContain('    external: {"orca":{"worktree_id":"wt_21"}}');
    expect(text).toContain('    question: q_7 Round 1/3 cup to 80 ml or 79 ml?');
    expect(text).toContain(
      '    brief: Implement the unit conversion table.\n      Resume from the checklist; claim_lead first.',
    );
  });

  it('lists parked runs with what they wait on, workspaces with their state, and orphaned resources', () => {
    const text = report();
    expect(text).toContain(
      '  RCP-23 Meal plan templates · waiting on RCP-12 · resume_ready true · since 10:40Z · ws C:/work/rcp-23 on rcp-23-templates @ c1d2e3f (pushed) · clean',
    );
    expect(text).toContain(
      '  at_risk · ws C:/work/rcp-21 on rcp-21-units @ 77aa001, pushed 6f00e12 · dirty · RCP-21 · run run_21 · 1 unreleased resource',
    );
    expect(text).toContain(
      '  safe_to_prune · ws C:/work/rcp-30 on rcp-30-share @ aa11bb2 (pushed) · clean · RCP-30 · run run_30',
    );
    expect(text).toContain(
      '  rsc_1 dev server :5173 · dev_server · port 5173 · pid 4242 · running · RCP-21 · run run_21 ended 03:12Z',
    );
  });

  it('omits the brief text unless it was included', () => {
    const without = { ...RECOVERY_REPORT.interrupted[1]! };
    delete without.brief;
    const text = renderResult(
      'recovery_report',
      { ...RECOVERY_REPORT, interrupted: [without] },
      opts,
    );
    expect(text).not.toContain('brief: Implement');
    expect(text).toContain('brief dv_brief21');
  });

  it('a parked lead run shows parked instead of a lease, with the workspace and the brief', () => {
    const item = {
      ...RCP14,
      lead: { client: 'claude', label: 'orca-w2', run_id: 'run_A', run_state: 'parked' as const },
      runs: [RUN_PARKED],
    };
    const lines = renderItem(item, { view: 'standard', ...opts }).split('\n');
    const at = lines.indexOf('  lead claude·orca-w2 parked · run run_A');
    expect(at).toBeGreaterThan(0);
    expect(lines.slice(at + 1, at + 4)).toEqual([
      '    parked · waiting on RCP-12 · since 10:40Z · ready to resume · reason: Waiting for RCP-12 (planner) to merge before wiring templates in',
      '    ws C:/work/rcp-23 on rcp-23-templates @ c1d2e3f (pushed) · clean · parked',
      '    orchestrator orca ctx_6f2d · brief dv_brief23',
    ]);
  });

  it('an ended run in view full shows its end reason, workspace and resources', () => {
    const text = renderItem(
      { ...RCP14, runs: [...RCP14.runs, RUN_AT_RISK] },
      { view: 'full', ...opts },
    );
    expect(text).toContain(
      [
        '  - run_21 claude·orca-w4 interrupted · lead',
        '      ended: lease_expired',
        '      ws C:/work/rcp-21 on rcp-21-units @ 77aa001, pushed 6f00e12 · dirty · at_risk',
        '      orchestrator orca ctx_91ab task_7 · brief dv_brief21',
        '      resources:',
        '      - rsc_1 dev server :5173 · dev_server · port 5173 · pid 4242 · running',
        '      external: {"orca":{"worktree_id":"wt_21"}}',
      ].join('\n'),
    );
  });

  it('Item.resume says where to pick the work up', () => {
    const text = renderItem(
      {
        ...RCP14,
        resume: {
          workspace: RUN_AT_RISK.workspace,
          last_pushed_sha: '6f00e12',
          brief_document_version_id: 'dv_brief21',
          last_end_reason: 'lease_expired',
          unreleased_resources: 1,
        },
      },
      opts,
    );
    expect(text).toContain(
      '  resume: ws C:/work/rcp-21 on rcp-21-units @ 77aa001, pushed 6f00e12 · dirty · at_risk · last pushed 6f00e12 · last run lease_expired · brief dv_brief21 · 1 unreleased resource',
    );
  });

  it('park_run, heartbeat resources and report_commit pushed are one line each', () => {
    expect(
      renderResult(
        'park_run',
        { run_state: 'parked', resume_ready: true },
        {
          args: {
            run_id: 'run_A',
            waiting_on: { orchestrator: true, until: '2026-11-06T12:00:00Z' },
          },
          ...opts,
        },
      ),
    ).toBe('Parked run run_A · waiting on the coordinator, until 12:00Z · ready to resume');
    expect(
      renderResult(
        'park_run',
        { run_state: 'parked', resume_ready: false },
        { args: { run_id: 'run_A' }, ...opts },
      ),
    ).toBe('Parked run run_A · resume_ready false');
    expect(
      renderResult(
        'report_commit',
        { recorded: true, stale_packets: [] },
        { args: { id: 'RCP-23', sha: 'c1d2e3f0', pushed: true }, ...opts },
      ),
    ).toBe('Recorded c1d2e3f on RCP-23 · pushed');
    expect(
      renderResult(
        'heartbeat',
        { run_state: 'live', lease_expires_at: null, resources: [] },
        { args: { run_id: 'run_A' }, ...opts },
      ),
    ).toBe('Run run_A live · lease until none');
  });

  it('finish_run warnings render as ! lines', () => {
    expect(
      renderResult(
        'finish_run',
        {
          run_state: 'finished',
          warnings: ['1 resource still declared: dev server :5173', '2 commits not pushed'],
        },
        { args: { run_id: 'run_A' }, ...opts },
      ),
    ).toBe(
      'Run run_A finished\n! 1 resource still declared: dev server :5173\n! 2 commits not pushed',
    );
  });
});

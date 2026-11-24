/**
 * Fixture objects for the compact renderers, built from the seed shapes in
 * design/sample-data.json and the IDs of the MCP_SPEC §3.1 example (`wst_a`,
 * `chk_a`, `hr_a`, `dec_1`, `run_01JA…`). Plain objects, no database.
 */
import type { RecoveryReport } from '../src/mcp/recovery.js';
import type {
  ContextBundle,
  DecisionRecord,
  HumanReviewItem,
  Item,
  ItemSummary,
  Resource,
  Run,
  WorkStep,
} from '../src/mcp/types.js';

/** "Today" for the fixtures: times on this UTC date render as HH:MMZ. */
export const NOW = new Date('2026-11-06T11:00:00.000Z');

/** A run's recovery fields when nothing was reported (MCP_SPEC §4 Run). */
export const NO_RECOVERY: Pick<
  Run,
  'end_reason' | 'parked' | 'workspace' | 'orchestrator' | 'brief_document_version_id' | 'resources'
> = {
  end_reason: null,
  parked: null,
  workspace: null,
  orchestrator: null,
  brief_document_version_id: null,
  resources: [],
};

export const step = (
  over: Partial<WorkStep> & Pick<WorkStep, 'id' | 'text' | 'state'>,
): WorkStep => ({
  was_text: null,
  change_reason: null,
  added_by: 'agent',
  from_review: null,
  subagents: [],
  state_by: null,
  state_at: null,
  source: null,
  has_details: false,
  ...over,
});

export const RCP14_SUMMARY: ItemSummary = {
  id: 'RCP-14',
  project: 'RCP',
  type: 'Implementation',
  title: 'Generate shopping list from week plan',
  status: 'progress',
  priority: 1,
  epic: 'RCP-1',
  epic_title: 'Meal planning MVP',
  labels: ['mobile'],
  blocked: false,
  blocked_by: [],
  unblocks: 2,
  lead: { client: 'claude', label: 'orca-w3', run_id: 'run_01JA…', run_state: 'live' },
  human_review: { declared: 1, ready: 0, approved: 0, deferred: 0 },
  planned_start: null,
  planned_end: null,
  effort: null,
  archived: false,
  jira_key: null,
  version: 7,
  updated_at: '2026-11-06T10:52:00.000Z',
};

const HR_A: HumanReviewItem = {
  id: 'hr_a',
  text: "Export one week's list and check it reads well in your notes app.",
  state: 'declared',
  added_by: 'agent',
  added_by_client: 'claude',
  locked: false,
  version: 1,
  last_decision: null,
  follow_up_item_id: null,
};

/** `get_item RCP-14`, standard view, as the server will return it from the seed. */
export const RCP14: Item = {
  ...RCP14_SUMMARY,
  description_md: '',
  outcome_md:
    'When a week plan is saved, the user can produce one merged shopping list grouped by aisle and export it.',
  acceptance: [
    'Quantities for the same ingredient merge across recipes, with unit conversion',
    'List is grouped by aisle and sorted',
    'Export as a Markdown checklist',
  ],
  links: {
    blocks: [
      {
        link_id: 'lnk_a',
        id: 'RCP-24',
        title: 'Share the shopping list',
        status: 'planning',
        project: 'RCP',
        satisfied_when: 'done',
        cleared: false,
        waiting_for: 'done',
      },
      {
        link_id: 'lnk_b',
        id: 'RCP-27',
        title: 'Pantry-aware shopping list',
        status: 'planning',
        project: 'RCP',
        satisfied_when: 'done',
        cleared: false,
        waiting_for: 'done',
      },
    ],
    blocked_by: [],
    relates: [],
  },
  checklist: {
    plan_version: 3,
    work: [
      step({
        id: 'wst_a',
        text: 'Define aggregation rules',
        state: 'done',
        state_by: 'claude',
        state_at: '2026-11-06T09:10:00.000Z',
      }),
      step({
        id: 'wst_b',
        text: 'Implement unit merging (g/kg, ml/l, cups)',
        state: 'current',
        state_by: 'claude',
        state_at: '2026-11-06T10:52:00.000Z',
        subagents: [
          {
            name: 'units-worker',
            outcome: 'Added conversion table and 31 tests',
            evidence: null,
            provenance: 'observed',
            child_run_id: 'run_r77',
            at: '2026-11-06T10:40:00.000Z',
          },
          {
            name: 'explorer',
            outcome: 'Mapped 214 ingredient units in sample recipes',
            evidence: null,
            provenance: 'relayed',
            child_run_id: null,
            at: '2026-11-06T10:12:00.000Z',
          },
        ],
      }),
      step({
        id: 'wst_c',
        text: 'Export as a Markdown checklist',
        state: 'todo',
        was_text: 'Export to Reminders app',
        change_reason: 'Reminders API not reachable from the container',
      }),
      step({ id: 'wst_d', text: 'Group by aisle and sort', state: 'todo' }),
    ],
    checks: [
      {
        id: 'chk_a',
        text: '31 unit-conversion tests pass',
        state: 'pass',
        evidence: 'child run r-77 test output',
        provenance: 'observed',
        added_by: 'agent',
      },
      {
        id: 'chk_b',
        text: 'Aisle grouping snapshot tests',
        state: 'todo',
        evidence: null,
        provenance: 'agent',
        added_by: 'agent',
      },
      {
        id: 'chk_c',
        text: 'Export opens cleanly in a Markdown viewer',
        state: 'todo',
        evidence: null,
        provenance: 'agent',
        added_by: 'agent',
      },
    ],
    human_review: [HR_A],
    reviewed_with_epic: null,
  },
  runs: [
    {
      run_id: 'run_01JA…',
      parent_run_id: null,
      client: 'claude',
      label: 'orca-w3',
      is_lead: true,
      run_state: 'live',
      started_at: '2026-11-06T09:02:00.000Z',
      last_signal_at: '2026-11-06T10:59:20.000Z',
      lease_expires_at: '2026-11-06T12:02:00.000Z',
      current_step_id: 'wst_b',
      summary: null,
      error: null,
      ...NO_RECOVERY,
    },
    {
      run_id: 'run_r77',
      parent_run_id: 'run_01JA…',
      client: 'codex',
      label: 'units-worker',
      is_lead: false,
      run_state: 'finished',
      started_at: '2026-11-06T10:01:00.000Z',
      last_signal_at: '2026-11-06T10:40:00.000Z',
      lease_expires_at: null,
      current_step_id: null,
      summary: 'Conversion table + 31 tests',
      error: null,
      ...NO_RECOVERY,
      end_reason: 'finished',
    },
  ],
  decisions: [
    { id: 'dec_1', title: 'Units are metric internally; convert on display', authority: 'owner' },
  ],
  open_question: null,
  resume: null,
  unread_owner_notes: [],
  documents: [
    {
      document_id: 'doc_a',
      name: 'aggregation-rules.md',
      kind: 'planning',
      latest: {
        document_version_id: 'dv_a',
        version_no: 1,
        mime: 'text/markdown',
        size: 1834,
        sha256: 'ab12',
        created_at: '2026-11-06T09:10:00.000Z',
        created_by: 'claude',
      },
    },
  ],
  packets: [],
  commits: [],
  artifacts: [],
  dates_set_by: null,
  closed_by: null,
  recent_events: [],
};

/** The `search_items` example row in MCP_SPEC §3.1. */
export const RCP17_SUMMARY: ItemSummary = {
  id: 'RCP-17',
  project: 'RCP',
  type: 'Bug',
  title: 'Planner jumps back to the current week after reload',
  status: 'ready',
  priority: 1,
  epic: 'RCP-1',
  epic_title: 'Meal planning MVP',
  labels: [],
  blocked: false,
  blocked_by: [],
  unblocks: 2,
  lead: null,
  human_review: { declared: 0, ready: 0, approved: 0, deferred: 0 },
  planned_start: null,
  planned_end: null,
  effort: null,
  archived: false,
  jira_key: null,
  version: 4,
  updated_at: '2026-11-05T15:20:00.000Z',
};

export const DEC_1: DecisionRecord = {
  id: 'dec_1',
  project: 'RCP',
  scope: { kind: 'epic', id: 'RCP-1' },
  title: 'Units are metric internally; convert on display',
  decision_md: 'Store g and ml. Convert cups and spoons on import and display.',
  rationale_md: 'One canonical unit keeps merging simple.',
  authority: 'owner',
  author: 'owner',
  status: 'active',
  supersedes_id: null,
  superseded_by_id: null,
  created_at: '2026-11-01T09:00:00.000Z',
  confirmed_at: null,
  version: 1,
};

export const RCP14_CONTEXT: ContextBundle = {
  item: {
    id: 'RCP-14',
    title: RCP14.title,
    type: 'Implementation',
    status: 'progress',
    priority: 1,
    outcome_md: RCP14.outcome_md,
    acceptance: RCP14.acceptance,
    open_question: null,
    version: 7,
    unread_owner_notes: 1,
  },
  decisions: [DEC_1],
  epic: {
    id: 'RCP-1',
    title: 'Meal planning MVP',
    outcome_md: 'A household can plan a week of meals and get one shopping list from it.',
  },
  labels: [{ name: 'mobile', brief_md: 'Phone-first: touch targets of at least 44 px.' }],
  blockers: [],
  dependents: [
    { id: 'RCP-24', title: 'Share the shopping list', status: 'planning' },
    { id: 'RCP-27', title: 'Pantry-aware shopping list', status: 'planning' },
  ],
  workflow: {
    project: 'RCP',
    version_no: 2,
    content_md: '- Branch per item: rcp-<n>.\n- Run pnpm test before every report_commit.',
    truncated: false,
  },
  planning_docs: [
    {
      name: 'meal-planning-brief.md',
      version_no: 3,
      content_md: '# Brief\nPlan a week, get one list.',
      truncated: false,
    },
    { name: 'aggregation-rules.md', version_no: 1, content_md: null, truncated: true },
  ],
  last_review: null,
  budget: 'medium',
  truncated_sections: [],
};

// ---- Recovery (MCP_SPEC §3 "Workspaces, briefs and resources", §5.9, §7.12–7.13) ----

export const DEV_SERVER: Resource = {
  id: 'rsc_1',
  kind: 'dev_server',
  label: 'dev server :5173',
  locator: { port: 5173, pid: 4242 },
  started_at: '2026-11-06T02:40:00.000Z',
  released_at: null,
  release_note: null,
};

const runBase = {
  parent_run_id: null,
  is_lead: true,
  lease_expires_at: null,
  current_step_id: null,
  summary: null,
  error: null,
  ...NO_RECOVERY,
} as const;

/** §7.12: parked on RCP-12, which is now done. */
export const RUN_PARKED: Run = {
  ...runBase,
  run_id: 'run_A',
  client: 'claude',
  label: 'orca-w2',
  run_state: 'parked',
  started_at: '2026-11-06T08:00:00.000Z',
  last_signal_at: '2026-11-06T10:40:00.000Z',
  lease_expires_at: '2026-11-06T11:40:00.000Z',
  parked: {
    reason: 'Waiting for RCP-12 (planner) to merge before wiring templates in',
    waiting_on: { items: ['RCP-12'] },
    since: '2026-11-06T10:40:00.000Z',
    resume_ready: true,
  },
  workspace: {
    host: 'devbox',
    repo: 'github.com/owner/recipes',
    path: 'C:/work/rcp-23',
    branch: 'rcp-23-templates',
    base_ref: 'origin/main',
    base_sha: '9a10624',
    head_sha: 'c1d2e3f',
    pushed_sha: 'c1d2e3f',
    dirty: false,
    state: 'parked',
    updated_at: '2026-11-06T10:39:00.000Z',
  },
  orchestrator: { name: 'orca', dispatch_id: 'ctx_6f2d', task_id: null, run_id: null },
  brief_document_version_id: 'dv_brief23',
};

/** §7.13: interrupted by a restart, everything pushed (the §5.9 text example). */
export const RUN_RESTARTED: Run = {
  ...runBase,
  run_id: 'run_15',
  client: 'codex',
  label: 'orca-w1',
  run_state: 'interrupted',
  started_at: '2026-11-06T01:00:00.000Z',
  last_signal_at: '2026-11-06T03:00:00.000Z',
  end_reason: 'service_restart',
  workspace: {
    host: null,
    repo: null,
    path: 'C:/…/rcp-15',
    branch: null,
    base_ref: null,
    base_sha: null,
    head_sha: '4be1c09',
    pushed_sha: '4be1c09',
    dirty: null,
    state: 'safe_to_prune',
    updated_at: '2026-11-06T02:58:00.000Z',
  },
  brief_document_version_id: 'dv_…',
};

/** §7.13: lease expired with an unpushed commit, uncommitted changes and a dev server. */
export const RUN_AT_RISK: Run = {
  ...runBase,
  run_id: 'run_21',
  client: 'claude',
  label: 'orca-w4',
  run_state: 'interrupted',
  started_at: '2026-11-06T01:30:00.000Z',
  last_signal_at: '2026-11-06T02:10:00.000Z',
  end_reason: 'lease_expired',
  workspace: {
    host: 'devbox',
    repo: null,
    path: 'C:/work/rcp-21',
    branch: 'rcp-21-units',
    base_ref: 'origin/main',
    base_sha: '9a10624',
    head_sha: '77aa001',
    pushed_sha: '6f00e12',
    dirty: true,
    state: 'at_risk',
    updated_at: '2026-11-06T02:10:00.000Z',
  },
  orchestrator: { name: 'orca', dispatch_id: 'ctx_91ab', task_id: 'task_7', run_id: null },
  brief_document_version_id: 'dv_brief21',
  resources: [DEV_SERVER],
  external: { orca: { worktree_id: 'wt_21' } },
};

const summaryOf = (id: string, title: string, over: Partial<ItemSummary> = {}): ItemSummary => ({
  ...RCP14_SUMMARY,
  id,
  title,
  status: 'progress',
  lead: null,
  epic: null,
  epic_title: null,
  labels: [],
  ...over,
});

export const RECOVERY_REPORT: RecoveryReport = {
  interrupted: [
    {
      item: summaryOf('RCP-15', 'Pantry inventory schema'),
      run: RUN_RESTARTED,
      end_reason: 'service_restart',
      checklist: { done: 2, total: 4 },
      open_question: null,
    },
    {
      item: summaryOf('RCP-21', 'Unit conversion table'),
      run: RUN_AT_RISK,
      end_reason: 'lease_expired',
      checklist: { done: 1, total: 3 },
      open_question: {
        id: 'q_7',
        text: 'Round 1/3 cup to 80 ml or 79 ml?',
        asked_at: '2026-11-06T02:00:00.000Z',
        answer: null,
        answered_at: null,
      },
      brief: 'Implement the unit conversion table.\nResume from the checklist; claim_lead first.',
    },
  ],
  stale: [],
  parked: [
    {
      item: summaryOf('RCP-23', 'Meal plan templates', {
        lead: { client: 'claude', label: 'orca-w2', run_id: 'run_A', run_state: 'parked' },
      }),
      run: RUN_PARKED,
      resume_ready: true,
    },
  ],
  workspaces: [
    {
      path: 'C:/work/rcp-21',
      branch: 'rcp-21-units',
      item_id: 'RCP-21',
      run_id: 'run_21',
      state: 'at_risk',
      head_sha: '77aa001',
      pushed_sha: '6f00e12',
      dirty: true,
      unreleased_resources: 1,
    },
    {
      path: 'C:/work/rcp-30',
      branch: 'rcp-30-share',
      item_id: 'RCP-30',
      run_id: 'run_30',
      state: 'safe_to_prune',
      head_sha: 'aa11bb2',
      pushed_sha: 'aa11bb2',
      dirty: false,
      unreleased_resources: 0,
    },
  ],
  orphaned_resources: [
    {
      resource: DEV_SERVER,
      item_id: 'RCP-21',
      run_id: 'run_21',
      run_ended_at: '2026-11-06T03:12:00.000Z',
    },
  ],
  next_cursor: null,
};

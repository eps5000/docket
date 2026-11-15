/**
 * Fixture objects for the compact renderers, built from the seed shapes in
 * design/sample-data.json and the IDs of the MCP_SPEC §3.1 example (`wst_a`,
 * `chk_a`, `hr_a`, `dec_1`, `run_01JA…`). Plain objects, no database.
 */
import type {
  ContextBundle,
  DecisionRecord,
  HumanReviewItem,
  Item,
  ItemSummary,
  WorkStep,
} from '../src/mcp/types.js';

/** "Today" for the fixtures: times on this UTC date render as HH:MMZ. */
export const NOW = new Date('2026-11-06T11:00:00.000Z');

const step = (over: Partial<WorkStep> & Pick<WorkStep, 'id' | 'text' | 'state'>): WorkStep => ({
  was_text: null,
  change_reason: null,
  added_by: 'agent',
  from_review: null,
  subagents: [],
  state_by: null,
  state_at: null,
  ...over,
});

export const RCP14_SUMMARY: ItemSummary = {
  id: 'RCP-14',
  project: 'RCP',
  type: 'Story',
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
    },
  ],
  decisions: [
    { id: 'dec_1', title: 'Units are metric internally; convert on display', authority: 'owner' },
  ],
  open_question: null,
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
    type: 'Story',
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

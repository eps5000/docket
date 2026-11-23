/**
 * MCP shared types (MCP_SPEC §4) as zod schemas: the source of truth for the
 * output schemas of every tool. Field names, optionality and enums follow
 * §4 exactly. Shared contract file (tasks.md, Slice rules).
 */
import { z } from 'zod';
import { contextSharedSchema } from './shared-changes.js';
import {
  ADDED_BY,
  CHECK_STATES,
  CLOSED_BY,
  DECISION_AUTHORITIES,
  DECISION_SCOPE_KINDS,
  DECISION_STATUSES,
  DOC_KINDS,
  END_REASONS,
  EVENT_TYPES,
  HUMAN_REVIEW_STATES,
  ITEM_TYPES,
  PACKET_STATES,
  PROVENANCES,
  RESOURCE_KINDS,
  RESOLUTION_KINDS,
  RESOLUTION_STATES,
  REVIEW_KINDS,
  RUN_STATES,
  SATISFIED_WHEN,
  STATUSES,
  SUBAGENT_PROVENANCES,
  WORK_STEP_STATES,
  WORKSPACE_STATES,
} from '../enums.js';

// ---- Scalars ----

export const statusSchema = z.enum(STATUSES);
export const itemTypeSchema = z.enum(ITEM_TYPES);
export const prioritySchema = z.literal([1, 2, 3]);
export const runStateSchema = z.enum(RUN_STATES);
export const provenanceSchema = z.enum(PROVENANCES);
export const eventTypeSchema = z.enum(EVENT_TYPES);
export const docKindSchema = z.enum(DOC_KINDS);
export const satisfiedWhenSchema = z.enum(SATISFIED_WHEN);
export const workStepStateSchema = z.enum(WORK_STEP_STATES);
export const checkStateSchema = z.enum(CHECK_STATES);
export const humanReviewStateSchema = z.enum(HUMAN_REVIEW_STATES);
export const reviewKindSchema = z.enum(REVIEW_KINDS);
export const addedBySchema = z.enum(ADDED_BY);
export const endReasonSchema = z.enum(END_REASONS);
export const workspaceStateSchema = z.enum(WORKSPACE_STATES);
export const resourceKindSchema = z.enum(RESOURCE_KINDS);

// ---- ItemSummary and Item ----

export const leadSchema = z.object({
  client: z.string(),
  label: z.string().nullable(),
  run_id: z.string(),
  run_state: runStateSchema,
});

export const humanReviewCountsSchema = z.object({
  declared: z.number().int(),
  ready: z.number().int(),
  approved: z.number().int(),
  deferred: z.number().int(),
});

export const itemSummarySchema = z.object({
  id: z.string(),
  project: z.string(),
  type: itemTypeSchema,
  title: z.string(),
  status: statusSchema,
  priority: prioritySchema,
  epic: z.string().nullable(),
  /** The epic's title (B3 resolution 9). */
  epic_title: z.string().nullable(),
  labels: z.array(z.string()),
  blocked: z.boolean(),
  /** Unresolved blockers only. */
  blocked_by: z.array(z.string()),
  /** How many items finishing this one would unblock (B3 resolution 9). */
  unblocks: z.number().int(),
  lead: leadSchema.nullable(),
  human_review: humanReviewCountsSchema,
  planned_start: z.string().nullable(),
  planned_end: z.string().nullable(),
  effort: z.number().nullable(),
  archived: z.boolean(),
  jira_key: z.string().nullable(),
  version: z.number().int(),
  updated_at: z.string(),
});
export type ItemSummary = z.infer<typeof itemSummarySchema>;

export const linkRefSchema = z.object({
  link_id: z.string(),
  id: z.string(),
  title: z.string(),
  status: statusSchema,
  project: z.string(),
  /** Blocks links only: the effective rule. */
  satisfied_when: satisfiedWhenSchema.optional(),
  /** Blocks links only: true when this blocker no longer blocks. */
  cleared: z.boolean().optional(),
  waiting_for: z.enum(['done', 'merge', 'verification']).nullable().optional(),
});
export type LinkRef = z.infer<typeof linkRefSchema>;

export const subagentEntrySchema = z.object({
  name: z.string(),
  outcome: z.string(),
  evidence: z.string().nullable(),
  provenance: z.enum(SUBAGENT_PROVENANCES),
  child_run_id: z.string().nullable(),
  at: z.string(),
});

export const workStepSchema = z.object({
  id: z.string(),
  text: z.string(),
  state: workStepStateSchema,
  was_text: z.string().nullable(),
  change_reason: z.string().nullable(),
  added_by: addedBySchema,
  from_review: z.object({ round: z.number().int(), hr_item_id: z.string() }).nullable(),
  subagents: z.array(subagentEntrySchema),
  state_by: z.string().nullable(),
  state_at: z.string().nullable(),
  /** Where the step came from, for example a Jira key (decision 33). */
  source: z.string().nullable(),
  /** True when the step carries details; ordinary reads show a `· details` marker. */
  has_details: z.boolean(),
  /** Only in get_step, get_item view 'full', and get_context's current step (MCP_SPEC §4). */
  details_md: z.string().nullable().optional(),
  /** Counts edits to the details; 0 before the first. The owner's edits check it. */
  details_version: z.number().int().optional(),
});
export type WorkStep = z.infer<typeof workStepSchema>;

/** One entry of a step's history (get_step; MCP_SPEC §5.12, B33 resolutions). */
export const stepHistoryEntrySchema = z.object({
  at: z.string(),
  by: z.string(),
  change: z.enum(['added', 'text', 'state', 'details', 'source']),
  from: z.string().nullable().optional(),
  to: z.string().nullable().optional(),
  /** The reason for a wording change, or the note on a state change. */
  note: z.string().nullable().optional(),
});
export type StepHistoryEntry = z.infer<typeof stepHistoryEntrySchema>;

export const checkSchema = z.object({
  id: z.string(),
  text: z.string(),
  state: checkStateSchema,
  evidence: z.string().nullable(),
  provenance: provenanceSchema,
  added_by: addedBySchema,
});
export type Check = z.infer<typeof checkSchema>;

export const humanReviewItemSchema = z.object({
  id: z.string(),
  text: z.string(),
  state: humanReviewStateSchema,
  added_by: addedBySchema,
  /** The agent client that declared it; null when the owner added it (B3 resolution 9). */
  added_by_client: z.string().nullable(),
  locked: z.boolean(),
  version: z.number().int(),
  last_decision: z
    .object({
      kind: reviewKindSchema,
      note: z.string().nullable(),
      round: z.number().int(),
      at: z.string(),
      result_ref: z.string().nullable(),
    })
    .nullable(),
  follow_up_item_id: z.string().nullable(),
});
export type HumanReviewItem = z.infer<typeof humanReviewItemSchema>;

// ---- Recovery: workspaces, resources, parking (MCP_SPEC §3 "Workspaces, briefs and resources") ----

/** Where a run's work lives, as reported by the agent. `state` is derived per worktree path. */
export const workspaceSchema = z.object({
  host: z.string().nullable(),
  repo: z.string().nullable(),
  path: z.string().nullable(),
  branch: z.string().nullable(),
  base_ref: z.string().nullable(),
  base_sha: z.string().nullable(),
  head_sha: z.string().nullable(),
  pushed_sha: z.string().nullable(),
  /** Uncommitted changes, as the agent reports them; null when never reported. */
  dirty: z.boolean().nullable(),
  state: workspaceStateSchema,
  updated_at: z.string(),
});
export type Workspace = z.infer<typeof workspaceSchema>;

/** What a parked run waits on (`park_run`). */
export const waitingOnSchema = z.object({
  items: z.array(z.string()).optional(),
  orchestrator: z.boolean().optional(),
  person: z.boolean().optional(),
  until: z.string().optional(),
});
export type WaitingOn = z.infer<typeof waitingOnSchema>;

/** Enough to find a resource again. */
export const resourceLocatorSchema = z.object({
  pid: z.number().int().optional(),
  port: z.number().int().optional(),
  session_id: z.string().optional(),
  container: z.string().optional(),
  path: z.string().optional(),
  host: z.string().optional(),
});
export type ResourceLocator = z.infer<typeof resourceLocatorSchema>;

/** A long-lived thing a run started (`rsc_…`), declared and released through `heartbeat`. */
export const resourceSchema = z.object({
  id: z.string(),
  kind: resourceKindSchema,
  label: z.string(),
  locator: resourceLocatorSchema,
  started_at: z.string(),
  released_at: z.string().nullable(),
  release_note: z.string().nullable(),
});
export type Resource = z.infer<typeof resourceSchema>;

/** The orchestrator's own IDs for a run (for example Orca's), so a coordinator can match its records. */
export const orchestratorRefSchema = z.object({
  name: z.string(),
  dispatch_id: z.string().nullable(),
  task_id: z.string().nullable(),
  run_id: z.string().nullable(),
});
export type OrchestratorRef = z.infer<typeof orchestratorRefSchema>;

/** A namespaced map (≤ 2 KB of JSON), stored as it is and never interpreted. */
export const externalSchema = z.record(z.string(), z.unknown());

export const runParkedSchema = z.object({
  reason: z.string(),
  waiting_on: waitingOnSchema,
  since: z.string(),
  resume_ready: z.boolean(),
});

/** Decision 42: who last set this run's status for it (`update_run_status`). */
export const runStatusUpdateSchema = z.object({
  by: z.string(),
  client: z.string().nullable(),
  at: z.string(),
});
export type RunStatusUpdate = z.infer<typeof runStatusUpdateSchema>;

/**
 * Decision 44: a time-limited park set by a coordinator. `ended_at` is set once
 * the time ran out and the run went back to a short lease, until the run speaks.
 */
export const coordinatorParkSchema = z.object({
  by: z.string(),
  at: z.string(),
  until: z.string(),
  ended_at: z.string().optional(),
});
export type CoordinatorPark = z.infer<typeof coordinatorParkSchema>;

/**
 * Decision 42: real activity newer than the run's last word. `since_parked`:
 * while it is parked. `since_signal`: commits on its branch while it is silent,
 * so its session may be working without Docket. Stays until the run or a
 * coordinator speaks; the state itself doesn't change.
 */
export const runActivitySchema = z.object({
  kind: z.enum(['since_parked', 'since_signal']),
  since: z.string(),
  detected_at: z.string(),
  commits: z.number().int(),
  last_commit: z.string().nullable(),
  branch: z.string().nullable(),
  events: z.number().int(),
  /** `waiting_on.items` that cleared since. */
  cleared_items: z.array(z.string()),
});
export type RunActivity = z.infer<typeof runActivitySchema>;

/** Decision 45: the two advisory flags on a parked run's wait. */
export const WAIT_FLAG_KINDS = ['wait_no_next_step', 'wait_owner_unasked'] as const;
export type WaitFlagKind = (typeof WAIT_FLAG_KINDS)[number];

export const waitFlagSchema = z.object({
  kind: z.enum(WAIT_FLAG_KINDS),
  /** The item the flag is about: the blocker, or the run's own item. */
  on: z.string(),
  /** When it was raised. */
  since: z.string(),
  /** What moves it: "shape GF-381 or assign it". */
  step: z.string(),
});
export type WaitFlag = z.infer<typeof waitFlagSchema>;

/**
 * Decision 45: what a parked lead waits for, who can move it and how it
 * resumes, derived from what Docket stores. Advisory: it gates nothing.
 */
export const waitCardSchema = z.object({
  run_id: z.string(),
  item_id: z.string(),
  label: z.string().nullable(),
  client: z.string(),
  orchestrator: orchestratorRefSchema.nullable(),
  /** Named blockers, uncleared first, at most `WAIT_FLAGS.card_blockers`. */
  blockers: z.array(
    z.object({
      id: z.string(),
      status: statusSchema,
      clears_when: z.enum(['done', 'merged', 'verified']),
      cleared: z.boolean(),
      /** When this run first parked on it: a re-park doesn't move it. */
      waited_since: z.string(),
      /** Its live lead's name, if it has one. */
      lead: z.string().nullable(),
      /** The item further down the chain that can actually move, when it isn't this one. */
      moves: z.string().nullable(),
    }),
  ),
  /** How many named blockers aren't listed. */
  more_blockers: z.number().int(),
  person: z.boolean(),
  coordinator: z.boolean(),
  until: z.string().nullable(),
  /** The earliest first-park among what it still waits for. */
  waited_since: z.string(),
  next_owner: z.object({
    kind: z.enum(['lead', 'orchestrator', 'coordinator', 'owner']),
    name: z.string(),
    item_id: z.string().nullable(),
    step: z.string(),
  }),
  /** One exact sentence: what clears it, and who continues under which run. */
  resumes_when: z.string(),
  resume_ready: z.boolean(),
  flags: z.array(waitFlagSchema),
  /** A named blocker was linked after this run claimed the item: check it holds the whole story. */
  scope_hint: z.string().optional(),
});
export type WaitCard = z.infer<typeof waitCardSchema>;

/** Decision 45: a parked run waiting on this item, shown to whoever picks the item up. */
export const waitingRunSchema = z.object({
  item_id: z.string(),
  run_id: z.string(),
  label: z.string().nullable(),
  waited_since: z.string(),
  /** It waits on this item through another: the direct blocker. */
  via: z.string().nullable(),
});
export type WaitingRun = z.infer<typeof waitingRunSchema>;

export const runSchema = z.object({
  run_id: z.string(),
  parent_run_id: z.string().nullable(),
  client: z.string(),
  label: z.string().nullable(),
  is_lead: z.boolean(),
  run_state: runStateSchema,
  started_at: z.string(),
  last_signal_at: z.string(),
  lease_expires_at: z.string().nullable(),
  current_step_id: z.string().nullable(),
  summary: z.string().nullable(),
  error: z.string().nullable(),
  /** Set once the run has ended. */
  end_reason: endReasonSchema.nullable(),
  parked: runParkedSchema.nullable(),
  workspace: workspaceSchema.nullable(),
  orchestrator: orchestratorRefSchema.nullable(),
  brief_document_version_id: z.string().nullable(),
  resources: z.array(resourceSchema),
  /** `get_item` view `full` and `recovery_report` only. */
  external: externalSchema.optional(),
  /** Decision 42: the stable owner of the story across worker handoffs. Present when set. */
  producer: z.string().optional(),
  /** Decision 42: present after a coordinator's `update_run_status`. */
  status_update: runStatusUpdateSchema.optional(),
  /** Decision 44: present while a coordinator's park holds, or just ran out. */
  coordinator_park: coordinatorParkSchema.optional(),
  /** Decision 42: present while newer activity is flagged. */
  activity: runActivitySchema.optional(),
});
export type Run = z.infer<typeof runSchema>;

/** Decision 42: a story between workers, still held by its producer until `until`. */
export const producerHoldSchema = z.object({
  producer: z.string(),
  until: z.string(),
  last_worker: z.string().nullable(),
});
export type ProducerHold = z.infer<typeof producerHoldSchema>;

/** `Item.resume`: set when the item is resumable or its last run was interrupted. */
export const itemResumeSchema = z.object({
  workspace: workspaceSchema.nullable(),
  last_pushed_sha: z.string().nullable(),
  brief_document_version_id: z.string().nullable(),
  last_end_reason: endReasonSchema.nullable(),
  unreleased_resources: z.number().int(),
});
export type ItemResume = z.infer<typeof itemResumeSchema>;

export const questionSchema = z.object({
  id: z.string(),
  text: z.string(),
  asked_at: z.string(),
  answer: z.string().nullable(),
  answered_at: z.string().nullable(),
});
export type Question = z.infer<typeof questionSchema>;

export const docVersionRefSchema = z.object({
  document_version_id: z.string(),
  version_no: z.number().int(),
  mime: z.string(),
  size: z.number().int(),
  sha256: z.string(),
  created_at: z.string(),
  created_by: z.string(),
});
export type DocVersionRef = z.infer<typeof docVersionRefSchema>;

export const eventRowSchema = z.object({
  cursor: z.string(),
  at: z.string(),
  actor: z.string(),
  item_id: z.string().nullable(),
  type: eventTypeSchema,
  summary: z.string(),
});
export type EventRow = z.infer<typeof eventRowSchema>;

export const artifactSchema = z.object({
  kind: z.string(),
  label: z.string(),
  url: z.string().nullable(),
  state: z.string().nullable(),
});
export type Artifact = z.infer<typeof artifactSchema>;

export const itemSchema = itemSummarySchema.extend({
  description_md: z.string(),
  outcome_md: z.string(),
  acceptance: z.array(z.string()),
  links: z.object({
    blocks: z.array(linkRefSchema),
    blocked_by: z.array(linkRefSchema),
    relates: z.array(linkRefSchema),
  }),
  checklist: z.object({
    plan_version: z.number().int(),
    work: z.array(workStepSchema),
    checks: z.array(checkSchema),
    human_review: z.array(humanReviewItemSchema),
    /** Epic id when this item has none and its epic does. */
    reviewed_with_epic: z.string().nullable(),
  }),
  /** Open runs first, then the last 5 ended. */
  runs: z.array(runSchema),
  /** Active decisions in scope, owner first; titles only (B3 resolution 9). Full records: get_context. */
  decisions: z.array(
    z.object({ id: z.string(), title: z.string(), authority: z.enum(DECISION_AUTHORITIES) }),
  ),
  open_question: questionSchema.nullable(),
  /** Set when the item is resumable or its last run was interrupted (MCP_SPEC §4). */
  resume: itemResumeSchema.nullable(),
  /** Decision 42: present while the story is between workers under one producer. */
  producer_hold: producerHoldSchema.optional(),
  /** Returned once, then marked read. */
  unread_owner_notes: z.array(z.object({ id: z.string(), text: z.string(), at: z.string() })),
  documents: z.array(
    z.object({
      document_id: z.string(),
      name: z.string(),
      kind: docKindSchema,
      latest: docVersionRefSchema,
    }),
  ),
  packets: z.array(
    z.object({
      packet_id: z.string(),
      round: z.number().int(),
      state: z.enum(PACKET_STATES),
      stale: z.boolean(),
      built_from_commit: z.string(),
      created_at: z.string(),
    }),
  ),
  /** Newest first, max 20. */
  commits: z.array(z.object({ sha: z.string(), branch: z.string().nullable(), at: z.string() })),
  artifacts: z.array(artifactSchema),
  dates_set_by: z.string().nullable(),
  closed_by: z.enum(CLOSED_BY).nullable(),
  /** 20 newest. */
  recent_events: z.array(eventRowSchema),
});
export type Item = z.infer<typeof itemSchema>;

// ---- Lean reads (§3.2; B3 resolution 3) ----

/** Checklist counts shown by `get_item` view `summary`. */
export const checklistCountsSchema = z.object({
  work_done: z.number().int(),
  work_total: z.number().int(),
  checks_pass: z.number().int(),
  checks_total: z.number().int(),
});
export type ChecklistCounts = z.infer<typeof checklistCountsSchema>;

/**
 * What `get_item` returns: an Item, trimmed by `view` and `fields`. `id` and
 * `version` are always present. View `summary` adds the counts and the two
 * flags instead of delivering the question and notes.
 */
export const itemViewSchema = itemSchema.partial().required({ id: true, version: true }).extend({
  counts: checklistCountsSchema.optional(),
  has_open_question: z.boolean().optional(),
  unread_owner_notes_count: z.number().int().optional(),
});
export type ItemView = z.infer<typeof itemViewSchema>;

/** A `search_items` row: an ItemSummary, trimmed by `fields`. */
export const itemSummaryViewSchema = itemSummarySchema
  .partial()
  .required({ id: true, version: true });
export type ItemSummaryView = z.infer<typeof itemSummaryViewSchema>;

// ---- Decisions and context ----

export const decisionScopeSchema = z.object({
  kind: z.enum(DECISION_SCOPE_KINDS),
  id: z.string().nullable(),
});

export const decisionRecordSchema = z.object({
  id: z.string(),
  project: z.string(),
  scope: decisionScopeSchema,
  title: z.string(),
  decision_md: z.string(),
  rationale_md: z.string().nullable(),
  authority: z.enum(DECISION_AUTHORITIES),
  author: z.string(),
  status: z.enum(DECISION_STATUSES),
  supersedes_id: z.string().nullable(),
  superseded_by_id: z.string().nullable(),
  created_at: z.string(),
  confirmed_at: z.string().nullable(),
  version: z.number().int(),
});
export type DecisionRecord = z.infer<typeof decisionRecordSchema>;

export const contextBudgetSchema = z.enum(['small', 'medium', 'large']);

export const contextBundleSchema = z.object({
  item: itemSchema
    .pick({
      id: true,
      title: true,
      type: true,
      status: true,
      priority: true,
      outcome_md: true,
      acceptance: true,
      open_question: true,
      version: true,
    })
    .extend({ unread_owner_notes: z.number().int() }),
  /** Active, in scope; owner first. */
  decisions: z.array(decisionRecordSchema),
  epic: z.object({ id: z.string(), title: z.string(), outcome_md: z.string() }).nullable(),
  labels: z.array(z.object({ name: z.string(), brief_md: z.string() })),
  blockers: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      status: statusSchema,
      cleared: z.boolean(),
      waiting_for: z.string().nullable(),
      outcome_first_line: z.string(),
    }),
  ),
  dependents: z.array(z.object({ id: z.string(), title: z.string(), status: statusSchema })),
  /**
   * The step to work on next (decision 33; MCP_SPEC §5.12): the one in state
   * `current`, else the first `todo`, with its details, placed after the
   * blockers and dependents (BUILD_SPEC §5.15 section 4b). `truncated` when its
   * details were cut; get_step reads them in full. Null when no step is open.
   */
  current_step: z
    .object({
      id: z.string(),
      text: z.string(),
      state: workStepStateSchema,
      source: z.string().nullable(),
      details_md: z.string().nullable(),
      details_version: z.number().int(),
      truncated: z.boolean(),
    })
    .nullable()
    .optional(),
  /**
   * The project's Workflow notes, current version (decision 29; BUILD_SPEC
   * §5.15 section 5, §5.17). Null when the project has none.
   */
  workflow: z
    .object({
      project: z.string(),
      version_no: z.number().int(),
      content_md: z.string(),
      truncated: z.boolean(),
    })
    .nullable(),
  /**
   * Shared changes (decision 36; BUILD_SPEC §5.21 Context; MCP_SPEC §5.15):
   * the item's declaration, overlapping and other in-flight declarations,
   * leases and radar findings, after the Workflow notes. Optional: absent
   * until B39 (T183) fills it.
   */
  shared: contextSharedSchema.optional(),
  /**
   * The item's open problems (owner decision 37; BUILD_SPEC §5.15 section
   * 4d): what's wrong, what fixes it and who acts, in the words the owner
   * reads, with the ID `propose_resolution` takes. Optional (B42).
   */
  /** Decision 45: the wait card of the item's parked lead. */
  wait: waitCardSchema.optional(),
  /** Decision 45: parked runs this item would unblock, at most `WAIT_FLAGS.context_waiters`. */
  waiting_runs: z.object({ total: z.number().int(), rows: z.array(waitingRunSchema) }).optional(),
  problems: z
    .array(
      z.object({
        id: z.string(),
        kind: z.string(),
        what: z.string(),
        fix: z.string(),
        who: z.enum(['agent', 'owner']),
        who_text: z.string(),
      }),
    )
    .optional(),
  /**
   * The newest proposed resolutions for the item, up to 5, with the owner's
   * choice and note once decided (decision 37). Optional (B42).
   */
  resolutions: z
    .array(
      z.object({
        id: z.string(),
        problem_id: z.string().nullable(),
        kind: z.enum(RESOLUTION_KINDS),
        state: z.enum(RESOLUTION_STATES),
        note: z.string().nullable(),
      }),
    )
    .optional(),
  planning_docs: z.array(
    z.object({
      name: z.string(),
      version_no: z.number().int(),
      content_md: z.string().nullable(),
      truncated: z.boolean(),
    }),
  ),
  last_review: z
    .object({
      round: z.number().int(),
      items: z.array(
        z.object({ text: z.string(), kind: reviewKindSchema, note: z.string().nullable() }),
      ),
    })
    .nullable(),
  budget: contextBudgetSchema,
  truncated_sections: z.array(z.string()),
});
export type ContextBundle = z.infer<typeof contextBundleSchema>;

// ---- Errors ----

/** ToolError (§4) lives with the error codes in errors.ts; re-exported here with the other types. */
export { toolErrorSchema } from '../errors.js';

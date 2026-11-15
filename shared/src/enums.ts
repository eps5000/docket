/**
 * Shared enums (BUILD_SPEC §13, MCP_SPEC §3 and §4). The UI, the MCP adapter
 * and the server use these byte for byte. This is a shared contract file:
 * slices must not edit it (tasks.md, Slice rules).
 */

// ---- Items ----

/** Item statuses, in workflow order (owner decision 8; BUILD_SPEC §5.1). */
export const STATUSES = [
  'inbox',
  'planning',
  'ready',
  'progress',
  'review',
  'done',
  'canceled',
] as const;
export type Status = (typeof STATUSES)[number];

/** Display names, as in the workflow line of the server instructions (MCP_SPEC §2). */
export const STATUS_LABELS: Record<Status, string> = {
  inbox: 'Inbox',
  planning: 'Planning',
  ready: 'Ready',
  progress: 'In progress',
  review: 'Review',
  done: 'Done',
  canceled: 'Canceled',
};

/** Statuses an item can still move out of. */
export const OPEN_STATUSES = [
  'inbox',
  'planning',
  'ready',
  'progress',
  'review',
] as const satisfies readonly Status[];

export const ITEM_TYPES = ['Epic', 'Story', 'Task', 'Bug'] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

/** 1 is high. */
export const PRIORITIES = [1, 2, 3] as const;
export type Priority = (typeof PRIORITIES)[number];

export const CLOSED_BY = ['owner', 'agent', 'imported'] as const;
export type ClosedBy = (typeof CLOSED_BY)[number];

export const EFFORT_UNIT = 'pts';

// ---- Links and blocking ----

export const LINK_TYPES = ['blocks', 'relates'] as const;
export type LinkType = (typeof LINK_TYPES)[number];

/** When a blocker counts as cleared (BUILD_SPEC §5.2). */
export const SATISFIED_WHEN = ['done', 'merged', 'verified'] as const;
export type SatisfiedWhen = (typeof SATISFIED_WHEN)[number];

export const SATISFIED_WHEN_LABELS: Record<SatisfiedWhen, string> = {
  done: 'Done',
  merged: 'PR merged',
  verified: 'Verified by you',
};

// ---- Runs ----

/** Stored run state (BUILD_SPEC §4 `runs.state`). */
export const STORED_RUN_STATES = [
  'open',
  'needs_input',
  'finished',
  'failed',
  'interrupted',
] as const;
export type StoredRunState = (typeof STORED_RUN_STATES)[number];

/** Displayed run state, derived and never stored (BUILD_SPEC §5.4, MCP_SPEC §3). */
export const RUN_STATES = [
  'live',
  'reported',
  'stale',
  'needs_input',
  'failed',
  'finished',
  'interrupted',
] as const;
export type RunState = (typeof RUN_STATES)[number];

/** Run-state labels and one-line meanings (UI_SPEC §5). The meaning goes in `title`. */
export const RUN_STATE_LABELS: Record<RunState, { label: string; meaning: string }> = {
  live: { label: 'live', meaning: 'Working: the client session is responding' },
  reported: {
    label: 'reported',
    meaning: "The agent says it's working, with no recent session signal",
  },
  stale: { label: 'stale', meaning: 'No signal; state unknown, not assumed finished' },
  needs_input: { label: 'needs input', meaning: 'Waiting on you' },
  failed: { label: 'failed', meaning: 'Run ended with an error' },
  finished: { label: 'finished', meaning: 'Run ended normally' },
  interrupted: {
    label: 'interrupted',
    meaning: 'Stopped without finishing (lease expired, released, or service restart)',
  },
};

/** Kinds of run signal (BUILD_SPEC §5.4). */
export const SIGNAL_KINDS = ['session', 'report', 'relayed'] as const;
export type SignalKind = (typeof SIGNAL_KINDS)[number];

// ---- Provenance ----

/** Who asserted a fact and how we know (MCP_SPEC §3; constitution Principle III). */
export const PROVENANCES = ['agent', 'observed', 'relayed', 'ci'] as const;
export type Provenance = (typeof PROVENANCES)[number];

export const PROVENANCE_LABELS: Record<Provenance, string> = {
  agent: 'Agent-reported',
  observed: 'Observed child run',
  relayed: 'Relayed by lead',
  ci: 'CI',
};

/** Subagent log entries are either observed or relayed (BUILD_SPEC §4 `subagent_logs`). */
export const SUBAGENT_PROVENANCES = [
  'observed',
  'relayed',
] as const satisfies readonly Provenance[];
export type SubagentProvenance = (typeof SUBAGENT_PROVENANCES)[number];

// ---- Checklist ----

export const WORK_STEP_STATES = ['todo', 'current', 'done', 'blocked', 'skipped'] as const;
export type WorkStepState = (typeof WORK_STEP_STATES)[number];

export const CHECK_STATES = ['todo', 'pass', 'fail', 'skipped'] as const;
export type CheckState = (typeof CHECK_STATES)[number];

export const HUMAN_REVIEW_STATES = ['declared', 'ready', 'approved', 'deferred'] as const;
export type HumanReviewState = (typeof HUMAN_REVIEW_STATES)[number];

export const ADDED_BY = ['owner', 'agent'] as const;
export type AddedBy = (typeof ADDED_BY)[number];

// ---- Packets and review ----

export const PACKET_STATES = ['open', 'decided', 'withdrawn'] as const;
export type PacketState = (typeof PACKET_STATES)[number];

export const REVIEW_KINDS = ['approve', 'changes', 'defer'] as const;
export type ReviewKind = (typeof REVIEW_KINDS)[number];

export const REVIEW_INTO = ['checklist', 'bug'] as const;
export type ReviewInto = (typeof REVIEW_INTO)[number];

export const REVIEW_FOLLOW = ['ticket', 'none'] as const;
export type ReviewFollow = (typeof REVIEW_FOLLOW)[number];

// ---- Evidence and documents ----

export const ARTIFACT_KINDS = ['url', 'pr', 'ci', 'deploy', 'test'] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export const DOC_KINDS = ['planning', 'packet_attachment', 'import_report', 'other'] as const;
export type DocKind = (typeof DOC_KINDS)[number];

// ---- Decision records (BUILD_SPEC §5.14) ----

export const DECISION_AUTHORITIES = ['owner', 'agent'] as const;
export type DecisionAuthority = (typeof DECISION_AUTHORITIES)[number];

export const DECISION_AUTHORITY_LABELS: Record<DecisionAuthority, string> = {
  owner: 'Owner',
  agent: 'Agent',
};

export const DECISION_STATUSES = ['active', 'superseded', 'withdrawn'] as const;
export type DecisionStatus = (typeof DECISION_STATUSES)[number];

export const DECISION_SCOPE_KINDS = ['project', 'epic', 'label', 'item'] as const;
export type DecisionScopeKind = (typeof DECISION_SCOPE_KINDS)[number];

// ---- Events (contracts/events.md; MCP_SPEC §4 EventType) ----

export const ACTOR_KINDS = ['owner', 'agent', 'system'] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

export const EVENT_TYPES = [
  // Items
  'item.created',
  'item.updated',
  'item.status_changed',
  'item.archived',
  'item.unarchived',
  // Links and projects
  'link.added',
  'link.removed',
  'link.updated',
  'project.updated',
  'label.upserted',
  // Checklist
  'plan.updated',
  'step.updated',
  'subagent.logged',
  'checks.updated',
  'check.updated',
  'human_review.declared',
  'human_review.updated',
  'human_review.removed',
  // Claims and runs (heartbeats are not events)
  'claim.granted',
  'claim.rejected',
  'claim.released',
  'run.started',
  'run.ended',
  // Review
  'packet.submitted',
  'packet.stale',
  'packet.withdrawn',
  'review.decided',
  // Messages
  'question.asked',
  'question.answered',
  'owner_note.added',
  'note.added',
  // Evidence
  'document.added',
  'commit.reported',
  'artifact.linked',
  // Decisions
  'decision.published',
  'decision.confirmed',
  'decision.superseded',
  'decision.withdrawn',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** The only event types that make something "for you" on the stream (owner decision 21). */
export const FOR_YOU_EVENT_TYPES = [
  'packet.submitted',
  'question.asked',
] as const satisfies readonly EventType[];

/** Kinds of object an event touches, as sent in the stream's `objects[]`. */
export const OBJECT_KINDS = [
  'project',
  'item',
  'label',
  'link',
  'run',
  'packet',
  'document',
  'decision',
  'question',
] as const;
export type ObjectKind = (typeof OBJECT_KINDS)[number];

// ---- Filters (BUILD_SPEC §13; UI_SPEC §6.2; MCP_SPEC §5.2 search_items) ----

/**
 * Saved filters and their agent-query strings. `ui` filters appear on Work
 * (as chips or from the URL); `agent` filters are accepted by `search_items`.
 * `query` is the string shown in a chip's tooltip ("Agent query: …"); it is
 * null where BUILD_SPEC §13 defines none.
 */
export const FILTERS = [
  { key: 'all', label: 'All', query: '', ui: true, agent: false },
  { key: 'planning', label: 'In planning', query: 'status:planning', ui: true, agent: false },
  {
    key: 'ready_to_start',
    label: 'Ready to start',
    query: 'status:ready -is:blocked',
    ui: true,
    agent: true,
  },
  { key: 'blocked', label: 'Blocked', query: 'is:blocked', ui: true, agent: true },
  { key: 'for_you', label: 'For you', query: 'needs:human', ui: true, agent: false },
  {
    key: 'human_review_later',
    label: 'Human review later',
    query: 'has:human-review',
    ui: true,
    agent: false,
  },
  {
    key: 'deferred_review',
    label: 'Deferred review',
    query: 'review:deferred',
    ui: true,
    agent: true,
  },
  { key: 'live_run', label: 'Live run', query: 'run:live', ui: true, agent: false },
  { key: 'archived', label: 'Archived', query: 'is:archived', ui: true, agent: false },
  {
    key: 'resumable',
    label: 'Resumable',
    query: 'status:progress -has:lead',
    ui: false,
    agent: true,
  },
  { key: 'waiting_for_review', label: 'Waiting for review', query: null, ui: false, agent: true },
  { key: 'mine', label: 'Mine', query: null, ui: false, agent: true },
] as const;
export type FilterKey = (typeof FILTERS)[number]['key'];

/** The `search_items` filter values, in MCP_SPEC §5.2 order. */
export const AGENT_FILTERS = [
  'ready_to_start',
  'resumable',
  'blocked',
  'waiting_for_review',
  'mine',
  'deferred_review',
] as const satisfies readonly FilterKey[];
export type AgentFilter = (typeof AGENT_FILTERS)[number];

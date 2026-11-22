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

/**
 * In flight (decision 36; BUILD_SPEC §5.21): items whose declared shared
 * changes count for overlaps, `list_shared_parts` and `get_context.shared`.
 */
export const IN_FLIGHT_STATUSES = [
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
  /** Waiting on purpose (`park_run`; BUILD_SPEC §5.16): keeps its claim, lease suspended. */
  'parked',
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
  'parked',
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
  parked: {
    label: 'parked',
    meaning:
      'Waiting on purpose (on an item, the coordinator or a person). Keeps its claim; never mistaken for finished.',
  },
  needs_input: { label: 'needs input', meaning: 'Waiting on you' },
  failed: { label: 'failed', meaning: 'Run ended with an error' },
  finished: { label: 'finished', meaning: 'Run ended normally' },
  interrupted: {
    label: 'interrupted',
    meaning: 'Stopped without finishing (lease expired, released, or service restart)',
  },
};

/** Displayed run states of a run that hasn't ended (it may still hold a claim). */
export const OPEN_RUN_STATES = [
  'live',
  'reported',
  'stale',
  'parked',
  'needs_input',
] as const satisfies readonly RunState[];

/** Why a run ended; set on every terminal transition (BUILD_SPEC §5.16; MCP_SPEC §3). */
export const END_REASONS = [
  'finished',
  'failed',
  'released',
  'lease_expired',
  'owner_released',
  'service_restart',
  'canceled',
] as const;
export type EndReason = (typeof END_REASONS)[number];

/** End-reason labels (BUILD_SPEC §13: shared with their UI labels). */
export const END_REASON_LABELS: Record<EndReason, string> = {
  finished: 'finished',
  failed: 'failed',
  released: 'released by the agent',
  lease_expired: 'lease expired',
  owner_released: 'released by you',
  service_restart: 'service restarted',
  canceled: 'canceled',
};

// ---- Recovery: workspaces and resources (owner decision 26; BUILD_SPEC §5.16) ----

/** Workspace state, derived per worktree path and never stored (MCP_SPEC §3). */
export const WORKSPACE_STATES = [
  'in_use',
  'parked',
  'at_risk',
  'safe_to_prune',
  'unknown',
] as const;
export type WorkspaceState = (typeof WORKSPACE_STATES)[number];

/** State chip labels on Agents → Workspaces (UI_SPEC §6.6). */
export const WORKSPACE_STATE_LABELS: Record<WorkspaceState, string> = {
  in_use: 'In use',
  parked: 'Parked',
  at_risk: 'At risk',
  safe_to_prune: 'Safe to prune',
  unknown: 'Unknown',
};

/** Long-lived things a run starts (MCP_SPEC §4 Resource; BUILD_SPEC §4 `run_resources`). */
export const RESOURCE_KINDS = [
  'process',
  'dev_server',
  'session',
  'container',
  'temp_dir',
  'port',
  'other',
] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];

export const RESOURCE_KIND_LABELS: Record<ResourceKind, string> = {
  process: 'process',
  dev_server: 'dev server',
  session: 'session',
  container: 'container',
  temp_dir: 'temp dir',
  port: 'port',
  other: 'other',
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

/**
 * Where a note on an approval is kept (owner decision 35): on this item only,
 * or also as an owner decision for the epic's or the project's future work.
 */
export const REVIEW_KEEP = ['item', 'epic', 'project'] as const;
export type ReviewKeep = (typeof REVIEW_KEEP)[number];

// ---- Evidence and documents ----

export const ARTIFACT_KINDS = ['url', 'pr', 'ci', 'deploy', 'test'] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/** `brief` is written only by `claim_lead` and `start_run` (BUILD_SPEC §4, §5.16). */
export const DOC_KINDS = [
  'planning',
  'packet_attachment',
  'import_report',
  'brief',
  'other',
] as const;
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

// ---- Agent setup (owner decision 29; BUILD_SPEC §4, §5.17) ----

/**
 * The layers an agent file can have. For a project, the effective version is
 * the project override, else the service-wide edit, else bundled.
 */
export const AGENT_FILE_LAYERS = ['bundled', 'service', 'project'] as const;
export type AgentFileLayer = (typeof AGENT_FILE_LAYERS)[number];

/** The layer chips on Settings → Agent setup (UI_SPEC §6.7b). */
export const AGENT_FILE_LAYER_LABELS: Record<AgentFileLayer, string> = {
  bundled: 'Bundled',
  service: 'Your edit',
  project: 'Project override',
};

/** The layers the owner edits and reverts; bundled is read-only (upgrades update it). */
export const EDITABLE_AGENT_FILE_LAYERS = ['service', 'project'] as const;
export type EditableAgentFileLayer = (typeof EDITABLE_AGENT_FILE_LAYERS)[number];

/** The AGENTS.md block's key. Each skill's key is `skill:<name>`. */
export const AGENTS_BLOCK_KEY = 'agents_block';

export const INSTALL_CLIENTS = ['claude', 'codex'] as const;
export type InstallClient = (typeof INSTALL_CLIENTS)[number];

export const INSTALL_CLIENT_LABELS: Record<InstallClient, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
};

/** `repo`: the project's repo; `user`: user-wide (`~/.claude`, `~/.codex`). */
export const INSTALL_TARGET_KINDS = ['repo', 'user'] as const;
export type InstallTargetKind = (typeof INSTALL_TARGET_KINDS)[number];

/** `command`: the copy-paste download; `push`: written into the push root (opt-in). */
export const INSTALL_METHODS = ['command', 'push'] as const;
export type InstallMethod = (typeof INSTALL_METHODS)[number];

/**
 * What a pushed file did, shown after *Install* (UI_SPEC §6.7b). `removed`
 * and `kept_edited` are old `tasklite-*` skill folders an earlier install
 * recorded (B28): removed while unmodified, else kept ("old name, edited
 * locally").
 */
export const INSTALL_FILE_CHANGES = [
  'created',
  'updated',
  'unchanged',
  'removed',
  'kept_edited',
] as const;
export type InstallFileChange = (typeof INSTALL_FILE_CHANGES)[number];

/** A *Check* result per file (UI_SPEC §6.7b). */
export const INSTALL_CHECK_STATES = ['edited', 'missing', 'extra'] as const;
export type InstallCheckState = (typeof INSTALL_CHECK_STATES)[number];

export const INSTALL_CHECK_STATE_LABELS: Record<InstallCheckState, string> = {
  edited: 'Edited locally',
  missing: 'Missing',
  extra: 'Extra',
};

// ---- Agent proposals and drift (owner decision 30; BUILD_SPEC §4, §5.19) ----

/** The Workflow notes' key in get_agent_files and propose_agent_file_change (MCP_SPEC §5.10). */
export const WORKFLOW_KEY = 'workflow';

/** What get_agent_files lists: a skill, the AGENTS.md block, or the project's Workflow notes. */
export const AGENT_FILE_KINDS = ['skill', 'agents_block', 'workflow'] as const;
export type AgentFileKind = (typeof AGENT_FILE_KINDS)[number];

/** Where a file in effect comes from: the default every project uses, or the project's copy. */
export const AGENT_FILE_SOURCES = ['default', 'project'] as const;
export type AgentFileSource = (typeof AGENT_FILE_SOURCES)[number];

export const PROPOSAL_STATES = ['pending', 'approved', 'declined'] as const;
export type ProposalState = (typeof PROPOSAL_STATES)[number];

/** Who sent an instruction report: an agent on `claim_lead`, or the scheduled push-folder check. */
export const INSTRUCTION_REPORT_SOURCES = ['agent', 'push_check'] as const;
export type InstructionReportSource = (typeof INSTRUCTION_REPORT_SOURCES)[number];

/** A drift record: open until the owner adopts, restores or keeps the local file. */
export const DRIFT_STATES = ['open', 'adopted', 'restored', 'kept_local'] as const;
export type DriftState = (typeof DRIFT_STATES)[number];

/** How an installed file differs from what was sent (B26 resolution 7). */
export const DRIFT_CHANGES = ['edited', 'missing', 'extra'] as const;
export type DriftChange = (typeof DRIFT_CHANGES)[number];

// ---- Onboarding (owner decision 31; BUILD_SPEC §4, §5.20) ----

/** An onboarding session: the agent works, then hands it to the owner, who marks it reviewed. */
export const ONBOARDING_STATES = ['in_progress', 'ready_for_review', 'reviewed'] as const;
export type OnboardingState = (typeof ONBOARDING_STATES)[number];

/**
 * The onboarding guide's agent file key (decision 31; BUILD_SPEC §5.20; B30
 * contract change): a bundled agent file the owner edits like the others, as
 * the default or per project. `onboard_project` and the `onboard` prompt
 * serve it; it is never installed into a repo and can't be proposed.
 */
export const ONBOARDING_GUIDE_KEY = 'guide:onboarding';

/** Work's onboarding filter (B30): the items a session created, or the ones it enriched. */
export const ONBOARDING_CHANGES = ['created', 'enriched'] as const;
export type OnboardingChange = (typeof ONBOARDING_CHANGES)[number];

// ---- Shared changes (decision 36; BUILD_SPEC §5.21; MCP_SPEC §5.15) ----

/** What a shared part is: the prefix of its key (`model:Token`). */
export const SHARED_PART_KINDS = ['table', 'model', 'endpoint', 'file', 'other'] as const;
export type SharedPartKind = (typeof SHARED_PART_KINDS)[number];

/** What an item does to a part it declares. */
export const SHARED_CHANGES = ['add', 'change', 'remove'] as const;
export type SharedChange = (typeof SHARED_CHANGES)[number];

/**
 * An overlap between two in-flight items: `open` until the owner decides,
 * `sequenced` (*Run one after the other*: a `merged` blocker was added),
 * `compatible` (*They're compatible*), or `resolved` when it no longer
 * applies (a declaration changed, or an item closed or was canceled).
 */
export const OVERLAP_STATES = ['open', 'sequenced', 'compatible', 'resolved'] as const;
export type OverlapState = (typeof OVERLAP_STATES)[number];

/** The owner's choice on an overlap question. */
export const OVERLAP_DECISIONS = ['sequence', 'compatible'] as const;
export type OverlapDecision = (typeof OVERLAP_DECISIONS)[number];

/**
 * Owner decision 39 (B46): whether a declared change alters something the
 * owner already approved. `changes_approved_design` needs a note naming the
 * design, decision or acceptance criterion, and always reaches the owner.
 */
export const DESIGN_IMPACTS = ['none', 'changes_approved_design'] as const;
export type DesignImpact = (typeof DESIGN_IMPACTS)[number];

/**
 * Owner decision 39: the owner's review of a declared change to an approved
 * design. It applies with or without an overlap and in every Overlap handling
 * mode. `open` and `sent_back` pause that item only; `withdrawn` no longer
 * applies (the owner took the change out of the declaration, or the item was
 * canceled).
 */
export const DESIGN_REVIEW_STATES = ['open', 'approved', 'sent_back', 'withdrawn'] as const;
export type DesignReviewState = (typeof DESIGN_REVIEW_STATES)[number];

/** The owner's choice on a design review: *Approve the design change* or *Send back*. */
export const DESIGN_REVIEW_DECISIONS = ['approve', 'send_back'] as const;
export type DesignReviewDecision = (typeof DESIGN_REVIEW_DECISIONS)[number];

/**
 * Owner decision 39: Settings → Overlap handling, a global default with an
 * optional per-project override. Agents resolve (the default): the owner sees
 * only level 3. Ask on shared data: also tables, models and endpoints. Ask on
 * every overlap: decision 36's behaviour.
 */
export const OVERLAP_HANDLING = ['agents_resolve', 'ask_shared_data', 'ask_every'] as const;
export type OverlapHandling = (typeof OVERLAP_HANDLING)[number];
export const DEFAULT_OVERLAP_HANDLING: OverlapHandling = 'agents_resolve';

/** The three questions' answers: run in parallel, Docket sequences them, or the owner decides. */
export const OVERLAP_OUTCOMES = ['parallel', 'sequence', 'owner'] as const;
export type OverlapOutcome = (typeof OVERLAP_OUTCOMES)[number];

/** Why an overlap got its outcome (BUILD_SPEC §5.21, decision 39). */
export const OVERLAP_REASONS = [
  // Run in parallel
  'file_only',
  'different_members',
  // Sequence automatically
  'same_member',
  'change_touches_part',
  'bare_part',
  'unclear',
  // The owner decides (a change to an approved design is its own review: DESIGN_REVIEW_STATES)
  'blocker_cycle',
  'disputed',
  'setting',
] as const;
export type OverlapReason = (typeof OVERLAP_REASONS)[number];

/** The owner's overrule of an automatic outcome, from the ticket (decision 39; undoable). */
export const OVERLAP_OVERRULES = ['parallel', 'order'] as const;
export type OverlapOverrule = (typeof OVERLAP_OVERRULES)[number];

/** Why a lease ended (BUILD_SPEC §5.21 Leases). */
export const LEASE_END_REASONS = [
  'released',
  'owner_released',
  'done',
  'handed_off',
  'expired',
] as const;
export type LeaseEndReason = (typeof LEASE_END_REASONS)[number];

/**
 * A hand-off held for changes to parts the item didn't declare (B38
 * resolution: its own row, since a `set_status done` hold has no packet).
 * `open` until the owner picks *Add to the declaration* (`added`) or *Send
 * back* (`sent_back`).
 */
export const UNDECLARED_HOLD_STATES = ['open', 'added', 'sent_back'] as const;
export type UndeclaredHoldState = (typeof UNDECLARED_HOLD_STATES)[number];

/** The owner's choice on an undeclared-parts question. */
export const UNDECLARED_DECISIONS = ['add', 'send_back'] as const;
export type UndeclaredDecision = (typeof UNDECLARED_DECISIONS)[number];

/** Which hand-off raised a hold: a packet, or closing as done without one. */
export const UNDECLARED_HOLD_VIA = ['submit_packet', 'set_status'] as const;
export type UndeclaredHoldVia = (typeof UNDECLARED_HOLD_VIA)[number];

/**
 * The conflict radar's state for a project: `off` (no repository, or git
 * isn't available: "Radar off: no repository"), `idle` (set up, never run),
 * `ok` (the last run worked).
 */
export const RADAR_STATES = ['off', 'idle', 'ok'] as const;
export type RadarState = (typeof RADAR_STATES)[number];

/**
 * How the radar knew an item's branch (B40): `reported` (an agent or the
 * owner named it: `declare_shared_changes`, the Shared changes section, a
 * claim, a run or a packet) or `discovered` (the item had none, and exactly
 * one local branch names the item's key or Jira key).
 */
export const BRANCH_SOURCES = ['reported', 'discovered'] as const;
export type BranchSource = (typeof BRANCH_SOURCES)[number];

/**
 * What an agent's proposed resolution of a problem does (owner decision 37;
 * MCP_SPEC §5.16 `propose_resolution`): split the work, change its scope,
 * change the order of work, or something else.
 */
export const RESOLUTION_KINDS = ['split', 'rescope', 'reorder', 'other'] as const;
export type ResolutionKind = (typeof RESOLUTION_KINDS)[number];

/**
 * A proposed resolution's state (decision 37): `open` until the owner
 * decides; `approved`, `different` (*Go a different way*, with a note) or
 * `acknowledged` (fine, proceed); `superseded` when the agent proposed again
 * before the owner decided.
 */
export const RESOLUTION_STATES = [
  'open',
  'approved',
  'different',
  'acknowledged',
  'superseded',
] as const;
export type ResolutionState = (typeof RESOLUTION_STATES)[number];

/** The owner's choice on a proposed resolution (decision 37). */
export const RESOLUTION_DECISIONS = ['approve', 'different', 'acknowledge'] as const;
export type ResolutionDecision = (typeof RESOLUTION_DECISIONS)[number];

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
  // Recovery (US11): a heartbeat that declares or releases resources appends these
  'run.parked',
  'run.resumed',
  'run.unpushed_handled',
  'resource.declared',
  'resource.released',
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
  // The owner keeps an agent's project-wide decision without confirming it (decision 38; B44)
  'decision.acknowledged',
  // Agent setup (decision 29; BUILD_SPEC §5.17)
  'agent_file.updated',
  'agent_file.reverted',
  'workflow.updated',
  'install.recorded',
  // Agent proposals and drift (decision 30; BUILD_SPEC §5.19)
  'agent_file.proposed',
  'agent_file.proposal_decided',
  'drift.detected',
  'drift.resolved',
  // Onboarding (decision 31; BUILD_SPEC §5.20)
  'project.created',
  'onboarding.started',
  'onboarding.finished',
  'onboarding.reviewed',
  // Shared changes (decision 36; BUILD_SPEC §5.21)
  'shared_part.saved',
  'shared.declared',
  'overlap.raised',
  'overlap.decided',
  'lease.taken',
  'lease.ended',
  'undeclared.held',
  'undeclared.decided',
  'radar.found',
  'radar.cleared',
  // The radar sees in-flight branches (B40)
  'branch.reported',
  'branch.discovered',
  // Problems that say what to do (decision 37; B42)
  'problem.acknowledged',
  'resolution.proposed',
  'resolution.decided',
  // A declared change to an approved design (decision 39; B46)
  'design_review.raised',
  'design_review.decided',
  // Docket restarted and kept its open runs (decision 41; B49): one event, not one per run
  'service.restarted',
  // Status that follows the work (decision 42; B50): a coordinator's update, and newer activity
  'run.status_updated',
  'run.activity',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/**
 * The only event types that make something "for you" on the stream (owner
 * decision 21), plus an onboarding ready for the owner's review (decision 31;
 * B29).
 */
export const FOR_YOU_EVENT_TYPES = [
  'packet.submitted',
  'question.asked',
  'onboarding.finished',
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
  /** Decision 29: an agent file (one key, layer and project). */
  'agent_file',
  /** Decision 29: an install of agent files. */
  'install',
  /** Decision 30: an agent's proposed change to an agent file or Workflow notes. */
  'agent_file_proposal',
  /** Decision 30: an installed file that differs from what was sent. */
  'drift',
  /** Decision 31: an onboarding session. */
  'onboarding',
  /** Decision 36: a registered shared part. */
  'shared_part',
  /** Decision 36: two in-flight items that declare the same part. */
  'overlap',
  /** Decision 36: a lease on a single-writer part. */
  'lease',
  /** Decision 36: a hand-off held for changes to parts the item didn't declare. */
  'undeclared_hold',
  /** Decision 36: a conflict the radar found between two branches. */
  'radar_finding',
  /** Decision 37: the owner's acknowledgement of a problem. */
  'problem_ack',
  /** Decision 37: an agent's proposed resolution of a problem. */
  'resolution',
  /** Decision 39: the owner's review of a declared change to an approved design. */
  'design_review',
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

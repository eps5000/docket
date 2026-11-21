/**
 * The database schema: every table in BUILD_SPEC §4. This is a shared
 * contract file (tasks.md, Slice rules): change it only in a "contract:" PR,
 * together with a new migration.
 *
 * Conventions (BUILD_SPEC §4, data-model.md):
 * - every row has `id`, `created_at` and `updated_at` (UTC ISO-8601 text).
 *   Exceptions: `events` is keyed by `seq` (the change cursor) and stamped
 *   with `at`, being append-only; `settings` is keyed by `key`.
 * - mutable entities carry an integer `version`, starting at 1 and
 *   incremented on every change (A07). The write path bumps it.
 * - JSON columns hold canonical JSON text.
 * - limits and enums are CHECK constraints, so no adapter can bypass them.
 *
 * `search_fts` (FTS5) and its sync triggers are not expressible in Drizzle;
 * they live in the hand-written migration 0001_search_fts.sql.
 */
import {
  AGENT_FILE_LAYERS,
  AGENT_SETUP_LIMITS,
  AGENTS_BLOCK_KEY,
  ONBOARDING_GUIDE_KEY,
  INSTALL_CLIENTS,
  INSTALL_METHODS,
  INSTALL_TARGET_KINDS,
  INSTRUCTION_REPORT_SOURCES,
  PROPOSAL_STATES,
  DRIFT_CHANGES,
  DRIFT_STATES,
  ONBOARDING_STATES,
  WORKFLOW_KEY,
  ARTIFACT_KINDS,
  CHECK_STATES,
  CLOSED_BY,
  DECISION_AUTHORITIES,
  DECISION_SCOPE_KINDS,
  DECISION_STATUSES,
  DOC_KINDS,
  END_REASONS,
  HUMAN_REVIEW_STATES,
  ITEM_TYPES,
  LINK_TYPES,
  PACKET_STATES,
  PROVENANCES,
  REVIEW_FOLLOW,
  REVIEW_INTO,
  RESOURCE_KINDS,
  REVIEW_KINDS,
  SATISFIED_WHEN,
  SIGNAL_KINDS,
  STATUSES,
  STORED_RUN_STATES,
  SUBAGENT_PROVENANCES,
  WORK_STEP_STATES,
  ACTOR_KINDS,
  LEASE_END_REASONS,
  LIMITS,
  OVERLAP_STATES,
  SHARED_CHANGES,
  SHARED_PART_KINDS,
  UNDECLARED_HOLD_STATES,
  UNDECLARED_HOLD_VIA,
  RESOLUTION_KINDS,
  RESOLUTION_STATES,
} from '@docket/shared';
import { sql, type SQL } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn,
} from 'drizzle-orm/sqlite-core';

// ---- Limits (data-model.md "Validation"; MCP_SPEC §3 Types) ----

/** Item title: ≤ 200 characters. */
export const TITLE_MAX = 200;
/** Markdown fields (`description_md`, `outcome_md`): ≤ 20,000 characters. */
export const MARKDOWN_MAX = 20_000;
/** Label brief (`brief_md`): ≤ 10,000 characters (MCP_SPEC §3). */
export const BRIEF_MAX = 10_000;
/** Work step, agent check, human review item and acceptance criterion text: ≤ 500. */
export const STEP_TEXT_MAX = 500;
/** Notes and summary lines: ≤ 4,000 (MCP_SPEC §3). */
export const NOTE_MAX = 4_000;
/** Question text: ≤ 2,000 (FR-022). */
export const QUESTION_MAX = 2_000;
/** Subagent log: name ≤ 60, outcome ≤ 500 (FR-018). */
export const SUBAGENT_NAME_MAX = 60;
export const SUBAGENT_OUTCOME_MAX = 500;
/** Priority 1–3 (1 is high). */
export const PRIORITY_MIN = 1;
export const PRIORITY_MAX = 3;
/** Project key: 2–5 uppercase letters. */
export const PROJECT_KEY_MIN = 2;
export const PROJECT_KEY_MAX = 5;
/** Label name: `a-z0-9-`, ≤ 40. */
export const LABEL_NAME_MAX = 40;
/** Decision record: title ≤ 120, decision ≤ 4,000 (BUILD_SPEC §5.14). */
export const DECISION_TITLE_MAX = 120;
export const DECISION_MD_MAX = 4_000;
/** Recovery (BUILD_SPEC §5.16): `runs.external` ≤ 2 KB of JSON; resource label ≤ 120. */
export const EXTERNAL_MAX_BYTES = 2_048;
export const RESOURCE_LABEL_MAX = 120;

// ---- CHECK helpers (literals only: CHECK constraints cannot take parameters) ----

const quote = (v: string | number) => (typeof v === 'number' ? String(v) : `'${v}'`);
const oneOf = (column: string, values: readonly (string | number)[]): SQL =>
  sql.raw(`"${column}" IN (${values.map(quote).join(', ')})`);
/** A nullable enum column: NULL, or one of `values`. */
const nullOrOneOf = (column: string, values: readonly (string | number)[]): SQL =>
  sql.raw(`"${column}" IS NULL OR "${column}" IN (${values.map(quote).join(', ')})`);
const maxLen = (column: string, max: number): SQL => sql.raw(`length("${column}") <= ${max}`);
const lenBetween = (column: string, min: number, max: number): SQL =>
  sql.raw(`length("${column}") BETWEEN ${min} AND ${max}`);

// ---- Shared columns ----

const id = () => text('id').primaryKey();
const timestamps = {
  created_at: text('created_at').notNull(),
  updated_at: text('updated_at').notNull(),
};
const version = () => integer('version').notNull().default(1);
const itemRef = (name: string) =>
  text(name)
    .notNull()
    .references((): AnySQLiteColumn => items.id, { onDelete: 'cascade' });

// ---- Tables ----

export const projects = sqliteTable(
  'projects',
  {
    id: id(),
    key: text('key').notNull().unique(),
    name: text('name').notNull(),
    short_name: text('short_name').notNull(),
    color: text('color').notNull(),
    next_seq: integer('next_seq').notNull().default(1),
    default_satisfied_when: text('default_satisfied_when', { enum: SATISFIED_WHEN })
      .notNull()
      .default('done'),
    deleted_at: text('deleted_at'),
    /**
     * The agent that created it through onboard_project (`claude · orca-w3`);
     * null when the owner, the seed or a Jira import did (decision 31; B29).
     */
    created_by: text('created_by'),
    /**
     * The conflict radar (decision 36; BUILD_SPEC §5.21): the repository
     * folder inside `DOCKET_PUSH_ROOT` (null: radar off), its main branch,
     * and the last run. No CHECKs, so the migration needs no rebuild; the
     * route schemas hold the limits.
     */
    repo_path: text('repo_path'),
    main_branch: text('main_branch').notNull().default('main'),
    radar_last_run_at: text('radar_last_run_at'),
    /** Why the last run couldn't trial-merge ("no repository"); null when it worked. */
    radar_off_reason: text('radar_off_reason'),
    version: version(),
    ...timestamps,
  },
  () => [
    check(
      'projects_key_format',
      sql.raw(
        `length("key") BETWEEN ${PROJECT_KEY_MIN} AND ${PROJECT_KEY_MAX} AND "key" NOT GLOB '*[^A-Z]*'`,
      ),
    ),
    check('projects_default_satisfied_when', oneOf('default_satisfied_when', SATISFIED_WHEN)),
    check('projects_next_seq', sql.raw(`"next_seq" >= 1`)),
  ],
);

export const items = sqliteTable(
  'items',
  {
    id: id(),
    project_key: text('project_key')
      .notNull()
      .references(() => projects.key, { onDelete: 'cascade' }),
    type: text('type', { enum: ITEM_TYPES }).notNull(),
    title: text('title').notNull(),
    description_md: text('description_md').notNull().default(''),
    outcome_md: text('outcome_md').notNull().default(''),
    status: text('status', { enum: STATUSES }).notNull(),
    priority: integer('priority').notNull().default(2),
    epic_id: text('epic_id').references((): AnySQLiteColumn => items.id, {
      onDelete: 'set null',
    }),
    planned_start: text('planned_start'),
    planned_end: text('planned_end'),
    dates_set_by: text('dates_set_by'),
    dates_set_at: text('dates_set_at'),
    effort: real('effort'),
    effort_unit: text('effort_unit').notNull().default('pts'),
    closed_by: text('closed_by', { enum: CLOSED_BY }),
    closed_at: text('closed_at'),
    archived_at: text('archived_at'),
    jira_key: text('jira_key'),
    imported: integer('imported', { mode: 'boolean' }).notNull().default(false),
    /** `{item_id, round, hr_item_id}` when created from a review decision. */
    from_review: text('from_review', { mode: 'json' }),
    /** Decision 36: set when the item declared that it changes no shared part. */
    shared_none_at: text('shared_none_at'),
    /**
     * Decision 36, B40: the branch reported for the conflict radar
     * (`declare_shared_changes`' `branch`, or the owner's Shared changes
     * section); null when none, or cleared. `branch_at` is when it was last
     * reported or cleared (null: never), so the radar takes the latest of
     * this, a packet's, a lead run's and a claim's branch.
     */
    branch: text('branch'),
    branch_by: text('branch_by'),
    branch_at: text('branch_at'),
    /**
     * B40: what the radar's last run found for an item without a reported
     * branch: the one local branch that names the item (`radar_branch`), or
     * the several that do (`radar_branch_matches`, a JSON array; the radar
     * then uses none).
     */
    radar_branch: text('radar_branch'),
    radar_branch_matches: text('radar_branch_matches', { mode: 'json' }),
    /**
     * B41: the item's reported branches for the conflict radar, a JSON array
     * of `{name, by, at}` (oldest first, up to 10; null or empty: none, so the
     * radar looks for one by name). `declare_shared_changes` replaces it; the
     * owner adds or removes one; `claim_lead`, `submit_packet` and
     * `set_status` add theirs. Migration 0012 moved B40's single reported
     * branch here; `branch`, `branch_by` and `branch_at` are no longer written.
     * B45: an entry with `removed: true` is a branch the owner removed; it
     * isn't reported, and discovery won't adopt it until it is reported again.
     */
    branches: text('branches', { mode: 'json' }),
    version: version(),
    ...timestamps,
  },
  (t) => [
    index('items_project_status').on(t.project_key, t.status),
    index('items_epic').on(t.epic_id),
    check('items_type', oneOf('type', ITEM_TYPES)),
    check('items_status', oneOf('status', STATUSES)),
    check('items_priority', sql.raw(`"priority" BETWEEN ${PRIORITY_MIN} AND ${PRIORITY_MAX}`)),
    check('items_title', lenBetween('title', 1, TITLE_MAX)),
    check('items_description_md', maxLen('description_md', MARKDOWN_MAX)),
    check('items_outcome_md', maxLen('outcome_md', MARKDOWN_MAX)),
    check('items_effort', sql.raw(`"effort" >= 0`)),
    check('items_closed_by', oneOf('closed_by', CLOSED_BY)),
    check('items_epic_not_self', sql.raw(`"epic_id" <> "id"`)),
  ],
);

export const acceptance_criteria = sqliteTable(
  'acceptance_criteria',
  {
    id: id(),
    item_id: itemRef('item_id'),
    position: integer('position').notNull(),
    text: text('text').notNull(),
    ...timestamps,
  },
  (t) => [
    index('acceptance_criteria_item').on(t.item_id, t.position),
    check('acceptance_criteria_text', lenBetween('text', 1, STEP_TEXT_MAX)),
  ],
);

export const labels = sqliteTable(
  'labels',
  {
    id: id(),
    project_key: text('project_key')
      .notNull()
      .references(() => projects.key, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    brief_md: text('brief_md').notNull().default(''),
    brief_by: text('brief_by'),
    brief_at: text('brief_at'),
    version: version(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('labels_project_name').on(t.project_key, t.name),
    check(
      'labels_name_format',
      sql.raw(`length("name") BETWEEN 1 AND ${LABEL_NAME_MAX} AND "name" NOT GLOB '*[^a-z0-9-]*'`),
    ),
    check('labels_brief_md', maxLen('brief_md', BRIEF_MAX)),
  ],
);

export const item_labels = sqliteTable(
  'item_labels',
  {
    id: id(),
    item_id: itemRef('item_id'),
    label_id: text('label_id')
      .notNull()
      .references(() => labels.id, { onDelete: 'cascade' }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('item_labels_item_label').on(t.item_id, t.label_id),
    index('item_labels_label').on(t.label_id),
  ],
);

export const links = sqliteTable(
  'links',
  {
    id: id(),
    /** For `blocks`, `from` blocks `to`. */
    from_id: itemRef('from_id'),
    to_id: itemRef('to_id'),
    type: text('type', { enum: LINK_TYPES }).notNull(),
    /** null = the blocked item's project default (BUILD_SPEC §5.2). */
    satisfied_when: text('satisfied_when', { enum: SATISFIED_WHEN }),
    created_by: text('created_by').notNull(),
    version: version(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('links_from_to_type').on(t.from_id, t.to_id, t.type),
    index('links_to').on(t.to_id),
    check('links_type', oneOf('type', LINK_TYPES)),
    check('links_satisfied_when', oneOf('satisfied_when', SATISFIED_WHEN)),
    check('links_not_self', sql.raw(`"from_id" <> "to_id"`)),
  ],
);

export const plan_versions = sqliteTable(
  'plan_versions',
  {
    id: id(),
    item_id: itemRef('item_id'),
    version_no: integer('version_no').notNull(),
    reason: text('reason'),
    created_by: text('created_by').notNull(),
    ...timestamps,
  },
  (t) => [uniqueIndex('plan_versions_item_version').on(t.item_id, t.version_no)],
);

export const work_steps = sqliteTable(
  'work_steps',
  {
    id: id(),
    item_id: itemRef('item_id'),
    plan_version_no: integer('plan_version_no').notNull(),
    position: integer('position').notNull(),
    text: text('text').notNull(),
    state: text('state', { enum: WORK_STEP_STATES }).notNull().default('todo'),
    was_text: text('was_text'),
    change_reason: text('change_reason'),
    /** `{item_id, round, hr_item_id}` when the step came from a review decision. */
    from_review: text('from_review', { mode: 'json' }),
    /** `owner`, or the agent actor that added it. */
    added_by: text('added_by').notNull(),
    state_by: text('state_by'),
    state_at: text('state_at'),
    // ---- Step details (owner decision 33; BUILD_SPEC §4, §5.5) ----
    /** Markdown, ≤ 10,000 (checked by the tool and route schemas); null when the step has none. */
    details_md: text('details_md'),
    /** Where the step came from, ≤ 100, for example a Jira key. */
    source: text('source'),
    /** Goes up by one on every change to `details_md`; the owner's edits check it. */
    details_version: integer('details_version').notNull().default(0),
    version: version(),
    ...timestamps,
  },
  (t) => [
    index('work_steps_item').on(t.item_id, t.plan_version_no, t.position),
    check('work_steps_text', lenBetween('text', 1, STEP_TEXT_MAX)),
    check('work_steps_state', oneOf('state', WORK_STEP_STATES)),
  ],
);

export const runs = sqliteTable(
  'runs',
  {
    id: id(),
    item_id: itemRef('item_id'),
    parent_run_id: text('parent_run_id').references((): AnySQLiteColumn => runs.id, {
      onDelete: 'set null',
    }),
    client: text('client').notNull(),
    label: text('label'),
    session_id: text('session_id'),
    is_lead: integer('is_lead', { mode: 'boolean' }).notNull().default(false),
    state: text('state', { enum: STORED_RUN_STATES }).notNull().default('open'),
    last_signal_at: text('last_signal_at').notNull(),
    last_signal_kind: text('last_signal_kind', { enum: SIGNAL_KINDS }).notNull(),
    lease_expires_at: text('lease_expires_at'),
    summary: text('summary'),
    error: text('error'),
    current_step_id: text('current_step_id').references(() => work_steps.id, {
      onDelete: 'set null',
    }),
    // ---- Recovery (owner decision 26; BUILD_SPEC §5.16) ----
    /** Set on every terminal transition. */
    end_reason: text('end_reason', { enum: END_REASONS }),
    parked_reason: text('parked_reason'),
    /** `{items?, orchestrator?, person?, until?}` (MCP_SPEC §4 WaitingOn). */
    waiting_on: text('waiting_on', { mode: 'json' }),
    parked_at: text('parked_at'),
    /** `{host, repo, path, branch, base_ref, base_sha, head_sha, pushed_sha, dirty, updated_at}`. */
    workspace: text('workspace', { mode: 'json' }),
    /** `{name, dispatch_id, task_id, run_id}`. */
    orchestrator: text('orchestrator', { mode: 'json' }),
    /** The run's brief: an immutable `brief` document version. */
    brief_document_version_id: text('brief_document_version_id').references(
      (): AnySQLiteColumn => document_versions.id,
      { onDelete: 'set null' },
    ),
    /** A namespaced map, stored as it is and never interpreted (≤ 2 KB). */
    external: text('external', { mode: 'json' }),
    /** The owner's *Handled* on "Unpushed work may be lost". */
    unpushed_handled_at: text('unpushed_handled_at'),
    version: version(),
    ...timestamps,
  },
  (t) => [
    index('runs_item').on(t.item_id),
    index('runs_state').on(t.state),
    // At most one active lead run per item (A15, FR-013). A parked run keeps its claim (§5.16).
    uniqueIndex('runs_one_active_lead')
      .on(t.item_id)
      .where(sql.raw(`"is_lead" = 1 AND "state" IN ('open', 'needs_input', 'parked')`)),
    check('runs_state', oneOf('state', STORED_RUN_STATES)),
    check('runs_last_signal_kind', oneOf('last_signal_kind', SIGNAL_KINDS)),
    check('runs_end_reason', nullOrOneOf('end_reason', END_REASONS)),
    check(
      'runs_external',
      sql.raw(`"external" IS NULL OR length(CAST("external" AS BLOB)) <= ${EXTERNAL_MAX_BYTES}`),
    ),
  ],
);

export const run_resources = sqliteTable(
  'run_resources',
  {
    /** `rsc_…` */
    id: id(),
    run_id: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: RESOURCE_KINDS }).notNull(),
    label: text('label').notNull(),
    /** `{pid?, port?, session_id?, container?, path?, host?}` (MCP_SPEC §4 Resource). */
    locator: text('locator', { mode: 'json' }).notNull(),
    started_at: text('started_at').notNull(),
    released_at: text('released_at'),
    /** `owner`, or the agent actor (run) that released it. */
    released_by: text('released_by'),
    release_note: text('release_note'),
    ...timestamps,
  },
  (t) => [
    index('run_resources_run').on(t.run_id),
    index('run_resources_unreleased').on(t.released_at),
    check('run_resources_kind', oneOf('kind', RESOURCE_KINDS)),
    check('run_resources_label', lenBetween('label', 1, RESOURCE_LABEL_MAX)),
  ],
);

export const subagent_logs = sqliteTable(
  'subagent_logs',
  {
    id: id(),
    item_id: itemRef('item_id'),
    work_step_id: text('work_step_id').references(() => work_steps.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    outcome: text('outcome').notNull(),
    evidence: text('evidence'),
    provenance: text('provenance', { enum: SUBAGENT_PROVENANCES }).notNull(),
    child_run_id: text('child_run_id').references(() => runs.id, { onDelete: 'set null' }),
    reported_by_run_id: text('reported_by_run_id').references(() => runs.id, {
      onDelete: 'set null',
    }),
    ...timestamps,
  },
  (t) => [
    index('subagent_logs_item').on(t.item_id),
    check('subagent_logs_name', lenBetween('name', 1, SUBAGENT_NAME_MAX)),
    check('subagent_logs_outcome', lenBetween('outcome', 1, SUBAGENT_OUTCOME_MAX)),
    check('subagent_logs_provenance', oneOf('provenance', SUBAGENT_PROVENANCES)),
  ],
);

export const agent_checks = sqliteTable(
  'agent_checks',
  {
    id: id(),
    item_id: itemRef('item_id'),
    position: integer('position').notNull(),
    text: text('text').notNull(),
    state: text('state', { enum: CHECK_STATES }).notNull().default('todo'),
    evidence: text('evidence'),
    provenance: text('provenance', { enum: PROVENANCES }).notNull().default('agent'),
    /** `owner`, or the agent actor that added it. */
    added_by: text('added_by').notNull(),
    version: version(),
    ...timestamps,
  },
  (t) => [
    index('agent_checks_item').on(t.item_id, t.position),
    check('agent_checks_text', lenBetween('text', 1, STEP_TEXT_MAX)),
    check('agent_checks_state', oneOf('state', CHECK_STATES)),
    check('agent_checks_provenance', oneOf('provenance', PROVENANCES)),
  ],
);

export const hr_items = sqliteTable(
  'hr_items',
  {
    id: id(),
    item_id: itemRef('item_id'),
    position: integer('position').notNull(),
    text: text('text').notNull(),
    state: text('state', { enum: HUMAN_REVIEW_STATES }).notNull().default('declared'),
    /** `owner`, or the agent actor that added it. */
    added_by: text('added_by').notNull(),
    /** `{kind, note, round, at, result_ref}` (MCP_SPEC §4 HumanReviewItem). */
    last_decision: text('last_decision', { mode: 'json' }),
    follow_up_item_id: text('follow_up_item_id').references((): AnySQLiteColumn => items.id, {
      onDelete: 'set null',
    }),
    version: version(),
    ...timestamps,
  },
  (t) => [
    index('hr_items_item').on(t.item_id, t.position),
    check('hr_items_text', lenBetween('text', 1, STEP_TEXT_MAX)),
    check('hr_items_state', oneOf('state', HUMAN_REVIEW_STATES)),
  ],
);

export const packets = sqliteTable(
  'packets',
  {
    id: id(),
    item_id: itemRef('item_id'),
    round: integer('round').notNull(),
    /** sha256 of the canonical packet JSON; displayed as `pkt-` + its first 4 characters. */
    content_hash: text('content_hash').notNull(),
    built_from_commit: text('built_from_commit'),
    estimate: text('estimate'),
    how: text('how', { mode: 'json' }),
    checked: text('checked', { mode: 'json' }),
    gaps: text('gaps', { mode: 'json' }),
    created_by: text('created_by').notNull(),
    state: text('state', { enum: PACKET_STATES }).notNull().default('open'),
    /**
     * Decision 36 (BUILD_SPEC §5.21 Hand-off): the files the agent reported
     * (a JSON array; null when not reported: "Changed files not reported"),
     * its branch, and the undeclared parts that hold the packet (a JSON
     * array; null when not held).
     */
    changed_files: text('changed_files', { mode: 'json' }),
    branch: text('branch'),
    held_undeclared: text('held_undeclared', { mode: 'json' }),
    version: version(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('packets_item_round').on(t.item_id, t.round),
    // One open packet per item (FR-020).
    uniqueIndex('packets_one_open').on(t.item_id).where(sql.raw(`"state" = 'open'`)),
    check('packets_state', oneOf('state', PACKET_STATES)),
  ],
);

export const packet_items = sqliteTable(
  'packet_items',
  {
    id: id(),
    packet_id: text('packet_id')
      .notNull()
      .references(() => packets.id, { onDelete: 'cascade' }),
    hr_item_id: text('hr_item_id')
      .notNull()
      .references(() => hr_items.id, { onDelete: 'cascade' }),
    /** The item text as it was in this round. */
    text_snapshot: text('text_snapshot').notNull(),
    ...timestamps,
  },
  (t) => [uniqueIndex('packet_items_packet_hr').on(t.packet_id, t.hr_item_id)],
);

export const documents = sqliteTable(
  'documents',
  {
    id: id(),
    project_key: text('project_key')
      .notNull()
      .references(() => projects.key, { onDelete: 'cascade' }),
    item_id: text('item_id').references(() => items.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    kind: text('kind', { enum: DOC_KINDS }).notNull().default('other'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('documents_item_name').on(t.item_id, t.name),
    index('documents_project').on(t.project_key),
    check('documents_kind', oneOf('kind', DOC_KINDS)),
  ],
);

export const document_versions = sqliteTable(
  'document_versions',
  {
    id: id(),
    document_id: text('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    version_no: integer('version_no').notNull(),
    mime: text('mime').notNull(),
    size: integer('size').notNull(),
    sha256: text('sha256').notNull(),
    /** Relative to /data/docs: `<KEY>/<document_id>/v<n>/<filename>`. Immutable. */
    path: text('path').notNull(),
    created_by: text('created_by').notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('document_versions_doc_version').on(t.document_id, t.version_no),
    check('document_versions_size', sql.raw(`"size" >= 0`)),
  ],
);

export const packet_attachments = sqliteTable('packet_attachments', {
  id: id(),
  packet_id: text('packet_id')
    .notNull()
    .references(() => packets.id, { onDelete: 'cascade' }),
  document_version_id: text('document_version_id')
    .notNull()
    .references(() => document_versions.id, { onDelete: 'cascade' }),
  caption: text('caption'),
  ...timestamps,
});

export const review_decisions = sqliteTable(
  'review_decisions',
  {
    id: id(),
    packet_id: text('packet_id')
      .notNull()
      .references(() => packets.id, { onDelete: 'cascade' }),
    hr_item_id: text('hr_item_id')
      .notNull()
      .references(() => hr_items.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: REVIEW_KINDS }).notNull(),
    note: text('note'),
    into: text('into', { enum: REVIEW_INTO }),
    follow: text('follow', { enum: REVIEW_FOLLOW }),
    /** The work step or item a decision produced (e.g. the Bug for `into=bug`). */
    result_ref: text('result_ref'),
    decided_at: text('decided_at').notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('review_decisions_packet_hr').on(t.packet_id, t.hr_item_id),
    check('review_decisions_kind', oneOf('kind', REVIEW_KINDS)),
    check('review_decisions_into', oneOf('into', REVIEW_INTO)),
    check('review_decisions_follow', oneOf('follow', REVIEW_FOLLOW)),
    // A note is required for "changes" (FR-050).
    check(
      'review_decisions_changes_note',
      sql.raw(`"kind" <> 'changes' OR length(trim("note")) > 0`),
    ),
    check('review_decisions_note', maxLen('note', NOTE_MAX)),
  ],
);

export const questions = sqliteTable(
  'questions',
  {
    id: id(),
    item_id: itemRef('item_id'),
    run_id: text('run_id').references(() => runs.id, { onDelete: 'set null' }),
    text: text('text').notNull(),
    asked_by: text('asked_by').notNull(),
    answer: text('answer'),
    answered_at: text('answered_at'),
    read_by_agent_at: text('read_by_agent_at'),
    ...timestamps,
  },
  (t) => [
    index('questions_item').on(t.item_id),
    // At most one open question per item (FR-022).
    uniqueIndex('questions_one_open').on(t.item_id).where(sql.raw(`"answered_at" IS NULL`)),
    check('questions_text', lenBetween('text', 1, QUESTION_MAX)),
    check('questions_answer', maxLen('answer', NOTE_MAX)),
  ],
);

export const owner_notes = sqliteTable(
  'owner_notes',
  {
    id: id(),
    item_id: itemRef('item_id'),
    text: text('text').notNull(),
    read_by_agent_at: text('read_by_agent_at'),
    ...timestamps,
  },
  (t) => [
    index('owner_notes_item').on(t.item_id),
    check('owner_notes_text', lenBetween('text', 1, NOTE_MAX)),
  ],
);

export const commits = sqliteTable(
  'commits',
  {
    id: id(),
    item_id: itemRef('item_id'),
    /** The run that reported it, when the call carried `run_id` (BUILD_SPEC §5.16). */
    run_id: text('run_id').references((): AnySQLiteColumn => runs.id, { onDelete: 'set null' }),
    sha: text('sha').notNull(),
    branch: text('branch'),
    message: text('message'),
    pr_url: text('pr_url'),
    /** On the remote; with `run_id`, it sets the run's `workspace.pushed_sha`. */
    pushed: integer('pushed', { mode: 'boolean' }).notNull().default(false),
    reported_by: text('reported_by').notNull(),
    reported_at: text('reported_at').notNull(),
    ...timestamps,
  },
  (t) => [
    index('commits_item').on(t.item_id, t.reported_at),
    check(
      'commits_sha',
      sql.raw(`length("sha") BETWEEN 7 AND 40 AND lower("sha") NOT GLOB '*[^0-9a-f]*'`),
    ),
  ],
);

// ---- Agent setup (owner decision 29; BUILD_SPEC §5.17) ----

/**
 * One agent file (a skill, or the AGENTS.md block) in one layer: bundled,
 * the service-wide edit, or a project override. One row per key, layer and
 * project; its versions are immutable rows in `agent_file_versions`.
 */
export const agent_files = sqliteTable(
  'agent_files',
  {
    /** `af_…` */
    id: id(),
    /** `skill:<name>`, `agents_block` or `guide:onboarding` (B30). */
    key: text('key').notNull(),
    layer: text('layer', { enum: AGENT_FILE_LAYERS }).notNull(),
    /** Project layer only. */
    project_key: text('project_key').references(() => projects.key, { onDelete: 'cascade' }),
    /** The layer's current version; null only while the first version is being written. */
    current_version_id: text('current_version_id').references(
      (): AnySQLiteColumn => agent_file_versions.id,
      { onDelete: 'set null' },
    ),
    /** Edited layers: the bundled sha256 the edit was based on ("bundled version updated"). */
    bundled_hash_at_edit: text('bundled_hash_at_edit'),
    ...timestamps,
  },
  (t) => [
    // Unique (key, layer, project_key): SQLite treats NULLs as distinct, so one
    // partial index per case.
    uniqueIndex('agent_files_key_layer').on(t.key, t.layer).where(sql.raw(`"project_key" IS NULL`)),
    uniqueIndex('agent_files_key_project')
      .on(t.key, t.project_key)
      .where(sql.raw(`"project_key" IS NOT NULL`)),
    index('agent_files_project').on(t.project_key),
    check('agent_files_layer', oneOf('layer', AGENT_FILE_LAYERS)),
    check(
      'agent_files_project_layer',
      sql.raw(`("layer" = 'project') = ("project_key" IS NOT NULL)`),
    ),
    // B30 (decision 31; contract change): also exactly `guide:onboarding`, the onboarding
    // guide. It is served by onboard_project, never installed, and can't be proposed
    // (agent_file_proposals keeps the narrower check).
    check(
      'agent_files_key',
      sql.raw(
        `"key" = '${AGENTS_BLOCK_KEY}' OR "key" = '${ONBOARDING_GUIDE_KEY}' OR ("key" GLOB 'skill:?*' AND length("key") <= ${6 + AGENT_SETUP_LIMITS.skill_name} AND substr("key", 7) NOT GLOB '*[^a-z0-9-]*')`,
      ),
    ),
  ],
);

export const agent_file_versions = sqliteTable(
  'agent_file_versions',
  {
    /** `afv_…` */
    id: id(),
    file_id: text('file_id')
      .notNull()
      .references((): AnySQLiteColumn => agent_files.id, { onDelete: 'cascade' }),
    version_no: integer('version_no').notNull(),
    content: text('content').notNull(),
    sha256: text('sha256').notNull(),
    /** `owner`, or `system` for bundled versions loaded at startup. */
    author: text('author').notNull(),
    note: text('note'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('agent_file_versions_file_version').on(t.file_id, t.version_no),
    check('agent_file_versions_version_no', sql.raw(`"version_no" >= 1`)),
    check(
      'agent_file_versions_content',
      lenBetween('content', 1, AGENT_SETUP_LIMITS.agent_file_content),
    ),
    check('agent_file_versions_sha256', sql.raw(`length("sha256") = 64`)),
    check(
      'agent_file_versions_note',
      sql.raw(`"note" IS NULL OR length("note") <= ${AGENT_SETUP_LIMITS.note}`),
    ),
  ],
);

/** A project's Workflow notes, versioned; the newest is current (delivered in `get_context`). */
export const project_workflows = sqliteTable(
  'project_workflows',
  {
    /** `wf_…` */
    id: id(),
    project_key: text('project_key')
      .notNull()
      .references(() => projects.key, { onDelete: 'cascade' }),
    version_no: integer('version_no').notNull(),
    /** May be empty: an empty version clears the notes. */
    content_md: text('content_md').notNull(),
    author: text('author').notNull(),
    note: text('note'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('project_workflows_project_version').on(t.project_key, t.version_no),
    check('project_workflows_version_no', sql.raw(`"version_no" >= 1`)),
    check('project_workflows_content_md', maxLen('content_md', AGENT_SETUP_LIMITS.workflow_md)),
    check(
      'project_workflows_note',
      sql.raw(`"note" IS NULL OR length("note") <= ${AGENT_SETUP_LIMITS.note}`),
    ),
  ],
);

/**
 * An install of agent files (FR-124–FR-127). A command install keeps only
 * the sha256 of its single-use download token and when it expires (B21
 * resolution: the raw token is never stored, and single use survives a
 * restart); `token_used_at` is set when the bundle is downloaded.
 */
export const installs = sqliteTable(
  'installs',
  {
    /** `ins_…` */
    id: id(),
    at: text('at').notNull(),
    client: text('client', { enum: INSTALL_CLIENTS }).notNull(),
    target_kind: text('target_kind', { enum: INSTALL_TARGET_KINDS }).notNull(),
    project_key: text('project_key').references(() => projects.key, { onDelete: 'cascade' }),
    /** The host path; null for a command install the owner ran without one. */
    path: text('path'),
    method: text('method', { enum: INSTALL_METHODS }).notNull(),
    /** key → `{version_id, sha256}`. */
    manifest: text('manifest', { mode: 'json' }).notNull(),
    token_sha256: text('token_sha256'),
    token_expires_at: text('token_expires_at'),
    token_used_at: text('token_used_at'),
    ...timestamps,
  },
  (t) => [
    index('installs_at').on(t.at),
    index('installs_project').on(t.project_key),
    uniqueIndex('installs_token').on(t.token_sha256).where(sql.raw(`"token_sha256" IS NOT NULL`)),
    check('installs_client', oneOf('client', INSTALL_CLIENTS)),
    check('installs_target_kind', oneOf('target_kind', INSTALL_TARGET_KINDS)),
    check('installs_method', oneOf('method', INSTALL_METHODS)),
    check(
      'installs_path',
      sql.raw(`"path" IS NULL OR length("path") BETWEEN 1 AND ${AGENT_SETUP_LIMITS.install_path}`),
    ),
    check(
      'installs_token',
      sql.raw(
        `("token_sha256" IS NULL) = ("token_expires_at" IS NULL) AND ("method" = 'command' OR "token_sha256" IS NULL)`,
      ),
    ),
    check('installs_push_path', sql.raw(`"method" = 'command' OR "path" IS NOT NULL`)),
  ],
);

// ---- Agent proposals and drift (owner decision 30; BUILD_SPEC §4, §5.19) ----

/** `agents_block`, or `skill:<name>` with a name of `a-z0-9-` (as in agent_files). */
const installedKeyCheck = (column: string) =>
  `"${column}" = '${AGENTS_BLOCK_KEY}' OR ("${column}" GLOB 'skill:?*' AND length("${column}") <= ${6 + AGENT_SETUP_LIMITS.skill_name} AND substr("${column}", 7) NOT GLOB '*[^a-z0-9-]*')`;

export const agent_file_proposals = sqliteTable(
  'agent_file_proposals',
  {
    /** `afp_…` */
    id: id(),
    /** Null: a proposal to the default. */
    project_key: text('project_key').references(() => projects.key, { onDelete: 'cascade' }),
    /** `agents_block`, `workflow` or `skill:<name>`. */
    file_key: text('file_key').notNull(),
    /** The whole proposed text, as written. */
    content: text('content').notNull(),
    reason: text('reason').notNull(),
    /** The version the agent read (`afv_…` or `wf_…`, so not a foreign key); null for Workflow notes that didn't exist yet. */
    based_on_version_id: text('based_on_version_id'),
    run_id: text('run_id').references((): AnySQLiteColumn => runs.id, { onDelete: 'set null' }),
    /** The proposing agent, e.g. `codex · orca-w3`. */
    proposed_by: text('proposed_by').notNull(),
    state: text('state', { enum: PROPOSAL_STATES }).notNull().default('pending'),
    decided_at: text('decided_at'),
    decided_note: text('decided_note'),
    /** The version the approval saved (`afv_…` or `wf_…`). */
    result_version_id: text('result_version_id'),
    ...timestamps,
  },
  (t) => [
    index('agent_file_proposals_target').on(t.project_key, t.file_key, t.state),
    index('agent_file_proposals_run').on(t.run_id),
    check('agent_file_proposals_state', oneOf('state', PROPOSAL_STATES)),
    check(
      'agent_file_proposals_file_key',
      sql.raw(`"file_key" = '${WORKFLOW_KEY}' OR (${installedKeyCheck('file_key')})`),
    ),
    check(
      'agent_file_proposals_workflow_project',
      sql.raw(`"file_key" <> '${WORKFLOW_KEY}' OR "project_key" IS NOT NULL`),
    ),
    check(
      'agent_file_proposals_content',
      sql.raw(
        `CASE WHEN "file_key" = '${WORKFLOW_KEY}' THEN length("content") <= ${AGENT_SETUP_LIMITS.workflow_md} ELSE length("content") BETWEEN 1 AND ${AGENT_SETUP_LIMITS.agent_file_content} END`,
      ),
    ),
    check('agent_file_proposals_reason', sql.raw(`length("reason") BETWEEN 1 AND 500`)),
    check(
      'agent_file_proposals_decided_note',
      sql.raw(`"decided_note" IS NULL OR length("decided_note") <= 500`),
    ),
    check(
      'agent_file_proposals_decided',
      sql.raw(`("state" = 'pending') = ("decided_at" IS NULL)`),
    ),
  ],
);

export const instruction_reports = sqliteTable(
  'instruction_reports',
  {
    /** `irp_…` */
    id: id(),
    source: text('source', { enum: INSTRUCTION_REPORT_SOURCES }).notNull(),
    /** The claiming run (source agent). */
    run_id: text('run_id').references((): AnySQLiteColumn => runs.id, { onDelete: 'cascade' }),
    /** The install the report was compared with, when known. */
    install_id: text('install_id').references(() => installs.id, { onDelete: 'set null' }),
    /** Null for a user-wide install. */
    project_key: text('project_key').references(() => projects.key, { onDelete: 'cascade' }),
    /** Where: the workspace or install path, when known. */
    location: text('location'),
    /** key → `{sha256, content?}`. */
    files: text('files', { mode: 'json' }).notNull(),
    at: text('at').notNull(),
    ...timestamps,
  },
  (t) => [
    index('instruction_reports_run').on(t.run_id),
    index('instruction_reports_install').on(t.install_id, t.at),
    check('instruction_reports_source', oneOf('source', INSTRUCTION_REPORT_SOURCES)),
    check('instruction_reports_agent_run', sql.raw(`"source" <> 'agent' OR "run_id" IS NOT NULL`)),
    check(
      'instruction_reports_location',
      sql.raw(
        `"location" IS NULL OR length("location") BETWEEN 1 AND ${AGENT_SETUP_LIMITS.install_path}`,
      ),
    ),
  ],
);

export const drift = sqliteTable(
  'drift',
  {
    /** `dft_…` */
    id: id(),
    /** Drift is always against an install's manifest (B26 resolution 7). */
    install_id: text('install_id')
      .notNull()
      .references(() => installs.id, { onDelete: 'cascade' }),
    /** Null for a user-wide install: *Adopt* saves to the default. */
    project_key: text('project_key').references(() => projects.key, { onDelete: 'cascade' }),
    file_key: text('file_key').notNull(),
    /** edited, missing or extra (B26 resolution 7). */
    change: text('change', { enum: DRIFT_CHANGES }).notNull(),
    state: text('state', { enum: DRIFT_STATES }).notNull().default('open'),
    /** The installed file's hash; null when missing. *Keep local* keeps it as the accepted hash. */
    local_sha256: text('local_sha256'),
    /** The report that found it ("how it was found"; B26 resolution 7). */
    report_id: text('report_id').references((): AnySQLiteColumn => instruction_reports.id, {
      onDelete: 'set null',
    }),
    detected_at: text('detected_at').notNull(),
    resolved_at: text('resolved_at'),
    ...timestamps,
  },
  (t) => [
    // One open row per install and file.
    uniqueIndex('drift_open_install_file')
      .on(t.install_id, t.file_key)
      .where(sql.raw(`"state" = 'open'`)),
    index('drift_project_state').on(t.project_key, t.state),
    check('drift_state', oneOf('state', DRIFT_STATES)),
    check('drift_change', oneOf('change', DRIFT_CHANGES)),
    // Decision 32 (B31): drift also covers the project connection file, key `connection`.
    check(
      'drift_file_key',
      sql.raw(`"file_key" = 'connection' OR (${installedKeyCheck('file_key')})`),
    ),
    check(
      'drift_local_sha256',
      sql.raw(
        `CASE WHEN "change" = 'missing' THEN "local_sha256" IS NULL ELSE "local_sha256" IS NOT NULL AND length("local_sha256") = 64 END`,
      ),
    ),
    check('drift_resolved', sql.raw(`("state" = 'open') = ("resolved_at" IS NULL)`)),
  ],
);

/**
 * Onboarding sessions (owner decision 31; BUILD_SPEC §4, §5.20). An agent
 * starts one with onboard_project and finishes it with finish_onboarding;
 * the owner marks it reviewed. Events written during a session carry
 * `data.onboarding_session`, so the review card can count them.
 */
export const onboarding_sessions = sqliteTable(
  'onboarding_sessions',
  {
    /** `onb_…` */
    id: id(),
    project_key: text('project_key')
      .notNull()
      .references(() => projects.key, { onDelete: 'cascade' }),
    /** The agent that started it, e.g. `claude · orca-w3`. */
    started_by: text('started_by').notNull(),
    /** The client that started it: only it may resume or finish the session (B29). */
    client: text('client').notNull(),
    /** The run it was started under, if any. */
    run_id: text('run_id').references((): AnySQLiteColumn => runs.id, { onDelete: 'set null' }),
    started_at: text('started_at').notNull(),
    state: text('state', { enum: ONBOARDING_STATES }).notNull().default('in_progress'),
    summary: text('summary'),
    /** The agent's open questions: a JSON array of strings. */
    questions: text('questions', { mode: 'json' })
      .notNull()
      .default(sql`'[]'`),
    finished_at: text('finished_at'),
    reviewed_at: text('reviewed_at'),
    ...timestamps,
  },
  (t) => [
    // One session in progress per project (MCP_SPEC §5.11: another's is `forbidden`).
    uniqueIndex('onboarding_sessions_one_in_progress')
      .on(t.project_key)
      .where(sql.raw(`"state" = 'in_progress'`)),
    index('onboarding_sessions_project_state').on(t.project_key, t.state),
    check('onboarding_sessions_state', oneOf('state', ONBOARDING_STATES)),
    check(
      'onboarding_sessions_summary',
      sql.raw(
        `CASE WHEN "state" = 'in_progress' THEN "summary" IS NULL ELSE "summary" IS NOT NULL AND length("summary") BETWEEN 1 AND 4000 END`,
      ),
    ),
    check(
      'onboarding_sessions_questions',
      sql.raw(
        `json_valid("questions") AND json_type("questions") = 'array' AND json_array_length("questions") <= 20`,
      ),
    ),
    check(
      'onboarding_sessions_finished',
      sql.raw(`("state" = 'in_progress') = ("finished_at" IS NULL)`),
    ),
    check(
      'onboarding_sessions_reviewed',
      sql.raw(`("state" = 'reviewed') = ("reviewed_at" IS NOT NULL)`),
    ),
  ],
);

// ---- Shared changes (decision 36; BUILD_SPEC §5.21; B38) ----

/** A JSON array column of at most `max` entries. */
const jsonArray = (column: string, max: number): SQL =>
  sql.raw(
    `json_valid("${column}") AND json_type("${column}") = 'array' AND json_array_length("${column}") <= ${max}`,
  );

/**
 * The project's registry of shared parts (FR-158). `key` is kind-prefixed
 * and normalised (`normaliseSharedPartKey`); `paths` are repo-relative globs.
 * Agents register parts through declare_shared_changes, never single-writer;
 * the owner edits, marks single-writer and archives (the remove).
 */
export const shared_parts = sqliteTable(
  'shared_parts',
  {
    /** `spt_…` */
    id: id(),
    project_key: text('project_key')
      .notNull()
      .references(() => projects.key, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    kind: text('kind', { enum: SHARED_PART_KINDS }).notNull(),
    paths: text('paths', { mode: 'json' })
      .notNull()
      .default(sql`'[]'`),
    single_writer: integer('single_writer', { mode: 'boolean' }).notNull().default(false),
    note: text('note'),
    /** `owner`, or the agent (`claude · orca-w3`). */
    created_by: text('created_by').notNull(),
    archived_at: text('archived_at'),
    version: version(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('shared_parts_project_key').on(t.project_key, t.key),
    check('shared_parts_kind', oneOf('kind', SHARED_PART_KINDS)),
    check(
      'shared_parts_key',
      sql.raw(
        `length("key") BETWEEN 3 AND ${LIMITS.shared_part_key} AND substr("key", 1, length("kind") + 1) = "kind" || ':' AND length("key") > length("kind") + 1`,
      ),
    ),
    check('shared_parts_paths', jsonArray('paths', LIMITS.shared_part_paths_max)),
    check('shared_parts_note', maxLen('note', LIMITS.shared_part_note)),
  ],
);

/**
 * An item's declaration (FR-159): one row per part it will change. Parts are
 * named by key within the item's project; `items.shared_none_at` marks an
 * item that declared none.
 */
export const item_shared_changes = sqliteTable(
  'item_shared_changes',
  {
    /** `isc_…` */
    id: id(),
    item_id: itemRef('item_id'),
    part_key: text('part_key').notNull(),
    change: text('change', { enum: SHARED_CHANGES }).notNull(),
    note: text('note'),
    declared_by: text('declared_by').notNull(),
    declared_at: text('declared_at').notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('item_shared_changes_item_part').on(t.item_id, t.part_key),
    index('item_shared_changes_part').on(t.part_key),
    check('item_shared_changes_change', oneOf('change', SHARED_CHANGES)),
    check('item_shared_changes_note', maxLen('note', LIMITS.shared_change_note)),
  ],
);

/**
 * Two in-flight items that declare the same parts (FR-160). The pair is
 * stored in ID order (`item_a < item_b`) with `claimed_first`, so a pair has
 * one live row; the row is the owner question (Needs you kind `overlap`,
 * B38 resolution: not a `questions` row, so it never takes the item's one
 * open question). *Run one after the other* sets `sequenced` and `link_id`;
 * *They're compatible* sets `compatible` and `note`.
 */
export const part_overlaps = sqliteTable(
  'part_overlaps',
  {
    /** `pov_…` */
    id: id(),
    project_key: text('project_key')
      .notNull()
      .references(() => projects.key, { onDelete: 'cascade' }),
    item_a: itemRef('item_a'),
    item_b: itemRef('item_b'),
    /** The item that was in flight first: the blocker *Run one after the other* adds runs from it. */
    claimed_first: text('claimed_first').notNull(),
    /** The shared keys, a JSON array. */
    parts: text('parts', { mode: 'json' }).notNull(),
    state: text('state', { enum: OVERLAP_STATES }).notNull().default('open'),
    note: text('note'),
    link_id: text('link_id').references((): AnySQLiteColumn => links.id, { onDelete: 'set null' }),
    raised_at: text('raised_at').notNull(),
    decided_by: text('decided_by'),
    decided_at: text('decided_at'),
    version: version(),
    ...timestamps,
  },
  (t) => [
    // One live row per pair: re-claiming the same pair doesn't open a second question.
    uniqueIndex('part_overlaps_live_pair')
      .on(t.item_a, t.item_b)
      .where(sql.raw(`"state" <> 'resolved'`)),
    index('part_overlaps_project_state').on(t.project_key, t.state),
    index('part_overlaps_item_b').on(t.item_b),
    check('part_overlaps_order', sql.raw(`"item_a" < "item_b"`)),
    check('part_overlaps_first', sql.raw(`"claimed_first" IN ("item_a", "item_b")`)),
    check('part_overlaps_state', oneOf('state', OVERLAP_STATES)),
    check('part_overlaps_parts', sql.raw(`json_valid("parts") AND json_type("parts") = 'array'`)),
    check('part_overlaps_note', maxLen('note', LIMITS.shared_decision_note)),
    check(
      'part_overlaps_decided',
      sql.raw(`("state" IN ('sequenced', 'compatible')) <= ("decided_at" IS NOT NULL)`),
    ),
  ],
);

/** A lease on a single-writer part (FR-161): one live lease per part. */
export const part_leases = sqliteTable(
  'part_leases',
  {
    /** `pls_…` */
    id: id(),
    project_key: text('project_key')
      .notNull()
      .references(() => projects.key, { onDelete: 'cascade' }),
    part_key: text('part_key').notNull(),
    item_id: itemRef('item_id'),
    run_id: text('run_id').references((): AnySQLiteColumn => runs.id, { onDelete: 'set null' }),
    taken_at: text('taken_at').notNull(),
    expires_at: text('expires_at').notNull(),
    ended_at: text('ended_at'),
    end_reason: text('end_reason', { enum: LEASE_END_REASONS }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('part_leases_one_live')
      .on(t.project_key, t.part_key)
      .where(sql.raw(`"ended_at" IS NULL`)),
    index('part_leases_item').on(t.item_id),
    check('part_leases_end_reason', nullOrOneOf('end_reason', LEASE_END_REASONS)),
    check('part_leases_ended', sql.raw(`("ended_at" IS NULL) = ("end_reason" IS NULL)`)),
  ],
);

/**
 * A hand-off held for changes to parts the item didn't declare (FR-162; B38
 * resolution: its own table, since a `set_status done` hold has no packet).
 * The row is the owner question (Needs you kind `undeclared_parts`).
 */
export const undeclared_holds = sqliteTable(
  'undeclared_holds',
  {
    /** `udh_…` */
    id: id(),
    item_id: itemRef('item_id'),
    packet_id: text('packet_id').references((): AnySQLiteColumn => packets.id, {
      onDelete: 'set null',
    }),
    via: text('via', { enum: UNDECLARED_HOLD_VIA }).notNull(),
    /** The undeclared keys, a JSON array. */
    parts: text('parts', { mode: 'json' }).notNull(),
    /** The changed files that mapped to them, a JSON array. */
    files: text('files', { mode: 'json' }).notNull(),
    state: text('state', { enum: UNDECLARED_HOLD_STATES }).notNull().default('open'),
    note: text('note'),
    decided_by: text('decided_by'),
    decided_at: text('decided_at'),
    version: version(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('undeclared_holds_one_open').on(t.item_id).where(sql.raw(`"state" = 'open'`)),
    check('undeclared_holds_via', oneOf('via', UNDECLARED_HOLD_VIA)),
    check('undeclared_holds_state', oneOf('state', UNDECLARED_HOLD_STATES)),
    check(
      'undeclared_holds_parts',
      sql.raw(`json_valid("parts") AND json_type("parts") = 'array'`),
    ),
    check('undeclared_holds_files', jsonArray('files', LIMITS.changed_files_max)),
    check('undeclared_holds_note', maxLen('note', LIMITS.shared_decision_note)),
    check('undeclared_holds_decided', sql.raw(`("state" = 'open') = ("decided_at" IS NULL)`)),
  ],
);

/**
 * A conflict the radar found (FR-163): a trial merge of `branch_a` with
 * `branch_b` (another in-flight branch, or the main branch) that doesn't
 * merge cleanly. One open finding per branch pair; it clears when the trial
 * merge is clean.
 */
export const radar_findings = sqliteTable(
  'radar_findings',
  {
    /** `rdf_…` */
    id: id(),
    project_key: text('project_key')
      .notNull()
      .references(() => projects.key, { onDelete: 'cascade' }),
    branch_a: text('branch_a').notNull(),
    branch_b: text('branch_b').notNull(),
    item_a: text('item_a').references((): AnySQLiteColumn => items.id, { onDelete: 'cascade' }),
    /** Null when `branch_b` is the main branch. */
    item_b: text('item_b').references((): AnySQLiteColumn => items.id, { onDelete: 'cascade' }),
    /**
     * B40: how the radar knew each item's branch, `reported` (an agent or the
     * owner named it) or `discovered` (the radar matched the item's key to a
     * local branch); `source_b` is null for the main branch. Checked in code
     * (BRANCH_SOURCES), so the column needs no table rebuild.
     */
    source_a: text('source_a'),
    source_b: text('source_b'),
    /** The conflicting files, a JSON array. */
    files: text('files', { mode: 'json' }).notNull(),
    seen_at: text('seen_at').notNull(),
    cleared_at: text('cleared_at'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('radar_findings_open_pair')
      .on(t.project_key, t.branch_a, t.branch_b)
      .where(sql.raw(`"cleared_at" IS NULL`)),
    index('radar_findings_item_a').on(t.item_a),
    index('radar_findings_item_b').on(t.item_b),
    check('radar_findings_files', sql.raw(`json_valid("files") AND json_type("files") = 'array'`)),
    check('radar_findings_branches', sql.raw(`"branch_a" <> "branch_b"`)),
  ],
);

/**
 * The owner's acknowledgement of a problem (owner decision 37; BUILD_SPEC
 * §5.22 Problems): the problem leaves Needs you until it needs a human step
 * again. `kind`, `branches` and `facts` are what was acknowledged: the
 * problem comes back when its kind differs, it names a branch not in
 * `branches`, or a fact (a conflicting file, for a radar finding; the items
 * or resources involved, otherwise) not in `facts`, or when a proposed
 * resolution arrives after `created_at`. The newest row for a problem counts.
 */
export const problem_acks = sqliteTable(
  'problem_acks',
  {
    /** `pak_…` */
    id: id(),
    /** The problem's ID (`rdf_…`, or `<kind>:<item, run or link>`; Problems' `id`). */
    problem_id: text('problem_id').notNull(),
    project_key: text('project_key').references((): AnySQLiteColumn => projects.key, {
      onDelete: 'cascade',
    }),
    item_id: text('item_id').references((): AnySQLiteColumn => items.id, { onDelete: 'cascade' }),
    /** Problems' `kind`; checked in code, so a new kind needs no table rebuild. */
    kind: text('kind').notNull(),
    /** The branches the problem named, a JSON array (empty for kinds without branches). */
    branches: text('branches', { mode: 'json' }).notNull(),
    /** The facts it was acknowledged with, a JSON array. */
    facts: text('facts', { mode: 'json' }).notNull(),
    /** `owner`, or a decision's maker: who acknowledged it. */
    acked_by: text('acked_by').notNull(),
    ...timestamps,
  },
  (t) => [
    index('problem_acks_problem').on(t.problem_id),
    check('problem_acks_problem_id', lenBetween('problem_id', 1, LIMITS.problem_id)),
    check(
      'problem_acks_branches',
      sql.raw(`json_valid("branches") AND json_type("branches") = 'array'`),
    ),
    check('problem_acks_facts', sql.raw(`json_valid("facts") AND json_type("facts") = 'array'`)),
  ],
);

/**
 * An agent's proposed resolution of a problem, or of a problem with the item
 * in general (owner decision 37; MCP_SPEC §5.16 `propose_resolution`). Open
 * until the owner approves it, asks for a different way (with a note) or
 * acknowledges it; a newer proposal for the same problem supersedes an open
 * one.
 */
export const resolutions = sqliteTable(
  'resolutions',
  {
    /** `prs_…` */
    id: id(),
    item_id: itemRef('item_id'),
    /** The problem it resolves; null for one about the item in general. */
    problem_id: text('problem_id'),
    /** The problem's `kind` when proposed; checked in code. */
    problem_kind: text('problem_kind'),
    kind: text('kind', { enum: RESOLUTION_KINDS }).notNull(),
    plan_md: text('plan_md').notNull(),
    reason: text('reason').notNull(),
    /** `claude · orca-w3`: who proposed it. */
    proposed_by: text('proposed_by').notNull(),
    run_id: text('run_id').references((): AnySQLiteColumn => runs.id, { onDelete: 'set null' }),
    state: text('state', { enum: RESOLUTION_STATES }).notNull().default('open'),
    note: text('note'),
    decided_by: text('decided_by'),
    decided_at: text('decided_at'),
    version: version(),
    ...timestamps,
  },
  (t) => [
    index('resolutions_item').on(t.item_id),
    index('resolutions_open').on(t.state),
    check('resolutions_kind', oneOf('kind', RESOLUTION_KINDS)),
    check('resolutions_state', oneOf('state', RESOLUTION_STATES)),
    check('resolutions_plan', lenBetween('plan_md', 1, LIMITS.resolution_plan)),
    check('resolutions_reason', lenBetween('reason', 1, LIMITS.resolution_reason)),
    check('resolutions_note', maxLen('note', LIMITS.resolution_note)),
    check(
      'resolutions_decided',
      sql.raw(`("state" IN ('open', 'superseded')) = ("decided_at" IS NULL)`),
    ),
  ],
);

export const artifacts = sqliteTable(
  'artifacts',
  {
    id: id(),
    item_id: itemRef('item_id'),
    kind: text('kind', { enum: ARTIFACT_KINDS }).notNull(),
    label: text('label').notNull(),
    url: text('url'),
    state: text('state'),
    provenance: text('provenance', { enum: PROVENANCES }).notNull().default('agent'),
    ...timestamps,
  },
  (t) => [
    index('artifacts_item').on(t.item_id),
    check('artifacts_kind', oneOf('kind', ARTIFACT_KINDS)),
    check('artifacts_provenance', oneOf('provenance', PROVENANCES)),
  ],
);

export const events = sqliteTable(
  'events',
  {
    /** The change cursor read by `get_changes` and `/api/stream`. */
    seq: integer('seq').primaryKey({ autoIncrement: true }),
    at: text('at').notNull(),
    actor_kind: text('actor_kind', { enum: ACTOR_KINDS }).notNull(),
    client: text('client'),
    label: text('label'),
    run_id: text('run_id'),
    project_key: text('project_key'),
    item_id: text('item_id'),
    /** One of EVENT_TYPES (validated in code; no CHECK, so a new type needs no table rebuild). */
    type: text('type').notNull(),
    /** The one line shown in Activity. */
    summary: text('summary').notNull(),
    /** Old and new values, plus `objects: [{kind, id}]`. Never sent to agents. */
    data: text('data', { mode: 'json' }),
    /** Row operations that reverse this event, for owner undo; null when not undoable. */
    inverse: text('inverse', { mode: 'json' }),
    mutation_id: text('mutation_id').notNull(),
    idempotency_key: text('idempotency_key'),
  },
  (t) => [
    index('events_mutation').on(t.mutation_id),
    index('events_item').on(t.item_id, t.seq),
    index('events_project').on(t.project_key, t.seq),
    check('events_actor_kind', oneOf('actor_kind', ACTOR_KINDS)),
  ],
);

export const idempotency = sqliteTable(
  'idempotency',
  {
    id: id(),
    key: text('key').notNull(),
    /** The calling client (`owner` for the owner), so keys never collide across clients. */
    client: text('client').notNull(),
    request_hash: text('request_hash').notNull(),
    response: text('response', { mode: 'json' }).notNull(),
    expires_at: text('expires_at').notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('idempotency_client_key').on(t.client, t.key),
    index('idempotency_expires').on(t.expires_at),
    check('idempotency_key_length', lenBetween('key', 1, 100)),
  ],
);

export const decision_records = sqliteTable(
  'decision_records',
  {
    /** `dec_…` */
    id: id(),
    project_key: text('project_key')
      .notNull()
      .references(() => projects.key, { onDelete: 'cascade' }),
    scope_kind: text('scope_kind', { enum: DECISION_SCOPE_KINDS }).notNull(),
    /** Item ID for epic and item scope, label name for label scope, null for project scope. */
    scope_id: text('scope_id'),
    title: text('title').notNull(),
    decision_md: text('decision_md').notNull(),
    rationale_md: text('rationale_md'),
    authority: text('authority', { enum: DECISION_AUTHORITIES }).notNull(),
    author: text('author').notNull(),
    status: text('status', { enum: DECISION_STATUSES }).notNull().default('active'),
    supersedes_id: text('supersedes_id').references((): AnySQLiteColumn => decision_records.id, {
      onDelete: 'set null',
    }),
    confirmed_at: text('confirmed_at'),
    /**
     * Decision 38 (B44): when the owner acknowledged an agent's project-wide
     * record on Needs you (kept as an agent decision); null until then.
     */
    acknowledged_at: text('acknowledged_at'),
    /**
     * Decision 38 (B44): 1 for agent project records that predate the review
     * card; Needs you shows them as one grouped card, not one card each.
     */
    review_grouped: integer('review_grouped', { mode: 'boolean' }).notNull().default(false),
    version: version(),
    ...timestamps,
  },
  (t) => [
    index('decision_records_scope').on(t.project_key, t.scope_kind, t.scope_id),
    check('decision_records_scope_kind', oneOf('scope_kind', DECISION_SCOPE_KINDS)),
    check('decision_records_authority', oneOf('authority', DECISION_AUTHORITIES)),
    check('decision_records_status', oneOf('status', DECISION_STATUSES)),
    check('decision_records_title', lenBetween('title', 1, DECISION_TITLE_MAX)),
    check('decision_records_decision_md', lenBetween('decision_md', 1, DECISION_MD_MAX)),
    check(
      'decision_records_scope_id',
      sql.raw(`("scope_kind" = 'project') = ("scope_id" IS NULL)`),
    ),
  ],
);

export const owner_sessions = sqliteTable('owner_sessions', {
  /** sha256 of the session ID; the raw ID only ever exists in the cookie. */
  id: id(),
  last_seen_at: text('last_seen_at').notNull(),
  user_agent: text('user_agent'),
  ...timestamps,
});

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }),
  ...timestamps,
});

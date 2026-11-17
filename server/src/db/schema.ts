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
  INSTALL_CLIENTS,
  INSTALL_METHODS,
  INSTALL_TARGET_KINDS,
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
} from '@tasklite/shared';
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
    /** `skill:<name>` or `agents_block`. */
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
    check(
      'agent_files_key',
      sql.raw(
        `"key" = '${AGENTS_BLOCK_KEY}' OR ("key" GLOB 'skill:?*' AND length("key") <= ${6 + AGENT_SETUP_LIMITS.skill_name} AND substr("key", 7) NOT GLOB '*[^a-z0-9-]*')`,
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

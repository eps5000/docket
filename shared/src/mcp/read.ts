/**
 * Orientation and finding tools (MCP_SPEC §5.1–5.2): input and output schemas.
 * Shared contract file (tasks.md, Slice rules).
 */
import { z } from 'zod';
import { AGENT_FILTERS } from '../enums.js';
import {
  agentLabel,
  cursor,
  itemId,
  nextCursor,
  pageLimit,
  projectKey,
  readInput,
  readOutput,
  text,
} from './common.js';
import { LABEL_NAME_RE, LIMITS, TEXT_LIMITS } from './limits.js';
import {
  contextBudgetSchema,
  contextBundleSchema,
  eventRowSchema,
  eventTypeSchema,
  itemSchema,
  itemSummarySchema,
  itemSummaryViewSchema,
  itemTypeInputSchema,
  itemViewSchema,
  statusSchema,
} from './types.js';

const labelName = z.string().trim().max(LIMITS.label_name).regex(LABEL_NAME_RE, {
  error: 'Expected a label name: lowercase a-z, 0-9 and -.',
});

// ---- whoami ----

export const whoamiInput = readInput({});
export const whoamiOutput = readOutput({
  client: z.string(),
  session_id: z.string(),
  server_version: z.string(),
  server_time: z.string(),
  limits: z.object({
    page_max: z.number().int(),
    changes_max: z.number().int(),
    document_mcp_bytes: z.number().int(),
    text_limits: z.record(z.string(), z.number().int()),
  }),
  live_window_s: z.number().int(),
  stale_after_s: z.number().int(),
  lease_s: z.number().int(),
});

/** The limits `whoami` reports (§5.1). */
export const WHOAMI_LIMITS = {
  page_max: LIMITS.page_max,
  changes_max: LIMITS.changes_max,
  document_mcp_bytes: LIMITS.document_mcp_bytes,
  text_limits: {
    title: TEXT_LIMITS.title,
    step: TEXT_LIMITS.step,
    note: TEXT_LIMITS.note,
    question: TEXT_LIMITS.question,
    description_md: TEXT_LIMITS.markdown,
    outcome_md: TEXT_LIMITS.markdown,
    brief_md: TEXT_LIMITS.brief_md,
  },
} as const;

// ---- list_projects ----

export const listProjectsInput = readInput({});
export const listProjectsOutput = readOutput({
  projects: z.array(
    z.object({
      key: z.string(),
      name: z.string(),
      counts: z.object({
        open: z.number().int(),
        ready_to_start: z.number().int(),
        in_progress: z.number().int(),
        review: z.number().int(),
        blocked: z.number().int(),
      }),
    }),
  ),
});

// ---- search_items ----

/**
 * Decisions 65 and 67: `needs_shaping`, the inferred-type marks and `rollout`
 * come with every read that doesn't name its fields, and aren't fields to
 * pick: the text-only tool list is at its budget.
 */
const UNPICKED = ['needs_shaping', 'type_inferred', 'type_original', 'rollout'] as const;
type SummaryField = Exclude<keyof typeof itemSummarySchema.shape, (typeof UNPICKED)[number]>;
export const ITEM_SUMMARY_FIELDS = Object.keys(itemSummarySchema.shape).filter(
  (k) => !(UNPICKED as readonly string[]).includes(k),
) as [SummaryField, ...SummaryField[]];

export const searchItemsInput = readInput({
  project: projectKey.optional(),
  /** Matches ID, title, description, labels and Jira key. */
  text: text(TEXT_LIMITS.title).optional(),
  filter: z.enum(AGENT_FILTERS).optional(),
  status: z.array(statusSchema).min(1).optional(),
  type: z.array(itemTypeInputSchema).min(1).optional(),
  label: labelName.optional(),
  epic: itemId.optional(),
  include_archived: z.boolean().default(true),
  fields: z.array(z.enum(ITEM_SUMMARY_FIELDS)).min(1).optional(),
  /** Narrows filter `mine` to one agent label (B3 resolution 2). */
  agent_label: agentLabel.optional(),
  cursor: cursor.optional(),
  limit: pageLimit,
});
export const searchItemsOutput = readOutput({
  items: z.array(itemSummaryViewSchema),
  next_cursor: nextCursor,
});

// ---- get_item ----

type ItemField = Exclude<keyof typeof itemSchema.shape, 'needs_shaping'>;
export const ITEM_FIELDS = Object.keys(itemSchema.shape).filter((k) => k !== 'needs_shaping') as [
  ItemField,
  ...ItemField[],
];

export const itemViewNameSchema = z.enum(['summary', 'standard', 'full']);

export const getItemInput = readInput({
  id: itemId,
  view: itemViewNameSchema.default('standard'),
  fields: z.array(z.enum(ITEM_FIELDS)).min(1).optional(),
  /** Used to attribute delivery. */
  agent_label: agentLabel.optional(),
});
export const getItemOutput = readOutput({ item: itemViewSchema });

// ---- get_context ----

export const getContextInput = readInput({
  id: itemId,
  /** About 1k, 3k and 8k tokens. */
  budget: contextBudgetSchema.default('medium'),
});
export const getContextOutput = readOutput({ context: contextBundleSchema });

// ---- dependency_subgraph ----

export const dependencySubgraphInput = readInput({
  id: itemId,
  depth: z.number().int().min(1).max(LIMITS.subgraph_depth_max).default(2),
  direction: z.enum(['up', 'down', 'both']).default('both'),
  delay_days: z.number().min(0).optional(),
});
export const dependencySubgraphOutput = readOutput({
  nodes: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      status: statusSchema,
      blocked: z.boolean(),
      planned_start: z.string().nullable(),
      planned_end: z.string().nullable(),
      date_source: z.enum(['entered', 'none']),
      effort: z.number().nullable(),
    }),
  ),
  edges: z.array(z.object({ from: z.string(), to: z.string(), type: z.literal('blocks') })),
  cycles: z.array(z.array(z.string())),
  at_risk: z.array(z.object({ id: z.string(), reason: z.string() })),
});

// ---- deferred_reviews ----

export const deferredReviewsInput = readInput({
  project: projectKey.optional(),
  cursor: cursor.optional(),
  limit: pageLimit,
});
export const deferredReviewsOutput = readOutput({
  items: z.array(
    z.object({
      item_id: z.string(),
      title: z.string(),
      hr_item_id: z.string(),
      text: z.string(),
      note: z.string().nullable(),
      deferred_at: z.string(),
      follow_up: z.object({ id: z.string(), status: statusSchema }).nullable(),
    }),
  ),
  next_cursor: nextCursor,
});

// ---- get_changes ----

export const getChangesInput = readInput({
  cursor: cursor.optional(),
  project: projectKey.optional(),
  item_id: itemId.optional(),
  types: z.array(eventTypeSchema).min(1).optional(),
  limit: z.number().int().min(1).max(LIMITS.changes_max).default(LIMITS.changes_default),
  /** Decision 40: hold the call up to this many seconds for a matching event (needs `cursor`). */
  wait_s: z.number().int().min(1).max(LIMITS.changes_wait_s).optional(),
});
export const getChangesOutput = readOutput({
  events: z.array(eventRowSchema),
  next_cursor: nextCursor,
});

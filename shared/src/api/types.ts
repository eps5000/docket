/**
 * Response types the UI API shares across route groups (tasks.md T044).
 * They extend the MCP shared types (MCP_SPEC §4) where the shapes match,
 * so the owner and agents read the same records (constitution Principle II).
 *
 * Shared contract file (tasks.md, Slice rules).
 */
import { z } from 'zod';
import { ACTOR_KINDS, SIGNAL_KINDS } from '../enums.js';
import {
  eventRowSchema,
  itemSummarySchema,
  runStateSchema,
  satisfiedWhenSchema,
  runActivitySchema,
  statusSchema,
  waitingOnSchema,
} from '../mcp/types.js';

/** A project as the shell knows it (BUILD_SPEC §4 `projects`). */
export const projectSchema = z.object({
  key: z.string(),
  name: z.string(),
  short_name: z.string(),
  color: z.string(),
  default_satisfied_when: satisfiedWhenSchema,
  version: z.number().int(),
  /**
   * The agent that created it through onboard_project (`claude · orca-w3`); null
   * when the owner, the seed or a Jira import did. Drives the "created by <agent>
   * · review" chip (decision 31; UI_SPEC §6.7d; optional; B29).
   */
  created_by: z.string().nullable().optional(),
  /** Decision 42: coordinators the owner registered, who may use `update_run_status` here. */
  coordinators: z.array(z.string()).optional(),
});
export type Project = z.infer<typeof projectSchema>;

/** A label and its brief (BUILD_SPEC §4 `labels`). */
export const labelSchema = z.object({
  project: z.string(),
  name: z.string(),
  brief_md: z.string().nullable(),
  brief_by: z.string().nullable(),
  brief_at: z.string().nullable(),
});
export type Label = z.infer<typeof labelSchema>;

/** An item summary plus the text fields the owner edits inline (decision 22). */
export const itemTextSchema = itemSummarySchema.extend({
  description_md: z.string(),
  outcome_md: z.string(),
  acceptance: z.array(z.string()),
});
export type ItemText = z.infer<typeof itemTextSchema>;

/**
 * What a parked lead waits on, for the one-line run state on cards, the epic's
 * Tickets list and Agents rows ("parked · waiting on the coordinator · claude";
 * UI_SPEC §5). UI API only (B20): agents read `Run.parked` through get_item.
 * Null when the lead isn't parked.
 */
export const leadParkedSchema = z.object({
  waiting_on: waitingOnSchema,
  since: z.string(),
  resume_ready: z.boolean(),
  /** Decision 42: newer activity while it is parked. */
  activity: runActivitySchema.optional(),
});
export type LeadParked = z.infer<typeof leadParkedSchema>;

/** A row on Work (board, list, map): what the cards and the list need beyond the summary. */
export const workItemSchema = itemSummarySchema.extend({
  /** The lead's park, when it is parked (B20). */
  lead_parked: leadParkedSchema.nullable().optional(),
  /** Decision 42: the story's producer, and whether it is between workers. */
  producer: z.object({ name: z.string(), between_workers: z.boolean() }).optional(),
  /** Review cards with a ready packet open the packet screen directly (UI_SPEC §6.2.1). */
  packet_ready: z.boolean(),
  for_you: z.boolean(),
  last_activity_at: z.string(),
  /**
   * Decision 36 (UI_SPEC §6.3.6; B39): the card's small markers, "overlap" (an
   * undecided overlap question) and "conflict ahead" (an open radar finding).
   * Present only when one is true.
   */
  shared_flags: z.object({ overlap: z.boolean(), conflict: z.boolean() }).optional(),
});
export type WorkItem = z.infer<typeof workItemSchema>;

/** An Activity row: the event row agents see, plus who kind of actor it was. */
export const activityRowSchema = eventRowSchema.extend({
  actor_kind: z.enum(ACTOR_KINDS),
  project: z.string().nullable(),
  /**
   * A review that kept approval notes as owner decisions (owner decision 35):
   * those decisions' IDs, so the row links to them. Absent otherwise.
   */
  decision_ids: z.array(z.string()).optional(),
});
export type ActivityRow = z.infer<typeof activityRowSchema>;

/** An epic on the Epics row and the epic page header. */
export const epicCardSchema = itemSummarySchema.extend({
  children: z.object({
    total: z.number().int(),
    done: z.number().int(),
    by_status: z.partialRecord(statusSchema, z.number().int()),
    /** Children with a packet ready or an open question ("N for you", UI_SPEC §4). */
    for_you: z.number().int(),
  }),
});
export type EpicCard = z.infer<typeof epicCardSchema>;

/** A link between two items on the map and the Dependencies tab. */
export const linkEdgeSchema = z.object({
  link_id: z.string(),
  from: z.string(),
  to: z.string(),
  type: z.enum(['blocks', 'relates']),
  /** Blocks links only. */
  satisfied_when: satisfiedWhenSchema.nullable(),
  cleared: z.boolean().nullable(),
});
export type LinkEdge = z.infer<typeof linkEdgeSchema>;

/** `/readyz` checks, also shown by the sidebar health line. */
export const healthSchema = z.object({
  status: z.enum(['ready', 'not_ready']),
  checks: z.record(z.string(), z.string()),
});
export type Health = z.infer<typeof healthSchema>;

/** Counts per displayed run state (Needs you agents strip, sidebar). */
export const runStateCountsSchema = z.partialRecord(runStateSchema, z.number().int());

/** P50/P85 forecast, or why there is none yet (BUILD_SPEC §5.9; decision T11). */
export const forecastSchema = z.discriminatedUnion('available', [
  z.object({
    available: z.literal(true),
    p50: z.string(),
    p85: z.string(),
    /** Effort per week over the window. */
    rate_per_week: z.number(),
    window_weeks: z.number().int(),
    /** Completed estimated items in the window. */
    n: z.number().int(),
    excludes_unestimated: z.number().int(),
  }),
  z.object({
    available: z.literal(false),
    /** "No forecast yet: needs 8 completed items with effort (have N)". */
    reason: z.string(),
    have: z.number().int(),
  }),
]);
export type Forecast = z.infer<typeof forecastSchema>;

/** Signal kinds, re-exported for the agents table. */
export const signalKindSchema = z.enum(SIGNAL_KINDS);

/**
 * The Overview page's read API (owner decision 43; BUILD_SPEC §5.24; UI_SPEC
 * §6.1). Each metric is defined once, on the server (`domain/overview.ts`).
 * Needs you keeps its own route, `needsYouCount` and `agents_now`, so each
 * sidebar badge and the page read one number from one response. Shared contract file (tasks.md, Slice rules).
 */
import { z } from 'zod';
import { itemTypeSchema, statusSchema } from '../mcp/types.js';
import { input, jsonResponse, noInput, scopeSchema } from './common.js';
import { json, route } from './route.js';

export const OVERVIEW_WINDOWS = ['24h', '7d', '30d'] as const;
export type OverviewWindow = (typeof OVERVIEW_WINDOWS)[number];
export const DEFAULT_OVERVIEW_WINDOW: OverviewWindow = '7d';
export const overviewWindowSchema = z.enum(OVERVIEW_WINDOWS);

/** The lists behind the numbers that no Work filter can show exactly. */
export const OVERVIEW_METRICS = [
  'completed',
  'agents_working',
  'agents_waiting',
  'in_flight',
  'no_epic',
] as const;
export type OverviewMetric = (typeof OVERVIEW_METRICS)[number];

/** Workload buckets. Each open ticket is in exactly one; a blocked ticket is in `blocked`. */
export const WORKLOAD_BUCKETS = [
  'review',
  'progress',
  'ready',
  'blocked',
  'planning',
  'inbox',
] as const;
export type WorkloadBucket = (typeof WORKLOAD_BUCKETS)[number];

export const overviewQuery = input({
  scope: scopeSchema,
  window: overviewWindowSchema.default(DEFAULT_OVERVIEW_WINDOW),
});

const workloadCounts = z.object({
  review: z.number().int(),
  progress: z.number().int(),
  ready: z.number().int(),
  blocked: z.number().int(),
  planning: z.number().int(),
  inbox: z.number().int(),
});

/** A chart bucket lists at most this many tickets, newest first; `count` is always the whole number. */
export const OVERVIEW_BUCKET_TICKETS = 6;

const completedBucket = z.object({
  key: z.string(),
  label: z.string(),
  count: z.number().int(),
  /** The newest `OVERVIEW_BUCKET_TICKETS` of the tickets in `count`. */
  tickets: z.array(z.object({ id: z.string(), title: z.string() })),
});

const flowBucket = z.object({
  key: z.string(),
  label: z.string(),
  finished: z.number().int(),
  merged: z.number().int(),
  parked: z.number().int(),
});

/** Flow trends (owner decision 48; BUILD_SPEC §5.29), over the same window and buckets. */
const flowSchema = z.object({
  granularity: z.enum(['hour', 'day']),
  buckets: z.array(flowBucket),
  /** The Completed count. */
  finished: z.number().int(),
  /** Distinct PRs first recorded as merged in the window. Never estimated. */
  merged: z.number().int(),
  /** `run.parked` events on tickets. Epics are excluded. */
  parked: z.number().int(),
  /** Tickets finished in the window with no merged PR recorded, so `merged` may be low. */
  finished_without_merge: z.number().int(),
  /** One plain sentence when the trends diverge; null when they don't. */
  note: z.string().nullable(),
  /**
   * Decision 49: where `merged` came from. `github` is synced merges, `github_stale` the same
   * with a sync too old to treat as current, `recorded` what agents recorded in Docket.
   */
  merged_source: z.enum(['recorded', 'github', 'github_stale']).optional(),
  /** When the GitHub data was last synced, when it's the source. */
  merged_synced_at: z.string().nullable().optional(),
});

export const overviewResponse = jsonResponse({
  window: overviewWindowSchema,
  /** The window is `(from, to]`; the one before it is `(prior_from, from]`. */
  from: z.string(),
  to: z.string(),
  prior_from: z.string(),
  /** Tickets that entered Done in the window and are still Done. Never epics or imports. */
  completed: z.object({
    count: z.number().int(),
    prior: z.number().int(),
    /** 24h is by hour; 7d and 30d by the server's calendar day. The buckets sum to `count`. */
    granularity: z.enum(['hour', 'day']),
    buckets: z.array(completedBucket),
  }),
  flow: flowSchema,
  /** Open tickets in In progress or Review. */
  in_flight: z.object({
    count: z.number().int(),
    progress: z.number().int(),
    review: z.number().int(),
  }),
  /** Open tickets with an uncleared blocker: the same set as Work's *Blocked* filter. */
  blocked: z.number().int(),
  /** Open tickets by status, grouped by epic, largest first. `epic_id` null is "No epic". */
  workload: z.array(
    z.object({
      epic_id: z.string().nullable(),
      title: z.string().nullable(),
      project: z.string().nullable(),
      total: z.number().int(),
      counts: workloadCounts,
    }),
  ),
  /** The newest successful backup at any location; null when none has run. */
  last_backup_at: z.string().nullable(),
});
export type OverviewResponse = z.infer<typeof overviewResponse>;

export const overviewItemsQuery = input({
  scope: scopeSchema,
  window: overviewWindowSchema.default(DEFAULT_OVERVIEW_WINDOW),
  metric: z.enum(OVERVIEW_METRICS),
});

/** At most this many rows; `count` is always the whole number. */
export const OVERVIEW_ITEMS_LIMIT = 500;

export const overviewItemRowSchema = z.object({
  id: z.string(),
  title: z.string(),
  type: itemTypeSchema,
  status: statusSchema,
  blocked: z.boolean(),
  project: z.string(),
  epic_id: z.string().nullable(),
  epic_title: z.string().nullable(),
  /** When it entered Done (`completed` only). */
  closed_at: z.string().nullable(),
  /** The story's producer, or its lead agent (`agents_*` only). */
  agent: z.string().nullable(),
});
export type OverviewItemRow = z.infer<typeof overviewItemRowSchema>;

export const overviewItemsResponse = jsonResponse({
  metric: z.enum(OVERVIEW_METRICS),
  window: overviewWindowSchema,
  count: z.number().int(),
  rows: z.array(overviewItemRowSchema),
});
export type OverviewItemsResponse = z.infer<typeof overviewItemsResponse>;

export const overviewRoutes = {
  'overview.get': route({
    method: 'GET',
    path: '/api/overview',
    group: 'read',
    params: noInput,
    query: overviewQuery,
    body: null,
    response: json(overviewResponse),
  }),
  'overview.items': route({
    method: 'GET',
    path: '/api/overview/items',
    group: 'read',
    params: noInput,
    query: overviewItemsQuery,
    body: null,
    response: json(overviewItemsResponse),
  }),
} as const;

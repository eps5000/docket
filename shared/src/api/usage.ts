/**
 * Token use per ticket and epic (owner decision 48; B63; BUILD_SPEC §5.30;
 * UI_SPEC §6.1c). Tokens are measured from the agents' local session logs by the
 * optional `usage` collector in `tools/docket-sync`. Dollars are an
 * API-equivalent estimate (`usage-prices.ts`). Off by default, and when it's off
 * every read says `enabled: false` and the UI shows nothing.
 *
 * Only numbers, model, session ID, time and working folder ever reach this API:
 * the sync body is strict, so any other field is refused.
 * Shared contract file (tasks.md, Slice rules).
 */
import { z } from 'zod';
import { itemId, projectKey } from '../mcp/common.js';
import { statusSchema } from '../mcp/types.js';
import { isCalendarDay } from './brief.js';
import { input, jsonResponse, noInput, ownerMutationOutput, scopeSchema } from './common.js';
import { overviewWindowSchema } from './overview.js';
import { json, route } from './route.js';

export const USAGE_CLIENTS = ['claude-code', 'codex'] as const;
export type UsageClient = (typeof USAGE_CLIENTS)[number];

/** How a turn was attributed. Nothing is guessed: what can't be matched is `unlinked`. */
export const USAGE_LINKS = ['ticket', 'overhead', 'unlinked'] as const;
export type UsageLink = (typeof USAGE_LINKS)[number];

/** The most records one sync call may carry. */
export const USAGE_SYNC_MAX_RECORDS = 1000;
/** The most coordinator folders the owner can register. */
export const USAGE_MAX_FOLDERS = 50;
/** The longest working folder path Docket stores. */
export const USAGE_MAX_PATH = 500;
/** The helper counts as not running after this long without checking in. */
export const USAGE_HELPER_STALE_MS = 20 * 60_000;
/** Rows in the top-ticket and session lists; `count` is always the whole number. */
export const USAGE_TOP_ROWS = 5;
export const USAGE_SESSION_ROWS = 12;

/**
 * One form for a working folder on any OS: forward slashes, no trailing slash,
 * and lower case for a Windows drive path, whose case doesn't matter. The
 * collector keeps an identical copy (it runs with no dependencies), and a test
 * holds the two together.
 */
export function normalizeWorkspace(path: string): string {
  let out = path.trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  if (out.length > 1) out = out.replace(/\/+$/, '');
  if (/^[A-Za-z]:(\/|$)/.test(out)) out = out.toLowerCase();
  return out;
}

const count = z.number().int().nonnegative();

/** The four kinds, kept apart: most tokens are usually cheap cache reads. */
export const usageTokensSchema = z.object({
  fresh_input: count,
  cached_input: count,
  cache_write: count,
  output: count,
});
export type UsageTokens = z.infer<typeof usageTokensSchema>;

export const usageCostSchema = z.object({
  /** API-equivalent estimate in US dollars; null when nothing could be priced. */
  usd: z.number().nonnegative().nullable(),
  /** Tokens with no sourced price. The estimate leaves them out. */
  unpriced_tokens: count,
  /** Models with no sourced price; a null model is shown as "unknown model". */
  unpriced_models: z.array(z.string()),
});
export type UsageCost = z.infer<typeof usageCostSchema>;

export const usageBucketSchema = z.object({
  tokens: usageTokensSchema,
  cost: usageCostSchema,
  turns: count,
  sessions: count,
});
export type UsageBucket = z.infer<typeof usageBucketSchema>;

export const usageModelRowSchema = z.object({
  model: z.string().nullable(),
  tokens: usageTokensSchema,
  cost: usageCostSchema,
  turns: count,
});
export type UsageModelRow = z.infer<typeof usageModelRowSchema>;

export const usageTicketRowSchema = z.object({
  id: z.string(),
  title: z.string(),
  project: z.string(),
  status: statusSchema,
  tokens: usageTokensSchema,
  cost: usageCostSchema,
});
export type UsageTicketRow = z.infer<typeof usageTicketRowSchema>;

export const usageSessionRowSchema = z.object({
  session_id: z.string(),
  client: z.enum(USAGE_CLIENTS),
  first_at: z.string(),
  last_at: z.string(),
  turns: count,
  models: z.array(z.string()),
  tokens: usageTokensSchema,
  cost: usageCostSchema,
});
export type UsageSessionRow = z.infer<typeof usageSessionRowSchema>;

/** `off`, on with no recent check-in from the helper, or on and reading. */
export const USAGE_HELPER_STATES = ['off', 'not_running', 'running'] as const;
export type UsageHelperState = (typeof USAGE_HELPER_STATES)[number];

const usageMeta = {
  /** False: the source is off, and the UI shows none of this. */
  enabled: z.boolean(),
  /** The date of the price table the estimate uses. */
  prices_as_of: z.string(),
  /** The newest turn Docket has; null when none. */
  last_turn_at: z.string().nullable(),
};

export const usageQuery = input({
  scope: scopeSchema,
  /** The Overview window. Ignored when `day` is given. */
  window: overviewWindowSchema.optional(),
  /** One day in the configured timezone (the daily brief). */
  day: z.string().refine(isCalendarDay, { error: 'Expected a real day as YYYY-MM-DD.' }).optional(),
});

export const usageSummaryResponse = jsonResponse({
  ...usageMeta,
  /** The span is `(from, to]`. */
  from: z.string(),
  to: z.string(),
  total: usageBucketSchema,
  /** Matched to one ticket by working folder and time. */
  linked: usageBucketSchema,
  /** Coordinator and heartbeat sessions: the owner's registered coordinator folders. */
  overhead: usageBucketSchema,
  /** In a known workspace, but no single ticket matched. Never guessed. */
  unlinked: usageBucketSchema,
  /** Whole percent of all tokens linked to a ticket; null with no tokens. */
  linked_pct: z.number().int().min(0).max(100).nullable(),
  models: z.array(usageModelRowSchema),
  /** The tickets that used the most, by tokens that aren't cache reads. */
  top_tickets: z.object({ count, rows: z.array(usageTicketRowSchema) }),
});
export type UsageSummaryResponse = z.infer<typeof usageSummaryResponse>;

export const usageItemParams = input({ id: itemId });

export const usageItemResponse = jsonResponse({
  ...usageMeta,
  item_id: z.string(),
  /** An epic is its own turns plus its tickets'. */
  rollup: z.boolean(),
  total: usageBucketSchema,
  models: z.array(usageModelRowSchema),
  sessions: z.object({ count, rows: z.array(usageSessionRowSchema) }),
  /** For an epic: its tickets that have token use, most first. */
  children: z.array(usageTicketRowSchema),
});
export type UsageItemResponse = z.infer<typeof usageItemResponse>;

const folderPath = z
  .string()
  .trim()
  .min(2, { error: 'Enter the full path of the folder.' })
  .max(USAGE_MAX_PATH);

export const coordinatorFolderSchema = z.strictObject({
  project: projectKey,
  path: folderPath,
});
export type CoordinatorFolder = z.infer<typeof coordinatorFolderSchema>;

const usageSettingsShape = {
  enabled: z.boolean(),
  coordinator_folders: z.array(z.object({ project: z.string(), path: z.string() })),
  helper: z.enum(USAGE_HELPER_STATES),
  /** When the helper last checked in; null if it never has. */
  last_read_at: z.string().nullable(),
  /** Turns Docket holds. They stay when the source is turned off. */
  turns_stored: count,
};

export const usageSettingsResponse = jsonResponse(usageSettingsShape);
export type UsageSettingsResponse = z.infer<typeof usageSettingsResponse>;

export const putUsageSettingsBody = input({
  enabled: z.boolean(),
  coordinator_folders: z.array(coordinatorFolderSchema).max(USAGE_MAX_FOLDERS).optional(),
});
export const putUsageSettingsResponse = ownerMutationOutput(usageSettingsShape);

/** What the collector needs: whether to read at all, and the only folders it may report. */
export const usageSyncConfigResponse = jsonResponse({
  enabled: z.boolean(),
  workspaces: z.array(z.string()),
});
export type UsageSyncConfigResponse = z.infer<typeof usageSyncConfigResponse>;

const safeId = z.string().regex(/^[A-Za-z0-9._:-]{1,200}$/);

/** One model response. Strict: a field that isn't a number or an identifier is refused. */
export const usageRecordSchema = z.strictObject({
  key: safeId,
  client: z.enum(USAGE_CLIENTS),
  session_id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  at: z.iso.datetime(),
  workspace: z.string().min(1).max(USAGE_MAX_PATH),
  model: z
    .string()
    .regex(/^[A-Za-z0-9._:/[\]-]{1,100}$/)
    .nullable(),
  fresh_input: count,
  cached_input: count,
  cache_write: count,
  cache_write_1h: count,
  output: count,
});
export type UsageRecord = z.infer<typeof usageRecordSchema>;

export const usageSyncBody = input({
  records: z.array(usageRecordSchema).max(USAGE_SYNC_MAX_RECORDS),
});

export const usageSyncResponse = jsonResponse({
  /** New or grown turns. */
  accepted: count,
  /** Already held with the same numbers. */
  unchanged: count,
  /** Refused because the folder isn't a known workspace. */
  unknown_workspace: count,
  /** True when the source is off: nothing was stored. */
  disabled: z.boolean(),
});
export type UsageSyncResponse = z.infer<typeof usageSyncResponse>;

export const usageRoutes = {
  'usage.get': route({
    method: 'GET',
    path: '/api/usage',
    group: 'usage',
    params: noInput,
    query: usageQuery,
    body: null,
    response: json(usageSummaryResponse),
  }),
  'usage.item': route({
    method: 'GET',
    path: '/api/usage/items/:id',
    group: 'usage',
    params: usageItemParams,
    query: noInput,
    body: null,
    response: json(usageItemResponse),
  }),
  'usageSettings.get': route({
    method: 'GET',
    path: '/api/usage/settings',
    group: 'usage',
    params: noInput,
    query: noInput,
    body: null,
    response: json(usageSettingsResponse),
  }),
  /** Owner only. Not undoable: turning it off or on is the undo. */
  'usageSettings.set': route({
    method: 'PUT',
    path: '/api/usage/settings',
    group: 'usage',
    params: noInput,
    query: noInput,
    body: putUsageSettingsBody,
    response: json(putUsageSettingsResponse),
  }),
  /** The collector, on the host: the agent token in protected mode, like `/mcp`. */
  'usageSync.config': route({
    method: 'GET',
    path: '/api/sync/usage',
    group: 'usage',
    auth: 'bearer',
    params: noInput,
    query: noInput,
    body: null,
    response: json(usageSyncConfigResponse),
  }),
  'usageSync.post': route({
    method: 'POST',
    path: '/api/sync/usage',
    group: 'usage',
    auth: 'bearer',
    params: noInput,
    query: noInput,
    body: usageSyncBody,
    response: json(usageSyncResponse),
  }),
} as const;

/**
 * The daily brief's read API (owner decision 48; BUILD_SPEC §5.29; UI_SPEC
 * §6.1b): what finished, what's stuck and what changed in decisions, for one
 * day in the configured timezone. What needs the owner comes from
 * `GET /api/needs-you`, the query the badge reads, so the two can't disagree.
 * Read-only. There is no cost section until measured data exists.
 * Shared contract file (tasks.md, Slice rules).
 */
import { z } from 'zod';
import { statusSchema } from '../mcp/types.js';
import { input, jsonResponse, noInput, scopeSchema } from './common.js';
import { json, route } from './route.js';

/** A real calendar day, `YYYY-MM-DD`. */
export function isCalendarDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const at = Date.parse(`${value}T00:00:00.000Z`);
  return !Number.isNaN(at) && new Date(at).toISOString().startsWith(value);
}

export const briefQuery = input({
  scope: scopeSchema,
  /** Defaults to today in the configured timezone. A future day reads as today. */
  day: z.string().refine(isCalendarDay, { error: 'Expected a real day as YYYY-MM-DD.' }).optional(),
});

/** Each list returns at most this many rows; `count` is always the whole number. */
export const BRIEF_ROWS = 8;

const ticket = {
  id: z.string(),
  title: z.string(),
  project: z.string(),
};

const list = <S extends z.ZodRawShape>(row: S) =>
  z.object({ count: z.number().int(), rows: z.array(z.object({ ...ticket, ...row })) });

export const BRIEF_DECISION_CHANGES = [
  'recorded',
  'replaced',
  'confirmed',
  'withdrawn',
  'acknowledged',
] as const;
export type BriefDecisionChange = (typeof BRIEF_DECISION_CHANGES)[number];

export const briefDecisionSchema = z.object({
  decision_id: z.string(),
  title: z.string(),
  change: z.enum(BRIEF_DECISION_CHANGES),
  by: z.enum(['owner', 'agent']),
  at: z.string(),
  project: z.string(),
  /** The ticket or epic it applies to; null for a project-wide or label decision. */
  item_id: z.string().nullable(),
});
export type BriefDecision = z.infer<typeof briefDecisionSchema>;

export const briefResponse = jsonResponse({
  day: z.string(),
  /** Today in the configured timezone: the latest day that can be chosen. */
  today: z.string(),
  timezone: z.string(),
  /** The day is `(from, to]`; `to` is now while the day is still running. */
  from: z.string(),
  to: z.string(),
  /** The Completed definition (BUILD_SPEC §5.24), on this day. Newest first. */
  finished: list({ closed_at: z.string() }),
  /** Now, whichever day is chosen: Docket keeps no day-by-day record of what was stuck. */
  stuck: z.object({
    /** Parked leads on open tickets, longest wait first. Excludes `held`. */
    parked: list({
      since: z.string(),
      /** What moves it next, or that it can resume. */
      next: z.string(),
    }),
    /** Open tickets holding up other open tickets, with no live lead or producer. */
    unowned_blockers: list({ status: statusSchema, blocks: z.number().int() }),
    /** Parked leads held by an active owner decision. Empty until the wait card reports them. */
    held: list({ since: z.string(), decision_id: z.string(), decision_title: z.string() }),
  }),
  /** Changes to decision records on this day, newest first. Undone changes aren't listed. */
  decisions: z.object({ count: z.number().int(), rows: z.array(briefDecisionSchema) }),
});
export type BriefResponse = z.infer<typeof briefResponse>;

export const briefRoutes = {
  'brief.get': route({
    method: 'GET',
    path: '/api/brief',
    group: 'read',
    params: noInput,
    query: briefQuery,
    body: null,
    response: json(briefResponse),
  }),
} as const;

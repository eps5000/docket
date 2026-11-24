/**
 * Pick next epic (owner decision 54; BUILD_SPEC §5.38; UI_SPEC §6.2.5): for
 * each open epic with open tickets, what a new agent could do there and what
 * it would wait on. A read for the owner: no MCP tool, no status, no gate.
 */
import { z } from 'zod';
import { statusSchema } from '../mcp/types.js';
import { jsonResponse, noInput } from './common.js';
import { projectParams } from './deps.js';
import { json, route } from './route.js';
import { epicWaitSchema } from './types.js';
import { epicReadinessSchema } from '../epic-readiness.js';
import { epicReleaseSchema } from '../finish-line.js';

/**
 * - `available`: nobody holds it and it wouldn't likely park;
 * - `being_worked`: a live lead or producer already holds it or one of its tickets;
 * - `likely_parks`: nothing can start, or most of its tickets wait on outside work;
 * - `not_ready`: it hasn't started and some tickets are in Inbox or Planning
 *   (decision 58), so it can't start yet and is never Best next.
 */
export const EPIC_PICK_FITS = ['available', 'being_worked', 'likely_parks', 'not_ready'] as const;
export type EpicPickFit = (typeof EPIC_PICK_FITS)[number];

export const epicPickSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: statusSchema,
  priority: z.number().int(),
  /** Open, non-archived tickets in the epic. */
  open: z.number().int(),
  /** Open tickets whose whole chain of open hard blockers stays inside this epic. */
  self_contained: z.number().int(),
  /**
   * B58's Startable tickets. In a paused project this is what could start
   * once it's resumed: the pause is ignored, and the response says `paused`.
   */
  can_start: z.object({
    count: z.number().int(),
    /** The first few, highest priority first. */
    first: z.array(z.object({ id: z.string(), title: z.string() })),
  }),
  /** The other epics, or "no epic", that its open chain depends on. */
  waits_on: z.array(epicWaitSchema),
  /** Distinct open tickets in other epics that transitively wait on this epic. */
  unblocks_elsewhere: z.number().int(),
  /** Open tickets in Inbox or Planning. */
  not_shaped: z.number().int(),
  /** Decision 57: open tickets waiting their turn, and those whose wait needs attention. */
  waiting: z.object({ queued: z.number().int(), blocked: z.number().int() }),
  /** Who holds the epic or its tickets right now. Empty when nobody does. */
  worked_by: z.array(
    z.object({
      who: z.string(),
      role: z.enum(['lead', 'producer']),
      items: z.array(z.string()),
    }),
  ),
  fit: z.enum(EPIC_PICK_FITS),
  /** One plain sentence when `fit` is `likely_parks`; null otherwise. */
  park_reason: z.string().nullable(),
  /** Decision 58: Not ready to start, or Started with N unshaped tickets, with links; absent when all are Ready. */
  readiness: epicReadinessSchema.optional(),
  /** Decision 64: its finish line and open bugs. */
  release: epicReleaseSchema.optional(),
});
export type EpicPick = z.infer<typeof epicPickSchema>;

export const pickEpicResponse = jsonResponse({
  project: z.string(),
  /** The project is paused, so `can_start` means "once resumed". */
  paused: z.boolean(),
  /** In the default order: the best pick first. */
  epics: z.array(epicPickSchema),
  /** The first `available` epic and why, in one line; null when none qualifies. */
  best: z.object({ id: z.string(), reason: z.string() }).nullable(),
});
export type PickEpicResponse = z.infer<typeof pickEpicResponse>;

export const pickEpicRoutes = {
  'projects.pickEpic': route({
    method: 'GET',
    path: '/api/projects/:key/pick-epic',
    group: 'read',
    params: projectParams,
    query: noInput,
    body: null,
    response: json(pickEpicResponse),
  }),
} as const;

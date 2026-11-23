/**
 * The critical path to a goal (owner decision 48; BUILD_SPEC §5.31; UI_SPEC
 * §6.3.4): the longest chain of open hard blockers holding up a ticket or
 * epic, and the one ticket to move next. A read: it adds no status, no link
 * type and no gate.
 */
import { z } from 'zod';
import { itemSummarySchema } from '../mcp/types.js';
import { jsonResponse, noInput } from './common.js';
import { itemParams } from './read.js';
import { json, route } from './route.js';
import { linkEdgeSchema } from './types.js';

/**
 * Why the first ticket on the chain is the one to move:
 * - `startable`: ready, nothing blocks it, nobody is on it;
 * - `unowned`: nobody owns it, so it needs shaping or assigning;
 * - `active`: an agent holds it;
 * - `parked`: its agent is parked;
 * - `waiting_on_owner`: an open question, a review packet or a verification;
 * - `waiting_merge`: done, but the link needs its pull request merged;
 * - `canceled`: canceled, and a canceled blocker never clears;
 * - `cycle`: it's in a loop of blockers.
 */
export const CRITICAL_NEXT_REASONS = [
  'startable',
  'unowned',
  'active',
  'parked',
  'waiting_on_owner',
  'waiting_merge',
  'canceled',
  'cycle',
] as const;
export type CriticalNextReason = (typeof CRITICAL_NEXT_REASONS)[number];

export const criticalStepSchema = z.object({
  item: itemSummarySchema,
  /** It blocks, and is blocked by, others on the chain. */
  in_cycle: z.boolean(),
});
export type CriticalStep = z.infer<typeof criticalStepSchema>;

export const criticalPathResponse = jsonResponse({
  goal: z.object({
    id: z.string(),
    title: z.string(),
    kind: z.enum(['ticket', 'epic']),
  }),
  /** `finished`: done or canceled. `clear`: no open blocker. `blocked`: a chain holds it up. */
  state: z.enum(['finished', 'clear', 'blocked']),
  /** First = move this next; last = closest to the goal. Empty when nothing is left to move. */
  chain: z.array(criticalStepSchema),
  /** The `blocks` links between neighbours on the chain. */
  links: z.array(linkEdgeSchema),
  next: z
    .object({
      id: z.string(),
      reason: z.enum(CRITICAL_NEXT_REASONS),
      /** One plain sentence, for the owner. */
      why: z.string(),
    })
    .nullable(),
  /** Loops of blockers anywhere upstream of the goal; each is sorted by ID. */
  cycles: z.array(z.array(z.string())),
  /** Open blockers upstream of the goal, on or off the chain. */
  open_blockers: z.number().int(),
});
export type CriticalPathResponse = z.infer<typeof criticalPathResponse>;

export const criticalPathRoutes = {
  'items.criticalPath': route({
    method: 'GET',
    path: '/api/items/:id/critical-path',
    group: 'read',
    params: itemParams,
    query: noInput,
    body: null,
    response: json(criticalPathResponse),
  }),
} as const;

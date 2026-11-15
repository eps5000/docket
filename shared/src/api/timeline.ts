/**
 * Burn-down and forecast (BUILD_SPEC §5.9, §7; UI_SPEC §9.1;
 * contracts/ui-api.md US8). The Timeline layout itself is
 * `GET /api/work?layout=timeline` (read.ts). Shared contract file.
 */
import { z } from 'zod';
import { itemId } from '../mcp/common.js';
import { labelNameSchema } from '../mcp/items.js';
import { input, jsonResponse, noInput, scopeSchema } from './common.js';
import { json, route } from './route.js';
import { forecastSchema } from './types.js';

export const burndownQuery = input({
  scope: scopeSchema,
  epic: itemId.optional(),
  label: labelNameSchema.optional(),
});

export const burndownResponse = jsonResponse({
  /** Remaining effort at the end of each local day, oldest first (last 28 days). */
  series: z.array(z.object({ date: z.string(), remaining: z.number() })),
  /** Scope additions: "+3 pts: RCP-31 added". */
  additions: z.array(z.object({ date: z.string(), item_id: z.string(), effort: z.number() })),
  open_effort: z.number(),
  /** Counted, never as zero: "N not estimated". */
  not_estimated: z.number().int(),
  window_days: z.number().int(),
  forecast: forecastSchema,
});
export type BurndownResponse = z.infer<typeof burndownResponse>;

export const timelineRoutes = {
  'burndown.get': route({
    method: 'GET',
    path: '/api/burndown',
    group: 'timeline',
    params: noInput,
    query: burndownQuery,
    body: null,
    response: json(burndownResponse),
  }),
} as const;

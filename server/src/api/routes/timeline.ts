/**
 * Burn-down and forecast (BUILD_SPEC §5.9, §7; contracts/ui-api.md US8). The
 * Timeline layout itself is `GET /api/work?layout=timeline` (read.ts, which
 * calls `forecast.timeline`).
 *
 * Guarded and validated (tasks.md T045); US8 (B16, T136) filled the
 * service: remaining effort per local day replayed from events, scope
 * additions, the unestimated count and the forecast (domain/forecast.ts).
 */
import type { Env, Hono } from 'hono';
import { defineRoute, type RouteDeps } from '../define.js';

export function timelineRoutes<E extends Env>(api: Hono<E>, deps: RouteDeps): void {
  defineRoute(api, 'burndown.get', deps, ({ services, read, query }) =>
    services.forecast.burndown(read, query),
  );
}

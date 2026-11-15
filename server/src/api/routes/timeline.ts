/**
 * Burn-down and forecast (BUILD_SPEC §5.9, §7; contracts/ui-api.md US8). The
 * Timeline layout itself is `GET /api/work?layout=timeline` (read.ts, which
 * calls `forecast.timeline`).
 *
 * Placeholder (tasks.md T045): guarded and validated, and calls its
 * service; the stub answers 501 until US8 (T123) implements it.
 */
import type { Env, Hono } from 'hono';
import { defineRoute, type RouteDeps } from '../define.js';

export function timelineRoutes<E extends Env>(api: Hono<E>, deps: RouteDeps): void {
  defineRoute(api, 'burndown.get', deps, ({ services, read, query }) =>
    services.forecast.burndown(read, query),
  );
}

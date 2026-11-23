/**
 * Every UI API route (BUILD_SPEC §7, the 2026-11-14 clarification routes,
 * the recovery routes from owner decision 26, the agent setup routes from
 * owner decision 29 (including the session-less `GET /install/:token`), the
 * proposals and drift routes from owner decision 30, the new project and
 * onboarding routes from owner decision 31, the shared changes routes
 * from owner decision 36, and
 * `/agent-upload` from §5.10), keyed by a stable route ID. The server, the
 * route contract test and the web client all read this one table.
 *
 * Shared contract file (tasks.md, Slice rules).
 */
import type { z } from 'zod';
import { agentProposalsRoutes } from './agent-proposals.js';
import { agentSetupRoutes } from './agent-setup.js';
import { criticalPathRoutes } from './critical-path.js';
import { decisionsRoutes } from './decisions.js';
import { depsRoutes } from './deps.js';
import { diagnosticsRoutes, undoRoutes, uploadRoutes } from './diagnostics.js';
import { importRoutes } from './import.js';
import { onboardingRoutes } from './onboarding.js';
import { briefRoutes } from './brief.js';
import { overviewRoutes } from './overview.js';
import { planningRoutes } from './planning.js';
import { problemRoutes } from './problems.js';
import { readRoutes } from './read.js';
import { recoveryRoutes } from './recovery.js';
import { reviewRoutes } from './review.js';
import type { ApiGroup, ApiRouteDef } from './route.js';
import { sessionRoutes } from './session.js';
import { settingsRoutes } from './settings.js';
import { sharedChangesRoutes } from './shared-changes.js';
import { steerRoutes } from './steer.js';
import { timelineRoutes } from './timeline.js';

export const API_ROUTES = {
  ...sessionRoutes,
  ...readRoutes,
  ...criticalPathRoutes,
  ...overviewRoutes,
  ...briefRoutes,
  ...reviewRoutes,
  ...depsRoutes,
  ...decisionsRoutes,
  ...steerRoutes,
  ...problemRoutes,
  ...planningRoutes,
  ...timelineRoutes,
  ...importRoutes,
  ...settingsRoutes,
  ...diagnosticsRoutes,
  ...recoveryRoutes,
  ...agentSetupRoutes,
  ...agentProposalsRoutes,
  ...onboardingRoutes,
  ...sharedChangesRoutes,
  ...undoRoutes,
  ...uploadRoutes,
} as const;

export type ApiRoutes = typeof API_ROUTES;
export type RouteId = keyof ApiRoutes;

export const ROUTE_IDS = Object.keys(API_ROUTES) as RouteId[];

/** `POST /api/items/:id/cancel`: how errors and the 501 placeholders name a route. */
export const routeLabel = (route: Pick<ApiRouteDef, 'method' | 'path'>) =>
  `${route.method} ${route.path}`;

/** The routes in one group (one server file each). */
export function routesInGroup(group: ApiGroup): RouteId[] {
  return ROUTE_IDS.filter((id) => API_ROUTES[id].group === group);
}

// ---- Types: what the client sends (`z.input`) and the server receives (`z.output`) ----

type Schema<T> = T extends z.ZodType ? T : never;

export type RouteParamsInput<K extends RouteId> = z.input<ApiRoutes[K]['params']>;
export type RouteQueryInput<K extends RouteId> = z.input<ApiRoutes[K]['query']>;
export type RouteBodyInput<K extends RouteId> = ApiRoutes[K]['body'] extends z.ZodType
  ? z.input<Schema<ApiRoutes[K]['body']>>
  : never;

export type RouteParams<K extends RouteId> = z.output<ApiRoutes[K]['params']>;
export type RouteQuery<K extends RouteId> = z.output<ApiRoutes[K]['query']>;
export type RouteBody<K extends RouteId> = ApiRoutes[K]['body'] extends z.ZodType
  ? z.output<Schema<ApiRoutes[K]['body']>>
  : never;

/**
 * The JSON result of a route. `never` for file, JSONL and stream routes,
 * whose handlers and callers deal in a raw HTTP response instead.
 */
export type RouteResult<K extends RouteId> = ApiRoutes[K]['response'] extends {
  kind: 'json';
  schema: infer S;
}
  ? z.output<Schema<S>>
  : never;

/** Route IDs whose response is JSON. */
export type JsonRouteId = {
  [K in RouteId]: ApiRoutes[K]['response'] extends { kind: 'json' } ? K : never;
}[RouteId];

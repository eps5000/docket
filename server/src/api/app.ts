/**
 * The UI JSON API, mounted at /api (BUILD_SPEC §7).
 *
 * - Every route needs an unlocked owner session, except
 *   `POST /api/session/unlock` (constitution Principle VI).
 * - Mutations need the CSRF double-submit header.
 * - Every route is registered from its shared definition (define.ts):
 *   strict path, query and body validation, then the handler, which calls
 *   only the domain services (domain/contracts.ts). Stubs answer 501.
 * - Errors map to the shared error codes,
 *   as `{error: {code, message, details?, current?}}` with the matching
 *   HTTP status. Unexpected errors are logged by reference only, never with
 *   request content.
 */
import type { EventEmitter } from 'node:events';
import { Hono, type Context } from 'hono';
import { HTTP_STATUS, isToolError } from '@docket/shared';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Db } from '../db/client.js';
import type { Services } from '../domain/contracts.js';
import { newId } from '../domain/ids.js';
import { mapDbError, type WritePath } from '../domain/write.js';
import type { RouteDeps } from './define.js';
import { errorBody } from './guards.js';
import { decisionsRoutes } from './routes/decisions.js';
import { depsRoutes } from './routes/deps.js';
import { diagnosticsRoutes } from './routes/diagnostics.js';
import { importRoutes } from './routes/import.js';
import { planningRoutes } from './routes/planning.js';
import { readRoutes } from './routes/read.js';
import { recoveryRoutes } from './routes/recovery.js';
import { reviewRoutes } from './routes/review.js';
import { settingsRoutes } from './routes/settings.js';
import { setupRoutes } from './routes/setup.js';
import { steerRoutes } from './routes/steer.js';
import { timelineRoutes } from './routes/timeline.js';
import { undoRoutes } from './routes/undo.js';
import {
  requireCsrf,
  requireSession,
  sessionRoutes,
  type ApiEnv,
  type OwnerSessions,
} from './session.js';
import { streamRoute } from './stream.js';

export interface ApiDeps {
  db: Db;
  write: WritePath;
  sessions: OwnerSessions;
  services: Services;
  bus: EventEmitter;
  streamKeepAliveMs?: number;
  log?: (line: string) => void;
  /** The agent token, for *Reveal token* only (never logged). */
  agentToken?: () => string;
}

export function errorResponse(c: Context, err: unknown, log: (line: string) => void): Response {
  const mapped = mapDbError(err);
  if (isToolError(mapped)) {
    return c.json({ error: mapped.toJSON() }, HTTP_STATUS[mapped.code] as ContentfulStatusCode);
  }
  const ref = newId('mut').replace(/^mut_/, 'e_');
  // Log the reference and the error class only: messages can quote input.
  log(
    `internal error ${ref}: ${(mapped as Error)?.name ?? 'Error'} at ${c.req.method} ${c.req.path}`,
  );
  return c.json(
    errorBody('internal', `Unexpected error (ref ${ref}). It has been logged.`, { ref }),
    500,
  );
}

export function createApiApp(deps: ApiDeps): Hono<ApiEnv> {
  const log = deps.log ?? ((line: string) => console.error(line));
  const api = new Hono<ApiEnv>();

  api.onError((err, c) => errorResponse(c, err, log));
  api.notFound((c) =>
    c.json(errorBody('not_found', `No API route ${c.req.method} ${c.req.path}.`), 404),
  );

  // Guards first: every route needs the owner session (except unlock), mutations need CSRF.
  api.use('*', requireSession(deps.sessions));
  api.use('*', requireCsrf());

  const routeDeps: RouteDeps = {
    services: deps.services,
    write: deps.write,
    log,
    agentToken: deps.agentToken,
  };

  // B2's routes.
  sessionRoutes(api, { ...routeDeps, sessions: deps.sessions });
  undoRoutes(api, routeDeps);
  streamRoute(api, {
    ...routeDeps,
    db: deps.db,
    bus: deps.bus,
    keepAliveMs: deps.streamKeepAliveMs,
  });

  // One file per group (contracts/ui-api.md); slices fill in the services behind them.
  readRoutes(api, routeDeps);
  reviewRoutes(api, routeDeps);
  depsRoutes(api, routeDeps);
  decisionsRoutes(api, routeDeps);
  steerRoutes(api, routeDeps);
  planningRoutes(api, routeDeps);
  timelineRoutes(api, routeDeps);
  importRoutes(api, routeDeps);
  settingsRoutes(api, routeDeps);
  diagnosticsRoutes(api, routeDeps);
  recoveryRoutes(api, routeDeps);
  setupRoutes(api, routeDeps);

  return api;
}

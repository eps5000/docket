/**
 * The UI JSON API, mounted at /api (BUILD_SPEC §7).
 *
 * - Every route needs an unlocked owner session, except
 *   `POST /api/session/unlock` (constitution Principle VI).
 * - Mutations need the CSRF double-submit header.
 * - Bodies are validated with zod; errors map to the shared error codes,
 *   as `{error: {code, message, details?, current?}}` with the matching
 *   HTTP status. Unexpected errors are logged by reference only, never with
 *   request content.
 */
import type { EventEmitter } from 'node:events';
import { Hono, type Context } from 'hono';
import { HTTP_STATUS, ToolError, isToolError } from '@tasklite/shared';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { z } from 'zod';
import type { Db } from '../db/client.js';
import { newId } from '../domain/ids.js';
import { mapDbError, type WritePath } from '../domain/write.js';
import { errorBody } from './guards.js';
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
  bus: EventEmitter;
  streamKeepAliveMs?: number;
  log?: (line: string) => void;
}

/** Parse and validate a JSON body. Field errors name the field, never its value. */
export async function parseBody<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new ToolError('validation', 'The request body must be JSON.');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => ({
      field: i.path.join('.') || '(body)',
      problem: i.message,
    }));
    throw new ToolError(
      'validation',
      'Some fields are missing or invalid; correct them and retry.',
      {
        details: { fields },
      },
    );
  }
  return parsed.data;
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

  api.use('*', requireSession(deps.sessions));
  api.use('*', requireCsrf());

  sessionRoutes(api, { sessions: deps.sessions, parseBody });
  undoRoutes(api, { write: deps.write });
  streamRoute(api, { db: deps.db, bus: deps.bus, keepAliveMs: deps.streamKeepAliveMs });

  return api;
}

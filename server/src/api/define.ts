/**
 * Registering a UI API route from its shared definition (tasks.md T045).
 *
 * The guards run first, as middleware (B2): Host and Origin allowlists on
 * the app, then the owner session and CSRF on `/api`, or the bearer token on
 * `/agent-upload`. Then, for every route, the same steps:
 * 1. validate the path parameters, the query and the body against the
 *    route's strict schemas; a failure is `400 validation`, with the MCP
 *    did-you-mean message for unknown keys (`validationError`);
 * 2. run the handler with a context: the parsed input, the services, a read
 *    context, and `mutate` (the one write path, as the owner or the agent);
 * 3. check a JSON result against the route's response schema (a mismatch is
 *    a bug: `500 internal`);
 * 4. a service that is still a stub (`NotImplementedError`) becomes
 *    `501 {error: {code: "unavailable", message: "Not implemented yet: <METHOD path>"}}`.
 *
 * Handlers live in `routes/<group>.ts` and call only the services in
 * domain/contracts.ts.
 */
import type { Context, Env, Hono } from 'hono';
import {
  API_ROUTES,
  NOT_IMPLEMENTED_STATUS,
  ToolError,
  notImplementedRouteMessage,
  routeLabel,
  validationError,
  type RouteBody,
  type RouteId,
  type RouteParams,
  type RouteQuery,
  type RouteResult,
} from '@tasklite/shared';
import type { z } from 'zod';
import {
  isNotImplemented,
  readContext,
  type ReadContext,
  type Services,
  type WriteContext,
} from '../domain/contracts.js';
import { OWNER_ACTOR, type Actor, type WritePath } from '../domain/write.js';
import { errorBody } from './guards.js';

/** What every route handler can use. */
export interface RouteDeps {
  services: Services;
  write: WritePath;
  log: (line: string) => void;
}

export interface RouteContext<K extends RouteId> {
  readonly c: Context;
  readonly params: RouteParams<K>;
  readonly query: RouteQuery<K>;
  readonly body: RouteBody<K>;
  /** The uploaded file (multipart routes only). */
  readonly file: File | null;
  /** The owner on `/api`; the agent on `/agent-upload`. */
  readonly actor: Actor;
  readonly services: Services;
  readonly read: ReadContext;
  /** Run `fn` as one mutation through the write path: secret checks, one transaction, events. */
  mutate<T>(fn: (w: WriteContext) => T): { result: T; mutation_id: string };
}

/** A JSON route returns its result (or a `Response` for a special case); other routes return a `Response`. */
export type RouteHandler<K extends RouteId> = (
  ctx: RouteContext<K>,
) => RouteResult<K> | Response | Promise<RouteResult<K> | Response>;

export interface DefineOptions {
  /** Where the Hono app is mounted (`/api`), stripped from the route path. */
  prefix: string;
}

/** Parse one part of the request; a failure is `validation` naming the route. */
function parsePart<T>(label: string, schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw validationError(label, schema, parsed.error);
  return parsed.data;
}

async function readJsonBody(c: Context, label: string): Promise<unknown> {
  const text = await c.req.text();
  if (text.trim() === '') return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ToolError('validation', `The body of ${label} must be JSON; fix it and retry.`);
  }
}

async function readMultipart(
  c: Context,
  label: string,
): Promise<{ fields: Record<string, unknown>; file: File | null }> {
  const type = c.req.header('content-type') ?? '';
  if (!type.toLowerCase().startsWith('multipart/form-data')) {
    throw new ToolError(
      'validation',
      `${label} takes multipart/form-data with a file field; send the upload as a form.`,
    );
  }
  // The placeholder buffers the form; the documents slice (T111) streams it to disk instead.
  const form = await c.req.parseBody();
  const fields: Record<string, unknown> = {};
  let file: File | null = null;
  for (const [key, value] of Object.entries(form)) {
    if (key === 'file' && value instanceof File) file = value;
    else fields[key] = value;
  }
  return { fields, file };
}

/** The actor of a bearer-authenticated upload: an agent without an MCP session. */
function uploadActor(body: unknown): Actor {
  const fields = (body ?? {}) as { agent_label?: string; run_id?: string };
  return {
    kind: 'agent',
    client: 'unknown',
    label: fields.agent_label ?? null,
    session_id: null,
    run_id: fields.run_id ?? null,
  };
}

/** Register one route on `app` from its shared definition. */
export function defineRoute<K extends RouteId, E extends Env>(
  app: Hono<E>,
  id: K,
  deps: RouteDeps,
  handler: RouteHandler<K>,
  opts: DefineOptions = { prefix: '/api' },
): void {
  const route = API_ROUTES[id];
  const label = routeLabel(route);
  const path = route.path.startsWith(opts.prefix)
    ? route.path.slice(opts.prefix.length) || '/'
    : route.path;

  app.on(route.method, path, async (c) => {
    try {
      const params = parsePart(label, route.params as z.ZodType, c.req.param());
      const query = parsePart(label, route.query as z.ZodType, c.req.query());
      let body: unknown = undefined;
      let file: File | null = null;
      if (route.body) {
        let raw: unknown;
        if (route.bodyKind === 'multipart') {
          const form = await readMultipart(c, label);
          raw = form.fields;
          file = form.file;
        } else {
          raw = await readJsonBody(c, label);
        }
        body = parsePart(label, route.body as z.ZodType, raw);
        if (route.bodyKind === 'multipart' && !file) {
          throw new ToolError('validation', `Invalid arguments for ${label}: file is required.`, {
            details: { fields: { file: 'is required' } },
          });
        }
      }

      const actor = route.auth === 'bearer' ? uploadActor(body) : OWNER_ACTOR;
      const ctx: RouteContext<K> = {
        c,
        params: params as RouteParams<K>,
        query: query as RouteQuery<K>,
        body: body as RouteBody<K>,
        file,
        actor,
        services: deps.services,
        read: readContext(deps.write.db, actor, deps.write.now()),
        mutate: (fn) => {
          const out = deps.write.run({ actor, operation: label, args: { params, body } }, fn);
          return { result: out.result, mutation_id: out.mutation_id };
        },
      };

      const out = await handler(ctx);
      if (out instanceof Response) return out;
      if (route.response.kind !== 'json') {
        throw new Error(`${label} must return a Response`);
      }
      const checked = route.response.schema.safeParse(out);
      if (!checked.success) {
        // Paths only: values can quote user content.
        const paths = checked.error.issues.map((i) => i.path.join('.') || '(root)').join(', ');
        deps.log(`api ${label}: result does not match the response schema at ${paths}`);
        throw new Error('response schema mismatch');
      }
      return c.json(checked.data as object);
    } catch (err) {
      if (isNotImplemented(err)) {
        return c.json(
          errorBody('unavailable', notImplementedRouteMessage(route.method, route.path)),
          NOT_IMPLEMENTED_STATUS,
        );
      }
      throw err;
    }
  });
}

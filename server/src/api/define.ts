/**
 * Registering a UI API route from its shared definition (tasks.md T045).
 *
 * The guards run first, as middleware (B2): Host and Origin allowlists on
 * the app, then the owner session and CSRF on `/api`, or the bearer token on
 * `/agent-upload` (`/install/:token` has neither: its token is the credential). Then, for every route, the same steps:
 * 1. validate the path parameters, the query and the body against the
 *    route's strict schemas; a failure is `400 validation`, with the MCP
 *    did-you-mean message for unknown keys (`validationError`);
 * 2. run the handler with a context: the parsed input, the services, a read
 *    context, and `mutate` (the one write path, as the owner or the agent);
 * 3. add the write path's warnings (MCP_SPEC §3.4) to the result, then check
 *    a JSON result against the route's response schema (a mismatch is a bug:
 *    `500 internal`);
 * 4. a service that is still a stub (`NotImplementedError`) becomes
 *    `501 {error: {code: "unavailable", message: "Not implemented yet: <METHOD path>"}}`.
 *
 * Multipart (`/agent-upload`, US7): the body is read as a stream
 * (multipart.ts). The file part goes straight to `documents.stage`, which
 * hashes it and writes it to the staging directory as it arrives, with the
 * 500 MB limit enforced while streaming (and up front from Content-Length,
 * as `413`). A staged file the handler did not move into place is deleted,
 * whatever the outcome.
 *
 * Handlers live in `routes/<group>.ts` and call only the services in
 * domain/contracts.ts.
 */
import { existsSync, rmSync } from 'node:fs';
import type { Context, Env, Hono } from 'hono';
import {
  AGENT_UPLOAD_MAX_BYTES,
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
} from '@docket/shared';
import type { z } from 'zod';
import {
  isNotImplemented,
  readContext,
  type ReadContext,
  type Services,
  type StagedFile,
  type UploadFile,
  type WriteContext,
} from '../domain/contracts.js';
import { OWNER_ACTOR, SYSTEM_ACTOR, type Actor, type WritePath } from '../domain/write.js';
import { errorBody } from './guards.js';
import { MultipartReader, boundaryOf } from './multipart.js';

/** What every route handler can use. */
export interface RouteDeps {
  services: Services;
  write: WritePath;
  log: (line: string) => void;
  /** The agent token, for Settings → *Reveal token* only. Never logged. */
  agentToken?: () => string;
}

export interface RouteContext<K extends RouteId> {
  readonly c: Context;
  readonly params: RouteParams<K>;
  readonly query: RouteQuery<K>;
  readonly body: RouteBody<K>;
  /** The uploaded file, already streamed to the staging directory (multipart routes only). */
  readonly staged: StagedFile | null;
  /** The owner on `/api`; the agent on `/agent-upload`; the system on `/install/:token`. */
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

/** Multipart framing allowed on top of the file itself before Content-Length is refused. */
const MULTIPART_OVERHEAD = 1024 * 1024;

/**
 * Read a multipart body as a stream: fields as text, and the `file` part
 * handed to `stage` as it arrives (never buffered). Other file parts are
 * skipped. On a refusal mid-stream, the rest of the body is drained so the
 * client gets the answer.
 */
async function readMultipart(
  c: Context,
  label: string,
  stage: (file: UploadFile) => Promise<StagedFile>,
): Promise<{ fields: Record<string, unknown>; staged: StagedFile | null }> {
  const type = c.req.header('content-type') ?? '';
  const boundary = boundaryOf(type);
  if (!type.toLowerCase().startsWith('multipart/form-data') || !boundary) {
    throw new ToolError(
      'validation',
      `${label} takes multipart/form-data with a file field; send the upload as a form.`,
    );
  }
  const length = Number(c.req.header('content-length') ?? NaN);
  if (Number.isFinite(length) && length > AGENT_UPLOAD_MAX_BYTES + MULTIPART_OVERHEAD) {
    throw new ToolError(
      'validation',
      'The upload is larger than 500 MB, the /agent-upload limit. Split the file or store a smaller one.',
      { details: { too_large: true, limit_bytes: AGENT_UPLOAD_MAX_BYTES } },
    );
  }
  const body = c.req.raw.body;
  if (!body) {
    throw new ToolError('validation', `${label} needs a body with a file field; send a form.`);
  }
  const reader = new MultipartReader(body, boundary);
  const fields: Record<string, unknown> = {};
  let staged: StagedFile | null = null;
  try {
    for (let part = await reader.next(); part; part = await reader.next()) {
      if (part.name === 'file' && staged === null) {
        staged = await stage({
          name: part.filename ?? 'upload',
          type: part.contentType ?? '',
          size: -1,
          stream: () => reader.stream(),
        });
      } else if (part.filename === null) {
        fields[part.name] = await reader.text();
      }
    }
  } catch (err) {
    if (staged) rmSync(staged.path, { force: true });
    await reader.discard();
    throw err;
  }
  return { fields, staged };
}

/**
 * The actor of a bearer-authenticated upload: an agent without an MCP
 * session. With a `run_id`, the run's client (and its label, unless one is
 * given) attribute it; otherwise the client is `agent`.
 */
function uploadActor(deps: RouteDeps, body: unknown): Actor {
  const fields = (body ?? {}) as { agent_label?: string; run_id?: string };
  const run = fields.run_id
    ? (deps.write.db.sqlite
        .prepare('SELECT client, label FROM runs WHERE id = ?')
        .get(fields.run_id) as { client: string; label: string | null } | undefined)
    : undefined;
  return {
    kind: 'agent',
    client: run?.client ?? 'agent',
    label: fields.agent_label ?? run?.label ?? null,
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
    let staged: StagedFile | null = null;
    try {
      const params = parsePart(label, route.params as z.ZodType, c.req.param());
      const query = parsePart(label, route.query as z.ZodType, c.req.query());
      let body: unknown = undefined;
      if (route.body) {
        let raw: unknown;
        if (route.bodyKind === 'multipart') {
          const stager = readContext(deps.write.db, uploadActor(deps, {}), deps.write.now());
          const form = await readMultipart(c, label, (file) =>
            deps.services.documents.stage(stager, file),
          );
          raw = form.fields;
          staged = form.staged;
        } else {
          raw = await readJsonBody(c, label);
        }
        body = parsePart(label, route.body as z.ZodType, raw);
        if (route.bodyKind === 'multipart' && !staged) {
          throw new ToolError('validation', `Invalid arguments for ${label}: file is required.`, {
            details: { fields: { file: 'is required' } },
          });
        }
      }

      // `GET /install/:token` has no caller identity: the service records the download.
      const actor =
        route.auth === 'bearer'
          ? uploadActor(deps, body)
          : route.auth === 'token'
            ? SYSTEM_ACTOR
            : OWNER_ACTOR;
      const warnings: string[] = [];
      const ctx: RouteContext<K> = {
        c,
        params: params as RouteParams<K>,
        query: query as RouteQuery<K>,
        body: body as RouteBody<K>,
        staged,
        actor,
        services: deps.services,
        read: readContext(deps.write.db, actor, deps.write.now()),
        mutate: (fn) => {
          // A token route's path holds its credential (`/install/:token`): it never
          // reaches the write path's secret scan, request hash or warnings.
          const args = route.auth === 'token' ? { body } : { params, body };
          const out = deps.write.run({ actor, operation: label, args }, fn);
          for (const w of out.warnings) if (!warnings.includes(w)) warnings.push(w);
          return { result: out.result, mutation_id: out.mutation_id };
        },
      };

      let out = await handler(ctx);
      if (out instanceof Response) return out;
      // Write-check warnings (MCP_SPEC §3.4) ride on owner mutation results; the UI toasts them.
      if (warnings.length > 0 && out !== null && typeof out === 'object' && !Array.isArray(out)) {
        out = { ...(out as object), warnings } as typeof out;
      }
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
      if (err instanceof ToolError && err.details?.too_large === true) {
        return c.json(errorBody('validation', err.message), 413);
      }
      if (isNotImplemented(err)) {
        return c.json(
          errorBody('unavailable', notImplementedRouteMessage(route.method, route.path)),
          NOT_IMPLEMENTED_STATUS,
        );
      }
      throw err;
    } finally {
      // A staged upload the handler did not move into place is never kept.
      if (staged && existsSync(staged.path)) rmSync(staged.path, { force: true });
    }
  });
}

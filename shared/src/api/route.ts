/**
 * The route definition every UI API route is declared with (tasks.md T044).
 * The server registers routes from these definitions (guards, validation,
 * response checks), the route contract test walks them, and the web client
 * derives its typed calls from them, so the three can't drift.
 *
 * Shared contract file (tasks.md, Slice rules).
 */
import type { z } from 'zod';

export type ApiMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * Route groups: one server file each (`server/src/api/routes/<group>.ts`),
 * following contracts/ui-api.md. `session` and `undo` are B2's routes;
 * `upload` is `/agent-upload` (BUILD_SPEC §5.10). `setup` is agent setup
 * (decision 29, BUILD_SPEC §5.17); `install` is `GET /install/:token`, the
 * session-less bundle download.
 */
export const API_GROUPS = [
  'session',
  'read',
  'review',
  'deps',
  'decisions',
  'steer',
  'planning',
  'timeline',
  'import',
  'settings',
  'diagnostics',
  'recovery',
  'setup',
  'install',
  'undo',
  'upload',
] as const;
export type ApiGroup = (typeof API_GROUPS)[number];

/**
 * - `session`: the `docket_owner` cookie (every `/api` route but unlock), plus
 *   the CSRF header on mutations;
 * - `none`: `POST /api/session/unlock` only;
 * - `bearer`: the agent token (`/agent-upload`), never the owner session;
 * - `token`: `GET /install/:token` only: no session, CSRF or bearer; the
 *   single-use token in the path is the credential (checked by the handler),
 *   behind the app's Host and Origin guards (loopback only; decision 29).
 */
export type ApiAuth = 'session' | 'none' | 'bearer' | 'token';

/**
 * - `json`: a JSON body checked against `schema`;
 * - `sse`: the live stream (contracts/events.md);
 * - `file`: document bytes with `Content-Disposition` and `nosniff` (§5.10);
 * - `jsonl`: newline-delimited JSON (the diagnostic log).
 */
export type ApiResponse =
  { kind: 'json'; schema: z.ZodType } | { kind: 'sse' } | { kind: 'file' } | { kind: 'jsonl' };

/** How the body arrives: JSON, or multipart form fields plus one `file` (`/agent-upload`). */
export type ApiBodyKind = 'json' | 'multipart';

export interface ApiRouteDef<
  P extends z.ZodType = z.ZodType,
  Q extends z.ZodType = z.ZodType,
  B extends z.ZodType | null = z.ZodType | null,
  R extends ApiResponse = ApiResponse,
> {
  method: ApiMethod;
  /** The full path with `:param` segments, e.g. `/api/items/:id`. */
  path: string;
  group: ApiGroup;
  auth: ApiAuth;
  params: P;
  query: Q;
  /** Null for GET. Mutations always have one; an empty body counts as `{}`. */
  body: B;
  bodyKind: ApiBodyKind;
  response: R;
  /** True when the result carries a `mutation_id` the Undo toast can send back. */
  undoable: boolean;
}

/** The path parameter names of a path, in order. */
export function pathParams(path: string): string[] {
  return [...path.matchAll(/:([A-Za-z_]+)/g)].map((m) => m[1]!);
}

/** True for routes that change state (and so need the CSRF header under session auth). */
export const isMutation = (route: Pick<ApiRouteDef, 'method'>) => route.method !== 'GET';

/** True when the route needs the CSRF header (BUILD_SPEC §3). */
export const needsCsrf = (route: Pick<ApiRouteDef, 'method' | 'auth'>) =>
  route.auth === 'session' && isMutation(route);

/** Declare a route, keeping its precise schema types. */
export function route<
  const P extends z.ZodType,
  const Q extends z.ZodType,
  const B extends z.ZodType | null,
  const R extends ApiResponse,
>(def: {
  method: ApiMethod;
  path: string;
  group: ApiGroup;
  auth?: ApiAuth;
  params: P;
  query: Q;
  body: B;
  bodyKind?: ApiBodyKind;
  response: R;
  undoable?: boolean;
}): ApiRouteDef<P, Q, B, R> {
  return {
    auth: 'session',
    bodyKind: 'json',
    undoable: false,
    ...def,
  };
}

/** Shorthand for a JSON response. */
export const json = <S extends z.ZodType>(schema: S) => ({ kind: 'json' as const, schema });

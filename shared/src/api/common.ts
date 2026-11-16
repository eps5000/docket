/**
 * Building blocks for the owner's UI API (BUILD_SPEC §7; tasks.md T044).
 *
 * - Inputs are strict, like MCP (B3 resolution 4): an unknown key in the
 *   path, the query or the body is a `validation` error that names it and
 *   suggests the closest valid field (`validationError` in mcp/validation.ts).
 * - Field shapes reuse the MCP building blocks (`itemId`, `text`, limits), so
 *   the owner and agents hit the same limits (decision 22).
 * - Query values arrive as strings; `queryBool` and `queryInt` accept either
 *   the typed value (what the web client passes) or its string form.
 * - Every error is `{error: ToolError}` with the HTTP status for its code
 *   (errors.ts `HTTP_STATUS`); routes that a slice has not implemented yet
 *   answer `501` with `{error: {code: "unavailable", message: "Not implemented
 *   yet: <METHOD path>"}}`.
 *
 * Shared contract file (tasks.md, Slice rules).
 */
import { z } from 'zod';
import { toolErrorSchema } from '../errors.js';
import { projectKey } from '../mcp/common.js';

/** `scope` on list endpoints: `all` or a project key (BUILD_SPEC §7). */
export const scopeSchema = z.union([z.literal('all'), projectKey]).default('all');

/** A version the client read, for optimistic concurrency (BUILD_SPEC §4; decision T5). */
export const expectedVersion = z.number().int().min(0);

/** A boolean query parameter: `true`/`false`, typed or as a string. */
export const queryBool = z
  .union([z.boolean(), z.enum(['true', 'false'])])
  .transform((v) => v === true || v === 'true');

/** An integer query parameter in `[min, max]`, typed or as a string. */
export const queryInt = (min: number, max: number) =>
  z
    .union([z.number(), z.string().regex(/^\d+$/, { error: 'Expected a whole number.' })])
    .transform((v) => Number(v))
    .pipe(z.number().int().min(min).max(max));

/** A strict input object (path params, query or body). */
export const input = <S extends z.ZodRawShape>(shape: S) => z.strictObject(shape);

/** The empty strict input: anything passed is an unknown field. */
export const noInput = z.strictObject({});

// ---- Results ----

/**
 * An owner mutation's result. `mutation_id` is what the Undo toast sends to
 * `POST /api/mutations/:id/undo` (BUILD_SPEC §5.11).
 */
export function ownerMutationOutput<S extends z.ZodRawShape>(shape: S) {
  return z.object({
    mutation_id: z.string(),
    /** Write-check warnings, e.g. "RCP-99 doesn't exist" (MCP_SPEC §3.4); the UI shows them in the toast. */
    warnings: z.array(z.string()).optional(),
    ...shape,
  });
}

/** A JSON response. */
export function jsonResponse<S extends z.ZodRawShape>(shape: S) {
  return z.object(shape);
}

// ---- Errors ----

/** Every API error body. */
export const apiErrorSchema = z.object({ error: toolErrorSchema });
export type ApiErrorBody = z.infer<typeof apiErrorSchema>;

/** `409`: a stale `expected_version` (or a claim, or an undo that came too late) carries the current record. */
export const conflictErrorSchema = z.object({
  error: toolErrorSchema.extend({ code: z.literal('conflict'), current: z.unknown() }),
});
export type ConflictErrorBody = z.infer<typeof conflictErrorSchema>;

/** The HTTP status of a route a slice has not implemented yet. */
export const NOT_IMPLEMENTED_STATUS = 501;

/** The message of a route a slice has not implemented yet. */
export const notImplementedRouteMessage = (method: string, path: string) =>
  `Not implemented yet: ${method} ${path}`;

/** The header that must echo the `tl_csrf` cookie on every mutation (BUILD_SPEC §3). */
export const CSRF_HEADER_NAME = 'X-Tasklite-CSRF';
export const CSRF_COOKIE_NAME = 'tl_csrf';
export const SESSION_COOKIE_NAME = 'tl_owner';

/**
 * Building blocks for tool input and output schemas (MCP_SPEC §3 and §5).
 *
 * - Inputs are strict: an unknown key is a `validation` error that names the
 *   key and suggests the closest valid field (B3 resolution 4).
 * - Every tool accepts `run_id?` (§3 "Runs as signals"; B3 resolution 1).
 *   Mutating tools also accept `idempotency_key?` (§3 Idempotency).
 * - Mutating outputs may carry `replayed: true` and `warnings` (§3; B3
 *   resolution 5).
 *
 * Shared contract file (tasks.md, Slice rules).
 */
import { z } from 'zod';
import { DATE_RE, ITEM_ID_RE, LIMITS, PROJECT_KEY_RE, SHA_RE } from './limits.js';

/** Plain text: trimmed, non-empty, at most `max` characters (§3 Types). */
export const text = (max: number) => z.string().trim().min(1).max(max);

/** Markdown or free text that may be empty, at most `max` characters. */
export const longText = (max: number) => z.string().trim().max(max);

/** `<PROJECT>-<n>`, e.g. `RCP-14`. */
export const itemId = z
  .string()
  .trim()
  .regex(ITEM_ID_RE, { error: 'Expected an item ID like RCP-14.' });

/** The JSON Schema key that marks an opaque ID (json-schema.ts removes it). */
export const ID_MARK = 'x-docket-id';

/**
 * The JSON Schema key listing enum values a tool accepts but its definition
 * doesn't list (decision 67's Story and Task); json-schema.ts drops both.
 */
export const ALIAS_MARK = 'x-docket-aliases';

/** 2–5 uppercase letters, e.g. `RCP`. */
export const projectKey = z
  .string()
  .trim()
  .regex(PROJECT_KEY_RE, { error: 'Expected a project key of 2–5 uppercase letters, like RCP.' });

/**
 * A prefixed ULID (`run_…`, `wst_…`, …) or another opaque ID. Marked so the
 * definitions clients receive leave out its length limit (decision 61): an ID
 * comes from Docket or the orchestrator, and validation still enforces it.
 */
export const objectId = z
  .string()
  .trim()
  .min(1)
  .max(LIMITS.id)
  .meta({ [ID_MARK]: true });

/** `YYYY-MM-DD`. */
export const date = z.string().regex(DATE_RE, { error: 'Expected a date like 2026-11-15.' });

/** An ISO-8601 time with a zone, e.g. `2026-11-15T10:40:00Z`. */
export const isoTime = z.iso.datetime({
  offset: true,
  error: 'Expected an ISO time like 2026-11-15T10:40:00Z.',
});

/** A commit SHA: 7–40 hex (§5.6 report_commit). */
export const commitSha = z
  .string()
  .trim()
  .regex(SHA_RE, { error: 'Expected a commit SHA: 7–40 hex characters.' });

export const agentLabel = text(LIMITS.agent_label);

export const runIdField = objectId;

export const idempotencyKey = z.string().min(1).max(LIMITS.idempotency_key);

export const cursor = z
  .string()
  .min(1)
  .max(LIMITS.id * 4);

export const pageLimit = z.number().int().min(1).max(LIMITS.page_max).default(LIMITS.page_default);

/** Fields every read tool accepts. */
export const readBase = {
  run_id: runIdField.optional(),
} as const;

/** Fields every mutating tool accepts (§5: "not repeated"). */
export const mutationBase = {
  run_id: runIdField.optional(),
  idempotency_key: idempotencyKey.optional(),
} as const;

/** `base` fields the tool doesn't define itself (a tool may make `run_id` required). */
function withBase<S extends z.ZodRawShape, B extends z.ZodRawShape>(shape: S, base: B) {
  const extra = Object.fromEntries(Object.entries(base).filter(([key]) => !(key in shape)));
  return { ...shape, ...extra } as Omit<B, keyof S> & S;
}

/** A strict input object for a read tool. */
export function readInput<S extends z.ZodRawShape>(shape: S) {
  return z.strictObject(withBase(shape, readBase));
}

/** A strict input object for a mutating tool. */
export function mutationInput<S extends z.ZodRawShape>(shape: S) {
  return z.strictObject(withBase(shape, mutationBase));
}

/** An output object for a read tool. */
export function readOutput<S extends z.ZodRawShape>(shape: S) {
  return z.object(shape);
}

/** Fields every mutating result may carry. */
export const mutationResultBase = {
  /** Present and true when this result is the stored result of an earlier call with the same idempotency_key. */
  replayed: z.boolean().optional(),
  /** Write-check warnings, e.g. "RCP-99 doesn't exist" (§3.4). */
  warnings: z.array(z.string()).optional(),
} as const;

/** An output object for a mutating tool. */
export function mutationOutput<S extends z.ZodRawShape>(shape: S) {
  return z.object({ ...shape, ...mutationResultBase });
}

/** Pagination output. */
export const nextCursor = z.string().nullable();

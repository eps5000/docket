/**
 * Batches (owner decision 34; MCP_SPEC §5.13): `apply_batch` runs up to 100
 * writes in one call, for large onboardings. Shared contract file (tasks.md,
 * Slice rules).
 *
 * Each operation names a tool and its arguments, exactly as a single call
 * would take them. It runs through that tool's own checks (schema, secrets,
 * limits, versions) in its own transaction, so one failure doesn't undo the
 * others: atomic per operation, never all-or-nothing. Results come back per
 * operation, in order.
 *
 * - `$n` (a whole string, like `"$1"`) in an operation's arguments is replaced
 *   by the ID operation n wrote (an earlier one), so an epic and its items fit
 *   in one batch.
 * - `run_id` is the batch's; an operation can't carry its own.
 * - `idempotency_key` on the batch gives each operation its own key derived
 *   from it, so a retry replays what already succeeded and runs only the
 *   rest. An operation may also carry its own `idempotency_key`.
 */
import { z } from 'zod';
import { idempotencyKey, mutationInput, mutationOutput } from './common.js';

/** The writes a batch may hold (MCP_SPEC §5.13). */
export const BATCH_OPS = [
  'create_item',
  'update_item',
  'link_items',
  'upsert_label',
  'set_plan',
  'update_step',
  'put_document',
  'publish_decision',
] as const;
export type BatchOp = (typeof BATCH_OPS)[number];

/** At most 100 operations per call. */
export const BATCH_MAX = 100;

export const batchOperationSchema = z.strictObject({
  /** The tool to run. */
  op: z.enum(BATCH_OPS),
  /** Its arguments, as a single call takes them (without run_id). `"$n"` names operation n's ID. */
  args: z.record(z.string(), z.unknown()),
  /** This operation's own key; otherwise derived from the batch's. */
  idempotency_key: idempotencyKey.optional(),
});
export type BatchOperation = z.infer<typeof batchOperationSchema>;

export const applyBatchInput = mutationInput({
  operations: z.array(batchOperationSchema).min(1).max(BATCH_MAX),
});

/** The error of a failed operation: the same ToolError a single call would return (§6). */
const batchErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
});

export const batchResultSchema = z.object({
  /** 1-based, in the order sent. */
  index: z.number().int(),
  op: z.enum(BATCH_OPS),
  ok: z.boolean(),
  /**
   * What the operation wrote: an item ID (create_item, update_item, set_plan),
   * a link, step, document or decision ID, or a label name. Null on failure.
   */
  id: z.string().nullable(),
  /** The item's or document's new version, when it has one. */
  version: z.number().int().nullable(),
  /** The single call's compact text (§3.1), or the error message. */
  text: z.string(),
  replayed: z.boolean().optional(),
  warnings: z.array(z.string()).optional(),
  error: batchErrorSchema.optional(),
});
export type BatchResult = z.infer<typeof batchResultSchema>;

export const applyBatchOutput = mutationOutput({
  applied: z.number().int(),
  failed: z.number().int(),
  results: z.array(batchResultSchema),
});

/**
 * Batches (owner decision 34; MCP_SPEC §5.13; tasks.md T177): `apply_batch`.
 *
 * Each operation is run as its single call would be: its arguments are
 * checked against that tool's own input schema, then its own handler runs
 * with a mutate of its own, so the write path's checks (secrets, limits,
 * versions, references) and its one transaction apply to that operation
 * alone. A failed operation leaves no trace and doesn't stop the rest:
 * atomic per operation, never all-or-nothing. Results come back in order,
 * each with the single call's compact line or its error.
 *
 * - **`$n`:** a whole-string argument value `"$n"` is replaced by the ID
 *   operation n wrote, so a batch can create an epic and its items. Naming a
 *   later operation, or one that failed, fails this operation (`validation`).
 * - **Idempotency:** an operation's own `idempotency_key`, else one derived
 *   from the batch's key and its index, so a retry with the same key replays
 *   what succeeded and runs what didn't.
 * - **`run_id`** is the batch's; an operation carrying one fails.
 */
import { createHash } from 'node:crypto';
import {
  ToolError,
  getTool,
  renderResult,
  validationError,
  type BatchOp,
  type BatchResult,
  type ToolInput,
  type ToolOutput,
} from '@docket/shared';
import { toToolError, type ToolContext, type ToolHandler, type ToolHandlers } from '../register.js';

const REF = /^\$([1-9][0-9]{0,2})$/;

/** Replace each whole-string `"$n"` with operation n's ID. */
function resolveRefs(value: unknown, ids: (string | null)[], index: number): unknown {
  if (typeof value === 'string') {
    const m = REF.exec(value);
    if (!m) return value;
    const n = Number(m[1]);
    if (n >= index) {
      throw new ToolError(
        'validation',
        `"${value}" names operation ${n}, which doesn't come before this one (#${index}). Refer only to earlier operations.`,
        { details: { ref: value } },
      );
    }
    const id = ids[n - 1];
    if (!id) {
      throw new ToolError(
        'validation',
        `"${value}" names operation ${n}, which failed, so it has no ID. Fix it and send both again.`,
        { details: { ref: value } },
      );
    }
    return id;
  }
  if (Array.isArray(value)) return value.map((v) => resolveRefs(v, ids, index));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, resolveRefs(v, ids, index)]),
    );
  }
  return value;
}

/** An operation's idempotency key: its own, else derived from the batch's (≤ 100 characters). */
function operationKey(batchKey: string | undefined, own: string | undefined, index: number) {
  if (own) return own;
  if (!batchKey) return null;
  return `batch:${createHash('sha256').update(batchKey, 'utf8').digest('hex').slice(0, 40)}#${index}`;
}

/** What an operation wrote, and its new version, from its single call's result. */
function written(op: BatchOp, args: Record<string, unknown>, out: Record<string, unknown>) {
  const o = out as Record<string, unknown>;
  switch (op) {
    case 'create_item':
    case 'update_item': {
      const item = o.item as { id: string; version: number };
      return { id: item.id, version: item.version };
    }
    case 'set_plan':
      return { id: String(args.id), version: (o.plan_version as number | undefined) ?? null };
    case 'update_step':
      return { id: (o.step as { id: string }).id, version: null };
    case 'link_items':
      return { id: (o.link_id as string | undefined) ?? null, version: null };
    case 'upsert_label':
      return { id: (o.name as string | undefined) ?? null, version: null };
    case 'put_document':
      return {
        id: (o.document_id as string | undefined) ?? null,
        version: (o.version_no as number | undefined) ?? null,
      };
    case 'publish_decision':
      return { id: (o.decision as { id: string }).id, version: null };
  }
}

/** The batch handler, given every tool's handler (index.ts passes them, avoiding an import cycle). */
export function batchHandler(handlers: () => ToolHandlers): ToolHandler<'apply_batch'> {
  return async (args: ToolInput<'apply_batch'>, ctx: ToolContext) => {
    const ids: (string | null)[] = [];
    const results: BatchResult[] = [];

    for (const [i, operation] of args.operations.entries()) {
      const index = i + 1;
      const { op } = operation;
      const tool = getTool(op);
      try {
        if ('run_id' in operation.args) {
          throw new ToolError(
            'validation',
            'Pass run_id once on apply_batch, not on each operation.',
            { details: { fields: { run_id: 'set it on apply_batch' } } },
          );
        }
        const raw = resolveRefs(operation.args, ids, index) as Record<string, unknown>;
        const parsed = tool.input.safeParse({
          ...raw,
          ...(args.run_id ? { run_id: args.run_id } : {}),
        });
        if (!parsed.success) throw validationError(op, tool.input, parsed.error);
        const opArgs = parsed.data as Record<string, unknown>;
        const { idempotency_key: ownKey, ...hashed } = opArgs;
        const key = operationKey(
          args.idempotency_key,
          operation.idempotency_key ?? (typeof ownKey === 'string' ? ownKey : undefined),
          index,
        );

        let replayed = false;
        const warnings: string[] = [];
        const opCtx: ToolContext = {
          ...ctx,
          tool,
          mutate: (fn) => {
            const out = ctx.runtime.write.run(
              { actor: ctx.actor, operation: op, args: hashed, idempotencyKey: key },
              fn,
            );
            replayed ||= out.replayed;
            for (const w of out.warnings) if (!warnings.includes(w)) warnings.push(w);
            return out.result;
          },
        };
        const handler = handlers()[op] as ToolHandler<BatchOp>;
        const out = (await handler(opArgs as never, opCtx)) as ToolOutput<BatchOp>;
        const checked = tool.output.safeParse(out);
        if (!checked.success) {
          throw new Error(`${op} result does not match its output schema`);
        }
        const structured = {
          ...(checked.data as Record<string, unknown>),
          ...(replayed ? { replayed: true } : {}),
          ...(warnings.length > 0 ? { warnings } : {}),
        };
        const { id, version } = written(op, opArgs, structured);
        ids.push(id);
        results.push({
          index,
          op,
          ok: true,
          id,
          version,
          text: renderResult(op, structured as never, { args: opArgs, now: ctx.now }),
          ...(replayed ? { replayed: true } : {}),
          ...(warnings.length > 0 ? { warnings } : {}),
        });
      } catch (raw) {
        const err = toToolError(ctx.runtime, op, raw);
        ids.push(null);
        results.push({
          index,
          op,
          ok: false,
          id: null,
          version: null,
          text: err.message,
          error: { code: err.code, message: err.message },
        });
      }
    }

    const applied = results.filter((r) => r.ok).length;
    return { applied, failed: results.length - applied, results };
  };
}

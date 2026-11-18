/**
 * Claiming and runs (MCP_SPEC §5.4): tool handlers.
 *
 * Wired to the domain services (tasks.md T048): each handler calls its
 * service in domain/contracts.ts through `ctx.services`, and mutations go
 * through `ctx.mutate`. While a service is a stub, the tool answers
 * `unavailable` ("Not implemented yet: <tool>"). The slice that owns a tool
 * implements the service; registration, schemas and copy stay as they are.
 */
import { findSecret } from '@docket/shared';
import { runSignal, serviceArgs, type ToolContext, type ToolHandlers } from '../register.js';

/** The write context `ctx.mutate` hands a service (adapters import no domain module). */
type WriteContext = Parameters<Parameters<ToolContext['mutate']>[0]>[0];

/**
 * A refused claim is recorded as `claim.rejected` (BUILD_SPEC §5.3), but
 * the refusal rolls the claim's own transaction back. The service hands the
 * record back on the error; it is written here through the write path, with
 * no idempotency key, so a retried claim is refused (and recorded) again.
 */
function recordRejectedClaim(ctx: ToolContext, args: { id: string }, err: unknown): void {
  const record = (err as { recordRejection?: (w: WriteContext) => void } | null)?.recordRejection;
  if (typeof record !== 'function') return;
  try {
    ctx.runtime.write.run(
      { actor: ctx.actor, operation: 'claim_lead.rejected', args: { id: args.id } },
      record,
    );
  } catch (logErr) {
    ctx.runtime.log(
      `claim_lead: recording the rejected claim failed: ${(logErr as Error).message}`,
    );
  }
}

/** The claiming (or starting) call is the new run's first signal: session or report (§5.4). */
function firstSignal(ctx: ToolContext, runId: string): void {
  const { kind } = runSignal(ctx.runtime, runId, ctx.session);
  ctx.services.runs.recordSignal(ctx.read, {
    run_id: runId,
    kind,
    session_id: ctx.session?.session_id ?? null,
  });
}

export const runsHandlers: Pick<
  ToolHandlers,
  'claim_lead' | 'release_lead' | 'start_run' | 'heartbeat' | 'finish_run' | 'park_run'
> = {
  claim_lead: (args, ctx) => {
    // Reporting instructions must never block claiming (decision 30): a reported file
    // whose text looks like a secret keeps its key and hash, and loses its text, before
    // the write check sees the arguments. The text is never stored or logged.
    if (args.instructions) {
      const known = ctx.runtime.secrets.known();
      args.instructions.files = args.instructions.files.map((f) =>
        f.content !== undefined && findSecret(f.content, { known })
          ? ({ key: f.key, sha256: f.sha256, withheld: 'secret' } as typeof f)
          : f,
      );
    }
    let out;
    try {
      out = ctx.mutate((w) => ctx.services.runs.claim(w, serviceArgs(args)));
    } catch (err) {
      recordRejectedClaim(ctx, args, err);
      throw err;
    }
    firstSignal(ctx, out.run_id);
    return out;
  },
  release_lead: (args, ctx) => ({
    item: ctx.mutate((w) => ctx.services.runs.release(w, serviceArgs(args))),
  }),
  start_run: (args, ctx) => {
    const out = ctx.mutate((w) => ctx.services.runs.startRun(w, serviceArgs(args)));
    firstSignal(ctx, out.run_id);
    return out;
  },
  // Heartbeats are not events (contracts/events.md): a receipt write, outside the write path.
  // Declaring or releasing resources is (resource.declared / resource.released), so that part
  // goes through the write path first (MCP_SPEC §5.4; BUILD_SPEC §5.16).
  heartbeat: (args, ctx) => {
    const input = serviceArgs(args);
    if (input.resources_started || input.resources_released) {
      ctx.mutate((w) =>
        ctx.services.runs.updateResources(w, {
          run_id: input.run_id,
          resources_started: input.resources_started,
          resources_released: input.resources_released,
        }),
      );
    }
    return ctx.services.runs.heartbeat(ctx.read, input);
  },
  finish_run: (args, ctx) => ctx.mutate((w) => ctx.services.runs.finish(w, serviceArgs(args))),
  park_run: (args, ctx) => ctx.mutate((w) => ctx.services.runs.park(w, serviceArgs(args))),
};

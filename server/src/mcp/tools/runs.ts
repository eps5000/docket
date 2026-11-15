/**
 * Claiming and runs (MCP_SPEC §5.4): tool handlers.
 *
 * Wired to the domain services (tasks.md T048): each handler calls its
 * service in domain/contracts.ts through `ctx.services`, and mutations go
 * through `ctx.mutate`. While a service is a stub, the tool answers
 * `unavailable` ("Not implemented yet: <tool>"). The slice that owns a tool
 * implements the service; registration, schemas and copy stay as they are.
 */
import { serviceArgs, type ToolHandlers } from '../register.js';

export const runsHandlers: Pick<
  ToolHandlers,
  'claim_lead' | 'release_lead' | 'start_run' | 'heartbeat' | 'finish_run'
> = {
  claim_lead: (args, ctx) => ctx.mutate((w) => ctx.services.runs.claim(w, serviceArgs(args))),
  release_lead: (args, ctx) => ({
    item: ctx.mutate((w) => ctx.services.runs.release(w, serviceArgs(args))),
  }),
  start_run: (args, ctx) => ctx.mutate((w) => ctx.services.runs.startRun(w, serviceArgs(args))),
  // Heartbeats are not events (contracts/events.md): a receipt write, outside the write path.
  heartbeat: (args, ctx) => ctx.services.runs.heartbeat(ctx.read, serviceArgs(args)),
  finish_run: (args, ctx) => ctx.mutate((w) => ctx.services.runs.finish(w, serviceArgs(args))),
};

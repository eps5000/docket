/**
 * Decisions (MCP_SPEC §5.8): tool handlers.
 *
 * Wired to the domain services (tasks.md T048): each handler calls its
 * service in domain/contracts.ts through `ctx.services`, and mutations go
 * through `ctx.mutate`. While a service is a stub, the tool answers
 * `unavailable` ("Not implemented yet: <tool>"). The slice that owns a tool
 * implements the service; registration, schemas and copy stay as they are.
 */
import { omit, serviceArgs, type ToolHandlers } from '../register.js';

export const decisionsHandlers: Pick<
  ToolHandlers,
  'publish_decision' | 'list_decisions' | 'withdraw_decision'
> = {
  publish_decision: (args, ctx) => ({
    decision: ctx.mutate((w) =>
      ctx.services.decisions.publish(w, omit(serviceArgs(args), 'run_id')),
    ),
  }),
  list_decisions: (args, ctx) => ctx.services.decisions.list(ctx.read, omit(args, 'run_id')),
  withdraw_decision: (args, ctx) => ({
    decision: ctx.mutate((w) =>
      ctx.services.decisions.withdraw(w, { decision_id: args.decision_id, reason: args.reason }),
    ),
  }),
};

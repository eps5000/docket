/**
 * The checklist (MCP_SPEC §5.5): tool handlers.
 *
 * Wired to the domain services (tasks.md T048): each handler calls its
 * service in domain/contracts.ts through `ctx.services`, and mutations go
 * through `ctx.mutate`. While a service is a stub, the tool answers
 * `unavailable` ("Not implemented yet: <tool>"). The slice that owns a tool
 * implements the service; registration, schemas and copy stay as they are.
 */
import { serviceArgs, type ToolHandlers } from '../register.js';

export const checklistHandlers: Pick<
  ToolHandlers,
  | 'set_plan'
  | 'update_step'
  | 'log_subagent'
  | 'set_checks'
  | 'update_check'
  | 'declare_human_review'
  | 'update_human_review'
> = {
  set_plan: (args, ctx) => ctx.mutate((w) => ctx.services.checklist.setPlan(w, serviceArgs(args))),
  update_step: (args, ctx) =>
    ctx.mutate((w) => ctx.services.checklist.updateStep(w, serviceArgs(args))),
  log_subagent: (args, ctx) =>
    ctx.mutate((w) => ctx.services.checklist.logSubagent(w, serviceArgs(args))),
  set_checks: (args, ctx) =>
    ctx.mutate((w) => ctx.services.checklist.setChecks(w, serviceArgs(args))),
  update_check: (args, ctx) =>
    ctx.mutate((w) => ctx.services.checklist.updateCheck(w, serviceArgs(args))),
  declare_human_review: (args, ctx) => ({
    human_review: ctx.mutate((w) => ctx.services.humanReview.declare(w, serviceArgs(args))),
  }),
  update_human_review: (args, ctx) => ({
    human_review: ctx.mutate((w) => ctx.services.humanReview.update(w, serviceArgs(args))),
  }),
};

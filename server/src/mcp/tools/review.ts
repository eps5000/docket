/**
 * Review and the owner (MCP_SPEC §5.7): tool handlers.
 *
 * Wired to the domain services (tasks.md T048): each handler calls its
 * service in domain/contracts.ts through `ctx.services`, and mutations go
 * through `ctx.mutate`. While a service is a stub, the tool answers
 * `unavailable` ("Not implemented yet: <tool>"). The slice that owns a tool
 * implements the service; registration, schemas and copy stay as they are.
 */
import { serviceArgs, type ToolHandlers } from '../register.js';

export const reviewHandlers: Pick<ToolHandlers, 'submit_packet' | 'get_review' | 'ask_owner'> = {
  submit_packet: (args, ctx) =>
    ctx.mutate((w) => ctx.services.packets.submit(w, serviceArgs(args))),
  get_review: (args, ctx) => ctx.services.packets.getReview(ctx.read, args),
  ask_owner: (args, ctx) => ctx.mutate((w) => ctx.services.messages.askOwner(w, serviceArgs(args))),
};

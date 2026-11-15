/**
 * Creating and editing items (MCP_SPEC §5.3): tool handlers.
 *
 * Wired to the domain services (tasks.md T048): each handler calls its
 * service in domain/contracts.ts through `ctx.services`, and mutations go
 * through `ctx.mutate`. While a service is a stub, the tool answers
 * `unavailable` ("Not implemented yet: <tool>"). The slice that owns a tool
 * implements the service; registration, schemas and copy stay as they are.
 */
import { serviceArgs, type ToolHandlers } from '../register.js';

export const itemsHandlers: Pick<
  ToolHandlers,
  'create_item' | 'update_item' | 'set_status' | 'link_items' | 'unlink_items' | 'upsert_label'
> = {
  create_item: (args, ctx) => ({
    item: ctx.mutate((w) => ctx.services.items.create(w, serviceArgs(args))),
  }),
  update_item: (args, ctx) => ({
    item: ctx.mutate((w) => ctx.services.items.update(w, serviceArgs(args))),
  }),
  set_status: (args, ctx) => ({
    item: ctx.mutate((w) => ctx.services.items.setStatus(w, serviceArgs(args))),
  }),
  link_items: (args, ctx) => ctx.mutate((w) => ctx.services.links.link(w, serviceArgs(args))),
  unlink_items: (args, ctx) => {
    ctx.mutate((w) => ctx.services.links.unlink(w, serviceArgs(args)));
    return { removed: true as const };
  },
  upsert_label: (args, ctx) =>
    ctx.mutate((w) => ctx.services.items.upsertLabel(w, serviceArgs(args))),
};

/**
 * Orientation and finding work (MCP_SPEC §5.1–5.2): tool handlers.
 *
 * Wired to the domain services (tasks.md T048): each handler calls its
 * service in domain/contracts.ts through `ctx.services`, and mutations go
 * through `ctx.mutate`. While a service is a stub, the tool answers
 * `unavailable` ("Not implemented yet: <tool>"). The slice that owns a tool
 * implements the service; registration, schemas and copy stay as they are.
 */
import type { ToolHandlers } from '../register.js';

export const readHandlers: Pick<
  ToolHandlers,
  | 'whoami'
  | 'list_projects'
  | 'search_items'
  | 'get_item'
  | 'get_context'
  | 'dependency_subgraph'
  | 'deferred_reviews'
  | 'get_changes'
> = {
  whoami: (_args, ctx) =>
    ctx.services.search.whoami(ctx.read, {
      client: ctx.session?.client ?? 'unknown',
      session_id: ctx.session?.session_id ?? '',
    }),
  list_projects: (_args, ctx) => ctx.services.search.listProjects(ctx.read),
  search_items: (args, ctx) => ctx.services.search.searchItems(ctx.read, args),
  get_item: (args, ctx) => {
    const { item, delivery } = ctx.services.items.get(ctx.read, args);
    // Owner notes and an answer are returned once, then marked read (BUILD_SPEC §5.7).
    if (delivery) ctx.services.messages.markDelivered(ctx.read, delivery);
    return { item };
  },
  get_context: (args, ctx) => ({ context: ctx.services.context.getContext(ctx.read, args) }),
  dependency_subgraph: (args, ctx) => ctx.services.subgraph.dependencySubgraph(ctx.read, args),
  deferred_reviews: (args, ctx) => ctx.services.packets.deferredReviews(ctx.read, args),
  get_changes: (args, ctx) => ctx.services.search.getChanges(ctx.read, args),
};

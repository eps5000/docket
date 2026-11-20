/**
 * Shared changes (MCP_SPEC §5.15; owner decision 36): tool handlers.
 *
 * Wired to the `sharedChanges` service (domain/contracts.ts; tasks.md T182).
 * B38 implements `declare_shared_changes` and `list_shared_parts`;
 * `take_lease` and `release_lease` answer `unavailable` ("Not implemented
 * yet: <tool>") until B39 (T183) implements the leases. Registration,
 * schemas and copy stay as they are.
 */
import { serviceArgs, type ToolHandlers } from '../register.js';

export const sharedHandlers: Pick<
  ToolHandlers,
  'declare_shared_changes' | 'list_shared_parts' | 'take_lease' | 'release_lease'
> = {
  declare_shared_changes: (args, ctx) =>
    ctx.mutate((w) => ctx.services.sharedChanges.declare(w, serviceArgs(args))),
  // Read-only: it changes nothing.
  list_shared_parts: (args, ctx) => ctx.services.sharedChanges.listParts(ctx.read, args),
  take_lease: (args, ctx) =>
    ctx.mutate((w) => ctx.services.sharedChanges.takeLease(w, serviceArgs(args))),
  release_lease: (args, ctx) =>
    ctx.mutate((w) => ctx.services.sharedChanges.releaseLease(w, serviceArgs(args))),
};

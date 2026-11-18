/**
 * Agent files (MCP_SPEC §5.10; owner decision 30): tool handlers.
 *
 * Wired to the domain services (tasks.md T159): each handler calls the
 * `agentProposals` service in domain/contracts.ts through `ctx.services`,
 * and the proposal goes through `ctx.mutate`. While the service is a stub,
 * the tool answers `unavailable` ("Not implemented yet: <tool>"). US14
 * (T160) implements the service; registration, schemas and copy stay as
 * they are.
 */
import { serviceArgs, type ToolHandlers } from '../register.js';

export const agentFilesHandlers: Pick<
  ToolHandlers,
  'get_agent_files' | 'propose_agent_file_change'
> = {
  // Read-only: it changes nothing.
  get_agent_files: (args, ctx) => ctx.services.agentProposals.files(ctx.read, args),
  // A pending proposal: nothing changes until the owner approves.
  propose_agent_file_change: (args, ctx) =>
    ctx.mutate((w) => ctx.services.agentProposals.propose(w, serviceArgs(args))),
};

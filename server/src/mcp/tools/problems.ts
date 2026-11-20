/**
 * Problems that say what to do (MCP_SPEC §5.16; owner decision 37): tool
 * handlers, wired to the `problems` service (domain/problems.ts).
 */
import { serviceArgs, type ToolHandlers } from '../register.js';

export const problemsHandlers: Pick<ToolHandlers, 'propose_resolution'> = {
  propose_resolution: (args, ctx) =>
    ctx.mutate((w) => ctx.services.problems.propose(w, serviceArgs(args))),
};

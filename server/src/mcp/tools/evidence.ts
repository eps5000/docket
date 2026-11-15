/**
 * Evidence (MCP_SPEC §5.6): tool handlers.
 *
 * Wired to the domain services (tasks.md T048): each handler calls its
 * service in domain/contracts.ts through `ctx.services`, and mutations go
 * through `ctx.mutate`. While a service is a stub, the tool answers
 * `unavailable` ("Not implemented yet: <tool>"). The slice that owns a tool
 * implements the service; registration, schemas and copy stay as they are.
 */
import { serviceArgs, type ToolHandlers } from '../register.js';

export const evidenceHandlers: Pick<
  ToolHandlers,
  'add_note' | 'put_document' | 'link_artifact' | 'report_commit'
> = {
  add_note: (args, ctx) => ({
    event: ctx.mutate((w) => ctx.services.evidence.addNote(w, serviceArgs(args))),
  }),
  put_document: (args, ctx) => ctx.mutate((w) => ctx.services.documents.put(w, serviceArgs(args))),
  link_artifact: (args, ctx) => ({
    artifact: ctx.mutate((w) => ctx.services.evidence.linkArtifact(w, serviceArgs(args))),
  }),
  report_commit: (args, ctx) =>
    ctx.mutate((w) => ctx.services.evidence.reportCommit(w, serviceArgs(args))),
};

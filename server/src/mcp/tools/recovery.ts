/**
 * Recovery (MCP_SPEC §5.9): tool handlers.
 *
 * Wired to the domain services (tasks.md T054): `recovery_report` calls the
 * `recovery` service in domain/contracts.ts through `ctx.services`. While
 * the service is a stub, the tool answers `unavailable` ("Not implemented
 * yet: recovery_report"). US11 (T100) implements the service; registration,
 * schemas and copy stay as they are.
 */
import type { ToolHandlers } from '../register.js';

export const recoveryHandlers: Pick<ToolHandlers, 'recovery_report'> = {
  // Read-only: it never changes state; the coordinator acts on it.
  recovery_report: (args, ctx) => ctx.services.recovery.report(ctx.read, args),
};

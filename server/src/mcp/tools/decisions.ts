/**
 * Decisions (MCP_SPEC §5.8): tool handlers.
 *
 * Stubs (tasks.md T041): each answers `unavailable` ("Not implemented yet: <tool>")
 * after its arguments pass validation. The slice that owns a tool replaces
 * its stub here, in place; registration, schemas and copy stay as they are.
 */
import { notImplemented, type ToolHandlers } from '../register.js';

export const decisionsHandlers: Pick<
  ToolHandlers,
  'publish_decision' | 'list_decisions' | 'withdraw_decision'
> = {
  publish_decision: notImplemented('publish_decision'),
  list_decisions: notImplemented('list_decisions'),
  withdraw_decision: notImplemented('withdraw_decision'),
};

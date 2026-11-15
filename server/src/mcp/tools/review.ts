/**
 * Review and the owner (MCP_SPEC §5.7): tool handlers.
 *
 * Stubs (tasks.md T041): each answers `unavailable` ("Not implemented yet: <tool>")
 * after its arguments pass validation. The slice that owns a tool replaces
 * its stub here, in place; registration, schemas and copy stay as they are.
 */
import { notImplemented, type ToolHandlers } from '../register.js';

export const reviewHandlers: Pick<ToolHandlers, 'submit_packet' | 'get_review' | 'ask_owner'> = {
  submit_packet: notImplemented('submit_packet'),
  get_review: notImplemented('get_review'),
  ask_owner: notImplemented('ask_owner'),
};

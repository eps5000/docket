/**
 * Claiming and runs (MCP_SPEC §5.4): tool handlers.
 *
 * Stubs (tasks.md T041): each answers `unavailable` ("Not implemented yet: <tool>")
 * after its arguments pass validation. The slice that owns a tool replaces
 * its stub here, in place; registration, schemas and copy stay as they are.
 */
import { notImplemented, type ToolHandlers } from '../register.js';

export const runsHandlers: Pick<
  ToolHandlers,
  'claim_lead' | 'release_lead' | 'start_run' | 'heartbeat' | 'finish_run'
> = {
  claim_lead: notImplemented('claim_lead'),
  release_lead: notImplemented('release_lead'),
  start_run: notImplemented('start_run'),
  heartbeat: notImplemented('heartbeat'),
  finish_run: notImplemented('finish_run'),
};

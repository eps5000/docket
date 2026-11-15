/**
 * The checklist (MCP_SPEC §5.5): tool handlers.
 *
 * Stubs (tasks.md T041): each answers `unavailable` ("Not implemented yet: <tool>")
 * after its arguments pass validation. The slice that owns a tool replaces
 * its stub here, in place; registration, schemas and copy stay as they are.
 */
import { notImplemented, type ToolHandlers } from '../register.js';

export const checklistHandlers: Pick<
  ToolHandlers,
  | 'set_plan'
  | 'update_step'
  | 'log_subagent'
  | 'set_checks'
  | 'update_check'
  | 'declare_human_review'
  | 'update_human_review'
> = {
  set_plan: notImplemented('set_plan'),
  update_step: notImplemented('update_step'),
  log_subagent: notImplemented('log_subagent'),
  set_checks: notImplemented('set_checks'),
  update_check: notImplemented('update_check'),
  declare_human_review: notImplemented('declare_human_review'),
  update_human_review: notImplemented('update_human_review'),
};

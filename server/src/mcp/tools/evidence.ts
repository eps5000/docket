/**
 * Evidence (MCP_SPEC §5.6): tool handlers.
 *
 * Stubs (tasks.md T041): each answers `unavailable` ("Not implemented yet: <tool>")
 * after its arguments pass validation. The slice that owns a tool replaces
 * its stub here, in place; registration, schemas and copy stay as they are.
 */
import { notImplemented, type ToolHandlers } from '../register.js';

export const evidenceHandlers: Pick<
  ToolHandlers,
  'add_note' | 'put_document' | 'link_artifact' | 'report_commit'
> = {
  add_note: notImplemented('add_note'),
  put_document: notImplemented('put_document'),
  link_artifact: notImplemented('link_artifact'),
  report_commit: notImplemented('report_commit'),
};

/**
 * Creating and editing items (MCP_SPEC §5.3): tool handlers.
 *
 * Stubs (tasks.md T041): each answers `unavailable` ("Not implemented yet: <tool>")
 * after its arguments pass validation. The slice that owns a tool replaces
 * its stub here, in place; registration, schemas and copy stay as they are.
 */
import { notImplemented, type ToolHandlers } from '../register.js';

export const itemsHandlers: Pick<
  ToolHandlers,
  'create_item' | 'update_item' | 'set_status' | 'link_items' | 'unlink_items' | 'upsert_label'
> = {
  create_item: notImplemented('create_item'),
  update_item: notImplemented('update_item'),
  set_status: notImplemented('set_status'),
  link_items: notImplemented('link_items'),
  unlink_items: notImplemented('unlink_items'),
  upsert_label: notImplemented('upsert_label'),
};

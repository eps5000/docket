/**
 * Orientation and finding work (MCP_SPEC §5.1–5.2): tool handlers.
 *
 * Stubs (tasks.md T041): each answers `unavailable` ("Not implemented yet: <tool>")
 * after its arguments pass validation. The slice that owns a tool replaces
 * its stub here, in place; registration, schemas and copy stay as they are.
 */
import { notImplemented, type ToolHandlers } from '../register.js';

export const readHandlers: Pick<
  ToolHandlers,
  | 'whoami'
  | 'list_projects'
  | 'search_items'
  | 'get_item'
  | 'get_context'
  | 'dependency_subgraph'
  | 'deferred_reviews'
  | 'get_changes'
> = {
  whoami: notImplemented('whoami'),
  list_projects: notImplemented('list_projects'),
  search_items: notImplemented('search_items'),
  get_item: notImplemented('get_item'),
  get_context: notImplemented('get_context'),
  dependency_subgraph: notImplemented('dependency_subgraph'),
  deferred_reviews: notImplemented('deferred_reviews'),
  get_changes: notImplemented('get_changes'),
};

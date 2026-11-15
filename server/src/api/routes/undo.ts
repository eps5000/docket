/** `POST /api/mutations/:id/undo` (BUILD_SPEC §5.11, §7; FR-062). */
import type { Hono } from 'hono';
import { undoMutation } from '../../domain/undo.js';
import type { WritePath } from '../../domain/write.js';
import type { ApiEnv } from '../session.js';

export function undoRoutes(api: Hono<ApiEnv>, deps: { write: WritePath }): void {
  api.post('/mutations/:id/undo', (c) => {
    const out = undoMutation(deps.write, c.req.param('id'));
    return c.json({ mutation_id: out.mutation_id, undone: out.result.undone });
  });
}

/** `POST /api/mutations/:id/undo` (BUILD_SPEC §5.11, §7; FR-062). Implemented in B2. */
import type { Env, Hono } from 'hono';
import { defineRoute, type RouteDeps } from '../define.js';

export function undoRoutes<E extends Env>(api: Hono<E>, deps: RouteDeps): void {
  defineRoute(api, 'mutations.undo', deps, ({ services, mutate, params }) => {
    const { result, mutation_id } = mutate((w) =>
      services.undo.undo(w, { mutation_id: params.id }),
    );
    return { mutation_id, undone: result.undone };
  });
}

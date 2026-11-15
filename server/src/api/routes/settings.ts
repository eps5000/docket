/**
 * Settings and deleting a project (BUILD_SPEC §5.12, §7; contracts/ui-api.md
 * US10). Lock and rotate-key are B2's (api/session.ts); the blocker rule is
 * in deps.ts.
 *
 * Placeholders (tasks.md T045): each route is guarded and validated, and
 * calls its service; stubs answer 501 until US10 (T118) implements them.
 */
import type { Env, Hono } from 'hono';
import { defineRoute, type RouteDeps } from '../define.js';

export function settingsRoutes<E extends Env>(api: Hono<E>, deps: RouteDeps): void {
  defineRoute(api, 'settings.get', deps, ({ services, read }) => services.views.settings(read));

  /** Not undoable; the docs directory is removed after the commit. */
  defineRoute(api, 'projects.delete', deps, async ({ services, mutate, read, params, body }) => {
    const { result } = mutate((w) =>
      services.projects.delete(w, { key: params.key, confirm_key: body.confirm_key }),
    );
    await services.projects.removeDeletedDocs(read);
    return result;
  });
}

/**
 * Settings and deleting a project (BUILD_SPEC §5.12, §7; contracts/ui-api.md
 * US10). Lock and rotate-key are B2's (api/session.ts); the blocker rule is
 * in deps.ts.
 *
 * Placeholders (tasks.md T045): each route is guarded and validated, and
 * calls its service; stubs answer 501 until US10 (T118) implements them.
 */
import type { Env, Hono } from 'hono';
import { API_ROUTES, NOT_IMPLEMENTED_STATUS, notImplementedRouteMessage } from '@tasklite/shared';
import { defineRoute, type RouteDeps } from '../define.js';
import { errorBody } from '../guards.js';

export function settingsRoutes<E extends Env>(api: Hono<E>, deps: RouteDeps): void {
  defineRoute(api, 'settings.get', deps, ({ services, read }) => services.views.settings(read));

  /** *Reveal token* (US10 fills it): owner session only, `Cache-Control: no-store`, never logged. */
  defineRoute(api, 'settings.agentToken', deps, ({ c }) => {
    const { method, path } = API_ROUTES['settings.agentToken'];
    return c.json(
      errorBody('unavailable', notImplementedRouteMessage(method, path)),
      NOT_IMPLEMENTED_STATUS,
    );
  });

  /** Not undoable; the docs directory is removed after the commit. */
  defineRoute(api, 'projects.delete', deps, async ({ services, mutate, read, params, body }) => {
    const { result } = mutate((w) =>
      services.projects.delete(w, { key: params.key, confirm_key: body.confirm_key }),
    );
    await services.projects.removeDeletedDocs(read);
    return result;
  });
}

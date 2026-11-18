/**
 * The onboarding review (owner decision 31; BUILD_SPEC §5.20, §7; UI_SPEC
 * §6.7d; tasks.md T163): the sessions the Needs you card shows, and *Mark
 * reviewed*. *New project* (`POST /api/projects`) is in settings.ts.
 *
 * Each route sits behind the owner session (and CSRF on the POST), is
 * strictly validated, and calls the `onboarding` service; while it is a stub
 * the route answers 501, until US15 (T164, T165) implements it.
 */
import type { Env, Hono } from 'hono';
import { defineRoute, type RouteDeps } from '../define.js';

export function onboardingRoutes<E extends Env>(api: Hono<E>, deps: RouteDeps): void {
  defineRoute(api, 'onboarding.list', deps, ({ services, read, query }) =>
    services.onboarding.list(read, query),
  );

  /** Not undoable (B29). */
  defineRoute(api, 'onboarding.reviewed', deps, ({ services, mutate, params }) => {
    const { result, mutation_id } = mutate((w) => services.onboarding.markReviewed(w, params));
    return { mutation_id, session: result };
  });
}

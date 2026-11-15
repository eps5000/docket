/**
 * Dependencies: removing a link, and the project's blocker rule (BUILD_SPEC
 * §5.2, §7; contracts/ui-api.md US4).
 *
 * Placeholders (tasks.md T045): each route is guarded and validated, and
 * calls its service; stubs answer 501 until US4 (T093) implements them.
 */
import type { Env, Hono } from 'hono';
import { defineRoute, type RouteDeps } from '../define.js';

export function depsRoutes<E extends Env>(api: Hono<E>, deps: RouteDeps): void {
  defineRoute(api, 'links.delete', deps, ({ services, mutate, params }) => {
    const { result, mutation_id } = mutate((w) =>
      services.links.unlink(w, { link_id: params.linkId }),
    );
    return { mutation_id, ...result };
  });

  defineRoute(api, 'projects.patch', deps, ({ services, mutate, params, body }) => {
    const { result, mutation_id } = mutate((w) =>
      services.projects.setDefaultSatisfiedWhen(w, { key: params.key, ...body }),
    );
    return { mutation_id, ...result };
  });
}

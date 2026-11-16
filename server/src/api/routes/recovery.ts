/**
 * Recovery (owner decision 26; BUILD_SPEC §5.16, §7; contracts/ui-api.md
 * US11): Agents → Workspaces, and the Problems actions *Mark released* and
 * *Handled*.
 *
 * Placeholders (tasks.md T055): each route is guarded and validated, and
 * calls its service; stubs answer 501 until US11 (T100) implements them.
 */
import type { Env, Hono } from 'hono';
import { defineRoute, type RouteDeps } from '../define.js';

export function recoveryRoutes<E extends Env>(api: Hono<E>, deps: RouteDeps): void {
  defineRoute(api, 'workspaces.list', deps, ({ services, read, query }) =>
    services.recovery.workspaces(read, query),
  );

  defineRoute(api, 'resources.release', deps, ({ services, mutate, params, body }) => {
    const { result, mutation_id } = mutate((w) =>
      services.recovery.ownerReleaseResource(w, { ...params, ...body }),
    );
    return { mutation_id, resource: result };
  });

  defineRoute(api, 'runs.unpushedHandled', deps, ({ services, mutate, params }) => {
    const { result, mutation_id } = mutate((w) => services.recovery.markUnpushedHandled(w, params));
    return { mutation_id, ...result };
  });
}

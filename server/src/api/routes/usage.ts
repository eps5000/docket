/**
 * Token use (owner decision 48; B63; BUILD_SPEC §5.34). Everything sits behind
 * the owner guards. The two `/api/sync/usage` routes are the docket-sync
 * collector's, in its `{ settings, status }` and `{ records, run }` shapes.
 */
import type { Env, Hono } from 'hono';
import { defineRoute, type RouteDeps } from '../define.js';

export function usageRoutes<E extends Env>(api: Hono<E>, deps: RouteDeps): void {
  defineRoute(api, 'usage.get', deps, ({ services, read, query }) =>
    services.usage.summary(read, query),
  );

  defineRoute(api, 'usageSettings.get', deps, ({ services, read }) =>
    services.usage.settings(read),
  );

  defineRoute(api, 'usageSettings.set', deps, ({ services, mutate, body }) => {
    const { result, mutation_id } = mutate((w) => services.usage.setSettings(w, body));
    return { mutation_id, ...result };
  });

  defineRoute(api, 'usage.item', deps, ({ services, read, params }) =>
    services.usage.item(read, params),
  );
}

export function usageSyncRoutes<E extends Env>(api: Hono<E>, deps: RouteDeps): void {
  defineRoute(api, 'usageSync.config', deps, ({ services, read }) =>
    services.usage.syncConfig(read),
  );
  defineRoute(api, 'usageSync.post', deps, ({ services, read, body }) =>
    services.usage.ingest(read, body),
  );
}

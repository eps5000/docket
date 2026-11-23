/**
 * Token use (owner decision 48; B63; BUILD_SPEC §5.30). The owner's reads and the
 * Settings toggle sit behind the owner session. The collector's two routes are
 * mounted beside the UI API (`usageSyncRoutes`), behind the same rule as `/mcp`:
 * the agent token in protected mode, nothing in local trust.
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

export function usageSyncRoutes<E extends Env>(app: Hono<E>, deps: RouteDeps): void {
  defineRoute(
    app,
    'usageSync.config',
    deps,
    ({ services, read }) => services.usage.syncConfig(read),
    { prefix: '' },
  );
  defineRoute(
    app,
    'usageSync.post',
    deps,
    ({ services, read, body }) => services.usage.ingest(read, body.records),
    { prefix: '' },
  );
}

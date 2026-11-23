/**
 * The host collector and the GitHub connection (owner decision 49;
 * BUILD_SPEC §5.34). These routes sit behind `/api`'s owner guards, and the
 * ingest body is size-capped in app.ts. Docket calls nothing outside itself.
 */
import type { Env, Hono } from 'hono';
import { defineRoute, type RouteDeps } from '../define.js';

export function syncRoutes<E extends Env>(api: Hono<E>, deps: RouteDeps): void {
  defineRoute(api, 'sync.source', deps, ({ services, read, params }) =>
    services.sync.source(read, params.source),
  );

  /** Writes as the system through the write path: nothing here is the owner's own action. */
  defineRoute(api, 'sync.ingest', deps, ({ services, params, body }) =>
    services.sync.ingest(deps.write, params.source, body),
  );

  defineRoute(api, 'github.get', deps, ({ services, read }) => services.sync.github(read));

  defineRoute(api, 'github.set', deps, ({ services, mutate, body }) => {
    const { result, mutation_id } = mutate((w) => services.sync.setGithub(w, body));
    return { mutation_id, ...result };
  });

  defineRoute(api, 'github.setProject', deps, ({ services, mutate, params, body }) => {
    const { result, mutation_id } = mutate((w) =>
      services.sync.setGithubProject(w, { key: params.key, ...body }),
    );
    return { mutation_id, ...result };
  });

  defineRoute(api, 'items.github', deps, ({ services, read, params }) =>
    services.sync.itemGithub(read, params.id),
  );
}

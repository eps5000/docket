/**
 * Jira import (BUILD_SPEC §9, §7; contracts/ui-api.md US9). The API token
 * is held in memory by the import service only; it never reaches the write
 * path, an event or a log.
 *
 * Placeholders (tasks.md T045): each route is guarded and validated, and
 * calls its service; stubs answer 501 until US9 implements them.
 */
import type { Env, Hono } from 'hono';
import { defineRoute, type RouteDeps } from '../define.js';

export function importRoutes<E extends Env>(api: Hono<E>, deps: RouteDeps): void {
  defineRoute(api, 'jira.dryRun', deps, ({ services, read, body }) => ({
    import: services.jiraImport.dryRun(read, body),
  }));

  defineRoute(api, 'jira.get', deps, ({ services, read, params }) => ({
    import: services.jiraImport.get(read, { import_id: params.id }),
  }));

  defineRoute(api, 'jira.commit', deps, ({ services, mutate, params }) => {
    const { result, mutation_id } = mutate((w) =>
      services.jiraImport.commit(w, { import_id: params.id }),
    );
    return { mutation_id, import: result };
  });

  defineRoute(api, 'jira.cancel', deps, ({ services, read, params }) => {
    services.jiraImport.cancel(read, { import_id: params.id });
    return { canceled: true as const };
  });
}

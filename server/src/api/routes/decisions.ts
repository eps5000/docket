/**
 * Decision records for the owner (BUILD_SPEC §5.14, §7; contracts/ui-api.md
 * US5). The owner's records carry `authority=owner` (from the actor).
 *
 * Placeholders (tasks.md T045): each route is guarded and validated, and
 * calls its service; stubs answer 501 until US5 (T101) implements them.
 */
import { LIMITS } from '@docket/shared';
import type { Env, Hono } from 'hono';
import { defineRoute, type RouteDeps } from '../define.js';

export function decisionsRoutes<E extends Env>(api: Hono<E>, deps: RouteDeps): void {
  defineRoute(api, 'decisions.list', deps, ({ services, read, query }) =>
    services.decisions.list(read, {
      project: query.project,
      scope: query.scope_kind ? { kind: query.scope_kind, id: query.scope_id } : undefined,
      include_inactive: query.include_inactive,
      cursor: query.cursor,
      limit: LIMITS.page_max,
    }),
  );

  defineRoute(api, 'decisions.create', deps, ({ services, mutate, body }) => {
    const { result, mutation_id } = mutate((w) => services.decisions.publish(w, body));
    return { mutation_id, decision: result };
  });

  defineRoute(api, 'decisions.confirm', deps, ({ services, mutate, params, body }) => {
    const { result, mutation_id } = mutate((w) =>
      services.decisions.confirm(w, { decision_id: params.id, ...body }),
    );
    return { mutation_id, decision: result };
  });

  defineRoute(api, 'decisions.acknowledge', deps, ({ services, mutate, body }) => {
    const { result, mutation_id } = mutate((w) => services.decisions.acknowledge(w, body));
    return { mutation_id, decisions: result };
  });

  defineRoute(api, 'decisions.withdraw', deps, ({ services, mutate, params, body }) => {
    const { result, mutation_id } = mutate((w) =>
      services.decisions.withdraw(w, { decision_id: params.id, ...body }),
    );
    return { mutation_id, decision: result };
  });
}

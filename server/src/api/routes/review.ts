/**
 * The packet screen and owner review decisions (BUILD_SPEC §5.6, §7;
 * contracts/ui-api.md US3).
 *
 * Placeholders (tasks.md T045): each route is guarded and validated, and
 * calls its service; stubs answer 501 until US3 (T086) implements them.
 */
import type { Env, Hono } from 'hono';
import { defineRoute, type RouteDeps } from '../define.js';

export function reviewRoutes<E extends Env>(api: Hono<E>, deps: RouteDeps): void {
  defineRoute(api, 'review.get', deps, ({ services, read, params, query }) =>
    services.packets.screen(read, { id: params.id, round: query.round }),
  );

  defineRoute(api, 'review.decide', deps, ({ services, mutate, params, body }) => {
    const { result, mutation_id } = mutate((w) =>
      services.reviewDecisions.decide(w, { id: params.id, ...body }),
    );
    return { mutation_id, ...result };
  });

  defineRoute(api, 'review.refresh', deps, ({ services, mutate, params, body }) => {
    const { result, mutation_id } = mutate((w) =>
      services.packets.refresh(w, { id: params.id, ...body }),
    );
    return { mutation_id, item: result };
  });

  defineRoute(api, 'deferred.followUp', deps, ({ services, mutate, params }) => {
    const { result, mutation_id } = mutate((w) =>
      services.reviewDecisions.createFollowUp(w, { hr_item_id: params.hrId }),
    );
    return { mutation_id, item: result };
  });
}

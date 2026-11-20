/**
 * Shared changes and the conflict radar (owner decision 36; BUILD_SPEC
 * §5.21, §7; UI_SPEC §6.3.6; tasks.md T182): the registry, an item's
 * declaration, overlap and undeclared-parts decisions, lease release, and
 * the radar card.
 *
 * Each route sits behind the owner session (and CSRF on mutations), is
 * strictly validated, and calls the `sharedChanges` service (B38: the
 * registry, the declaration and the reads; B39: the decisions, lease release
 * and the radar's settings and runs). The registry and declaration edits are
 * undoable; the rest reach agents at once and aren't.
 */
import type { Env, Hono } from 'hono';
import { defineRoute, type RouteDeps } from '../define.js';

export function sharedRoutes<E extends Env>(api: Hono<E>, deps: RouteDeps): void {
  defineRoute(api, 'sharedParts.list', deps, ({ services, read, params, query }) =>
    services.sharedChanges.ownerList(read, { ...params, ...query }),
  );

  defineRoute(api, 'sharedParts.create', deps, ({ services, mutate, params, body }) => {
    const { result, mutation_id } = mutate((w) =>
      services.sharedChanges.ownerCreate(w, { project: params.key, part: body }),
    );
    return { mutation_id, part: result };
  });

  defineRoute(api, 'sharedParts.update', deps, ({ services, mutate, params, body }) => {
    const { result, mutation_id } = mutate((w) =>
      services.sharedChanges.ownerUpdate(w, { ...params, ...body }),
    );
    return { mutation_id, part: result };
  });

  defineRoute(api, 'itemShared.get', deps, ({ services, read, params }) =>
    services.sharedChanges.itemShared(read, params),
  );

  defineRoute(api, 'itemShared.put', deps, ({ services, mutate, params, body }) => {
    const { result, mutation_id } = mutate((w) =>
      services.sharedChanges.ownerDeclare(w, { ...params, ...body }),
    );
    return { mutation_id, ...result };
  });

  /** B40: set or clear the item's branch for the radar (undoable). */
  defineRoute(api, 'itemShared.branch', deps, ({ services, mutate, params, body }) => {
    const { result, mutation_id } = mutate((w) =>
      services.sharedChanges.ownerSetBranch(w, { ...params, ...body }),
    );
    return { mutation_id, ...result };
  });

  /** Not undoable: the decision reaches agents at once. */
  defineRoute(api, 'overlaps.decide', deps, ({ services, mutate, params, body }) => {
    const { result, mutation_id } = mutate((w) =>
      services.sharedChanges.decideOverlap(w, { ...params, ...body }),
    );
    return { mutation_id, overlap: result };
  });

  /** Not undoable. */
  defineRoute(api, 'undeclaredHolds.decide', deps, ({ services, mutate, params, body }) => {
    const { result, mutation_id } = mutate((w) =>
      services.sharedChanges.decideHold(w, { ...params, ...body }),
    );
    return { mutation_id, hold: result };
  });

  /** Not undoable. */
  defineRoute(api, 'leases.release', deps, ({ services, mutate, params }) => {
    const { result, mutation_id } = mutate((w) =>
      services.sharedChanges.ownerReleaseLease(w, params),
    );
    return { mutation_id, lease: result };
  });

  defineRoute(api, 'radar.get', deps, ({ services, read, params }) =>
    services.sharedChanges.radar(read, params),
  );

  defineRoute(api, 'radar.settings', deps, ({ services, mutate, params, body }) => {
    const { result, mutation_id } = mutate((w) =>
      services.sharedChanges.setRadar(w, { ...params, ...body }),
    );
    return { mutation_id, radar: result };
  });

  /** *Run radar now*: git runs before the write, never inside it (radar.ts). */
  defineRoute(api, 'radar.run', deps, ({ services, read, mutate, params }) => {
    const plan = services.sharedChanges.planRadar(read, params);
    const { mutation_id } = mutate((w) => services.sharedChanges.recordRadar(w, plan));
    services.sharedChanges.finishRadar(read, plan);
    return { mutation_id, radar: services.sharedChanges.radar(read, params) };
  });
}

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

  /** B41: add or remove one of the item's branches for the radar (undoable). */
  defineRoute(api, 'itemShared.branches', deps, ({ services, mutate, params, body }) => {
    const { result, mutation_id } = mutate((w) =>
      services.sharedChanges.ownerBranches(w, { ...params, ...body }),
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

  /** Decision 39: *Run in parallel* or *Run in order* on an automatic outcome. Undoable. */
  defineRoute(api, 'overlaps.overrule', deps, ({ services, mutate, params, body }) => {
    const { result, mutation_id } = mutate((w) =>
      services.sharedChanges.overruleOverlap(w, { ...params, ...body }),
    );
    return { mutation_id, overlap: result };
  });

  /** Decision 39: *Approve the design change* or *Send back*. Undoable. */
  defineRoute(api, 'designReviews.decide', deps, ({ services, mutate, params, body }) => {
    const { result, mutation_id } = mutate((w) =>
      services.sharedChanges.decideDesignReview(w, { ...params, ...body }),
    );
    return { mutation_id, review: result };
  });

  /** Decision 39: Settings → Overlap handling (owner session only; no MCP tool). */
  defineRoute(api, 'overlapHandling.get', deps, ({ services, read }) =>
    services.sharedChanges.overlapHandling(read),
  );

  defineRoute(api, 'overlapHandling.set', deps, ({ services, mutate, body }) => {
    const { result, mutation_id } = mutate((w) =>
      services.sharedChanges.setOverlapHandling(w, body),
    );
    return { mutation_id, ...result };
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

  /**
   * *Run radar now*: git runs before the write, never inside it, and never on
   * the event loop (B52). During a run this joins it and answers when it ends.
   */
  defineRoute(api, 'radar.run', deps, async ({ services, read, mutate, params }) => {
    const current = () => ({ ...read, now: deps.write.now().toISOString() });
    const { mutation_id } = await services.sharedChanges.runRadar(params, {
      read: current,
      record: mutate,
    });
    return { mutation_id, radar: services.sharedChanges.radar(current(), params) };
  });
}

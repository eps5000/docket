/**
 * Steering a ticket: answers, notes, lead actions and the owner's checklist
 * entries (BUILD_SPEC §5.3, §5.5, §5.7, §7; contracts/ui-api.md US6).
 *
 * Placeholders (tasks.md T045): each route is guarded and validated, and
 * calls its service; stubs answer 501 until US6 (T107) implements them.
 */
import type { Env, Hono } from 'hono';
import { defineRoute, type RouteDeps } from '../define.js';

export function steerRoutes<E extends Env>(api: Hono<E>, deps: RouteDeps): void {
  defineRoute(api, 'items.answer', deps, ({ services, mutate, params, body }) => {
    const { result, mutation_id } = mutate((w) =>
      services.messages.answer(w, { id: params.id, ...body }),
    );
    return { mutation_id, question: result };
  });

  defineRoute(api, 'items.addNote', deps, ({ services, mutate, params, body }) => {
    const { result, mutation_id } = mutate((w) =>
      services.messages.addOwnerNote(w, { id: params.id, ...body }),
    );
    return { mutation_id, note: result };
  });

  defineRoute(api, 'items.release', deps, ({ services, mutate, params, body }) => {
    const { result, mutation_id } = mutate((w) =>
      services.runs.ownerRelease(w, { id: params.id, ...body }),
    );
    return { mutation_id, item: result };
  });

  defineRoute(api, 'items.returnToReady', deps, ({ services, mutate, params, body }) => {
    const { result, mutation_id } = mutate((w) =>
      services.runs.returnToReady(w, { id: params.id, ...body }),
    );
    return { mutation_id, item: result };
  });

  defineRoute(api, 'steps.add', deps, ({ services, mutate, params, body }) => {
    const { result, mutation_id } = mutate((w) =>
      services.checklist.ownerAddStep(w, { id: params.id, ...body }),
    );
    return { mutation_id, step: result };
  });

  defineRoute(api, 'steps.remove', deps, ({ services, mutate, params }) => {
    const { mutation_id } = mutate((w) => services.checklist.ownerRemoveStep(w, params));
    return { mutation_id, removed: true as const };
  });

  defineRoute(api, 'steps.get', deps, ({ services, read, params }) =>
    services.checklist.ownerGetStep(read, params),
  );

  defineRoute(api, 'steps.details', deps, ({ services, mutate, params, body }) => {
    const { result, mutation_id } = mutate((w) =>
      services.checklist.ownerSetStepDetails(w, { ...params, ...body }),
    );
    return { mutation_id, step: result };
  });

  defineRoute(api, 'checks.add', deps, ({ services, mutate, params, body }) => {
    const { result, mutation_id } = mutate((w) =>
      services.checklist.ownerAddCheck(w, { id: params.id, ...body }),
    );
    return { mutation_id, check: result };
  });

  defineRoute(api, 'checks.remove', deps, ({ services, mutate, params }) => {
    const { mutation_id } = mutate((w) => services.checklist.ownerRemoveCheck(w, params));
    return { mutation_id, removed: true as const };
  });

  defineRoute(api, 'humanReview.add', deps, ({ services, mutate, params, body }) => {
    const { result, mutation_id } = mutate((w) =>
      services.humanReview.ownerAdd(w, { id: params.id, ...body }),
    );
    return { mutation_id, hr_item: result };
  });

  defineRoute(api, 'humanReview.update', deps, ({ services, mutate, params, body }) => {
    const { result, mutation_id } = mutate((w) =>
      services.humanReview.ownerUpdate(w, { ...params, ...body }),
    );
    return { mutation_id, hr_item: result };
  });

  defineRoute(api, 'humanReview.remove', deps, ({ services, mutate, params, body }) => {
    const { mutation_id } = mutate((w) =>
      services.humanReview.ownerRemove(w, { ...params, ...body }),
    );
    return { mutation_id, removed: true as const };
  });
}

/**
 * Agent setup (owner decision 29; BUILD_SPEC §5.17, §7; UI_SPEC §6.7b;
 * contracts/ui-api.md US13): agent files and their layers, the project's
 * Workflow notes, installs and their log, the check, and the push folder.
 *
 * Placeholders (tasks.md T150): each route is guarded (owner session, CSRF
 * on mutations) and strictly validated, and calls its service; stubs answer
 * 501 until US13 (T153–T157) implements them.
 *
 * An install touches the host outside any transaction, so it runs in two
 * steps, like `/agent-upload`: `installs.prepare` builds the bundle (and for
 * push writes the files), then one write records it.
 */
import type { Env, Hono } from 'hono';
import { defineRoute, type RouteDeps } from '../define.js';

export function setupRoutes<E extends Env>(api: Hono<E>, deps: RouteDeps): void {
  defineRoute(api, 'agentFiles.list', deps, ({ services, read, query }) =>
    services.agentFiles.list(read, query),
  );

  defineRoute(api, 'agentFiles.get', deps, ({ services, read, params, query }) =>
    services.agentFiles.get(read, { ...params, ...query }),
  );

  defineRoute(api, 'agentFiles.put', deps, ({ services, mutate, params, body }) => {
    const { result, mutation_id } = mutate((w) =>
      services.agentFiles.put(w, { ...params, ...body }),
    );
    return { mutation_id, file: result };
  });

  defineRoute(api, 'agentFiles.revert', deps, ({ services, mutate, params, body }) => {
    const { result, mutation_id } = mutate((w) =>
      services.agentFiles.revert(w, { ...params, ...body }),
    );
    return { mutation_id, file: result };
  });

  defineRoute(api, 'workflow.get', deps, ({ services, read, params }) =>
    services.agentFiles.workflow(read, params),
  );

  defineRoute(api, 'workflow.put', deps, ({ services, mutate, params, body }) => {
    const { result, mutation_id } = mutate((w) =>
      services.agentFiles.putWorkflow(w, { ...params, ...body }),
    );
    return { mutation_id, workflow: result };
  });

  defineRoute(api, 'installs.create', deps, async ({ services, read, mutate, body }) => {
    const prepared = await services.installs.prepare(read, body);
    return mutate((w) => services.installs.record(w, prepared)).result;
  });

  defineRoute(api, 'installs.list', deps, ({ services, read, query }) =>
    services.installs.list(read, query),
  );

  defineRoute(api, 'installs.check', deps, ({ services, read, params }) =>
    services.installs.check(read, params),
  );

  defineRoute(api, 'pushTarget.get', deps, ({ services, read }) =>
    services.installs.pushTarget(read),
  );

  defineRoute(api, 'pushTarget.test', deps, ({ services, read }) =>
    services.installs.testPushTarget(read),
  );
}

/**
 * Reading routes (BUILD_SPEC §7; contracts/ui-api.md US2): the shell, Needs
 * you, Work, the item page, Agents and search. `GET /api/stream` is B2's
 * (api/stream.ts).
 *
 * Placeholders (tasks.md T045): each route is guarded and validated, and
 * calls its service; stubs answer 501 until US2 (T073) implements them.
 * `layout=timeline` takes its `timeline` section from the forecast service (US8).
 */
import type { Env, Hono } from 'hono';
import { withCardActivity } from '../../domain/work-card-activity.js';
import { defineRoute, type RouteDeps } from '../define.js';

export function readRoutes<E extends Env>(api: Hono<E>, deps: RouteDeps): void {
  defineRoute(api, 'bootstrap.get', deps, ({ services, read }) => services.views.bootstrap(read));

  defineRoute(api, 'needsYou.get', deps, ({ services, read, query }) =>
    services.views.needsYou(read, query),
  );

  // Decision 43: the Overview metrics, and the list behind each number.
  defineRoute(api, 'overview.get', deps, ({ services, read, query }) =>
    services.views.overview(read, query),
  );

  defineRoute(api, 'overview.items', deps, ({ services, read, query }) =>
    services.views.overviewItems(read, query),
  );

  // Decision 48: one day's brief.
  defineRoute(api, 'brief.get', deps, ({ services, read, query }) =>
    services.views.brief(read, query),
  );

  defineRoute(api, 'work.get', deps, ({ services, read, query }) => {
    const work = services.views.work(read, query);
    // The Agents view already computes live vs reported vs stale and lease
    // custody. Keep this projection outside views.ts while DKT-36 owns it.
    const activity = withCardActivity(
      work,
      services.views.agents(read, { scope: query.scope }),
      read.db,
      read.now,
    );
    if (query.layout !== 'timeline') return activity;
    return { ...activity, timeline: services.forecast.timeline(read, query) };
  });

  defineRoute(api, 'items.get', deps, ({ services, read, params }) =>
    services.views.itemDetail(read, params),
  );

  // Decision 48: the longest chain of open blockers to a goal.
  defineRoute(api, 'items.criticalPath', deps, ({ services, read, params }) =>
    services.subgraph.criticalPath(read, params),
  );

  // Decision 54: which open epic a new agent can take without parking.
  defineRoute(api, 'projects.pickEpic', deps, ({ services, read, params }) =>
    services.subgraph.pickEpic(read, params),
  );

  defineRoute(api, 'agents.list', deps, ({ services, read, query }) =>
    services.views.agents(read, query),
  );

  defineRoute(api, 'runs.custody', deps, ({ services, read, params }) =>
    services.views.runCustody(read, params),
  );

  defineRoute(api, 'search.get', deps, ({ services, read, query }) =>
    services.search.palette(read, query),
  );
}

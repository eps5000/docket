/**
 * Settings, *Reveal token* and deleting a project (BUILD_SPEC §3, §5.12, §7;
 * UI_SPEC §6.7; contracts/ui-api.md US10). Lock and rotate-key are B2's
 * (api/session.ts); the blocker rule is in deps.ts.
 *
 * *New project* (decision 31; BUILD_SPEC §5.20; tasks.md T163) answers 501
 * until US15 (T164) implements `projects.create`. Not undoable.
 */
import type { Env, Hono } from 'hono';
import { ToolError } from '@docket/shared';
import { defineRoute, type RouteDeps } from '../define.js';

export function settingsRoutes<E extends Env>(api: Hono<E>, deps: RouteDeps): void {
  defineRoute(api, 'settings.get', deps, ({ services, read }) => services.views.settings(read));

  /**
   * *Reveal token*: the owner session (the guards before this) is the only
   * way in. `no-store`, so no cache keeps it, and nothing here logs it.
   */
  defineRoute(api, 'settings.agentToken', deps, ({ c }) => {
    if (!deps.agentToken) throw new ToolError('unavailable', 'The agent token is not available.');
    c.header('cache-control', 'no-store');
    c.header('pragma', 'no-cache');
    return { token: deps.agentToken() };
  });

  /** *New project* (decision 31). Not undoable. */
  defineRoute(api, 'projects.create', deps, ({ services, mutate, body }) => {
    const { result, mutation_id } = mutate((w) => services.projects.create(w, body));
    return { mutation_id, project: result };
  });

  /** Not undoable; the docs directory is removed after the commit (and retried at startup). */
  defineRoute(api, 'projects.delete', deps, async ({ services, mutate, read, params, body }) => {
    const { result } = mutate((w) =>
      services.projects.delete(w, { key: params.key, confirm_key: body.confirm_key }),
    );
    await services.projects.removeDeletedDocs(read);
    return result;
  });
}

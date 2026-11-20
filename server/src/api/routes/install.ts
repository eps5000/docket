/**
 * `GET /install/:token` (owner decision 29; BUILD_SPEC §5.17, §7): the bundle
 * the copy-paste install command downloads.
 *
 * No owner session, CSRF or bearer token: the single-use token in the path
 * is the credential (route auth `token`). It is mounted outside `/api`, so
 * the session guard never sees it, but it stays behind the app's Host and
 * Origin guards like every route, which keeps it loopback only.
 *
 * Placeholder (tasks.md T150): the token is checked in `installs.bundleForToken`,
 * a stub that answers 501 until US13 (T155) implements it. Unknown, expired
 * and used tokens will all answer `404 not_found`.
 */
import type { Env, Hono } from 'hono';
import { defineRoute, type RouteDeps } from '../define.js';

export function installRoutes<E extends Env>(app: Hono<E>, deps: RouteDeps): void {
  defineRoute(
    app,
    'install.download',
    deps,
    async ({ services, read, mutate, params }) => {
      const bundle = await services.installs.bundleForToken(read, params);
      // Every client's install in the bundle is marked used in one write (decision 34).
      mutate((w) => {
        for (const id of bundle.install_ids)
          services.installs.markDownloaded(w, { install_id: id });
      });
      return new Response(bundle.bytes, {
        headers: {
          'content-type': 'application/gzip',
          'content-disposition': `attachment; filename="${bundle.filename}"`,
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        },
      });
    },
    { prefix: '' },
  );
}

/**
 * `POST /agent-upload` (BUILD_SPEC §5.10; decision T9): agents upload up to
 * 500 MB as multipart, with the bearer token (never the owner session, no
 * CSRF), and get a `document_version_id` to reference from tools.
 *
 * Placeholder (tasks.md T045): guarded and validated, and calls its
 * services; the stubs answer 501 until US7 (T111) implements them. The bytes
 * are staged on disk first, then one write records the version.
 */
import type { Env, Hono } from 'hono';
import { defineRoute, type RouteDeps } from '../define.js';

export function uploadRoutes<E extends Env>(app: Hono<E>, deps: RouteDeps): void {
  defineRoute(
    app,
    'agentUpload.post',
    deps,
    async ({ services, mutate, read, body, file }) => {
      const staged = await services.documents.stage(read, file!);
      const { result } = mutate((w) =>
        services.documents.commitUpload(w, { fields: body, staged }),
      );
      return result;
    },
    { prefix: '' },
  );
}

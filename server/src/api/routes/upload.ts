/**
 * `POST /agent-upload` (BUILD_SPEC §5.10; decision T9): agents upload up to
 * 500 MB as multipart, with the bearer token (never the owner session, no
 * CSRF), and get a `document_version_id` to reference from tools.
 *
 * The bytes are streamed to the staging directory while the form is read
 * (define.ts, `documents.stage`: hashed as they arrive, the limit enforced
 * while streaming); then one write records the version and moves the
 * staged file into place. A staged file that isn't recorded is deleted.
 */
import type { Env, Hono } from 'hono';
import { defineRoute, type RouteDeps } from '../define.js';

export function uploadRoutes<E extends Env>(app: Hono<E>, deps: RouteDeps): void {
  defineRoute(
    app,
    'agentUpload.post',
    deps,
    ({ services, mutate, body, staged }) => {
      const { result } = mutate((w) =>
        services.documents.commitUpload(w, { fields: body, staged: staged! }),
      );
      return result;
    },
    { prefix: '' },
  );
}

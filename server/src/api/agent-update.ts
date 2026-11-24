/**
 * A project pulling its own Docket update (owner decision 56; BUILD_SPEC §5.39;
 * MCP_SPEC §5.10). Behind the app's Host and Origin guards, and in protected
 * mode the same bearer token as `/mcp` (`/agent/*` in app.ts).
 *
 * - `GET /agent/update/docket-update.sh` and `.ps1`: the current updater, so an
 *   install from before it existed can run it. Nothing else is served there.
 * - `POST /agent/update`: `docket-update` sends the checkout's hashes (never
 *   file text) and gets a tar.gz of that project's non-secret files that need
 *   writing. A POST, because it records the unconfirmed install, and because a
 *   browser can't send it across origins without the Origin guard seeing it.
 */
import type { Context } from 'hono';
import { z } from 'zod';
import {
  INSTALL_CLIENTS,
  LIMITS,
  ToolError,
  UPDATE_SCRIPT_PS1,
  UPDATE_SCRIPT_SH,
  objectId,
  projectKey,
  sha256Hex,
} from '@docket/shared';
import { readContext } from '../domain/contracts.js';
import { updatePs1, updateSh } from '../domain/update-scripts.js';
import { SYSTEM_ACTOR } from '../domain/write.js';
import type { Runtime } from '../runtime.js';
import { errorBody } from './guards.js';

/** A manifest with every key reported stays far below this. */
const MAX_BODY_BYTES = 64 * 1024;
/** Decision 66: each skill reference is a file of its own. */
const MAX_FILES = 128;

const reportedKey = z
  .string()
  .regex(/^(agents_block|connection|skill:[a-z0-9-]{1,60}|script:docket-[a-z]+\.(sh|ps1))$/);

const updateBody = z.strictObject({
  project: projectKey,
  client: z.enum(INSTALL_CLIENTS),
  from: objectId.optional(),
  files: z
    .array(
      z.strictObject({
        key: reportedKey,
        sha256: sha256Hex,
        sent: sha256Hex.optional(),
        version_id: z
          .string()
          .regex(/^[A-Za-z0-9:._-]+$/)
          .max(LIMITS.id)
          .optional(),
      }),
    )
    .max(MAX_FILES),
});

export function agentUpdateScript(c: Context): Response {
  const name = c.req.param('script');
  const text =
    name === UPDATE_SCRIPT_SH ? updateSh() : name === UPDATE_SCRIPT_PS1 ? updatePs1() : null;
  if (text === null) return c.json(errorBody('not_found', 'No such file.'), 404);
  return new Response(text, {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

export async function agentUpdate(runtime: Runtime, c: Context): Promise<Response> {
  const refuse = (message: string) => c.json(errorBody('validation', message), 400);
  if (Number(c.req.header('content-length') ?? 0) > MAX_BODY_BYTES) {
    return refuse('The update request is too large.');
  }
  const text = await c.req.text();
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) return refuse('The update request is too large.');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return refuse('The update request must be JSON.');
  }
  const parsed = updateBody.safeParse(raw);
  if (!parsed.success) return refuse('The update request is not valid.');

  const { services, write, db, clock } = runtime;
  try {
    const prepared = services.installs.prepareUpdate(
      readContext(db, SYSTEM_ACTOR, clock()),
      parsed.data,
    );
    // Hashes and keys only: the write path's arguments never hold a file's text.
    const { result: id } = write.run(
      {
        actor: SYSTEM_ACTOR,
        operation: 'installs.update',
        args: { project: parsed.data.project, client: parsed.data.client },
      },
      (w) => services.installs.recordUpdate(w, prepared),
    );
    const bytes = await services.installs.updateBundle(prepared, id, clock().toISOString());
    return new Response(bytes, {
      headers: {
        'content-type': 'application/gzip',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      },
    });
  } catch (err) {
    if (err instanceof ToolError) {
      return c.json(errorBody(err.code, err.message), err.code === 'not_found' ? 404 : 400);
    }
    throw err;
  }
}

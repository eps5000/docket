/**
 * Planning and housekeeping: quick capture, the owner's field and text edits,
 * cancel, archive, the label page and document content (BUILD_SPEC §5.1,
 * §5.8, §5.10, §7; contracts/ui-api.md US7; decisions 22 and 23).
 *
 * Placeholders (tasks.md T045): each route is guarded and validated, and
 * calls its service; stubs answer 501 until US7 (T111, T112) implements them.
 */
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import type { Env, Hono } from 'hono';
import { defineRoute, type RouteDeps } from '../define.js';

export function planningRoutes<E extends Env>(api: Hono<E>, deps: RouteDeps): void {
  /** Quick capture: an item in Inbox; `notes` becomes the description. */
  defineRoute(api, 'items.create', deps, ({ services, mutate, body }) => {
    const { result, mutation_id } = mutate((w) =>
      services.items.create(w, {
        project: body.project,
        type: body.type,
        title: body.title,
        epic: body.epic,
        description_md: body.notes,
        priority: 2,
        status: 'inbox',
      }),
    );
    return { mutation_id, item: result };
  });

  defineRoute(api, 'items.patch', deps, ({ services, mutate, params, body }) => {
    const { result, mutation_id } = mutate((w) =>
      services.items.ownerPatch(w, { id: params.id, ...body }),
    );
    return { mutation_id, item: result };
  });

  defineRoute(api, 'items.archive', deps, ({ services, mutate, params }) => {
    const { result, mutation_id } = mutate((w) => services.archive.archive(w, params));
    return { mutation_id, item: result };
  });

  defineRoute(api, 'items.unarchive', deps, ({ services, mutate, params }) => {
    const { result, mutation_id } = mutate((w) => services.archive.unarchive(w, params));
    return { mutation_id, item: result };
  });

  defineRoute(api, 'archive.many', deps, ({ services, mutate, body }) => {
    const { result, mutation_id } = mutate((w) => services.archive.archiveMany(w, body));
    return { mutation_id, archived: result };
  });

  defineRoute(api, 'items.cancel', deps, ({ services, mutate, params, body }) => {
    const { result, mutation_id } = mutate((w) =>
      services.archive.cancel(w, { id: params.id, ...body }),
    );
    return { mutation_id, item: result };
  });

  defineRoute(api, 'labels.get', deps, ({ services, read, params }) =>
    services.views.labelPage(read, params),
  );

  defineRoute(api, 'labels.moveToReady', deps, ({ services, mutate, params }) => {
    const { result, mutation_id } = mutate((w) => services.items.moveLabelToReady(w, params));
    return { mutation_id, moved: result };
  });

  /**
   * Streams the stored bytes with `Content-Disposition` and `nosniff`
   * (BUILD_SPEC §5.10). Everything but a PDF (which needs the browser's
   * viewer) also gets a sandboxing CSP, so an SVG or text opened directly
   * can't run script in the app's origin.
   */
  defineRoute(api, 'documents.content', deps, ({ services, read, params }) => {
    const doc = services.documents.content(read, { version_id: params.versionId });
    const stream = Readable.toWeb(createReadStream(doc.path)) as ReadableStream<Uint8Array>;
    const filename = encodeURIComponent(doc.name).replace(
      /['()*]/g,
      (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
    );
    const headers: Record<string, string> = {
      'content-type': doc.mime,
      'content-length': String(doc.size),
      'content-disposition': `${doc.disposition}; filename*=UTF-8''${filename}`,
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, max-age=31536000, immutable',
    };
    if (doc.mime !== 'application/pdf') {
      headers['content-security-policy'] = "sandbox; default-src 'none'; style-src 'unsafe-inline'";
    }
    return new Response(stream, { headers });
  });
}

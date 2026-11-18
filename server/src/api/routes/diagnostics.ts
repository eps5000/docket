/**
 * The diagnostic call log download (BUILD_SPEC §7; decision T21; FR-108):
 * JSONL, metadata only, never arguments or results.
 *
 * Placeholder (tasks.md T045): guarded and validated, and calls its
 * service; the stub answers 501 until US10 (T118) implements it.
 */
import type { Env, Hono } from 'hono';
import { defineRoute, type RouteDeps } from '../define.js';

export function diagnosticsRoutes<E extends Env>(api: Hono<E>, deps: RouteDeps): void {
  defineRoute(api, 'diagnostics.calls', deps, ({ services, read, query }) => {
    const lines = [...services.diagnostics.calls(read, query)];
    const body = lines.length > 0 ? `${lines.join('\n')}\n` : '';
    return new Response(body, {
      headers: {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'content-disposition': `attachment; filename="docket-calls-${query.days}d.jsonl"`,
        'x-content-type-options': 'nosniff',
      },
    });
  });
}

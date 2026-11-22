/**
 * `GET /agent/changes/wait` (owner decision 40; MCP_SPEC §5.2): a long-poll
 * on the change feed for the installed `docket-wait` script. The Host and
 * Origin guards and the trust mode's auth are the same as `/mcp` (app.ts).
 *
 * It answers as soon as a matching event exists, or at `timeout_s` with no
 * events and the same cursor. `format=text` is what the script reads, so it
 * needs no JSON parser: `changed cursor=813 events=2` (or `timeout …`), then
 * one line per event. During shutdown it answers 503, and the script retries.
 */
import type { Context } from 'hono';
import { z } from 'zod';
import {
  LIMITS,
  ToolError,
  eventTypeSchema,
  itemId,
  projectKey,
  truncate,
  type EventRow,
} from '@docket/shared';
import { readContext } from '../domain/contracts.js';
import type { Actor } from '../domain/write.js';
import type { Runtime } from '../runtime.js';
import { errorBody } from './guards.js';

/** The default page: enough for one wake-up; the next wait returns the rest at once. */
const DEFAULT_EVENTS = 20;
const SYSTEM: Actor = { kind: 'system', client: null, label: null, session_id: null, run_id: null };

const query = z.strictObject({
  cursor: z
    .string()
    .regex(/^\d{1,15}$/, { error: 'Expected a change cursor.' })
    .optional(),
  project: projectKey.optional(),
  item_id: itemId.optional(),
  types: z
    .string()
    .transform((v) => v.split(',').map((t) => t.trim()))
    .pipe(z.array(eventTypeSchema).min(1))
    .optional(),
  timeout_s: z.coerce.number().int().min(0).max(LIMITS.changes_wait_route_s).default(60),
  limit: z.coerce.number().int().min(1).max(LIMITS.changes_max).default(DEFAULT_EVENTS),
  format: z.enum(['json', 'text']).default('json'),
});

/** `812 GF-3 review.decided Changes requested`: one line, whatever the summary holds. */
export const waitEventLine = (e: EventRow): string =>
  [e.cursor, e.item_id ?? '-', e.type, truncate(e.summary, 100)].filter(Boolean).join(' ');

export async function changesWait(runtime: Runtime, c: Context): Promise<Response> {
  const parsed = query.safeParse(c.req.query());
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const field = first?.path.join('.') || 'query';
    return c.json(errorBody('validation', `${field}: ${first?.message ?? 'invalid'}`), 400);
  }
  const { cursor, project, item_id, types, timeout_s, limit, format } = parsed.data;
  const read = () => readContext(runtime.db, SYSTEM, runtime.clock());
  const filter = { project, item_id, types };
  // Without a cursor, wait for what happens from now on.
  const from = cursor ?? runtime.services.search.getChanges(read(), { limit: 1 }).next_cursor!;

  const waited = await runtime.changes.wait({
    ...filter,
    cursor: Number(from),
    timeoutMs: timeout_s * 1000,
    signal: c.req.raw.signal,
  });
  if (waited.status === 'closed') {
    c.header('Retry-After', '1');
    return c.json(errorBody('unavailable', 'Docket is restarting. Try again.'), 503);
  }
  if (waited.status === 'aborted') return c.body(null, 204);

  let events: EventRow[] = [];
  let next = String(waited.cursor);
  if (waited.status === 'changed') {
    try {
      const page = runtime.services.search.getChanges(read(), {
        ...filter,
        cursor: next,
        limit,
      });
      events = page.events;
      next = page.next_cursor ?? next;
    } catch (err) {
      if (err instanceof ToolError) return c.json(errorBody(err.code, err.message), 400);
      throw err;
    }
  }
  const status = events.length > 0 ? 'changed' : 'timeout';
  c.header('Cache-Control', 'no-store');
  if (format === 'text') {
    const head = `${status} cursor=${next} events=${events.length}`;
    return c.text(`${[head, ...events.map(waitEventLine)].join('\n')}\n`);
  }
  return c.json({ status, next_cursor: next, events });
}

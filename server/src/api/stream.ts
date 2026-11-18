/**
 * The live stream at `GET /api/stream` (contracts/events.md; BUILD_SPEC §7).
 *
 * - `event: change`, `id: <seq>`, `data: {seq, type, objects, for_you}`.
 * - Resumes after `Last-Event-ID`; without it, starts at the current end.
 * - A `: keep-alive` comment every 25 s.
 * - `for_you` is true only for `packet.submitted` and `question.asked`.
 *
 * It reads `events.seq`, the same cursor `get_changes` uses. The write path
 * wakes it after each commit, and the keep-alive tick also re-reads, which
 * catches writes made by another process (the CLI).
 */
import type { EventEmitter } from 'node:events';
import type { Env, Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { FOR_YOU_EVENT_TYPES } from '@docket/shared';
import type { Db } from '../db/client.js';
import type { ObjectRef } from '../domain/write.js';
import { defineRoute, type RouteDeps } from './define.js';

export const KEEP_ALIVE_MS = 25_000;
const PAGE = 500;

export interface StreamMessage {
  seq: number;
  type: string;
  objects: ObjectRef[];
  for_you: boolean;
}

interface EventRow {
  seq: number;
  type: string;
  item_id: string | null;
  project_key: string | null;
  data: string | null;
}

export function toStreamMessage(row: EventRow): StreamMessage {
  const data = row.data ? (JSON.parse(row.data) as { objects?: ObjectRef[] }) : {};
  let objects = data.objects ?? [];
  if (objects.length === 0 && row.item_id) objects = [{ kind: 'item', id: row.item_id }];
  if (objects.length === 0 && row.project_key) objects = [{ kind: 'project', id: row.project_key }];
  return {
    seq: row.seq,
    type: row.type,
    objects,
    for_you: (FOR_YOU_EVENT_TYPES as readonly string[]).includes(row.type),
  };
}

export function streamRoute<E extends Env>(
  api: Hono<E>,
  deps: RouteDeps & { db: Db; bus: EventEmitter; keepAliveMs?: number },
): void {
  const keepAliveMs = deps.keepAliveMs ?? KEEP_ALIVE_MS;
  const after = deps.db.sqlite.prepare(
    'SELECT seq, type, item_id, project_key, data FROM events WHERE seq > ? ORDER BY seq LIMIT ?',
  );
  const latest = deps.db.sqlite.prepare('SELECT coalesce(max(seq), 0) AS seq FROM events');

  defineRoute(api, 'stream.get', deps, ({ c }) => {
    const lastEventId = c.req.header('last-event-id');
    const resumeFrom =
      lastEventId !== undefined && /^\d+$/.test(lastEventId.trim())
        ? Number(lastEventId.trim())
        : null;

    return streamSSE(c, async (stream) => {
      let cursor = resumeFrom ?? (latest.get() as { seq: number }).seq;
      let chain = Promise.resolve();
      const enqueue = (task: () => Promise<void>) => {
        chain = chain.then(task).catch(() => {});
      };
      const flush = async () => {
        for (;;) {
          if (stream.aborted || stream.closed) return;
          const rows = after.all(cursor, PAGE) as EventRow[];
          for (const row of rows) {
            await stream.writeSSE({
              event: 'change',
              id: String(row.seq),
              data: JSON.stringify(toStreamMessage(row)),
            });
            cursor = row.seq;
          }
          if (rows.length < PAGE) return;
        }
      };

      let done: () => void = () => {};
      const finished = new Promise<void>((resolve) => (done = resolve));
      const onChange = () => enqueue(flush);
      const onClose = () => done();
      const timer = setInterval(() => {
        enqueue(async () => {
          await stream.write(': keep-alive\n\n');
          await flush();
        });
      }, keepAliveMs);
      deps.bus.on('change', onChange);
      deps.bus.on('close', onClose);
      stream.onAbort(() => done());

      await stream.write(': connected\n\n');
      enqueue(flush);
      await finished;

      clearInterval(timer);
      deps.bus.off('change', onChange);
      deps.bus.off('close', onClose);
    });
  });
}

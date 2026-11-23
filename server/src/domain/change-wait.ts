/**
 * Waiting on the change feed (owner decision 40; BUILD_SPEC §5.11): the one
 * object behind `GET /agent/changes/wait` and `get_changes { wait_s }`.
 *
 * A waiter costs no database work while it waits. Each commit wakes the set
 * once: **one** query reads the new events, and they are matched to every
 * waiter in memory. Writes from another process (the CLI) don't reach the bus,
 * so one shared timer runs the same scan while anyone is waiting. A waiter
 * ends on a match, at its timeout, when its client goes away, or on shutdown.
 */
import type { EventEmitter } from 'node:events';
import { QUIET_EVENT_TYPES } from '@docket/shared';
import type { Db } from '../db/client.js';

/** How often the shared scan catches writes from another process. */
export const WAIT_SCAN_MS = 2_000;
const PAGE = 500;

export interface ChangeFilter {
  project?: string | undefined;
  item_id?: string | undefined;
  types?: readonly string[] | undefined;
}

export interface WaitRequest extends ChangeFilter {
  /** Wait for an event after this one. Past the end of the feed, it counts as the end. */
  cursor: number;
  timeoutMs: number;
  /** Aborted when the client goes away. */
  signal?: AbortSignal | undefined;
}

export type WaitStatus = 'changed' | 'timeout' | 'aborted' | 'closed';

export interface WaitResult {
  status: WaitStatus;
  /** The cursor the wait really started from: the request's, or the end of the feed. */
  cursor: number;
}

interface EventKey {
  seq: number;
  type: string;
  item_id: string | null;
  project_key: string | null;
}

interface Waiter {
  filter: ChangeFilter;
  finish: (status: WaitStatus) => void;
}

/** Decision 49: a wait with no type filter doesn't wake for background bookkeeping. */
const matches = (f: ChangeFilter, e: EventKey) =>
  (f.project === undefined || e.project_key === f.project) &&
  (f.item_id === undefined || e.item_id === f.item_id) &&
  (f.types === undefined ? !QUIET_EVENT_TYPES.includes(e.type) : f.types.includes(e.type));

export class ChangeWaiters {
  private readonly waiters = new Set<Waiter>();
  private readonly latestStmt;
  private readonly afterStmt;
  /** Everything up to here has been matched against the current waiters. */
  private seen = 0;
  private timer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(
    private readonly db: Db,
    bus: EventEmitter,
    private readonly scanMs: number = WAIT_SCAN_MS,
  ) {
    const sql = db.sqlite;
    this.latestStmt = sql.prepare('SELECT coalesce(max(seq), 0) AS seq FROM events');
    this.afterStmt = sql.prepare(
      'SELECT seq, type, item_id, project_key FROM events WHERE seq > ? ORDER BY seq LIMIT ?',
    );
    bus.on('change', () => this.scan());
    bus.on('close', () => this.close());
  }

  /** How many clients are waiting (tests, diagnostics). */
  get size(): number {
    return this.waiters.size;
  }

  private latest(): number {
    return (this.latestStmt.get() as { seq: number }).seq;
  }

  /** Whether a matching event exists in (`from`, `to`]. */
  private hasMatch(filter: ChangeFilter, from: number, to: number): boolean {
    const where = ['seq > ?', 'seq <= ?'];
    const params: unknown[] = [from, to];
    if (filter.project !== undefined) {
      where.push('project_key = ?');
      params.push(filter.project);
    }
    if (filter.item_id !== undefined) {
      where.push('item_id = ?');
      params.push(filter.item_id);
    }
    const types = filter.types ?? QUIET_EVENT_TYPES;
    where.push(`type ${filter.types ? '' : 'NOT '}IN (${types.map(() => '?').join(', ')})`);
    params.push(...types);
    return (
      this.db.sqlite
        .prepare(`SELECT 1 FROM events WHERE ${where.join(' AND ')} LIMIT 1`)
        .get(...params) !== undefined
    );
  }

  /** One read of the new events, matched to every waiter in memory. */
  private scan(): void {
    if (this.waiters.size === 0) return;
    for (;;) {
      const rows = this.afterStmt.all(this.seen, PAGE) as EventKey[];
      for (const row of rows) {
        this.seen = row.seq;
        for (const w of [...this.waiters]) if (matches(w.filter, row)) w.finish('changed');
      }
      if (rows.length < PAGE || this.waiters.size === 0) return;
    }
  }

  wait(req: WaitRequest): Promise<WaitResult> {
    const latest = this.latest();
    const cursor = Math.min(req.cursor, latest);
    const filter: ChangeFilter = { project: req.project, item_id: req.item_id, types: req.types };
    if (this.hasMatch(filter, cursor, latest)) {
      return Promise.resolve({ status: 'changed', cursor });
    }
    if (this.closed) return Promise.resolve({ status: 'closed', cursor });
    if (req.signal?.aborted) return Promise.resolve({ status: 'aborted', cursor });
    if (req.timeoutMs <= 0) return Promise.resolve({ status: 'timeout', cursor });

    // Others are waiting: bring them up to date first, so `seen` can move to the end.
    this.scan();
    this.seen = Math.max(this.seen, latest);

    return new Promise((resolve) => {
      const onAbort = () => waiter.finish('aborted');
      const timeout = setTimeout(() => waiter.finish('timeout'), req.timeoutMs);
      timeout.unref();
      const waiter: Waiter = {
        filter,
        finish: (status) => {
          if (!this.waiters.delete(waiter)) return;
          clearTimeout(timeout);
          req.signal?.removeEventListener('abort', onAbort);
          if (this.waiters.size === 0) this.stopTimer();
          resolve({ status, cursor });
        },
      };
      this.waiters.add(waiter);
      req.signal?.addEventListener('abort', onAbort, { once: true });
      if (!this.timer) {
        this.timer = setInterval(() => this.scan(), this.scanMs);
        this.timer.unref();
      }
    });
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Shutdown: release everyone at once. */
  close(): void {
    this.closed = true;
    for (const w of [...this.waiters]) w.finish('closed');
    this.stopTimer();
  }
}

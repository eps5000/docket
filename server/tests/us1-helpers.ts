/**
 * Helpers for the US1 domain tests (tasks.md T064–T067): a real runtime
 * (database, write path, services) on a fresh volume, optionally seeded,
 * with a clock the test moves. Mutations go through the one write path,
 * exactly as the MCP adapter sends them.
 */
import { ToolError, type ErrorCode } from '@tasklite/shared';
import { expect } from 'vitest';
import { loadSampleSeed } from '../src/db/seed/loader.js';
import { readContext, type ReadContext, type Services } from '../src/domain/contracts.js';
import type { Actor, WriteContext } from '../src/domain/write.js';
import { SYSTEM_ACTOR } from '../src/domain/write.js';
import { TestClock } from './helpers.js';
import { createTestServer, type TestServer } from './integration/harness.js';

/** The prototype clock: seed times are as in the spec examples. */
export const NOW = new Date('2026-11-06T11:00:00.000Z');

export interface Domain {
  server: TestServer;
  services: Services;
  clock: TestClock;
  sql: TestServer['runtime']['db']['sqlite'];
  /** An agent actor: `client`, optional label, a session per client, optional run. */
  agent(client?: string, extra?: Partial<Actor>): Actor;
  /** Run `fn` as one mutation through the write path. */
  write<T>(actor: Actor, fn: (w: WriteContext, s: Services) => T, idempotencyKey?: string): T;
  /** As `write`, but expect a ToolError with `code`, and return it. */
  fails(actor: Actor, fn: (w: WriteContext, s: Services) => unknown, code: ErrorCode): ToolError;
  read(actor?: Actor): ReadContext;
  /** One row. */
  row<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T;
  rows<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[];
  cleanup(): Promise<void>;
}

export function startDomain(
  opts: { seed?: boolean; env?: Record<string, string>; now?: Date } = {},
): Domain {
  const clock = new TestClock(new Date(opts.now ?? NOW));
  const server = createTestServer({ clock, env: opts.env });
  const { runtime } = server;
  if (opts.seed !== false) {
    loadSampleSeed(runtime.db, { now: clock.now(), docsDir: runtime.config.paths.docs });
  }
  const sql = runtime.db.sqlite;
  const write = <T>(actor: Actor, fn: (w: WriteContext, s: Services) => T, key?: string): T =>
    runtime.write.run({ actor, operation: 'test', args: {}, idempotencyKey: key ?? null }, (w) =>
      fn(w, runtime.services),
    ).result;
  return {
    server,
    services: runtime.services,
    clock,
    sql,
    agent: (client = 'claude', extra = {}) => ({
      kind: 'agent',
      client,
      label: null,
      session_id: `sess-${client}`,
      run_id: null,
      ...extra,
    }),
    write,
    fails: (actor, fn, code) => {
      let caught: unknown;
      try {
        write(actor, fn);
      } catch (err) {
        caught = err;
      }
      expect(caught, `expected a ${code} ToolError`).toBeInstanceOf(ToolError);
      const err = caught as ToolError;
      expect(err.code, err.message).toBe(code);
      // One or two sentences: what happened, then what to do (MCP_SPEC §6).
      expect(err.message).toMatch(/[.?!)]$/);
      return err;
    },
    read: (actor = SYSTEM_ACTOR) => readContext(runtime.db, actor, clock.now()),
    row: (q, ...p) => sql.prepare(q).get(...p) as never,
    rows: (q, ...p) => sql.prepare(q).all(...p) as never,
    cleanup: () => server.cleanup(),
  };
}

/** Create a project directly (fixture only; the project service is another slice's). */
export function addProject(d: Domain, key: string, satisfiedWhen = 'done'): void {
  const t = d.clock.now().toISOString();
  d.sql
    .prepare(
      `INSERT INTO projects (id, key, name, short_name, color, next_seq, default_satisfied_when, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, '#3b5bdb', 1, ?, 1, ?, ?)`,
    )
    .run(`prj_${key}`, key, `Project ${key}`, key, satisfiedWhen, t, t);
}

/** Force an item's status directly (fixture only). */
export function forceStatus(d: Domain, id: string, status: string): void {
  d.sql.prepare('UPDATE items SET status = ? WHERE id = ?').run(status, id);
}

export const minutes = (n: number) => n * 60_000;

/**
 * Helpers for the US1 domain tests (tasks.md T064–T067): a real runtime
 * (database, write path, services) on a fresh volume, optionally seeded,
 * with a clock the test moves. Mutations go through the one write path,
 * exactly as the MCP adapter sends them.
 */
import { ToolError, type ErrorCode } from '@docket/shared';
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

/**
 * Open runs ended the way a restart ended them before decision 41 (B49), for
 * tests of the `service_restart` history that must stay readable.
 */
export function endRunsAsOldRestart(runtime: TestServer['runtime']): string[] {
  return runtime.write.run(
    { actor: SYSTEM_ACTOR, operation: 'test.old_restart', args: {} },
    (w) => {
      const open = w.db.sqlite
        .prepare("SELECT id, item_id, is_lead FROM runs WHERE state IN ('open', 'needs_input')")
        .all() as { id: string; item_id: string; is_lead: number }[];
      for (const run of open) {
        w.update('runs', run.id, { state: 'interrupted', end_reason: 'service_restart' });
        w.event({
          type: 'run.ended',
          summary: 'Lead run interrupted: service restarted',
          item_id: run.item_id,
          data: { run_id: run.id, end_reason: 'service_restart', is_lead: run.is_lead === 1 },
          objects: [{ kind: 'run', id: run.id }],
        });
      }
      return open.map((r) => r.id);
    },
  ).result;
}

/**
 * Declare that items change no shared part (fixture only), so the Ready gate
 * passes them (decision 36; BUILD_SPEC §5.21). No event, like `forceStatus`.
 */
export function declareNone(d: Domain, ...ids: string[]): void {
  const t = d.clock.now().toISOString();
  for (const id of ids) {
    d.sql
      .prepare('UPDATE items SET shared_none_at = ? WHERE id = ? AND shared_none_at IS NULL')
      .run(t, id);
  }
}

/**
 * Decision 67 (fixture only): an epic's Release, shaped and Ready, so the
 * epic can start the way tests from before every epic had a Release expect.
 * No event, like `forceStatus`. Returns the Release's ID.
 */
export function readyRelease(d: Domain, epic: string): string | undefined {
  const row = d.sql
    .prepare("SELECT id FROM items WHERE epic_id = ? AND type = 'Release' AND archived_at IS NULL")
    .get(epic) as { id: string } | undefined;
  if (!row) return undefined;
  declareNone(d, row.id);
  d.sql
    .prepare("UPDATE items SET status = 'ready' WHERE id = ? AND status IN ('inbox', 'planning')")
    .run(row.id);
  return row.id;
}

/**
 * Decision 67 (fixture only): drop the Release Docket created with an epic, for
 * tests of other features that count an epic's tickets and IDs the way they did
 * before every epic had one. Its number goes back to the project when it was
 * the last one given. Such an epic can't start; use `readyRelease` for one that does.
 */
export function withoutRelease(d: Domain, epic: string): void {
  const row = d.sql
    .prepare("SELECT id, project_key FROM items WHERE epic_id = ? AND type = 'Release'")
    .get(epic) as { id: string; project_key: string } | undefined;
  if (!row) return;
  d.sql.prepare('DELETE FROM items WHERE id = ?').run(row.id);
  d.sql.prepare('DELETE FROM events WHERE item_id = ?').run(row.id);
  const n = Number(row.id.split('-').pop());
  d.sql
    .prepare('UPDATE projects SET next_seq = next_seq - 1 WHERE key = ? AND next_seq = ?')
    .run(row.project_key, n + 1);
}

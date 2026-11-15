import Database from 'better-sqlite3';
import { ToolError } from '@tasklite/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb } from '../../src/db/client.js';
import { WritePath, type Actor, type WriteContext } from '../../src/domain/write.js';
import {
  TestClock,
  allEvents,
  count,
  createTestDb,
  getItem,
  insertItem,
  insertProject,
  type TestDb,
} from '../helpers.js';

const agent: Actor = {
  kind: 'agent',
  client: 'claude',
  label: 'orca-w3',
  session_id: 'sess-1',
  run_id: 'run_01JATEST',
};

let t: TestDb;
let clock: TestClock;
let write: WritePath;

beforeEach(() => {
  t = createTestDb();
  clock = new TestClock();
  write = new WritePath({ db: t.db, clock: clock.now });
  insertProject(t.db, 'RCP');
  insertItem(t.db, { id: 'RCP-1', title: 'Original title' });
  insertItem(t.db, { id: 'RCP-2', title: 'Other item' });
});

afterEach(() => t.cleanup());

/** A minimal mutation: rename an item, with an optional expected version. */
function rename(
  ctx: WriteContext,
  args: { id: string; title: string; expected_version?: number },
): { id: string; version: number } {
  const before = ctx.checkVersion('items', args.id, args.expected_version);
  const inverse = ctx.update('items', args.id, { title: args.title });
  ctx.event({
    type: 'item.updated',
    summary: `Renamed ${args.id}`,
    item_id: args.id,
    project_key: 'RCP',
    data: { title: { old: before.title, new: args.title } },
    inverse: [inverse],
  });
  return { id: args.id, version: ctx.require('items', args.id).version as number };
}

function runRename(
  args: { id: string; title: string; expected_version?: number },
  idempotencyKey?: string,
  actor: Actor = agent,
) {
  return write.run({ actor, operation: 'rename', args, idempotencyKey }, (ctx) =>
    rename(ctx, args),
  );
}

describe('event appending', () => {
  it('applies the change, bumps version and appends one event with actor, mutation ID and inverse', () => {
    const out = runRename({ id: 'RCP-1', title: 'New title' });

    expect(out.replayed).toBe(false);
    expect(out.mutation_id).toMatch(/^mut_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(out.result).toEqual({ id: 'RCP-1', version: 2 });

    const item = getItem(t.db, 'RCP-1');
    expect(item).toMatchObject({ title: 'New title', version: 2 });
    expect(item?.updated_at).toBe(clock.current.toISOString());

    const events = allEvents(t.db);
    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event).toMatchObject({
      seq: 1,
      at: clock.current.toISOString(),
      actor_kind: 'agent',
      client: 'claude',
      label: 'orca-w3',
      run_id: 'run_01JATEST',
      project_key: 'RCP',
      item_id: 'RCP-1',
      type: 'item.updated',
      summary: 'Renamed RCP-1',
      mutation_id: out.mutation_id,
      idempotency_key: null,
    });
    expect(JSON.parse(event!.data!)).toMatchObject({
      title: { old: 'Original title', new: 'New title' },
      objects: [{ kind: 'item', id: 'RCP-1' }],
    });
    expect(JSON.parse(event!.inverse!)).toEqual([
      { op: 'update', table: 'items', id: 'RCP-1', set: { title: 'Original title' } },
    ]);
  });

  it('gives events increasing seq numbers across mutations', () => {
    runRename({ id: 'RCP-1', title: 'A' });
    runRename({ id: 'RCP-2', title: 'B' });
    expect(allEvents(t.db).map((e) => e.seq)).toEqual([1, 2]);
  });

  it('rolls back the change and its events when the mutation throws', () => {
    expect(() =>
      write.run({ actor: agent, operation: 'rename', args: {} }, (ctx) => {
        rename(ctx, { id: 'RCP-1', title: 'Doomed' });
        throw new ToolError('validation', 'Something else was wrong.');
      }),
    ).toThrow(ToolError);
    expect(getItem(t.db, 'RCP-1')).toMatchObject({ title: 'Original title', version: 1 });
    expect(count(t.db, 'events')).toBe(0);
  });

  it('tells subscribers about committed events only', () => {
    const seen: number[][] = [];
    write = new WritePath({ db: t.db, clock: clock.now, onCommit: (seqs) => seen.push(seqs) });
    runRename({ id: 'RCP-1', title: 'A' });
    expect(() =>
      write.run({ actor: agent, operation: 'x', args: {} }, (ctx) => {
        rename(ctx, { id: 'RCP-2', title: 'B' });
        throw new Error('boom');
      }),
    ).toThrow();
    expect(seen).toEqual([[1]]);
  });

  it('refuses a mutation that records no event', () => {
    expect(() =>
      write.run({ actor: agent, operation: 'silent', args: {} }, (ctx) => {
        ctx.update('items', 'RCP-1', { title: 'No event' });
      }),
    ).toThrow(/no event/i);
    expect(getItem(t.db, 'RCP-1')?.title).toBe('Original title');
  });
});

describe('version conflicts', () => {
  it('applies the change when expected_version matches', () => {
    expect(runRename({ id: 'RCP-1', title: 'A', expected_version: 1 }).result.version).toBe(2);
  });

  it('returns conflict with the current record when expected_version is stale', () => {
    runRename({ id: 'RCP-1', title: 'First' });
    let error: ToolError | undefined;
    try {
      runRename({ id: 'RCP-1', title: 'Second', expected_version: 1 });
    } catch (err) {
      error = err as ToolError;
    }
    expect(error).toBeInstanceOf(ToolError);
    expect(error?.code).toBe('conflict');
    expect(error?.current).toMatchObject({ id: 'RCP-1', title: 'First', version: 2 });
    expect(getItem(t.db, 'RCP-1')).toMatchObject({ title: 'First', version: 2 });
    expect(count(t.db, 'events')).toBe(1);
  });

  it('applies on top of the current state when expected_version is omitted', () => {
    runRename({ id: 'RCP-1', title: 'First' });
    expect(runRename({ id: 'RCP-1', title: 'Second' }).result.version).toBe(3);
  });

  it('returns not_found for an unknown row', () => {
    expect(() => runRename({ id: 'RCP-99', title: 'X' })).toThrow(
      expect.objectContaining({ code: 'not_found' }),
    );
  });
});

describe('idempotency', () => {
  it('replays the original result for the same key and arguments, without a second change', () => {
    const first = runRename({ id: 'RCP-1', title: 'Once' }, 'key-1');
    clock.advance(5_000);
    const second = runRename({ id: 'RCP-1', title: 'Once' }, 'key-1');

    expect(first.replayed).toBe(false);
    expect(second).toEqual({ ...first, replayed: true });
    expect(getItem(t.db, 'RCP-1')?.version).toBe(2);
    expect(count(t.db, 'events')).toBe(1);
    expect(allEvents(t.db)[0]?.idempotency_key).toBe('key-1');
  });

  it('treats argument order as irrelevant when comparing arguments', () => {
    const args = { id: 'RCP-1', title: 'Once' };
    write.run({ actor: agent, operation: 'rename', args, idempotencyKey: 'k' }, (ctx) =>
      rename(ctx, args),
    );
    const reordered = { title: 'Once', id: 'RCP-1' };
    const out = write.run(
      { actor: agent, operation: 'rename', args: reordered, idempotencyKey: 'k' },
      (ctx) => rename(ctx, reordered),
    );
    expect(out.replayed).toBe(true);
  });

  it('returns validation for the same key with different arguments', () => {
    runRename({ id: 'RCP-1', title: 'Once' }, 'key-1');
    expect(() => runRename({ id: 'RCP-1', title: 'Different' }, 'key-1')).toThrow(
      expect.objectContaining({ code: 'validation' }),
    );
    expect(getItem(t.db, 'RCP-1')?.title).toBe('Once');
  });

  it('returns validation for the same key used by a different operation', () => {
    runRename({ id: 'RCP-1', title: 'Once' }, 'key-1');
    const args = { id: 'RCP-1', title: 'Once' };
    expect(() =>
      write.run({ actor: agent, operation: 'other', args, idempotencyKey: 'key-1' }, (ctx) =>
        rename(ctx, args),
      ),
    ).toThrow(expect.objectContaining({ code: 'validation' }));
  });

  it('keeps keys separate per client', () => {
    runRename({ id: 'RCP-1', title: 'Once' }, 'key-1');
    const codex: Actor = { kind: 'agent', client: 'codex', label: null };
    const out = runRename({ id: 'RCP-1', title: 'Once' }, 'key-1', codex);
    expect(out.replayed).toBe(false);
  });

  it('forgets keys after 24 hours', () => {
    runRename({ id: 'RCP-1', title: 'Once' }, 'key-1');
    clock.advance(24 * 60 * 60 * 1000 + 1);
    const again = runRename({ id: 'RCP-1', title: 'Once' }, 'key-1');
    expect(again.replayed).toBe(false);
    expect(count(t.db, 'events')).toBe(2);
  });

  it('does not store a key when the mutation fails, so a retry can succeed', () => {
    expect(() => runRename({ id: 'RCP-1', title: 'X', expected_version: 9 }, 'key-1')).toThrow();
    expect(count(t.db, 'idempotency')).toBe(0);
    expect(runRename({ id: 'RCP-1', title: 'X', expected_version: 1 }, 'key-1').replayed).toBe(
      false,
    );
  });

  it('rejects keys longer than 100 characters', () => {
    expect(() => runRename({ id: 'RCP-1', title: 'X' }, 'k'.repeat(101))).toThrow(
      expect.objectContaining({ code: 'validation' }),
    );
  });
});

describe('secret checks on every text field', () => {
  const secret = ['gh', 'p_', 'Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2'].join('');

  it('rejects the write with validation; nothing is stored and nothing is logged', () => {
    const spies = [
      vi.spyOn(console, 'log'),
      vi.spyOn(console, 'info'),
      vi.spyOn(console, 'warn'),
      vi.spyOn(console, 'error'),
      vi.spyOn(console, 'debug'),
      vi.spyOn(process.stdout, 'write'),
      vi.spyOn(process.stderr, 'write'),
    ];
    let error: ToolError | undefined;
    try {
      runRename({ id: 'RCP-1', title: `Use ${secret} for the API` }, 'key-secret');
    } catch (err) {
      error = err as ToolError;
    }
    const logged = spies.flatMap((s) => s.mock.calls.flat().map(String)).join('\n');
    spies.forEach((s) => s.mockRestore());

    expect(error?.code).toBe('validation');
    expect(error?.message).toBe('Looks like a secret (GitHub token); remove it and retry.');
    expect(JSON.stringify(error?.toJSON())).not.toContain(secret);
    expect(logged).not.toContain(secret);
    expect(getItem(t.db, 'RCP-1')?.title).toBe('Original title');
    expect(count(t.db, 'events')).toBe(0);
    expect(count(t.db, 'idempotency')).toBe(0);
    const dbText = JSON.stringify(t.db.sqlite.prepare('SELECT * FROM events').all());
    expect(dbText).not.toContain(secret);
  });

  it("rejects the service's own tokens", () => {
    const token = 'tl_c0ffeec0ffeec0ffeec0ffeec0ffeec0ffee';
    write = new WritePath({ db: t.db, clock: clock.now, knownSecrets: () => [token] });
    expect(() => runRename({ id: 'RCP-1', title: `token ${token}` })).toThrow(
      expect.objectContaining({ code: 'validation' }),
    );
  });

  it('checks nested text, such as list entries', () => {
    expect(() =>
      write.run(
        { actor: agent, operation: 'plan', args: { steps: [{ text: 'ok' }, { text: secret }] } },
        () => 'unreachable',
      ),
    ).toThrow(expect.objectContaining({ code: 'validation', details: { field: 'steps[1].text' } }));
  });
});

describe('busy database', () => {
  it('returns unavailable with retry_after_s when the write lock is held past the busy timeout', () => {
    const blocker = new Database(t.db.path);
    blocker.exec('BEGIN IMMEDIATE');
    const busyDb = openDb(t.db.path, { busyTimeoutMs: 50 });
    const busyWrite = new WritePath({ db: busyDb, clock: clock.now });
    try {
      expect(() =>
        busyWrite.run({ actor: agent, operation: 'rename', args: {} }, (ctx) =>
          rename(ctx, { id: 'RCP-1', title: 'X' }),
        ),
      ).toThrow(expect.objectContaining({ code: 'unavailable', details: { retry_after_s: 2 } }));
    } finally {
      blocker.exec('ROLLBACK');
      blocker.close();
      busyDb.sqlite.close();
    }
  });
});

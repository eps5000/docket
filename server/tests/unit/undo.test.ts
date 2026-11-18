import type { ToolError } from '@docket/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UNDO_WINDOW_MS, undoMutation } from '../../src/domain/undo.js';
import { OWNER_ACTOR, WritePath, type Actor } from '../../src/domain/write.js';
import {
  TestClock,
  allEvents,
  createTestDb,
  getItem,
  insertItem,
  insertProject,
  type TestDb,
} from '../helpers.js';

const agent: Actor = { kind: 'agent', client: 'codex', label: 'orca-w1' };

let t: TestDb;
let clock: TestClock;
let write: WritePath;

beforeEach(() => {
  t = createTestDb();
  clock = new TestClock();
  write = new WritePath({ db: t.db, clock: clock.now });
  insertProject(t.db, 'RCP');
  insertItem(t.db, { id: 'RCP-1', status: 'ready' });
  insertItem(t.db, { id: 'RCP-2', status: 'ready' });
});

afterEach(() => t.cleanup());

/** An owner (or agent) status change that stores its inverse, like the owner API routes will. */
function setStatus(id: string, status: string, actor: Actor = OWNER_ACTOR) {
  return write.run({ actor, operation: 'set_status', args: { id, status } }, (ctx) => {
    const before = ctx.require('items', id);
    const inverse = ctx.update('items', id, { status });
    ctx.event({
      type: 'item.status_changed',
      summary: `${id} ${String(before.status)} → ${status}`,
      item_id: id,
      project_key: 'RCP',
      data: { status: { old: before.status, new: status } },
      inverse: [inverse],
    });
    return { id };
  });
}

function undoError(mutationId: string): ToolError {
  try {
    undoMutation(write, mutationId);
  } catch (err) {
    return err as ToolError;
  }
  throw new Error('expected undo to fail');
}

describe('undo', () => {
  it('within 60 s applies the inverse and records an undo event with its own mutation ID', () => {
    const change = setStatus('RCP-1', 'planning');
    expect(getItem(t.db, 'RCP-1')).toMatchObject({ status: 'planning', version: 2 });

    clock.advance(UNDO_WINDOW_MS - 1_000);
    const out = undoMutation(write, change.mutation_id);

    expect(out.result).toEqual({ undone: change.mutation_id });
    expect(out.mutation_id).not.toBe(change.mutation_id);
    // The status is restored; the version moves forward, never back.
    expect(getItem(t.db, 'RCP-1')).toMatchObject({ status: 'ready', version: 3 });

    const events = allEvents(t.db);
    expect(events).toHaveLength(2);
    const undo = events[1]!;
    expect(undo).toMatchObject({
      type: 'item.status_changed',
      summary: 'Undid: RCP-1 ready → planning',
      actor_kind: 'owner',
      item_id: 'RCP-1',
      project_key: 'RCP',
      mutation_id: out.mutation_id,
      inverse: null,
    });
    expect(JSON.parse(undo.data!)).toMatchObject({ undo_of: change.mutation_id });
  });

  it('returns conflict after the 60 s window', () => {
    const change = setStatus('RCP-1', 'planning');
    clock.advance(UNDO_WINDOW_MS + 1);
    expect(undoError(change.mutation_id).code).toBe('conflict');
    expect(getItem(t.db, 'RCP-1')?.status).toBe('planning');
  });

  it('returns conflict when a later event touched the same objects', () => {
    const change = setStatus('RCP-1', 'planning');
    clock.advance(1_000);
    setStatus('RCP-1', 'ready', agent);
    const error = undoError(change.mutation_id);
    expect(error.code).toBe('conflict');
    expect(getItem(t.db, 'RCP-1')).toMatchObject({ status: 'ready', version: 3 });
    expect(allEvents(t.db)).toHaveLength(2);
  });

  it('still applies when later events touched only other objects', () => {
    const change = setStatus('RCP-1', 'planning');
    setStatus('RCP-2', 'planning', agent);
    undoMutation(write, change.mutation_id);
    expect(getItem(t.db, 'RCP-1')?.status).toBe('ready');
    expect(getItem(t.db, 'RCP-2')?.status).toBe('planning');
  });

  it('returns conflict ("already undone") for a second undo of the same mutation', () => {
    const change = setStatus('RCP-1', 'planning');
    undoMutation(write, change.mutation_id);
    const error = undoError(change.mutation_id);
    expect(error.code).toBe('conflict');
    expect(error.message).toMatch(/already undone/i);
    expect(getItem(t.db, 'RCP-1')).toMatchObject({ status: 'ready', version: 3 });
  });

  it('returns validation when asked to undo an undo', () => {
    const change = setStatus('RCP-1', 'planning');
    const undo = undoMutation(write, change.mutation_id);
    const error = undoError(undo.mutation_id);
    expect(error.code).toBe('validation');
    expect(getItem(t.db, 'RCP-1')?.status).toBe('ready');
  });

  it('refuses agent mutations with forbidden', () => {
    const change = setStatus('RCP-1', 'planning', agent);
    expect(undoError(change.mutation_id).code).toBe('forbidden');
  });

  it('returns not_found for an unknown mutation', () => {
    expect(undoError('mut_01JAAAAAAAAAAAAAAAAAAAAAAA').code).toBe('not_found');
  });

  it('restores inserted and deleted rows', () => {
    const created = write.run({ actor: OWNER_ACTOR, operation: 'create', args: {} }, (ctx) => {
      const inverse = ctx.insert('owner_notes', {
        id: 'note_1',
        item_id: 'RCP-1',
        text: 'Please check units',
      });
      ctx.event({
        type: 'owner_note.added',
        summary: 'Note on RCP-1',
        item_id: 'RCP-1',
        project_key: 'RCP',
        inverse: [inverse],
      });
      return null;
    });
    const noteCount = () =>
      (t.db.sqlite.prepare('SELECT count(*) AS n FROM owner_notes').get() as { n: number }).n;
    expect(noteCount()).toBe(1);
    undoMutation(write, created.mutation_id);
    expect(noteCount()).toBe(0);
  });
});

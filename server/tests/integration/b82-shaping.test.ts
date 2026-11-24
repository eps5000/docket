/**
 * B82, tickets agents create arrive shaped or ask for a planner (owner
 * decision 65), with synthetic text only: `create_item` with shared parts,
 * with "none" and with neither; splits; the owner's refused Move to Ready and
 * *Ask a planner to shape this*; the digest count; the planner's path to
 * Ready; the epic, the map and Ready ending it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createItemInput, renderResult, type ToolInput } from '@docket/shared';
import { undoMutation } from '../../src/domain/undo.js';
import type { Actor } from '../../src/domain/write.js';
import { addProject, startDomain, type Domain } from '../us1-helpers.js';

const OWNER: Actor = { kind: 'owner', client: null, label: null, session_id: null, run_id: null };
const SHAPED = {
  outcome_md: 'Synthetic outcome: the export lists every order.',
  acceptance: ['The export has one row per order'],
};

let d: Domain;
let producer: Actor;
let planner: Actor;

beforeEach(() => {
  d = startDomain({ seed: false, now: new Date('2026-11-24T08:00:00.000Z') });
  addProject(d, 'TST');
  producer = d.agent('claude', { label: 'producer' });
  planner = d.agent('codex', { label: 'planner' });
});
afterEach(() => d.cleanup());

type CreateArgs = Partial<ToolInput<'create_item'>>;
const create = (extra: CreateArgs = {}, actor = producer) =>
  d.write(actor, (w, s) =>
    s.items.create(w, {
      project: 'TST',
      type: 'Story',
      title: 'Synthetic story',
      priority: 2,
      status: 'planning',
      ...extra,
    } as ToolInput<'create_item'>),
  );
const epic = () => create({ type: 'Epic', title: 'Synthetic epic', ...SHAPED, shared: 'none' }).id;
const version = (id: string) =>
  d.row<{ version: number }>('SELECT version FROM items WHERE id = ?', id).version;
const status = (id: string) =>
  d.row<{ status: string }>('SELECT status FROM items WHERE id = ?', id).status;
const shapingColumn = (id: string) =>
  d.row<{ shaping: string | null }>('SELECT shaping FROM items WHERE id = ?', id).shaping;
const getItem = (id: string, actor = planner) =>
  d.services.items.get(d.read(actor), { id, view: 'standard' } as never).item;
const declaration = (id: string) =>
  d.services.sharedChanges.itemShared(d.read(OWNER), { id }).declaration;
const digest = (cursor?: string) =>
  d.services.digest.get(d.read(producer), { project: 'TST', ...(cursor ? { cursor } : {}) });
const ownerPatch = (id: string, body: Record<string, unknown>) =>
  d.write(OWNER, (w, s) =>
    s.items.ownerPatch(w, { id, expected_version: version(id), ...body } as never),
  );

describe('create_item arrives shaped, or Needs shaping', () => {
  it('with shared parts: declared on creation, a new key registered, not Needs shaping', () => {
    const item = create({ ...SHAPED, shared: ['table:orders', 'model:Order'] });
    expect(item.needs_shaping).toBeUndefined();
    expect(item.version).toBe(1);
    const decl = declaration(item.id);
    expect(decl.state).toBe('declared');
    expect(decl.changes.map((c) => [c.part, c.change])).toEqual([
      ['model:Order', 'change'],
      ['table:orders', 'change'],
    ]);
    const parts = d.rows<{ key: string }>(
      "SELECT key FROM shared_parts WHERE project_key = 'TST' ORDER BY key",
    );
    expect(parts.map((p) => p.key)).toEqual(['model:Order', 'table:orders']);
    expect(shapingColumn(item.id)).toBeNull();
  });

  it("with 'none': declared none, not Needs shaping", () => {
    const item = create({ ...SHAPED, shared: 'none' });
    expect(item.needs_shaping).toBeUndefined();
    expect(declaration(item.id).state).toBe('none');
  });

  it('with neither: Needs shaping by its agent, listing all three, in its text', () => {
    const item = create();
    expect(item.needs_shaping).toEqual({
      missing: ['outcome', 'acceptance', 'shared_changes'],
      asked_by: 'agent',
      by: 'claude · producer',
      at: '2026-11-24T08:00:00.000Z',
      note: null,
    });
    const text = renderResult('create_item', { item }, {});
    expect(text).toContain(
      'needs shaping: no outcome, no acceptance criteria and shared changes not declared',
    );
    // get_item and search rows say it too.
    expect(getItem(item.id).needs_shaping?.missing).toEqual([
      'outcome',
      'acceptance',
      'shared_changes',
    ]);
  });

  it('a declaration alone is not enough: an outcome and acceptance are part of shaping', () => {
    const item = create({ shared: 'none' });
    expect(item.needs_shaping?.missing).toEqual(['outcome', 'acceptance']);
  });

  it('an Epic and the owner’s own tickets are never marked', () => {
    expect(create({ type: 'Epic' }).needs_shaping).toBeUndefined();
    const owned = create({}, OWNER);
    expect(owned.needs_shaping).toBeUndefined();
    expect(shapingColumn(owned.id)).toBeNull();
  });

  it('validates shared: at least one part, no part twice, a known kind', () => {
    const base = { project: 'TST', type: 'Story', title: 'Synthetic story' };
    expect(createItemInput.safeParse({ ...base, shared: [] }).success).toBe(false);
    expect(createItemInput.safeParse({ ...base, shared: ['table:a', 'Table:A'] }).success).toBe(
      false,
    );
    expect(createItemInput.safeParse({ ...base, shared: ['nope'] }).success).toBe(false);
    expect(createItemInput.safeParse({ ...base, shared: 'none' }).success).toBe(true);
    expect(createItemInput.safeParse({ ...base, shared: ['table:a'] }).success).toBe(true);
  });
});

describe('splits', () => {
  const original = () => {
    const item = create({
      ...SHAPED,
      acceptance: ['First synthetic criterion', 'Second synthetic criterion'],
      shared: ['table:orders'],
    });
    return item;
  };
  const split = (from: { id: string }, extra: CreateArgs = {}, also?: unknown[]) =>
    create({
      title: 'Synthetic split',
      outcome_md: 'Synthetic outcome for the split.',
      split_from: {
        id: from.id,
        expected_version: version(from.id),
        move: [2],
        relation: 'none',
        ...(also ? { also } : {}),
      },
      ...extra,
    } as CreateArgs);

  it('a split carrying the original’s part arrives shaped', () => {
    const from = original();
    const made = split(from, {}, [{ kind: 'part', id: 'table:orders', copy: true }]);
    expect(made.needs_shaping).toBeUndefined();
    expect(declaration(made.id).changes.map((c) => c.part)).toEqual(['table:orders']);
  });

  it("a split with shared 'none' arrives shaped; with neither it Needs shaping", () => {
    const from = original();
    expect(split(from, { shared: 'none' }).needs_shaping).toBeUndefined();
    const bare = split(original());
    expect(bare.needs_shaping?.missing).toEqual(['shared_changes']);
  });

  it('shared keys join the carried parts, and none with carried parts is refused', () => {
    const from = original();
    const made = split(from, { shared: ['model:Order'] }, [
      { kind: 'part', id: 'table:orders', copy: true },
    ]);
    expect(
      declaration(made.id)
        .changes.map((c) => c.part)
        .sort(),
    ).toEqual(['model:Order', 'table:orders']);
    const again = original();
    d.fails(
      producer,
      (w, s) =>
        s.items.create(w, {
          project: 'TST',
          type: 'Story',
          title: 'Synthetic split',
          status: 'planning',
          shared: 'none',
          split_from: {
            id: again.id,
            expected_version: version(again.id),
            move: [2],
            relation: 'none',
            also: [{ kind: 'part', id: 'table:orders', copy: true }],
          },
        } as ToolInput<'create_item'>),
      'validation',
    );
  });
});

describe("the owner's Move to Ready never dead-ends", () => {
  it('the refusal lists exactly what is missing and offers a planner', () => {
    const { id } = create();
    const err = d.fails(
      OWNER,
      (w, s) => s.items.ownerPatch(w, { id, expected_version: version(id), status: 'ready' }),
      'not_declared',
    );
    expect(err.message).toBe(
      `${id} can't move to Ready: its shared changes aren't declared. It also has no outcome and no acceptance criteria. Ask a planner to shape it, declare none if it changes no shared part, or give a reason to move it anyway.`,
    );
    expect(err.details).toEqual({
      missing: ['outcome', 'acceptance', 'shared_changes'],
      ask_planner: true,
    });
    expect(status(id)).toBe('planning');
  });

  it('an agent hears the same gaps', () => {
    const { id } = create();
    const err = d.fails(
      planner,
      (w, s) => s.items.setStatus(w, { id, status: 'ready' }),
      'not_declared',
    );
    expect(err.message).toBe(
      `Declare the shared parts ${id} will change (or none) with declare_shared_changes, then move it to Ready. It also has no outcome and no acceptance criteria.`,
    );
    expect(err.details).toEqual({ missing: ['outcome', 'acceptance', 'shared_changes'] });
  });

  it('Ask a planner marks it Needs shaping with the owner’s note, recorded and undoable', () => {
    const { id } = create({}, OWNER); // the owner's own idea: not marked yet
    expect(getItem(id).needs_shaping).toBeUndefined();
    ownerPatch(id, { request_shaping: { note: 'Check it against the synthetic export story' } });
    expect(getItem(id).needs_shaping).toEqual({
      missing: ['outcome', 'acceptance', 'shared_changes'],
      asked_by: 'owner',
      by: 'owner',
      at: '2026-11-24T08:00:00.000Z',
      note: 'Check it against the synthetic export story',
    });
    const event = d.row<{ summary: string; mutation_id: string }>(
      "SELECT summary, mutation_id FROM events WHERE type = 'item.updated' ORDER BY seq DESC LIMIT 1",
    );
    expect(event.summary).toBe(
      `You asked a planner to shape ${id} (no outcome, no acceptance criteria and shared changes not declared): Check it against the synthetic export story`,
    );
    expect(digest().needs_shaping?.rows[0]).toMatchObject({ id, asked_by: 'owner' });
    undoMutation(d.server.runtime.write, event.mutation_id);
    expect(getItem(id).needs_shaping).toBeUndefined();
  });

  it('refuses a request on a shaped ticket, a Ready one, an epic, or with a move', () => {
    const shaped = create({ ...SHAPED, shared: 'none' }).id;
    d.fails(
      OWNER,
      (w, s) =>
        s.items.ownerPatch(w, {
          id: shaped,
          expected_version: version(shaped),
          request_shaping: {},
        } as never),
      'validation',
    );
    d.write(planner, (w, s) => s.items.setStatus(w, { id: shaped, status: 'ready' }));
    d.fails(
      OWNER,
      (w, s) =>
        s.items.ownerPatch(w, {
          id: shaped,
          expected_version: version(shaped),
          request_shaping: {},
        } as never),
      'validation',
    );
    const e = epic();
    d.fails(
      OWNER,
      (w, s) =>
        s.items.ownerPatch(w, {
          id: e,
          expected_version: version(e),
          request_shaping: {},
        } as never),
      'validation',
    );
    const { id } = create();
    d.fails(
      OWNER,
      (w, s) =>
        s.items.ownerPatch(w, {
          id,
          expected_version: version(id),
          status: 'ready',
          request_shaping: {},
        } as never),
      'validation',
    );
  });

  it('the owner can still declare none and move it, as before', () => {
    const { id } = create();
    d.write(OWNER, (w, s) => s.sharedChanges.ownerDeclare(w, { id, none: true } as never));
    ownerPatch(id, { status: 'ready' });
    expect(status(id)).toBe('ready');
    // Ready ends the request; back in Planning it isn't Needs shaping again.
    expect(shapingColumn(id)).toBeNull();
    ownerPatch(id, { status: 'planning' });
    expect(getItem(id).needs_shaping).toBeUndefined();
  });
});

describe("the producer's digest", () => {
  it('counts Needs shaping, highest priority first, with what each lacks', () => {
    const e = epic();
    const a = create({ epic: e, priority: 3 }).id;
    const b = create({ epic: e, priority: 1, shared: 'none' }).id;
    create({ ...SHAPED, shared: 'none', epic: e }); // shaped: not listed
    const first = digest();
    expect(first.needs_shaping).toEqual({
      total: 2,
      rows: [
        {
          id: b,
          title: 'Synthetic story',
          epic: e,
          missing: ['outcome', 'acceptance'],
          asked_by: 'agent',
          note: null,
        },
        {
          id: a,
          title: 'Synthetic story',
          epic: e,
          missing: ['outcome', 'acceptance', 'shared_changes'],
          asked_by: 'agent',
          note: null,
        },
      ],
    });
    const text = renderResult('get_digest', first, {});
    expect(text).toContain(
      `needs shaping 2:\n- ${b} in ${e} · no outcome and no acceptance criteria · Synthetic story`,
    );
    // With a cursor, only what changed since.
    const later = create().id;
    expect(digest(first.cursor).needs_shaping?.rows.map((r) => r.id)).toEqual([later]);
  });

  it('is absent when nothing needs shaping, and lists while the project is paused', () => {
    expect(digest().needs_shaping).toBeUndefined();
    const { id } = create();
    d.write(OWNER, (w, s) => s.projects.pause(w, { key: 'TST', reason: 'Synthetic pause' }));
    expect(digest().needs_shaping?.rows.map((r) => r.id)).toEqual([id]);
  });
});

describe("the planner's path to Ready", () => {
  it('shaping ends Needs shaping, and Ready moves with no owner step', () => {
    const e = epic();
    const { id } = create({ epic: e });
    expect(digest().needs_shaping?.total).toBe(1);
    d.write(planner, (w, s) => s.items.update(w, { id, expected_version: version(id), ...SHAPED }));
    expect(getItem(id).needs_shaping?.missing).toEqual(['shared_changes']);
    d.write(planner, (w, s) =>
      s.sharedChanges.declare(w, { id, none: true } as ToolInput<'declare_shared_changes'>),
    );
    expect(getItem(id).needs_shaping).toBeUndefined();
    expect(digest().needs_shaping).toBeUndefined();
    d.write(planner, (w, s) => s.items.setStatus(w, { id, status: 'ready' }));
    expect(status(id)).toBe('ready');
    expect(shapingColumn(id)).toBeNull();
  });
});

describe('the epic and the map', () => {
  it('the epic page marks its Needs shaping tickets, and so do its map cards', () => {
    const e = epic();
    const unshaped = create({ epic: e }).id;
    const inbox = create({ epic: e, status: 'inbox', ...SHAPED, shared: 'none' }).id;
    const detail = d.services.views.itemDetail(d.read(OWNER), { id: e });
    expect(detail.epic_readiness).toEqual({
      state: 'not_ready',
      unshaped: [
        { id: 'TST-2', title: 'Release Synthetic epic', status: 'inbox' },
        {
          id: unshaped,
          title: 'Synthetic story',
          status: 'planning',
          needs_shaping: true,
        },
        { id: inbox, title: 'Synthetic story', status: 'inbox' },
      ],
    });
    const child = detail.children.find((c) => c.id === unshaped)!;
    expect(child.needs_shaping?.missing).toEqual(['outcome', 'acceptance', 'shared_changes']);
    expect(detail.children.find((c) => c.id === inbox)!.needs_shaping).toBeUndefined();
  });

  it('archived and canceled tickets never need shaping', () => {
    const { id } = create();
    d.write(planner, (w, s) =>
      s.items.setStatus(w, { id, status: 'canceled', reason: 'Synthetic duplicate' }),
    );
    expect(getItem(id).needs_shaping).toBeUndefined();
    expect(digest().needs_shaping).toBeUndefined();
  });
});

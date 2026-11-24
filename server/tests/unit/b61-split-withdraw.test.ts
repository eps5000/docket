/**
 * Split a ticket and withdraw a question (owner decision 48; BUILD_SPEC §5.33;
 * B61): authority, atomicity, no criterion lost, each relation, a live lead,
 * stale versions, out-of-date packets, and undo. All content is synthetic.
 */
import type { SplitRelation } from '@docket/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getRun } from '../../src/domain/model.js';
import type { SplitInput } from '../../src/domain/split.js';
import { applyUndo } from '../../src/domain/undo.js';
import { OWNER_ACTOR, type Actor } from '../../src/domain/write.js';
import { askForm } from '../helpers.js';
import { startDomain, type Domain } from '../us1-helpers.js';

const CO = 'orca-coordinator';
let d: Domain;
let worker: Actor;
let other: Actor;

beforeEach(() => {
  d = startDomain();
  worker = d.agent('claude', { label: 'worker-1' });
  other = d.agent('codex', { label: 'worker-2' });
});
afterEach(() => d.cleanup());

const registerCoordinator = () =>
  d.write(OWNER_ACTOR, (w, s) =>
    s.projects.setDefaultSatisfiedWhen(w, { key: 'RCP', coordinators: [CO] }),
  );
const claim = (id = 'RCP-17', extra: Record<string, unknown> = {}) =>
  d.write(worker, (w, s) => s.runs.claim(w, { id, agent_label: 'worker-1', ...extra })).run_id;
const as = (run_id: string): Actor => ({ ...worker, run_id });
const ask = (actor: Actor, id = 'RCP-17', text = 'Should the planner remember the week?') =>
  d.write(actor, (w, s) => s.messages.askOwner(w, { id, ...askForm(text) })).question_id;
const withdraw = (actor: Actor, question_id: string, coordinator?: string) =>
  d.write(actor, (w, s) =>
    s.messages.withdraw(w, {
      question_id,
      reason: 'The design changed, so this no longer matters.',
      ...(coordinator ? { coordinator } : {}),
    }),
  );
const refuseWithdraw = (
  actor: Actor,
  question_id: string,
  code: 'forbidden' | 'conflict' | 'validation',
  extra: { coordinator?: string; reason?: string } = {},
) =>
  d.fails(
    actor,
    (w, s) =>
      s.messages.withdraw(w, {
        question_id,
        reason: 'The design changed, so this no longer matters.',
        ...extra,
      }),
    code,
  );
const readItem = (actor: Actor, id: string) =>
  d.services.items.get(d.read(actor), { id, view: 'standard' } as never);
const question = (id: string) =>
  d.row<{
    withdrawn_at: string | null;
    withdrawn_by: string | null;
    withdrawn_reason: string | null;
    read_by_agent_at: string | null;
  }>('SELECT * FROM questions WHERE id = ?', id);
const needsYouHas = (qid: string) =>
  d.services.views
    .needsYou(d.read(OWNER_ACTOR), { scope: 'all' })
    .for_you_now.some((r) => r.kind === 'question' && r.question_id === qid);

describe('withdraw a question', () => {
  it('the run that asked withdraws it: gone from Needs you, recorded, and it can ask again', () => {
    const run = claim();
    const qid = ask(as(run));
    expect(needsYouHas(qid)).toBe(true);
    expect(getRun(d.server.runtime.db, run)!.state).toBe('needs_input');

    withdraw(as(run), qid);

    expect(needsYouHas(qid)).toBe(false);
    expect(getRun(d.server.runtime.db, run)!.state).toBe('open');
    expect(question(qid)).toMatchObject({
      withdrawn_by: 'claude · worker-1',
      withdrawn_reason: 'The design changed, so this no longer matters.',
    });
    const event = d.row<{ summary: string }>(
      "SELECT summary FROM events WHERE type = 'question.withdrawn'",
    );
    expect(event.summary).toContain('withdrew a question');
    expect(event.summary).toContain('The design changed');

    const next = ask(as(run), 'RCP-17', 'Should the planner open on today instead?');
    expect(next).not.toBe(qid);
    expect(needsYouHas(next)).toBe(true);
  });

  it('its recorded coordinator and a registered one may withdraw it', () => {
    const run = claim('RCP-17', { orchestrator: { name: CO } });
    const first = ask(as(run));
    withdraw(other, first, CO);
    expect(question(first).withdrawn_by).toBe(`${CO} (coordinator)`);

    registerCoordinator();
    const second = ask(as(run), 'RCP-17', 'Should the planner open on today instead?');
    withdraw(other, second, CO);
    expect(question(second).withdrawn_at).not.toBeNull();
  });

  it('refuses anyone else, and changes nothing', () => {
    const run = claim();
    const qid = ask(as(run));
    refuseWithdraw(other, qid, 'forbidden');
    refuseWithdraw(other, qid, 'forbidden', { coordinator: 'not-them' });
    // Same client, but not the run that asked.
    refuseWithdraw(d.agent('claude', { label: 'worker-3' }), qid, 'forbidden');
    expect(question(qid).withdrawn_at).toBeNull();
    expect(needsYouHas(qid)).toBe(true);
  });

  it("can't withdraw an answered question, and never answers for the owner", () => {
    const run = claim();
    const qid = ask(as(run));
    d.write(OWNER_ACTOR, (w, s) =>
      s.messages.answer(w, { id: 'RCP-17', question_id: qid, option: 'Per serving' }),
    );
    expect(refuseWithdraw(as(run), qid, 'conflict').message).toContain('already answered');
    expect(question(qid).withdrawn_at).toBeNull();
  });

  it("the owner can't answer a withdrawn question", () => {
    const run = claim();
    const qid = ask(as(run));
    withdraw(as(run), qid);
    const err = d.fails(
      OWNER_ACTOR,
      (w, s) => s.messages.answer(w, { id: 'RCP-17', question_id: qid, text: 'Yes.' }),
      'conflict',
    );
    expect(err.message).toContain('withdrawn');
    refuseWithdraw(as(run), qid, 'conflict');
  });

  it('needs a plain reason the owner can read', () => {
    const run = claim();
    const qid = ask(as(run));
    const err = refuseWithdraw(as(run), qid, 'validation', { reason: 'Superseded by dec_01ABC.' });
    expect(err.message).toContain('everyday words');
  });

  it("isn't delivered, and leaves read receipts alone", () => {
    const run = claim();
    const qid = ask(as(run));
    withdraw(as(run), qid);
    const got = readItem(as(run), 'RCP-17');
    expect(got.item.open_question).toBeNull();
    expect(got.delivery).toBeNull();
    expect(question(qid).read_by_agent_at).toBeNull();
  });

  it('an unread answer still has to be read before asking again', () => {
    const run = claim();
    const qid = ask(as(run));
    d.write(OWNER_ACTOR, (w, s) =>
      s.messages.answer(w, { id: 'RCP-17', question_id: qid, text: 'Yes.' }),
    );
    const err = d.fails(
      as(run),
      (w, s) => s.messages.askOwner(w, { id: 'RCP-17', ...askForm('A different question, now?') }),
      'validation',
    );
    expect(err.message).toContain("haven't read");
  });
});

// ---- Split ----

const CRITERIA = ['Loads the week', 'Keeps the scroll', 'Saves the filter', 'Shows a spinner'];

function ticket() {
  const made = d.write(worker, (w, s) =>
    s.items.create(w, {
      project: 'RCP',
      type: 'Implementation',
      title: 'A ticket to split',
      acceptance: CRITERIA,
      status: 'planning',
      priority: 1,
      epic: 'RCP-1',
      labels: ['regression'],
    }),
  );
  return made.id;
}

const splitArgs = (id: string, extra: Partial<SplitInput> = {}): SplitInput => ({
  id,
  expected_version: versionOf(id),
  move: [2, 4],
  relation: 'none',
  type: 'Implementation',
  title: 'The part that can start now',
  ...extra,
});
const split = (actor: Actor, id: string, extra: Partial<SplitInput> = {}) =>
  d.write(actor, (w, s) => s.items.split(w, splitArgs(id, extra)));
const versionOf = (id: string) =>
  d.row<{ version: number }>('SELECT version FROM items WHERE id = ?', id).version;
const acceptance = (id: string) =>
  d
    .rows<{ text: string }>(
      'SELECT text FROM acceptance_criteria WHERE item_id = ? ORDER BY position, id',
      id,
    )
    .map((r) => r.text);
const blocks = (from: string, to: string) =>
  !!d.row("SELECT 1 AS y FROM links WHERE from_id = ? AND to_id = ? AND type = 'blocks'", from, to);
const addBlocker = (from: string, to: string) =>
  d.write(worker, (w, s) => s.links.link(w, { from, to, type: 'blocks' }));

/** A row without the counters every write bumps, and any other columns named. */
function without(row: Record<string, unknown>, ...more: string[]) {
  const drop = new Set(['version', 'updated_at', ...more]);
  return Object.fromEntries(Object.entries(row).filter(([key]) => !drop.has(key)));
}

/** Everything a split touches, without the counters a write bumps. */
function snapshot(ids: string[]) {
  const rows = (query: string, ...args: string[]) =>
    d.rows<Record<string, unknown>>(query, ...args).map((row) => without(row));
  return ids.map((id) => ({
    item: rows('SELECT * FROM items WHERE id = ?', id),
    criteria: rows('SELECT * FROM acceptance_criteria WHERE item_id = ? ORDER BY id', id),
    labels: rows('SELECT * FROM item_labels WHERE item_id = ? ORDER BY id', id),
    links: rows('SELECT * FROM links WHERE from_id = ? OR to_id = ? ORDER BY id', id, id),
    parts: rows('SELECT * FROM item_shared_changes WHERE item_id = ? ORDER BY id', id),
    steps: rows('SELECT * FROM work_steps WHERE item_id = ? ORDER BY id', id),
    plans: rows('SELECT * FROM plan_versions WHERE item_id = ? ORDER BY id', id),
    packets: rows('SELECT * FROM packets WHERE item_id = ? ORDER BY id', id),
    overlaps: rows(
      'SELECT * FROM part_overlaps WHERE item_a = ? OR item_b = ? ORDER BY id',
      id,
      id,
    ),
  }));
}

function planSteps(id: string) {
  d.write(worker, (w, s) =>
    s.checklist.setPlan(w, {
      id,
      steps: [{ text: 'Read the week' }, { text: 'Keep the scroll' }, { text: 'Write the test' }],
    } as never),
  );
  return d
    .rows<{ id: string; text: string }>(
      'SELECT id, text FROM work_steps WHERE item_id = ? ORDER BY position',
      id,
    )
    .map((r) => r.id);
}

function declare(id: string, keys: string[]) {
  d.write(worker, (w, s) =>
    s.sharedChanges.declare(w, {
      id,
      changes: keys.map((part) => ({ part, change: 'change', note: 'Synthetic change.' })),
      new_parts: keys.map((key) => ({ key })),
    } as never),
  );
}

function openPacket(id: string) {
  const t = d.clock.now().toISOString();
  d.sql
    .prepare(
      `INSERT INTO packets (id, item_id, round, content_hash, built_from_commit, created_by, state, version, created_at, updated_at)
       VALUES ('pkt_b61', ?, 1, 'abcd1234', 'abc1234', 'claude', 'open', 1, ?, ?)`,
    )
    .run(id, t, t);
}

describe('split a ticket', () => {
  it('moves the chosen criteria, keeps the rest, and loses none', () => {
    const id = ticket();
    const { item, source } = split(worker, id);
    expect(acceptance(id)).toEqual(['Loads the week', 'Saves the filter']);
    expect(acceptance(item.id)).toEqual(['Keeps the scroll', 'Shows a spinner']);
    expect([...acceptance(id), ...acceptance(item.id)].sort()).toEqual([...CRITERIA].sort());
    expect(source.version).toBeGreaterThan(1);
    expect(item).toMatchObject({ epic: 'RCP-1', priority: 1, labels: ['regression'] });
  });

  it('a copied criterion is on both tickets; the moved rows keep their identity', () => {
    const id = ticket();
    const ids = d
      .rows<{ id: string }>(
        'SELECT id FROM acceptance_criteria WHERE item_id = ? ORDER BY position',
        id,
      )
      .map((r) => r.id);
    const { item } = split(worker, id, { move: [2], copy: [1] });
    expect(acceptance(id)).toEqual(['Loads the week', 'Saves the filter', 'Shows a spinner']);
    expect(acceptance(item.id)).toEqual(['Loads the week', 'Keeps the scroll']);
    const moved = d.row<{ item_id: string }>(
      'SELECT item_id FROM acceptance_criteria WHERE id = ?',
      ids[1]!,
    );
    expect(moved.item_id).toBe(item.id);
  });

  it.each<[SplitRelation, boolean, boolean]>([
    ['after_original', true, false],
    ['before_original', false, true],
    ['none', false, false],
  ])('relation %s', (relation, originalFirst, newFirst) => {
    const id = ticket();
    const { item } = split(worker, id, { relation });
    expect(blocks(id, item.id)).toBe(originalFirst);
    expect(blocks(item.id, id)).toBe(newFirst);
  });

  it('records where it came from on both tickets', () => {
    const id = ticket();
    const { item } = split(worker, id);
    const read = (x: string) => readItem(worker, x).item;
    expect(read(item.id).split_from).toBe(id);
    expect(read(id).split_into).toEqual([item.id]);
  });

  it('refuses what would lose or muddle a criterion', () => {
    const id = ticket();
    const refuse = (extra: Partial<SplitInput>) =>
      d.fails(worker, (w, s) => s.items.split(w, splitArgs(id, extra)), 'validation');
    expect(refuse({ move: [1, 2, 3, 4] }).message).toContain('keep at least one');
    expect(refuse({ move: [9] }).message).toContain('no acceptance criterion 9');
    expect(refuse({ move: [0] }).message).toContain('no acceptance criterion 0');
    expect(refuse({ move: [2, 2] }).message).toContain('twice');
    expect(refuse({ move: [2], copy: [2] }).message).toContain('both');
    expect(refuse({ move: [] }).message).toContain('Nothing to split');
    expect(acceptance(id)).toEqual(CRITERIA);
  });

  it('refuses an epic and a closed ticket', () => {
    d.fails(worker, (w, s) => s.items.split(w, { ...splitArgs('RCP-1'), move: [1] }), 'validation');
    const id = ticket();
    d.sql.prepare("UPDATE items SET status = 'done' WHERE id = ?").run(id);
    d.fails(worker, (w, s) => s.items.split(w, splitArgs(id)), 'validation');
  });

  it('a stale version is a conflict and changes nothing', () => {
    const id = ticket();
    const before = snapshot([id]);
    d.fails(
      worker,
      (w, s) => s.items.split(w, { ...splitArgs(id), expected_version: versionOf(id) - 1 + 5 }),
      'conflict',
    );
    expect(snapshot([id])).toEqual(before);
  });

  it('is atomic: a failure part way leaves both tickets and the ID counter as they were', () => {
    const id = ticket();
    const nextSeq = () =>
      d.row<{ next_seq: number }>("SELECT next_seq FROM projects WHERE key = 'RCP'").next_seq;
    const seq = nextSeq();
    const before = snapshot([id]);
    d.sql.exec(`CREATE TRIGGER b61_fail BEFORE INSERT ON events WHEN NEW.type = 'item.split'
      BEGIN SELECT RAISE(ABORT, 'injected failure'); END`);
    expect(() => split(worker, id, { relation: 'after_original' })).toThrow();
    d.sql.exec('DROP TRIGGER b61_fail');
    expect(snapshot([id])).toEqual(before);
    expect(nextSeq()).toBe(seq);
  });

  it('moves or copies blockers, keeping their rule', () => {
    const id = ticket();
    addBlocker('RCP-24', id);
    addBlocker('RCP-12', id);
    d.sql
      .prepare("UPDATE links SET satisfied_when = 'merged' WHERE from_id = 'RCP-24' AND to_id = ?")
      .run(id);
    const { item } = split(worker, id, {
      also: [
        { kind: 'blocker', id: 'RCP-24' },
        { kind: 'blocker', id: 'RCP-12', copy: true },
      ],
    });
    expect(blocks('RCP-24', id)).toBe(false);
    expect(blocks('RCP-24', item.id)).toBe(true);
    expect(blocks('RCP-12', id)).toBe(true);
    expect(blocks('RCP-12', item.id)).toBe(true);
    expect(
      d.row<{ satisfied_when: string }>(
        "SELECT satisfied_when FROM links WHERE from_id = 'RCP-24' AND to_id = ?",
        item.id,
      ).satisfied_when,
    ).toBe('merged');
  });

  it('moves or copies shared-part declarations', () => {
    const id = ticket();
    declare(id, ['file:planner.ts', 'file:week.ts']);
    const { item } = split(worker, id, {
      also: [
        { kind: 'part', id: 'file:planner.ts' },
        { kind: 'part', id: 'file:week.ts', copy: true },
      ],
    });
    const keys = (x: string) =>
      d
        .rows<{ part_key: string }>(
          'SELECT part_key FROM item_shared_changes WHERE item_id = ? ORDER BY part_key',
          x,
        )
        .map((r) => r.part_key);
    expect(keys(id)).toEqual(['file:week.ts']);
    expect(keys(item.id)).toEqual(['file:planner.ts', 'file:week.ts']);
  });

  it("moves steps off the original's plan and keeps its history", () => {
    const id = ticket();
    const [first, second] = planSteps(id);
    const { item } = split(worker, id, {
      also: [
        { kind: 'step', id: second! },
        { kind: 'step', id: first!, copy: true },
      ],
    });
    const texts = (x: string) => readItem(worker, x).item.checklist!.work;
    expect(texts(id).map((s) => s.text)).toEqual(['Read the week', 'Write the test']);
    expect(
      texts(item.id)
        .map((s) => s.text)
        .sort(),
    ).toEqual(['Keep the scroll', 'Read the week']);
    // The moved step's row stays in the old plan version.
    expect(
      d.row<{ item_id: string }>('SELECT item_id FROM work_steps WHERE id = ?', second!),
    ).toEqual({ item_id: id });
  });
});

describe('a split with a live lead', () => {
  const claimed = () => {
    const id = ticket();
    d.sql
      .prepare("UPDATE items SET status = 'ready', shared_none_at = ? WHERE id = ?")
      .run(d.clock.now().toISOString(), id);
    return { id, run: claim(id, { orchestrator: { name: CO } }) };
  };

  it('only the lead, its coordinator or the owner may split', () => {
    const { id, run } = claimed();
    const before = snapshot([id]);
    const err = d.fails(other, (w, s) => s.items.split(w, splitArgs(id)), 'forbidden');
    expect(err.message).toContain('Only its lead');
    d.fails(
      other,
      (w, s) => s.items.split(w, { ...splitArgs(id), coordinator: 'not-them' }),
      'forbidden',
    );
    // Same client, without the lead's run.
    d.fails(d.agent('claude'), (w, s) => s.items.split(w, splitArgs(id)), 'forbidden');
    expect(snapshot([id])).toEqual(before);

    split(as(run), id, { move: [4] });
    split(other, id, { move: [3], coordinator: CO });
    split(OWNER_ACTOR, id, { move: [2] });
    expect(acceptance(id)).toEqual(['Loads the week']);
  });

  it('the claim and run stay on the original', () => {
    const { id, run } = claimed();
    const { item } = split(as(run), id);
    expect(getRun(d.server.runtime.db, run)).toMatchObject({ item_id: id, state: 'open' });
    expect(d.rows('SELECT 1 FROM runs WHERE item_id = ?', item.id)).toEqual([]);
    expect(d.row<{ status: string }>('SELECT status FROM items WHERE id = ?', id).status).toBe(
      'progress',
    );
  });

  it("can't move the step the lead is on, but can copy it", () => {
    const { id, run } = claimed();
    const [step] = planSteps(id);
    d.write(as(run), (w, s) =>
      s.checklist.updateStep(w, { id, step_id: step!, state: 'current' } as never),
    );
    const err = d.fails(
      as(run),
      (w, s) => s.items.split(w, { ...splitArgs(id), also: [{ kind: 'step', id: step! }] }),
      'validation',
    );
    expect(err.message).toContain('working on');
    split(as(run), id, { also: [{ kind: 'step', id: step!, copy: true }] });
  });

  it("an agent can't move an owner's step", () => {
    const id = ticket();
    const added = d.write(OWNER_ACTOR, (w, s) =>
      s.checklist.ownerAddStep(w, { id, text: 'Check it on a phone' }),
    );
    d.fails(
      worker,
      (w, s) => s.items.split(w, { ...splitArgs(id), also: [{ kind: 'step', id: added.id }] }),
      'forbidden',
    );
  });

  it('marks an open packet out of date without changing it', () => {
    const id = ticket();
    openPacket(id);
    const before = d.row<Record<string, unknown>>("SELECT * FROM packets WHERE id = 'pkt_b61'");
    split(worker, id);
    const after = d.row<Record<string, unknown>>("SELECT * FROM packets WHERE id = 'pkt_b61'");
    expect(after.criteria_changed_at).not.toBeNull();
    expect(without(after, 'criteria_changed_at')).toEqual(without(before, 'criteria_changed_at'));
    const packets = readItem(worker, id).item.packets!;
    expect(packets[0]!.stale).toBe(true);
    expect(d.row("SELECT 1 AS y FROM events WHERE type = 'packet.stale'")).toBeDefined();
  });

  it('a copy leaves the packet in date', () => {
    const id = ticket();
    openPacket(id);
    split(worker, id, { move: [], copy: [1] });
    expect(readItem(worker, id).item.packets![0]!.stale).toBe(false);
  });
});

describe('undo a split', () => {
  const undoLast = () => {
    const { mutation_id } = d.row<{ mutation_id: string }>(
      "SELECT mutation_id FROM events WHERE type = 'item.split' ORDER BY seq DESC LIMIT 1",
    );
    return d.write(OWNER_ACTOR, (w) => applyUndo(w, mutation_id));
  };

  it('restores both tickets exactly', () => {
    const id = ticket();
    addBlocker('RCP-24', id);
    addBlocker('RCP-12', id);
    declare(id, ['file:planner.ts', 'file:week.ts']);
    const [first, second] = planSteps(id);
    openPacket(id);
    const before = snapshot([id]);

    const { item } = split(OWNER_ACTOR, id, {
      relation: 'before_original',
      copy: [1],
      also: [
        { kind: 'blocker', id: 'RCP-24' },
        { kind: 'blocker', id: 'RCP-12', copy: true },
        { kind: 'part', id: 'file:planner.ts' },
        { kind: 'part', id: 'file:week.ts', copy: true },
        { kind: 'step', id: second! },
        { kind: 'step', id: first!, copy: true },
      ],
    });
    expect(snapshot([id])).not.toEqual(before);

    undoLast();
    expect(snapshot([id])).toEqual(before);
    expect(d.row('SELECT 1 AS y FROM items WHERE id = ?', item.id)).toBeUndefined();
    expect(d.rows('SELECT 1 FROM acceptance_criteria WHERE item_id = ?', item.id)).toEqual([]);
  });

  it('brings back an open overlap the moved part ended', () => {
    const id = ticket();
    declare(id, ['file:planner.ts']);
    declare('RCP-17', ['file:planner.ts']);
    const t = d.clock.now().toISOString();
    const [a, b] = [id, 'RCP-17'].sort() as [string, string];
    d.sql
      .prepare(
        `INSERT INTO part_overlaps (id, project_key, item_a, item_b, parts, claimed_first, state, raised_at, created_at, updated_at, version)
         VALUES ('pov_b61', 'RCP', ?, ?, '["file:planner.ts"]', ?, 'open', ?, ?, ?, 1)`,
      )
      .run(a, b, id, t, t, t);
    const before = snapshot([id]);
    split(OWNER_ACTOR, id, { also: [{ kind: 'part', id: 'file:planner.ts' }] });
    expect(
      d.row<{ state: string }>("SELECT state FROM part_overlaps WHERE id = 'pov_b61'").state,
    ).toBe('resolved');
    undoLast();
    expect(snapshot([id])).toEqual(before);
  });

  it("a later change to either ticket stops the undo, and an agent's split isn't undoable", () => {
    const id = ticket();
    const { item } = split(OWNER_ACTOR, id);
    d.write(worker, (w, s) =>
      s.items.update(w, { id: item.id, expected_version: item.version, title: 'Renamed' }),
    );
    const mutation = () =>
      d.row<{ mutation_id: string }>(
        "SELECT mutation_id FROM events WHERE type = 'item.split' ORDER BY seq DESC LIMIT 1",
      ).mutation_id;
    const first = mutation();
    d.fails(OWNER_ACTOR, (w) => applyUndo(w, first), 'conflict');

    split(worker, id, { move: [1] });
    const second = mutation();
    d.fails(OWNER_ACTOR, (w) => applyUndo(w, second), 'forbidden');
  });
});

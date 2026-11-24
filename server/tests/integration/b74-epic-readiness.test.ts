/**
 * B74, an epic starts only when its tickets are ready (owner decision 58),
 * with synthetic text only: the start check for each ticket status, canceled
 * and done tickets, an empty epic, an In progress epic that isn't blocked and
 * its resume, known gaps approved through the question form and the item page,
 * rejection, the implementer's context, Pick next epic and the digest flag.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DIGEST_MAX_CHARS,
  GAP_APPROVE_OPTION,
  GAP_KEEP_OPTION,
  renderResult,
  type Status,
} from '@docket/shared';
import { GapsRefusal } from '../../src/domain/epic-readiness.js';
import { undoMutation } from '../../src/domain/undo.js';
import type { Actor } from '../../src/domain/write.js';
import { addProject, declareNone, forceStatus, startDomain, type Domain } from '../us1-helpers.js';

const OWNER: Actor = { kind: 'owner', client: null, label: null, session_id: null, run_id: null };
const GAPS = ['Which retry limit to use', 'Wording of the empty state'];

let d: Domain;
let planner: Actor;
let worker: Actor;

beforeEach(() => {
  d = startDomain({ seed: false, now: new Date('2026-11-24T08:00:00.000Z') });
  addProject(d, 'TST');
  planner = d.agent('claude', { label: 'planner' });
  worker = d.agent('codex', { label: 'worker' });
});
afterEach(() => d.cleanup());

const create = (type: 'Epic' | 'Task', opts: { epic?: string; status?: Status } = {}) => {
  const { id } = d.write(planner, (w, s) =>
    s.items.create(w, {
      project: 'TST',
      type,
      title: `Synthetic ${type.toLowerCase()}`,
      priority: 2,
      status: 'planning',
      ...(opts.epic ? { epic: opts.epic } : {}),
    }),
  );
  declareNone(d, id);
  if (opts.status && opts.status !== 'planning') forceStatus(d, id, opts.status);
  return id;
};
const epicWith = (epicStatus: Status, ...kids: Status[]) => {
  const epic = create('Epic', { status: epicStatus });
  const tickets = kids.map((status) => create('Task', { epic, status }));
  return { epic, tickets };
};
const claim = (id: string, actor = worker) =>
  d.write(actor, (w, s) => s.runs.claim(w, { id, agent_label: 'worker' })).run_id;
const version = (id: string) =>
  d.row<{ version: number }>('SELECT version FROM items WHERE id = ?', id).version;
const status = (id: string) =>
  d.row<{ status: Status }>('SELECT status FROM items WHERE id = ?', id).status;
const setGaps = (id: string, gaps: { gap: string; settled?: string }[], actor = planner) =>
  d.write(actor, (w, s) =>
    s.items.update(w, { id, expected_version: version(id), known_gaps: gaps }),
  );
const toReady = (id: string, actor = planner) =>
  d.write(actor, (w, s) => s.items.setStatus(w, { id, status: 'ready' }));
const detail = (id: string) => d.services.views.itemDetail(d.read(), { id });
const questionOf = (id: string) =>
  d.row<{ id: string; text: string; form: string; answered_at: string | null } | undefined>(
    'SELECT id, text, form, answered_at FROM questions WHERE item_id = ? ORDER BY created_at DESC LIMIT 1',
    id,
  );
/** An agent's refused set_status ready, with the question the MCP adapter writes. */
const proposeReady = (id: string) => {
  const err = d.fails(
    planner,
    (w, s) => s.items.setStatus(w, { id, status: 'ready' }),
    'forbidden',
  );
  expect(err).toBeInstanceOf(GapsRefusal);
  d.write(planner, (w) => (err as GapsRefusal).recordRejection(w));
  return err;
};
const answer = (id: string, option: string, note?: string) =>
  d.write(OWNER, (w, s) =>
    s.messages.answer(w, {
      id,
      question_id: questionOf(id)!.id,
      option,
      ...(note ? { note } : {}),
    }),
  );
const decisionsOn = (id: string) =>
  d.rows<{ id: string; authority: string; decision_md: string; status: string }>(
    "SELECT id, authority, decision_md, status FROM decision_records WHERE scope_kind = 'item' AND scope_id = ?",
    id,
  );

describe('the epic start check', () => {
  it.each<[Status, boolean]>([
    ['inbox', false],
    ['planning', false],
    ['ready', true],
    ['progress', true],
    ['review', true],
    ['done', true],
    ['canceled', true],
  ])('a Ready epic with a %s ticket can start: %s', (child, starts) => {
    const { epic, tickets } = epicWith('ready', 'ready', child);
    if (starts) {
      claim(epic);
      expect(status(epic)).toBe('progress');
    } else {
      const err = d.fails(worker, (w, s) => s.runs.claim(w, { id: epic }), 'epic_not_ready');
      expect(err.details).toMatchObject({
        epic,
        unshaped: [{ id: tickets[1], status: child }],
        ways_forward: ['shape', 'known_gaps', 'move', 'remove'],
      });
      expect(err.message).toContain(tickets[1]!);
      for (const way of ['finish shaping', 'known gaps', 'epic it belongs in', 'out of this epic'])
        expect(err.message).toContain(way);
      expect(status(epic)).toBe('ready');
    }
  });

  it('lists every unshaped ticket, and canceled and done ones never count', () => {
    const { epic, tickets } = epicWith('ready', 'inbox', 'planning', 'done', 'canceled');
    const err = d.fails(worker, (w, s) => s.runs.claim(w, { id: epic }), 'epic_not_ready');
    expect((err.details!.unshaped as { id: string }[]).map((t) => t.id)).toEqual(
      tickets.slice(0, 2),
    );
  });

  it('a Planning epic with unshaped tickets is refused with epic_not_ready first', () => {
    const { epic } = epicWith('planning', 'inbox');
    d.fails(worker, (w, s) => s.runs.claim(w, { id: epic }), 'epic_not_ready');
  });

  it('an empty epic starts', () => {
    const { epic } = epicWith('ready');
    claim(epic);
    expect(status(epic)).toBe('progress');
  });

  it('archived unshaped tickets are left out', () => {
    const { epic, tickets } = epicWith('ready', 'inbox');
    d.sql
      .prepare('UPDATE items SET archived_at = ? WHERE id = ?')
      .run('2026-11-24T07:00:00.000Z', tickets[0]);
    claim(epic);
  });

  it('moving an epic to In progress is refused the same way', () => {
    const { epic } = epicWith('ready', 'planning');
    d.fails(
      worker,
      (w, s) => s.items.setStatus(w, { id: epic, status: 'progress' }),
      'epic_not_ready',
    );
  });

  it('an epic already In progress is never blocked, and resuming its claim works', () => {
    const { epic, tickets } = epicWith('progress', 'ready', 'inbox');
    const run = claim(epic);
    expect(status(epic)).toBe('progress');
    // Its lead stopped; resuming the claim on the In progress epic still works.
    d.sql
      .prepare("UPDATE runs SET state = 'interrupted', end_reason = 'released' WHERE id = ?")
      .run(run);
    claim(epic);
    const ready = detail(epic).epic_readiness!;
    expect(ready).toEqual({
      state: 'started_unshaped',
      unshaped: [{ id: tickets[1], title: 'Synthetic task', status: 'inbox' }],
    });
  });

  it('claiming an ordinary ticket is unchanged', () => {
    const { tickets } = epicWith('ready', 'ready', 'inbox');
    claim(tickets[0]!);
    expect(status(tickets[0]!)).toBe('progress');
  });

  it('the shaping ways forward clear it: move a ticket out, or to another epic', () => {
    const { epic, tickets } = epicWith('ready', 'planning', 'inbox');
    const other = create('Epic');
    d.write(planner, (w, s) =>
      s.items.update(w, { id: tickets[0]!, expected_version: version(tickets[0]!), epic: other }),
    );
    d.write(planner, (w, s) =>
      s.items.update(w, { id: tickets[1]!, expected_version: version(tickets[1]!), epic: null }),
    );
    claim(epic);
  });
});

describe('visible before choosing', () => {
  it('epic cards and the epic page say Not ready to start, with the tickets', () => {
    const { epic, tickets } = epicWith('ready', 'ready', 'planning');
    const card = d.services.views
      .work(d.read(), { scope: 'TST', layout: 'board' } as never)
      .epics.find((e) => e.id === epic)!;
    expect(card.readiness).toEqual({
      state: 'not_ready',
      unshaped: [{ id: tickets[1], title: 'Synthetic task', status: 'planning' }],
    });
    expect(detail(epic).epic_readiness?.state).toBe('not_ready');
    const fine = epicWith('ready', 'ready');
    expect(detail(fine.epic).epic_readiness).toBeUndefined();
  });

  it('Pick next epic marks it Not ready to start and never makes it Best next', () => {
    const blocked = epicWith('ready', 'ready', 'inbox');
    const pick = d.services.subgraph.pickEpic(d.read(), { key: 'TST' });
    const row = pick.epics.find((e) => e.id === blocked.epic)!;
    expect(row.fit).toBe('not_ready');
    expect(row.readiness?.unshaped.map((t) => t.id)).toEqual([blocked.tickets[1]]);
    expect(pick.best).toBeNull();
    const good = epicWith('ready', 'ready');
    const again = d.services.subgraph.pickEpic(d.read(), { key: 'TST' });
    expect(again.best?.id).toBe(good.epic);
  });

  it('get_digest flags an In progress epic Started with N unshaped tickets, within its cap', () => {
    const { epic, tickets } = epicWith('progress', 'ready', 'inbox', 'planning');
    epicWith('ready', 'inbox'); // Not started: not in the digest.
    const digest = d.services.digest.get(d.read(worker), { project: 'TST' });
    expect(digest.unshaped_epics).toEqual({
      total: 1,
      rows: [{ id: epic, title: 'Synthetic epic', unshaped: tickets.slice(1) }],
    });
    const text = renderResult('get_digest', digest, { now: d.clock.now() });
    expect(text).toContain(
      `started unshaped 1:\n- ${epic} started with 2 unshaped: ${tickets[1]}, ${tickets[2]}`,
    );
    expect(text.length).toBeLessThanOrEqual(DIGEST_MAX_CHARS);
  });

  it('the digest says nothing when every ticket is Ready', () => {
    epicWith('progress', 'ready');
    const digest = d.services.digest.get(d.read(worker), { project: 'TST' });
    expect(digest.unshaped_epics).toBeUndefined();
  });
});

describe('known gaps', () => {
  it('a fully shaped ticket moves to Ready with no owner step, and settled gaps count as shaped', () => {
    const a = create('Task');
    toReady(a);
    expect(status(a)).toBe('ready');
    const b = create('Task');
    setGaps(b, [{ gap: GAPS[0]!, settled: 'Three retries, decided in planning' }]);
    toReady(b);
    expect(status(b)).toBe('ready');
    expect(questionOf(b)).toBeUndefined();
  });

  it('an agent proposing Ready with open gaps is refused, and Docket asks the owner once', () => {
    const id = create('Task');
    setGaps(
      id,
      GAPS.map((gap) => ({ gap })),
    );
    const err = proposeReady(id);
    expect(err.message).toContain("needs the owner's approval");
    expect(err.details).toMatchObject({ known_gaps: GAPS, ask: 'the owner' });
    const q = questionOf(id)!;
    expect(q.text).toBe(`Approve moving ${id} to Ready with these gaps?`);
    const form = JSON.parse(q.form);
    expect(form.ready_with_gaps).toEqual({ gaps: GAPS });
    expect(form.options.map((o: { label: string }) => o.label)).toEqual([
      GAP_APPROVE_OPTION,
      GAP_KEEP_OPTION,
    ]);
    expect(status(id)).toBe('planning');
    // Asking again doesn't ask twice.
    const again = proposeReady(id);
    expect(again.message).toContain('already asked');
    expect(
      d.row<{ n: number }>('SELECT count(*) AS n FROM questions WHERE item_id = ?', id).n,
    ).toBe(1);
  });

  it('approval through the question form records an owner decision and moves it to Ready', () => {
    const id = create('Task');
    setGaps(
      id,
      GAPS.map((gap) => ({ gap })),
    );
    proposeReady(id);
    answer(id, GAP_APPROVE_OPTION, 'Fine to settle these while building');
    expect(status(id)).toBe('ready');
    const [decision] = decisionsOn(id);
    expect(decision).toMatchObject({ authority: 'owner', status: 'active' });
    for (const gap of GAPS) expect(decision!.decision_md).toContain(gap);
    const gaps = detail(id).item.known_gaps!;
    expect(gaps.approved?.decision_id).toBe(decision!.id);
    expect(gaps.open).toBe(2);
  });

  it('rejection keeps it in Planning with no decision', () => {
    const id = create('Task');
    setGaps(
      id,
      GAPS.map((gap) => ({ gap })),
    );
    proposeReady(id);
    answer(id, GAP_KEEP_OPTION);
    expect(status(id)).toBe('planning');
    expect(decisionsOn(id)).toEqual([]);
    expect(detail(id).item.known_gaps!.approved).toBeNull();
  });

  it('an answer about gaps that changed since asking approves nothing', () => {
    const id = create('Task');
    setGaps(
      id,
      GAPS.map((gap) => ({ gap })),
    );
    proposeReady(id);
    setGaps(id, [{ gap: 'A different gap' }]);
    answer(id, GAP_APPROVE_OPTION);
    expect(status(id)).toBe('planning');
    expect(decisionsOn(id)).toEqual([]);
  });

  it('the owner approves on the item page, which answers the open question, and Undo reverses it', () => {
    const id = create('Task');
    setGaps(
      id,
      GAPS.map((gap) => ({ gap })),
    );
    proposeReady(id);
    const err = d.fails(
      OWNER,
      (w, s) => s.items.ownerPatch(w, { id, expected_version: version(id), status: 'ready' }),
      'validation',
    );
    expect(err.message).toContain('open known gaps');
    d.write(OWNER, (w, s) =>
      s.items.ownerPatch(w, {
        id,
        expected_version: version(id),
        status: 'ready',
        approve_gaps: true,
      }),
    );
    expect(status(id)).toBe('ready');
    expect(decisionsOn(id)).toHaveLength(1);
    expect(questionOf(id)!.answered_at).not.toBeNull();
    const mutation = d.row<{ mutation_id: string }>(
      "SELECT mutation_id FROM events WHERE type = 'item.status_changed' ORDER BY seq DESC LIMIT 1",
    ).mutation_id;
    undoMutation(d.server.runtime.write, mutation);
    expect(status(id)).toBe('planning');
    expect(decisionsOn(id)).toEqual([]);
    expect(detail(id).item.known_gaps!.approved).toBeNull();
  });

  it('only the owner approves; an agent cannot slip gaps past Planning', () => {
    const id = create('Task');
    toReady(id);
    const err = d.fails(
      planner,
      (w, s) =>
        s.items.update(w, { id, expected_version: version(id), known_gaps: [{ gap: GAPS[0]! }] }),
      'validation',
    );
    expect(err.message).toContain('move it back to Planning');
  });

  it('the implementer sees Known gaps to shape and records how each was settled', () => {
    const id = create('Task');
    setGaps(
      id,
      GAPS.map((gap) => ({ gap })),
    );
    proposeReady(id);
    answer(id, GAP_APPROVE_OPTION);
    const run = claim(id);
    const ctx = d.services.context.getContext(d.read(worker), { id, budget: 'small' });
    expect(ctx.known_gaps?.open).toBe(2);
    const text = renderResult(
      'get_context',
      { context: ctx },
      { args: { id }, now: d.clock.now() },
    );
    expect(text).toContain('known gaps to shape (2 open');
    expect(text).toContain(`1. ${GAPS[0]} · open`);
    // Changing an approved gap is refused; settling each is allowed.
    const me = { ...worker, run_id: run };
    d.fails(
      me,
      (w, s) =>
        s.items.update(w, {
          id,
          expected_version: version(id),
          run_id: run,
          known_gaps: [{ gap: 'Something else' }],
        }),
      'validation',
    );
    setGaps(id, [{ gap: GAPS[0]!, settled: 'Three retries' }, { gap: GAPS[1]! }], me);
    setGaps(id, [{ gap: GAPS[0]! }, { gap: GAPS[1]!, settled: 'Reused the list wording' }], me);
    const gaps = detail(id).item.known_gaps!;
    expect(gaps.gaps.map((g) => g.settled)).toEqual(['Three retries', 'Reused the list wording']);
    expect(gaps.open).toBe(0);
    expect(gaps.approved).not.toBeNull();
    const item = renderResult('get_item', { item: detail(id).item } as never, {
      args: { id },
      now: d.clock.now(),
    });
    expect(item).toContain('known gaps (0 open');
    expect(item).toContain('settled: Three retries');
  });

  it('moving back to Planning, or changing a gap, clears the approval', () => {
    const id = create('Task');
    setGaps(
      id,
      GAPS.map((gap) => ({ gap })),
    );
    proposeReady(id);
    answer(id, GAP_APPROVE_OPTION);
    d.write(OWNER, (w, s) =>
      s.items.ownerPatch(w, { id, expected_version: version(id), status: 'planning' }),
    );
    expect(detail(id).item.known_gaps!.approved).toBeNull();
    d.fails(planner, (w, s) => s.items.setStatus(w, { id, status: 'ready' }), 'forbidden');
  });

  it('a gapped ticket counts as unshaped for its epic until it is Ready', () => {
    const { epic, tickets } = epicWith('ready', 'planning');
    setGaps(
      tickets[0]!,
      GAPS.map((gap) => ({ gap })),
    );
    d.fails(worker, (w, s) => s.runs.claim(w, { id: epic }), 'epic_not_ready');
    proposeReady(tickets[0]!);
    answer(tickets[0]!, GAP_APPROVE_OPTION);
    claim(epic);
    expect(status(epic)).toBe('progress');
  });
});

/**
 * Questions and owner notes (BUILD_SPEC §5.7; MCP_SPEC §3.2, §5.7; tasks.md
 * T117): exactly-once delivery of answers and notes, one open question per
 * item, and the asking run going to `needs_input` and back to `open` when
 * the answer is read.
 *
 * Delivery is what the `get_item` MCP handler does: the items service says
 * what it showed, and B9's `messages.markDelivered` marks exactly that.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { In } from '../../src/domain/contracts.js';
import { undoMutation } from '../../src/domain/undo.js';
import { OWNER_ACTOR, type Actor, type WriteContext } from '../../src/domain/write.js';
import type { Services } from '../../src/domain/contracts.js';
import { startDomain, type Domain } from '../us1-helpers.js';
import { askForm } from '../helpers.js';

let d: Domain;
beforeEach(() => {
  d = startDomain();
});
afterEach(() => d.cleanup());

type RunRow = { id: string; state: string; client: string; end_reason: string | null };
type QuestionRow = {
  id: string;
  item_id: string;
  run_id: string | null;
  text: string;
  asked_by: string;
  answer: string | null;
  answered_at: string | null;
  read_by_agent_at: string | null;
};

const run = (id: string) => d.row<RunRow>('SELECT * FROM runs WHERE id = ?', id);
const question = (id: string) => d.row<QuestionRow>('SELECT * FROM questions WHERE id = ?', id);
const eventsOf = (type: string) =>
  d.rows<{ type: string; summary: string; inverse: string | null; data: string }>(
    'SELECT type, summary, inverse, data FROM events WHERE type = ? ORDER BY seq',
    type,
  );

/** What the get_item MCP handler does (server/src/mcp/tools/read.ts). */
function getItem(args: Partial<In<'get_item'>> & { id: string }, actor = d.agent('codex')) {
  const r = d.read(actor);
  const { item, delivery } = d.services.items.get(r, args as In<'get_item'>);
  if (delivery) d.services.messages.markDelivered(r, delivery);
  return item;
}

/** An owner mutation through the write path; returns its result and mutation ID. */
function owner<T>(fn: (w: WriteContext, s: Services) => T) {
  return d.server.runtime.write.run({ actor: OWNER_ACTOR, operation: 'test', args: {} }, (w) =>
    fn(w, d.services),
  );
}

/** A fresh lead on RCP-17 (Ready, unblocked and unclaimed in the seed) for `client`. */
function claim(client = 'claude'): { runId: string; actor: Actor } {
  const actor = d.agent(client);
  const { run_id } = d.write(actor, (w, s) =>
    s.runs.claim(w, { id: 'RCP-17', agent_label: 'orca-w5' } as In<'claim_lead'>),
  );
  return { runId: run_id, actor: { ...actor, run_id } };
}

function ask(actor: Actor, id: string, text: string) {
  return d.write(actor, (w, s) =>
    s.messages.askOwner(w, {
      id,
      ...askForm(text),
      run_id: actor.run_id ?? undefined,
    }),
  );
}

const answer = (id: string, questionId: string, text: string) =>
  owner((w, s) => s.messages.answer(w, { id, question_id: questionId, text }));

describe('ask_owner', () => {
  it('creates an open question and puts the asking run in needs_input', () => {
    const { runId, actor } = claim();
    const { question_id } = ask(actor, 'RCP-17', 'Per serving or per 100 g?');
    expect(question_id).toMatch(/^q_/);
    expect(question(question_id)).toMatchObject({
      item_id: 'RCP-17',
      run_id: runId,
      text: 'Per serving or per 100 g?',
      asked_by: 'claude · orca-w5',
      answer: null,
      answered_at: null,
    });
    expect(run(runId).state).toBe('needs_input');
    const asked = eventsOf('question.asked').at(-1);
    expect(asked!.summary).toBe('claude · orca-w5 asks: “Per serving or per 100 g?”');
    // An agent's question is not something the owner undoes.
    expect(asked!.inverse).toBeNull();
    // It is for the owner now: Needs you lists it.
    const needs = d.services.views.needsYou(d.read(OWNER_ACTOR), { scope: 'all' } as never);
    expect(needs.for_you_now).toContainEqual(
      expect.objectContaining({ kind: 'question', item_id: 'RCP-17', question_id }),
    );
  });

  it('without run_id, the caller’s own lead on the item goes to needs_input', () => {
    const { runId } = claim('claude');
    ask(d.agent('claude'), 'RCP-17', 'Which unit?');
    expect(run(runId).state).toBe('needs_input');
  });

  it('another agent asking leaves the lead’s run alone', () => {
    const { runId } = claim('claude');
    const { question_id } = ask(d.agent('codex'), 'RCP-17', 'Is this still wanted?');
    expect(question(question_id).run_id).toBeNull();
    expect(run(runId).state).toBe('open');
  });

  it('allows one open question per item: a second one gets validation', () => {
    const { actor } = claim();
    ask(actor, 'RCP-17', 'First?');
    const err = d.fails(
      actor,
      (w, s) => s.messages.askOwner(w, { id: 'RCP-17', ...askForm('Second?') }),
      'validation',
    );
    expect(err.message).toBe(
      'RCP-17 already has an open question: “First?”. Wait for the answer in get_item (open_question).',
    );
    expect(
      d.row<{ n: number }>("SELECT count(*) AS n FROM questions WHERE item_id = 'RCP-17'").n,
    ).toBe(1);
  });

  it('the seeded DOC-4 question is open, so asking on DOC-4 is refused until it is answered', () => {
    d.fails(
      d.agent('codex'),
      (w, s) => s.messages.askOwner(w, { id: 'DOC-4', ...askForm('Another?') }),
      'validation',
    );
    const q = d.row<QuestionRow>("SELECT * FROM questions WHERE item_id = 'DOC-4'");
    answer('DOC-4', q.id, 'Per serving; put 100 g in a footnote.');
    // Answered and read: a new question may be asked.
    getItem({ id: 'DOC-4' });
    expect(ask(d.agent('codex'), 'DOC-4', 'And for drinks?').question_id).toMatch(/^q_/);
  });

  it('asking again while an answer is unread gets validation; after get_item delivers it, asking works', () => {
    const { actor } = claim();
    const { question_id } = ask(actor, 'RCP-17', 'Which unit?');
    answer('RCP-17', question_id, 'Grams.');
    const err = d.fails(
      actor,
      (w, s) => s.messages.askOwner(w, { id: 'RCP-17', ...askForm('And volumes?') }),
      'validation',
    );
    expect(err.message).toBe("RCP-17 has an answer you haven't read. Call get_item first.");
    expect(err.details).toEqual({ question_id });
    // Summary and get_context don't deliver, so they don't unlock it either.
    getItem({ id: 'RCP-17', view: 'summary' }, actor);
    d.fails(
      actor,
      (w, s) => s.messages.askOwner(w, { id: 'RCP-17', ...askForm('And volumes?') }),
      'validation',
    );
    expect(
      d.row<{ n: number }>("SELECT count(*) AS n FROM questions WHERE item_id = 'RCP-17'").n,
    ).toBe(1);
    // Delivered: the answer was read, and the next question goes through.
    expect(getItem({ id: 'RCP-17' }, actor).open_question?.answer).toBe('Grams.');
    expect(ask(actor, 'RCP-17', 'And volumes?').question_id).toMatch(/^q_/);
    expect(getItem({ id: 'RCP-17' }, actor).open_question).toMatchObject({
      text: 'And volumes?',
      answer: null,
    });
  });

  it('a run that has ended gets conflict, and nothing is stored', () => {
    const { runId, actor } = claim();
    d.write(actor, (w, s) =>
      s.runs.finish(w, { run_id: runId, result: 'finished', summary: 'Done.' } as In<'finish_run'>),
    );
    const err = d.fails(
      actor,
      (w, s) => s.messages.askOwner(w, { id: 'RCP-17', ...askForm('Late?') }),
      'conflict',
    );
    expect(err.message).toContain(`Run ${runId} has ended (finished).`);
    expect(
      d.row<{ n: number }>("SELECT count(*) AS n FROM questions WHERE item_id = 'RCP-17'").n,
    ).toBe(0);
  });

  it('an unknown item is not_found', () => {
    d.fails(
      d.agent('codex'),
      (w, s) => s.messages.askOwner(w, { id: 'RCP-99', ...askForm('Hello?') }),
      'not_found',
    );
  });
});

describe('answering', () => {
  it('records the answer as the owner’s; the run stays needs_input until the agent reads it', () => {
    const { runId, actor } = claim();
    const { question_id } = ask(actor, 'RCP-17', 'Which unit?');
    const { result } = answer('RCP-17', question_id, 'Grams.');
    expect(result).toMatchObject({
      id: question_id,
      answer: 'Grams.',
      answered_at: d.clock.now().toISOString(),
    });
    expect(run(runId).state).toBe('needs_input');
    const answered = eventsOf('question.answered').at(-1);
    expect(answered!.summary).toBe('You answered claude · orca-w5: “Grams.”');
    // No longer in Needs you.
    const needs = d.services.views.needsYou(d.read(OWNER_ACTOR), { scope: 'all' } as never);
    expect(needs.for_you_now.some((r) => r.kind === 'question' && r.item_id === 'RCP-17')).toBe(
      false,
    );
  });

  it('is undoable: undo puts the question back to open', () => {
    const { actor } = claim();
    const { question_id } = ask(actor, 'RCP-17', 'Which unit?');
    const { mutation_id } = answer('RCP-17', question_id, 'Grams.');
    undoMutation(d.server.runtime.write, mutation_id);
    expect(question(question_id)).toMatchObject({ answer: null, answered_at: null });
  });

  it('an already answered question gets conflict', () => {
    const { actor } = claim();
    const { question_id } = ask(actor, 'RCP-17', 'Which unit?');
    answer('RCP-17', question_id, 'Grams.');
    d.fails(
      OWNER_ACTOR,
      (w, s) => s.messages.answer(w, { id: 'RCP-17', question_id, text: 'Ounces.' }),
      'conflict',
    );
    expect(question(question_id).answer).toBe('Grams.');
  });

  it('a question on another item, or an unknown one, is not_found', () => {
    const { actor } = claim();
    const { question_id } = ask(actor, 'RCP-17', 'Which unit?');
    d.fails(
      OWNER_ACTOR,
      (w, s) => s.messages.answer(w, { id: 'RCP-14', question_id, text: 'Grams.' }),
      'not_found',
    );
    d.fails(
      OWNER_ACTOR,
      (w, s) => s.messages.answer(w, { id: 'RCP-17', question_id: 'q_nope', text: 'Grams.' }),
      'not_found',
    );
  });
});

describe('delivery of an answer: exactly once, and the run back to open', () => {
  function answered() {
    const c = claim();
    const { question_id } = ask(c.actor, 'RCP-17', 'Which unit?');
    answer('RCP-17', question_id, 'Grams.');
    return { ...c, question_id };
  }

  it('get_item (standard) delivers it once; the run goes back to open', () => {
    const { runId, actor, question_id } = answered();
    const first = getItem({ id: 'RCP-17' }, actor);
    expect(first.open_question).toMatchObject({ id: question_id, answer: 'Grams.' });
    expect(question(question_id).read_by_agent_at).toBe(d.clock.now().toISOString());
    expect(run(runId).state).toBe('open');
    // Delivered: the next read has no open question.
    expect(getItem({ id: 'RCP-17' }, actor).open_question).toBeNull();
  });

  it('the full view delivers too', () => {
    const { runId, question_id } = answered();
    expect(getItem({ id: 'RCP-17', view: 'full' }).open_question?.id).toBe(question_id);
    expect(run(runId).state).toBe('open');
    expect(getItem({ id: 'RCP-17', view: 'full' }).open_question).toBeNull();
  });

  it('the summary view and get_context deliver nothing', () => {
    const { runId, question_id } = answered();
    expect(getItem({ id: 'RCP-17', view: 'summary' }).has_open_question).toBe(true);
    d.services.context.getContext(d.read(d.agent('claude')), { id: 'RCP-17' } as In<'get_context'>);
    expect(question(question_id).read_by_agent_at).toBeNull();
    expect(run(runId).state).toBe('needs_input');
    expect(getItem({ id: 'RCP-17' }).open_question?.answer).toBe('Grams.');
  });

  it('fields without open_question deliver nothing', () => {
    const { question_id } = answered();
    getItem({ id: 'RCP-17', fields: ['status'] as never });
    expect(question(question_id).read_by_agent_at).toBeNull();
  });

  it('an unanswered question is shown but not delivered, and the run stays needs_input', () => {
    const { runId, actor } = claim();
    const { question_id } = ask(actor, 'RCP-17', 'Which unit?');
    expect(getItem({ id: 'RCP-17' }, actor).open_question).toMatchObject({
      id: question_id,
      answer: null,
    });
    expect(getItem({ id: 'RCP-17' }, actor).open_question?.id).toBe(question_id);
    expect(question(question_id).read_by_agent_at).toBeNull();
    expect(run(runId).state).toBe('needs_input');
  });

  it('the item page says the answer is unread until it is delivered', () => {
    const { actor } = answered();
    const page = () => d.services.views.itemDetail(d.read(OWNER_ACTOR), { id: 'RCP-17' } as never);
    expect(page().answer_unread).toBe(true);
    getItem({ id: 'RCP-17' }, actor);
    expect(page().answer_unread).toBe(false);
  });
});

describe('owner notes: delivered exactly once', () => {
  const addNote = (id: string, text: string) =>
    owner((w, s) => s.messages.addOwnerNote(w, { id, text }));

  it('a note is stored, recorded as the owner’s, and listed under unread_owner_notes once', () => {
    const { result } = addNote('RCP-14', 'Use the metric units table.');
    expect(result).toEqual({
      id: expect.stringMatching(/^note_/),
      text: 'Use the metric units table.',
      at: d.clock.now().toISOString(),
    });
    const added = eventsOf('owner_note.added').at(-1);
    expect(added!.summary).toBe('You left a note: Use the metric units table.');
    expect(getItem({ id: 'RCP-14' }).unread_owner_notes).toEqual([
      { id: result.id, text: 'Use the metric units table.', at: result.at },
    ]);
    expect(getItem({ id: 'RCP-14' }).unread_owner_notes).toEqual([]);
  });

  it('two notes come in order, together, once', () => {
    addNote('RCP-14', 'First.');
    d.clock.advance(1000);
    addNote('RCP-14', 'Second.');
    expect(getItem({ id: 'RCP-14', view: 'full' }).unread_owner_notes!.map((n) => n.text)).toEqual([
      'First.',
      'Second.',
    ]);
    expect(getItem({ id: 'RCP-14', view: 'full' }).unread_owner_notes).toEqual([]);
  });

  it('summary only counts them; get_context neither lists nor delivers them', () => {
    addNote('RCP-14', 'Check the units.');
    expect(getItem({ id: 'RCP-14', view: 'summary' }).unread_owner_notes_count).toBe(1);
    d.services.context.getContext(d.read(d.agent('claude')), { id: 'RCP-14' } as In<'get_context'>);
    expect(getItem({ id: 'RCP-14', view: 'summary' }).unread_owner_notes_count).toBe(1);
    expect(getItem({ id: 'RCP-14' }).unread_owner_notes).toHaveLength(1);
    expect(getItem({ id: 'RCP-14', view: 'summary' }).unread_owner_notes_count).toBe(0);
  });

  it('is undoable before it is read', () => {
    const { result, mutation_id } = addNote('RCP-14', 'Oops.');
    undoMutation(d.server.runtime.write, mutation_id);
    expect(d.rows('SELECT id FROM owner_notes WHERE id = ?', result.id)).toEqual([]);
    expect(getItem({ id: 'RCP-14' }).unread_owner_notes).toEqual([]);
  });

  it('an unknown item is not_found', () => {
    d.fails(
      OWNER_ACTOR,
      (w, s) => s.messages.addOwnerNote(w, { id: 'RCP-99', text: 'Hi.' }),
      'not_found',
    );
  });

  it('secret-looking text is rejected and nothing is stored', () => {
    expect(() =>
      d.server.runtime.write.run(
        {
          actor: OWNER_ACTOR,
          operation: 'items.addNote',
          args: { text: 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789' },
        },
        (w) =>
          d.services.messages.addOwnerNote(w, {
            id: 'RCP-14',
            text: 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789',
          }),
      ),
    ).toThrow(/secret/i);
    expect(
      d.row<{ n: number }>("SELECT count(*) AS n FROM owner_notes WHERE item_id = 'RCP-14'").n,
    ).toBe(0);
  });
});

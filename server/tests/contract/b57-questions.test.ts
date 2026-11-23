/**
 * Questions the owner can read (owner decision 47; MCP_SPEC §5.7), over MCP
 * and the UI API: the old call teaches the new shape, the one-open-question
 * rule holds, and the answer reaches text-only and structured clients, once.
 * All content is synthetic.
 */
import { TOOL_DESCRIPTIONS, getTool, inputJsonSchema } from '@docket/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { askForm } from '../helpers.js';
import { ORIGIN, parseSetCookies } from '../integration/harness.js';
import {
  PRODUCT_RESULT_MODES,
  expectOk,
  expectValidation,
  startHarness,
  textOf,
  tokens,
  type ContractHarness,
} from './harness.js';

let h: ContractHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

type S = Record<string, unknown>;

const RUN_ID = /\brun_(?!id\b)[0-9A-Za-z]+/;
const QUESTION_ID = /\bq_[0-9A-Za-z]+/;

async function ownerApi(harness: ContractHarness) {
  const app = harness.server.app;
  const req = (path: string, init?: RequestInit) =>
    Promise.resolve(app.request(`${ORIGIN}${path}`, init));
  const res = await req('/api/session/unlock', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: harness.server.runtime.secrets.ownerKey() }),
  });
  const cookies = parseSetCookies(res);
  const cookie = `docket_owner=${cookies.docket_owner!.value}; docket_csrf=${cookies.docket_csrf!.value}`;
  return async (method: string, path: string, body?: unknown) => {
    const r = await req(path, {
      method,
      headers: {
        cookie,
        ...(method === 'GET' ? {} : { 'x-docket-csrf': cookies.docket_csrf!.value }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    return { status: r.status, body: (text ? JSON.parse(text) : {}) as S };
  };
}

async function ask(harness: ContractHarness, id = 'RCP-17') {
  // A text-only client has no structured result, so the IDs come from the text block.
  const claim = await harness.call('claim_lead', { id, agent_label: 'orca-w3' });
  expect(claim.isError ?? false, textOf(claim)).toBe(false);
  const runId = RUN_ID.exec(textOf(claim))![0];
  const asked = await harness.call('ask_owner', {
    id,
    run_id: runId,
    ...askForm('Should recipe cards show nutrition per serving?'),
    details: 'Follows dec_01ABC; see server/src/domain/nutrition.ts.',
  });
  expect(asked.isError ?? false, textOf(asked)).toBe(false);
  return { runId, questionId: QUESTION_ID.exec(textOf(asked))![0] };
}

const questionOf = (s: S) =>
  (s.item as { open_question: S | null }).open_question as S & {
    answer: string | null;
    choice?: { option: string; recommended: boolean; note: string | null };
  };

describe('ask_owner (decision 47)', () => {
  it('the old single-text call gets a validation error that teaches the new shape', async () => {
    h = await startHarness();
    const res = await h.call('ask_owner', { id: 'RCP-17', question: 'Per serving or per 100 g?' });
    const err = expectValidation(res);
    for (const word of ['context', 'why_it_matters', 'options', 'recommendation_reason']) {
      expect(err.message).toContain(word);
    }
    expect(textOf(res)).toContain('recommended: true on exactly one');
  });

  it('refuses internals outside details, saying which field and what to do', async () => {
    h = await startHarness();
    const err = expectValidation(
      await h.call('ask_owner', {
        id: 'RCP-17',
        ...askForm('Should we follow dec_01ABC here?'),
      }),
    );
    expect(err.message).toContain('question contains "dec_01ABC"');
    expect(err.message).toContain('move IDs, hashes, paths and links to details');
  });

  it('keeps the one-open-question rule', async () => {
    h = await startHarness();
    const { runId } = await ask(h);
    const err = expectValidation(
      await h.call('ask_owner', { id: 'RCP-17', run_id: runId, ...askForm('And for drinks?') }),
    );
    expect(err.message).toContain('already has an open question');
  });

  it('Needs you and the item carry the form; an older question has none', async () => {
    h = await startHarness();
    const { questionId } = await ask(h);
    const owner = await ownerApi(h);
    const needs = (await owner('GET', '/api/needs-you')).body.for_you_now as (S & {
      form?: { options: { label: string }[]; details: string | null } | null;
    })[];
    const row = needs.find((r) => r.question_id === questionId)!;
    expect(row.form!.options.map((o) => o.label)).toEqual(['Per serving', 'Per 100 g']);
    expect(row.form!.details).toContain('dec_01ABC');
    // DOC-4's seeded question predates the contract.
    expect(needs.find((r) => r.item_id === 'DOC-4')!.form).toBeNull();
    const item = (await owner('GET', '/api/items/RCP-17')).body;
    expect((item.question_form as { why_it_matters: string }).why_it_matters).toContain('compare');
    expect((await owner('GET', '/api/items/DOC-4')).body.question_form).toBeNull();
  });

  it('the agent form stays out of get_item, so reads cost no extra tokens', async () => {
    h = await startHarness();
    await ask(h);
    const out = expectOk(await h.call('get_item', { id: 'RCP-17' }));
    expect(questionOf(out.structured)).not.toHaveProperty('form');
    expect(out.text).not.toContain('compare recipes');
  });

  it('the tool definition stays inside its token budget', () => {
    const schema = JSON.stringify(inputJsonSchema(getTool('ask_owner')!));
    const n = tokens(`${TOOL_DESCRIPTIONS.ask_owner}${schema}`);
    console.log(`ask_owner tool definition: ${n} tokens (budget 390)`);
    expect(n).toBeLessThanOrEqual(390);
  });
});

describe('the answer (decision 47)', () => {
  it('a structured client gets the choice and readable text, once', async () => {
    h = await startHarness();
    const { runId, questionId } = await ask(h);
    const owner = await ownerApi(h);
    const answered = await owner('POST', '/api/items/RCP-17/answer', {
      question_id: questionId,
      option: 'Per serving',
      note: 'Put 100 g in a footnote.',
    });
    expect(answered.status).toBe(200);

    const got = expectOk(await h.call('get_item', { id: 'RCP-17', run_id: runId }));
    const q = questionOf(got.structured);
    expect(q.answer).toBe(
      'Chose: Per serving (the recommended option). Note: Put 100 g in a footnote.',
    );
    expect(q.choice).toEqual({
      option: 'Per serving',
      recommended: true,
      note: 'Put 100 g in a footnote.',
    });
    // Delivered once.
    const again = expectOk(await h.call('get_item', { id: 'RCP-17', run_id: runId }));
    expect(questionOf(again.structured)).toBeNull();
  });

  it('a text-only client sees the choice in the text block', async () => {
    h = await startHarness({ env: PRODUCT_RESULT_MODES });
    const { runId, questionId } = await ask(h);
    const owner = await ownerApi(h);
    await owner('POST', '/api/items/RCP-17/answer', {
      question_id: questionId,
      option: 'Per 100 g',
      note: 'People here compare recipes.',
    });
    const res = await h.call('get_item', { id: 'RCP-17', run_id: runId });
    expect(res).not.toHaveProperty('structuredContent');
    expect(textOf(res)).toContain('answer: Chose: Per 100 g. Note: People here compare recipes.');
  });

  it('a free-text answer has no choice', async () => {
    h = await startHarness();
    const { runId, questionId } = await ask(h);
    const owner = await ownerApi(h);
    await owner('POST', '/api/items/RCP-17/answer', {
      question_id: questionId,
      text: 'Show both on the detail page.',
    });
    const q = questionOf(
      expectOk(await h.call('get_item', { id: 'RCP-17', run_id: runId })).structured,
    );
    expect(q.answer).toBe('Show both on the detail page.');
    expect(q).not.toHaveProperty('choice');
  });

  it('refuses an unknown option, both forms at once, a note without an option, and neither', async () => {
    h = await startHarness();
    const { questionId } = await ask(h);
    const owner = await ownerApi(h);
    const post = (body: S) =>
      owner('POST', '/api/items/RCP-17/answer', { question_id: questionId, ...body });
    expect((await post({ option: 'Per cup' })).status).toBe(400);
    expect((await post({ option: 'Per serving', text: 'Both' })).status).toBe(400);
    expect((await post({ text: 'Mine', note: 'And a note' })).status).toBe(400);
    expect((await post({})).status).toBe(400);
  });

  it('an option on an older question is refused; its free-text answer still works', async () => {
    h = await startHarness();
    const owner = await ownerApi(h);
    const row = (
      (await owner('GET', '/api/needs-you')).body.for_you_now as (S & { question_id: string })[]
    ).find((r) => r.item_id === 'DOC-4')!;
    const bad = await owner('POST', '/api/items/DOC-4/answer', {
      question_id: row.question_id,
      option: 'Per serving',
    });
    expect(bad.status).toBe(400);
    const good = await owner('POST', '/api/items/DOC-4/answer', {
      question_id: row.question_id,
      text: 'Per serving.',
    });
    expect(good.status).toBe(200);
  });

  it('Undo clears the choice and reopens the question', async () => {
    h = await startHarness();
    const { questionId } = await ask(h);
    const owner = await ownerApi(h);
    const answered = await owner('POST', '/api/items/RCP-17/answer', {
      question_id: questionId,
      option: 'Per serving',
    });
    const undo = await owner('POST', `/api/mutations/${String(answered.body.mutation_id)}/undo`);
    expect(undo.status).toBe(200);
    const row = h.server.runtime.db.sqlite
      .prepare('SELECT answer, answer_choice, answered_at FROM questions WHERE id = ?')
      .get(questionId);
    expect(row).toEqual({ answer: null, answer_choice: null, answered_at: null });
  });
});

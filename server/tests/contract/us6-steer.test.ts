/**
 * US6 over MCP (tasks.md T118): the worked flow MCP_SPEC §7.5 (question
 * round trip), MCP_SPEC §10 test 8 (`get_item` delivers owner notes and
 * answers exactly once), and §8's owner-side effects agents should expect:
 * a released claim's old `run_id` gets `conflict` (§6), *Return to Ready*,
 * and owner-added checklist entries that agents keep and can't remove.
 * Through the official SDK client against a seeded server; the owner's side
 * goes through the UI API with an owner session, as the screens call it.
 *
 * The compact text of every step is printed (PR evidence).
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { ORIGIN, parseSetCookies } from '../integration/harness.js';
import {
  expectConflict,
  expectForbidden,
  expectOk,
  expectValidation,
  startHarness,
  textOf,
  type ContractHarness,
} from './harness.js';
import { askForm } from '../helpers.js';

let h: ContractHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const transcript: string[] = [];
afterAll(() => {
  if (transcript.length > 0) console.log(transcript.join('\n'));
});

type S = Record<string, unknown>;
type Client = ContractHarness['a'];

async function step(name: string, args: S, client: Client = h!.a) {
  const res = await h!.call(name, args, client);
  const out = expectOk(res);
  transcript.push(`> ${name} ${JSON.stringify(args)}`, out.text, '');
  return out;
}

async function fails(name: string, args: S, client: Client = h!.a): Promise<CallToolResult> {
  const res = await h!.call(name, args, client);
  transcript.push(`> ${name} ${JSON.stringify(args)}`, textOf(res), '');
  return res;
}

/** An owner session on the harness app, and a JSON request helper. */
async function ownerApi() {
  const app = h!.server.app;
  const req = (path: string, init?: RequestInit) =>
    Promise.resolve(app.request(`${ORIGIN}${path}`, init));
  const res = await req('/api/session/unlock', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: h!.server.runtime.secrets.ownerKey() }),
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
    transcript.push(
      `owner ${method} ${path} ${body === undefined ? '' : JSON.stringify(body)}`.trim(),
      `→ ${r.status}`,
      '',
    );
    return { status: r.status, body: (text ? JSON.parse(text) : {}) as S };
  };
}

const sql = () => h!.server.runtime.db.sqlite;
const leadRunId = (item: string) =>
  (
    sql()
      .prepare(
        'SELECT id FROM runs WHERE item_id = ? AND is_lead = 1 ORDER BY created_at DESC, id DESC LIMIT 1',
      )
      .get(item) as { id: string }
  ).id;
const runState = (id: string) =>
  (sql().prepare('SELECT state FROM runs WHERE id = ?').get(id) as { state: string }).state;

type Question = { id: string; text: string; answer: string | null } | null;
const openQuestion = (s: S) => (s.item as { open_question: Question }).open_question;
const forYou = (body: S) =>
  body.for_you_now as { kind: string; item_id: string; question_id?: string; text?: string }[];

describe('flow §7.5: question round trip', () => {
  it('runs end to end: ask, needs input, the owner answers, get_item delivers the answer once', async () => {
    h = await startHarness();
    const owner = await ownerApi();
    const codex = h.b;
    const runId = leadRunId('DOC-4');

    // The seed already has codex's open question on DOC-4: one open question per item.
    const seeded = (await owner('GET', '/api/needs-you?scope=all')).body;
    const q0 = forYou(seeded).find((r) => r.kind === 'question' && r.item_id === 'DOC-4')!;
    expect(q0).toBeDefined();
    expectValidation(
      await fails(
        'ask_owner',
        { id: 'DOC-4', run_id: runId, ...askForm('Another question?') },
        codex,
      ),
    );
    expect(runState(runId)).toBe('needs_input');
    expect(
      (
        await owner('POST', '/api/items/DOC-4/answer', {
          question_id: q0.question_id,
          text: 'Per serving.',
        })
      ).status,
    ).toBe(200);
    // Reading it puts the run back to open.
    const read0 = await step('get_item', { id: 'DOC-4', run_id: runId }, codex);
    expect(openQuestion(read0.structured)?.answer).toBe('Per serving.');
    expect(runState(runId)).toBe('open');

    // ---- MCP_SPEC §7.5, as written ----
    const asked = await step(
      'ask_owner',
      {
        id: 'DOC-4',
        run_id: runId,
        ...askForm('Should nutrition be documented per serving or per 100 g?'),
      },
      codex,
    );
    const questionId = asked.structured.question_id as string;
    expect(questionId).toMatch(/^q_/);
    expect(asked.text).toBe(`Asked the owner on DOC-4 · ${questionId} · your run needs input`);
    expect(runState(runId)).toBe('needs_input');
    // The run shows as needs input; a second question while it is open is refused.
    const summary = await step('get_item', { id: 'DOC-4', view: 'summary' }, codex);
    expect((summary.structured.item as { lead: { run_state: string } }).lead.run_state).toBe(
      'needs_input',
    );
    expectValidation(
      await fails('ask_owner', { id: 'DOC-4', run_id: runId, ...askForm('Also: units?') }, codex),
    );
    await step(
      'finish_run',
      {
        run_id: runId,
        result: 'finished',
        summary: 'Waiting on the owner: per serving vs per 100 g.',
      },
      codex,
    );

    // Before the answer: the newest change cursor.
    const before = await step('get_changes', { item_id: 'DOC-4', limit: 1 }, codex);
    const cursor = before.structured.next_cursor as string;

    //   (the owner: it's in Needs you, answered inline)
    const needs = (await owner('GET', '/api/needs-you?scope=all')).body;
    expect(forYou(needs)).toContainEqual(
      expect.objectContaining({ kind: 'question', item_id: 'DOC-4', question_id: questionId }),
    );
    const answered = await owner('POST', '/api/items/DOC-4/answer', {
      question_id: questionId,
      text: 'Per serving; put 100 g in a footnote.',
    });
    expect(answered.status).toBe(200);
    expect(answered.body).toMatchObject({
      question: { id: questionId, answer: 'Per serving; put 100 g in a footnote.' },
      mutation_id: expect.any(String),
    });
    const page = (await owner('GET', '/api/items/DOC-4')).body;
    expect(page.answer_unread).toBe(true);

    //   (later)
    const changes = await step(
      'get_changes',
      { cursor, item_id: 'DOC-4', types: ['question.answered'] },
      codex,
    );
    expect(changes.structured.events as unknown[]).toHaveLength(1);
    const got = await step('get_item', { id: 'DOC-4' }, codex);
    expect(openQuestion(got.structured)).toMatchObject({
      id: questionId,
      answer: 'Per serving; put 100 g in a footnote.',
    });
    expect(got.text).toContain('Per serving; put 100 g in a footnote.');
    // Now marked read: delivered exactly once.
    expect(openQuestion((await step('get_item', { id: 'DOC-4' }, codex)).structured)).toBeNull();
    expect((await owner('GET', '/api/items/DOC-4')).body.answer_unread).toBe(false);
  });

  it("undoing an answer works until the agent reads it; after that it's refused with conflict", async () => {
    h = await startHarness();
    const owner = await ownerApi();
    const claimed = await step('claim_lead', { id: 'RCP-17', agent_label: 'orca-w3' });
    const runId = claimed.structured.run_id as string;
    const ask = async (question: string) =>
      (await step('ask_owner', { id: 'RCP-17', run_id: runId, ...askForm(question) })).structured
        .question_id as string;

    // Unread: undo takes the answer back, and the question is open again.
    const q1 = await ask('Keep the week in the URL or in local storage?');
    const first = await owner('POST', '/api/items/RCP-17/answer', {
      question_id: q1,
      text: 'In the URL.',
    });
    const undone = await owner('POST', `/api/mutations/${first.body.mutation_id as string}/undo`);
    expect(undone.status).toBe(200);
    expect((await owner('GET', '/api/items/RCP-17')).body.answer_unread).toBe(false);

    // Read by the agent: the undo is refused, and the answer stays.
    const second = await owner('POST', '/api/items/RCP-17/answer', {
      question_id: q1,
      text: 'In local storage.',
    });
    const got = await step('get_item', { id: 'RCP-17', run_id: runId });
    expect(openQuestion(got.structured)?.answer).toBe('In local storage.');
    const refused = await owner('POST', `/api/mutations/${second.body.mutation_id as string}/undo`);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      error: {
        code: 'conflict',
        message: 'The agent already read this answer; leave a note instead.',
      },
    });
  });

  it('a lead that asks goes to needs input, and back to open when get_item delivers the answer', async () => {
    h = await startHarness();
    const owner = await ownerApi();
    const claimed = await step('claim_lead', { id: 'RCP-17', agent_label: 'orca-w3' });
    const runId = claimed.structured.run_id as string;
    const { structured } = await step('ask_owner', {
      id: 'RCP-17',
      run_id: runId,
      ...askForm('Keep the week in the URL or in local storage?'),
    });
    expect(runState(runId)).toBe('needs_input');
    await owner('POST', '/api/items/RCP-17/answer', {
      question_id: structured.question_id,
      text: 'In the URL.',
    });
    // Answered but unread: still needs input. Summary and get_context don't deliver.
    expect(runState(runId)).toBe('needs_input');
    await step('get_item', { id: 'RCP-17', view: 'summary', run_id: runId });
    await step('get_context', { id: 'RCP-17', run_id: runId });
    expect(runState(runId)).toBe('needs_input');
    const got = await step('get_item', { id: 'RCP-17', run_id: runId });
    expect(openQuestion(got.structured)?.answer).toBe('In the URL.');
    expect(runState(runId)).toBe('open');
  });

  it('asking again while an answer is unread gets validation; after get_item delivers it, asking works', async () => {
    h = await startHarness();
    const owner = await ownerApi();
    const claimed = await step('claim_lead', { id: 'RCP-17', agent_label: 'orca-w3' });
    const runId = claimed.structured.run_id as string;
    const first = await step('ask_owner', {
      id: 'RCP-17',
      run_id: runId,
      ...askForm('Keep the week in the URL or in local storage?'),
    });
    await owner('POST', '/api/items/RCP-17/answer', {
      question_id: first.structured.question_id,
      text: 'In the URL.',
    });
    const refused = expectValidation(
      await fails('ask_owner', { id: 'RCP-17', run_id: runId, ...askForm('And the day too?') }),
    );
    expect(refused.message).toBe("RCP-17 has an answer you haven't read. Call get_item first.");
    expect(refused.details).toEqual({ question_id: first.structured.question_id });
    // Summary doesn't deliver, so it doesn't unlock asking either.
    await step('get_item', { id: 'RCP-17', view: 'summary', run_id: runId });
    expectValidation(
      await fails('ask_owner', { id: 'RCP-17', run_id: runId, ...askForm('And the day too?') }),
    );

    const got = await step('get_item', { id: 'RCP-17', run_id: runId });
    expect(openQuestion(got.structured)?.answer).toBe('In the URL.');
    const again = await step('ask_owner', {
      id: 'RCP-17',
      run_id: runId,
      ...askForm('And the day too?'),
    });
    expect(again.structured.question_id).not.toBe(first.structured.question_id);
    expect(runState(runId)).toBe('needs_input');
    const needs = (await owner('GET', '/api/needs-you?scope=all')).body;
    expect(forYou(needs)).toContainEqual(
      expect.objectContaining({ kind: 'question', item_id: 'RCP-17', text: 'And the day too?' }),
    );
  });
});

describe('owner notes (MCP_SPEC §10 test 8)', () => {
  it('a note is delivered once by get_item, never by summary or get_context', async () => {
    h = await startHarness();
    const owner = await ownerApi();
    const added = await owner('POST', '/api/items/RCP-14/notes', {
      text: 'Use the metric units table for the export.',
    });
    expect(added.status).toBe(200);
    expect(added.body).toMatchObject({
      note: { text: 'Use the metric units table for the export.' },
    });
    const s = await step('get_item', { id: 'RCP-14', view: 'summary' });
    expect((s.structured.item as S).unread_owner_notes_count).toBe(1);
    await step('get_context', { id: 'RCP-14' });
    const got = await step('get_item', { id: 'RCP-14' });
    expect(
      (got.structured.item as { unread_owner_notes: { text: string }[] }).unread_owner_notes,
    ).toEqual([expect.objectContaining({ text: 'Use the metric units table for the export.' })]);
    expect(got.text).toContain('Use the metric units table for the export.');
    const again = await step('get_item', { id: 'RCP-14' });
    expect((again.structured.item as { unread_owner_notes: unknown[] }).unread_owner_notes).toEqual(
      [],
    );
  });
});

describe('the owner releases a stale claim (§5.3; MCP_SPEC §6, §8)', () => {
  it('the old run_id gets conflict with the current state; the item is Ready and claimable', async () => {
    h = await startHarness();
    const owner = await ownerApi();
    const codex = h.b;
    const oldRun = leadRunId('RCP-15');
    const step1 = (
      sql()
        .prepare("SELECT id FROM work_steps WHERE item_id = 'RCP-15' AND state = 'current' LIMIT 1")
        .get() as { id: string }
    ).id;
    const released = await owner('POST', '/api/items/RCP-15/release', {});
    expect(released.status).toBe(200);
    expect(released.body).toMatchObject({
      item: { id: 'RCP-15', status: 'ready', lead: null },
      mutation_id: expect.any(String),
    });

    // codex comes back: every call naming the old run is refused with the current state.
    const hb = expectConflict(await fails('heartbeat', { run_id: oldRun }, codex));
    expect(hb.current).toMatchObject({
      run_id: oldRun,
      state: 'interrupted',
      end_reason: 'owner_released',
      item_status: 'ready',
    });
    expect(hb.message).toBe(
      `Run ${oldRun} has ended (owner released). Stop work on it; claim the item again with claim_lead if it is free.`,
    );
    expectConflict(
      await fails(
        'update_step',
        { id: 'RCP-15', run_id: oldRun, step_id: step1, state: 'done' },
        codex,
      ),
    );
    expectConflict(
      await fails('finish_run', { run_id: oldRun, result: 'finished', summary: 'Done.' }, codex),
    );
    // The plan is kept; another agent can claim it now.
    const item = await step('get_item', { id: 'RCP-15' });
    expect((item.structured.item as { checklist: { work: unknown[] } }).checklist.work.length).toBe(
      3,
    );
    await step('claim_lead', { id: 'RCP-15', agent_label: 'orca-w2' });
    // After the new claim, the old run still gets conflict, naming the new lead.
    const after = expectConflict(await fails('heartbeat', { run_id: oldRun }, codex));
    expect(after.message).toContain('RCP-15 is now led by claude · orca-w2.');
  });

  it('undo restores the status, not the run', async () => {
    h = await startHarness();
    const owner = await ownerApi();
    const oldRun = leadRunId('RCP-15');
    const released = await owner('POST', '/api/items/RCP-15/release', {});
    const undo = await owner('POST', `/api/mutations/${released.body.mutation_id as string}/undo`);
    expect(undo.status).toBe(200);
    const item = await step('get_item', { id: 'RCP-15', view: 'summary' });
    expect(item.structured.item).toMatchObject({ status: 'progress', lead: null });
    expectConflict(await fails('heartbeat', { run_id: oldRun }, h.b));
    // In progress with no lead: resumable.
    const resumable = await step('search_items', { project: 'RCP', filter: 'resumable' });
    expect((resumable.structured.items as { id: string }[]).map((i) => i.id)).toContain('RCP-15');
  });
});

describe('Return to Ready after a failed run', () => {
  it('the item is unclaimed and startable again', async () => {
    h = await startHarness();
    const owner = await ownerApi();
    const { structured } = await step('claim_lead', { id: 'RCP-17' });
    await step('finish_run', {
      run_id: structured.run_id,
      result: 'failed',
      summary: 'The reload test fails.',
      error: 'Expected week 46, got 45',
    });
    const back = await owner('POST', '/api/items/RCP-17/return-to-ready', {});
    expect(back.status).toBe(200);
    expect(back.body).toMatchObject({ item: { id: 'RCP-17', status: 'ready', lead: null } });
    const ready = await step('search_items', { project: 'RCP', filter: 'ready_to_start' });
    expect((ready.structured.items as { id: string }[]).map((i) => i.id)).toContain('RCP-17');
    await step('claim_lead', { id: 'RCP-17' }, h.b);
  });
});

describe('the owner’s checklist entries (§5.5; MCP_SPEC §3.3)', () => {
  it('agents keep owner-added steps and checks through patch and replace, and get forbidden on them', async () => {
    h = await startHarness();
    const owner = await ownerApi();
    const runId = leadRunId('RCP-14');
    const step0 = await owner('POST', '/api/items/RCP-14/work', {
      text: 'Handle an empty week plan',
    });
    expect(step0.status).toBe(200);
    const stepId = (step0.body.step as { id: string; added_by: string }).id;
    expect((step0.body.step as { added_by: string }).added_by).toBe('owner');
    const check0 = await owner('POST', '/api/items/RCP-14/checks', {
      text: 'Run the full test suite on a clean checkout',
    });
    const checkId = (check0.body.check as { id: string }).id;
    const hr0 = await owner('POST', '/api/items/RCP-14/human-review', {
      text: 'Try it on your phone',
    });
    const hr = hr0.body.hr_item as { id: string; version: number };

    const replaced = await step('set_plan', {
      id: 'RCP-14',
      run_id: runId,
      reason: 'Restating the plan',
      mode: 'replace',
      steps: [{ text: 'Export as Markdown' }],
    });
    expect(
      (replaced.structured.work as { text: string; added_by: string }[]).map((s) => [
        s.text,
        s.added_by,
      ]),
    ).toEqual([
      ['Export as Markdown', 'agent'],
      ['Handle an empty week plan', 'owner'],
    ]);
    expectForbidden(
      await fails('set_plan', { id: 'RCP-14', run_id: runId, reason: 'Tidy', remove: [stepId] }),
    );
    const checks = await step('set_checks', {
      id: 'RCP-14',
      run_id: runId,
      mode: 'replace',
      checks: [{ text: 'Export opens in Notes' }],
    });
    expect((checks.structured.checks as { id: string }[]).map((c) => c.id)).toContain(checkId);
    expectForbidden(await fails('set_checks', { id: 'RCP-14', run_id: runId, remove: [checkId] }));
    expectForbidden(
      await fails('update_human_review', {
        id: 'RCP-14',
        run_id: runId,
        hr_item_id: hr.id,
        expected_version: hr.version,
        text: 'Try it on a tablet',
      }),
    );

    // The owner removes their own.
    expect((await owner('DELETE', `/api/items/RCP-14/work/${stepId}`)).status).toBe(200);
    expect((await owner('DELETE', `/api/items/RCP-14/checks/${checkId}`)).status).toBe(200);
    const after = await step('get_item', { id: 'RCP-14', fields: ['checklist'] });
    const list = (
      after.structured.item as { checklist: { work: { id: string }[]; checks: { id: string }[] } }
    ).checklist;
    expect(list.work.map((s) => s.id)).not.toContain(stepId);
    expect(list.checks.map((c) => c.id)).not.toContain(checkId);
  });
});

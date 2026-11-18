/**
 * US5 over MCP (tasks.md T112): the worked flow MCP_SPEC §7.10 (recording
 * and following decisions), MCP_SPEC §10 test 13 (scope inheritance,
 * authority, supersede and withdraw) and test 16 (`get_context` never marks
 * notes read), and the `get_context` budget (RCP-14 medium ≤ 3,000), through
 * the official SDK client against a seeded server. The owner's side
 * (record, confirm, withdraw, undo) goes through the UI API with an owner
 * session, exactly as the Decisions sections call it.
 *
 * The compact text of every step, and `get_context RCP-14` at each budget
 * with its measured tokens, is printed (PR evidence).
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { ORIGIN, parseSetCookies } from '../integration/harness.js';
import {
  expectForbidden,
  expectNotFound,
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

const transcript: string[] = [];
afterAll(() => {
  if (transcript.length > 0) console.log(transcript.join('\n'));
});

type S = Record<string, unknown>;
type Decision = { id: string; title: string; authority: string; status: string; version: number };

async function step(
  name: string,
  args: S,
  client = h!.a,
): Promise<{ structured: S; text: string }> {
  const res = await h!.call(name, args, client);
  const out = expectOk(res);
  transcript.push(`> ${name} ${JSON.stringify(args)}`, out.text, '');
  return out;
}

async function fails(name: string, args: S): Promise<CallToolResult> {
  const res = await h!.call(name, args);
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
    return { status: r.status, body: (text ? JSON.parse(text) : {}) as S };
  };
}

const decisionsOf = (s: S) => s.decisions as Decision[];
const contextDecisions = (s: S) => decisionsOf(s.context as S);

describe('flow §7.10: recording and following decisions', () => {
  it('runs end to end: follow the owner, publish for the epic, confirm, refuse changes to owner records', async () => {
    h = await startHarness();
    const owner = await ownerApi();

    // The owner has recorded a decision on RCP-16 (the flow's dec_7; not in the seed).
    const recorded = await owner('POST', '/api/decisions', {
      project: 'RCP',
      scope: { kind: 'item', id: 'RCP-16' },
      title: 'Nutrition is per serving; 100 g goes in a footnote',
      decision: 'Show nutrition per serving. Put the per-100 g values in a footnote.',
    });
    expect(recorded.status).toBe(200);
    const dec7 = recorded.body.decision as Decision;
    expect(dec7).toMatchObject({ authority: 'owner', status: 'active' });
    expect(typeof recorded.body.mutation_id).toBe('string');

    // get_context { id: "RCP-16" } → the owner's decisions, owner first.
    const ctx16 = await step('get_context', { id: 'RCP-16' });
    expect(contextDecisions(ctx16.structured).map((d) => [d.id, d.authority])).toEqual([
      [dec7.id, 'owner'],
      ['dec_1', 'owner'],
    ]);
    expect(ctx16.text).toContain(
      `${dec7.id} Nutrition is per serving; 100 g goes in a footnote (owner) · item RCP-16`,
    );
    expect(ctx16.text.split('\n')[0]).toBe(
      'Context for RCP-16 Nutrition summary card · budget medium',
    );

    // publish_decision for the epic → an agent record.
    const published = await step('publish_decision', {
      project: 'RCP',
      scope: { kind: 'epic', id: 'RCP-1' },
      title: 'Units are stored metric; convert on display',
      decision: 'Store g and ml. Convert cups and spoons on import (RCP-14) and display.',
      rationale: 'One canonical unit keeps merging simple.',
      idempotency_key: 'dec-9',
    });
    const dec9 = published.structured.decision as Decision & { author: string };
    expect(dec9).toMatchObject({ authority: 'agent', author: 'claude', status: 'active' });
    expect(published.text).toBe(
      `Published ${dec9.id} Units are stored metric; convert on display · agent`,
    );
    expect(tokens(published.text)).toBeLessThanOrEqual(60);
    // RCP-14 exists, so no warning.
    expect(published.structured.warnings).toBeUndefined();

    // Retrying with the same key replays; nothing new is stored.
    const replay = expectOk(
      await h.call('publish_decision', {
        project: 'RCP',
        scope: { kind: 'epic', id: 'RCP-1' },
        title: 'Units are stored metric; convert on display',
        decision: 'Store g and ml. Convert cups and spoons on import (RCP-14) and display.',
        rationale: 'One canonical unit keeps merging simple.',
        idempotency_key: 'dec-9',
      }),
    );
    expect(replay.structured).toMatchObject({ replayed: true, decision: { id: dec9.id } });

    // Another agent, another ticket in the epic: the decision is in its context (scenario 2).
    const ctx14 = await step('get_context', { id: 'RCP-14' }, h.b);
    expect(contextDecisions(ctx14.structured).map((d) => d.id)).toEqual(['dec_1', dec9.id]);

    // The owner sees dec_9 on RCP-1 and its tickets.
    const epic = await owner('GET', '/api/items/RCP-1');
    expect((epic.body.decisions as Decision[]).map((d) => d.id)).toContain(dec9.id);
    const ticket = await owner('GET', '/api/items/RCP-12');
    expect((ticket.body.decisions as Decision[]).map((d) => d.id)).toContain(dec9.id);
    // ...but never in Needs you (scenario 5).
    const needs = await owner('GET', '/api/needs-you?scope=RCP');
    expect(needs.status).toBe(200);
    expect(JSON.stringify(needs.body)).not.toContain(dec9.id);

    // The owner confirms it: it becomes an owner decision (scenario 4).
    const confirmed = await owner('POST', `/api/decisions/${dec9.id}/confirm`, {
      expected_version: dec9.version,
    });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.decision).toMatchObject({ authority: 'owner', author: 'claude' });
    const after = await step('get_context', { id: 'RCP-14' });
    expect(contextDecisions(after.structured).map((d) => [d.id, d.authority])).toEqual([
      [dec9.id, 'owner'],
      ['dec_1', 'owner'],
    ]);

    // Agents can't change owner decisions: supersede and withdraw are forbidden (scenario 3).
    const sup = expectForbidden(
      await fails('publish_decision', {
        project: 'RCP',
        scope: { kind: 'item', id: 'RCP-16' },
        title: 'Nutrition is per 100 g',
        decision: 'Show per 100 g.',
        supersedes: dec7.id,
      }),
    );
    expect(sup.message).toMatch(/ask_owner/);
    const wd = expectForbidden(
      await fails('withdraw_decision', { decision_id: dec9.id, reason: 'Mine.' }),
    );
    expect(wd.message).toMatch(/ask_owner/);
  });
});

describe('MCP_SPEC §10 test 13: decisions', () => {
  it('list_decisions in_scope_of inherits project → epic → label → item, owner first', async () => {
    h = await startHarness();
    await step('publish_decision', {
      project: 'RCP',
      scope: { kind: 'item', id: 'RCP-12' },
      title: 'Drop targets are at least 44 px',
      decision: 'Every drop target is at least 44 × 44 px.',
    });
    await step('publish_decision', {
      project: 'RCP',
      scope: { kind: 'project' },
      title: 'Write dates as ISO 8601',
      decision: 'Use YYYY-MM-DD everywhere.',
    });
    // RCP-12: epic RCP-1, label ui-refresh.
    const list = await step('list_decisions', { project: 'RCP', in_scope_of: 'RCP-12' });
    expect((list.structured.items as Decision[]).map((d) => d.title)).toEqual([
      'Units are metric internally; convert on display',
      'Write dates as ISO 8601',
      'Drop targets are at least 44 px',
      'Use design tokens v2 spacing (8 px grid)',
    ]);
    // RCP-14: epic RCP-1, label mobile: not the ui-refresh label or RCP-12's record.
    const list14 = await step('list_decisions', { project: 'RCP', in_scope_of: 'RCP-14' });
    expect((list14.structured.items as Decision[]).map((d) => d.title)).toEqual([
      'Units are metric internally; convert on display',
      'Write dates as ISO 8601',
    ]);
    // One scope.
    const label = await step('list_decisions', {
      project: 'RCP',
      scope: { kind: 'label', id: 'ui-refresh' },
    });
    expect((label.structured.items as Decision[]).map((d) => d.id)).toEqual(['dec_3']);
    // Pages.
    const page = await step('list_decisions', { project: 'RCP', limit: 2 });
    expect(page.structured.next_cursor).not.toBeNull();
    const rest = await step('list_decisions', {
      project: 'RCP',
      limit: 2,
      cursor: page.structured.next_cursor,
    });
    expect((rest.structured.items as Decision[]).length).toBe(2);
    expectValidation(await fails('list_decisions', { project: 'RCP', in_scope_of: 'DOC-2' }));
  });

  it('supersede and withdraw states; withdrawn records leave the context but stay readable', async () => {
    h = await startHarness();
    // dec_3 is claude's agent record on ui-refresh: codex supersedes it.
    const sup = await step(
      'publish_decision',
      {
        project: 'RCP',
        scope: { kind: 'label', id: 'ui-refresh' },
        title: 'Use design tokens v2 spacing (4 px grid)',
        decision: 'The v2 grid is 4 px.',
        supersedes: 'dec_3',
      },
      h.b,
    );
    const neu = sup.structured.decision as Decision & { supersedes_id: string };
    expect(neu).toMatchObject({ supersedes_id: 'dec_3', author: 'codex' });
    const all = await step('list_decisions', {
      project: 'RCP',
      scope: { kind: 'label', id: 'ui-refresh' },
      include_inactive: true,
    });
    expect(all.structured.items).toMatchObject([
      { id: neu.id, status: 'active' },
      { id: 'dec_3', status: 'superseded', superseded_by_id: neu.id },
    ]);
    expect(all.text).toContain(
      'dec_3 Use design tokens v2 spacing (8 px grid) (agent) · superseded · label ui-refresh',
    );

    // Withdraw the new one: it drops out of RCP-12's context, and stays in history.
    const wd = await step('withdraw_decision', {
      decision_id: neu.id,
      reason: 'The grid stays 8 px.',
    });
    expect(wd.structured.decision).toMatchObject({ status: 'withdrawn' });
    expect(tokens(wd.text)).toBeLessThanOrEqual(60);
    const ctx = await step('get_context', { id: 'RCP-12' });
    expect(contextDecisions(ctx.structured).map((d) => d.id)).not.toContain(neu.id);
    expect(contextDecisions(ctx.structured).map((d) => d.id)).not.toContain('dec_3');
    // History keeps it: the event is on the project (label scope).
    const event = h.server.runtime.db.sqlite
      .prepare("SELECT summary, project_key, item_id FROM events WHERE type = 'decision.withdrawn'")
      .get();
    expect(event).toEqual({
      summary:
        'claude withdrew a decision: Use design tokens v2 spacing (4 px grid) (The grid stays 8 px.)',
      project_key: 'RCP',
      item_id: null,
    });

    expectNotFound(await fails('withdraw_decision', { decision_id: 'dec_nope', reason: 'x' }));
    expectNotFound(
      await fails('publish_decision', {
        project: 'RCP',
        scope: { kind: 'project' },
        title: 't',
        decision: 'd',
        supersedes: 'dec_nope',
      }),
    );
    expectValidation(
      await fails('publish_decision', {
        project: 'RCP',
        scope: { kind: 'epic', id: 'DOC-2' },
        title: 't',
        decision: 'd',
      }),
    );
    expectValidation(
      await fails('publish_decision', {
        project: 'RCP',
        scope: { kind: 'item' },
        title: 't',
        decision: 'd',
      }),
    );
  });

  it('the item-reference check warns on decision text, through the write path', async () => {
    h = await startHarness();
    const res = await step('publish_decision', {
      project: 'RCP',
      scope: { kind: 'project' },
      title: 'Follow RCP-999 for units',
      decision: 'As decided in RCP-14 and RCP-998. `RCP-997` in code is fine.',
    });
    expect(res.structured.warnings).toEqual(["RCP-999 doesn't exist", "RCP-998 doesn't exist"]);
    expect(res.text).toContain("! RCP-999 doesn't exist");
  });
});

describe('the owner’s side: record, confirm, withdraw, undo', () => {
  it('records owner decisions, confirms, withdraws any record, and undoes each', async () => {
    h = await startHarness();
    const owner = await ownerApi();
    const list = async () =>
      (await owner('GET', '/api/decisions?project=RCP&include_inactive=true')).body
        .items as Decision[];
    const undo = (id: unknown) => owner('POST', `/api/mutations/${String(id)}/undo`, {});

    // Confirm dec_3 (agent) and undo it.
    const c = await owner('POST', '/api/decisions/dec_3/confirm', { expected_version: 1 });
    expect(c.body.decision).toMatchObject({ authority: 'owner' });
    expect((await undo(c.body.mutation_id)).status).toBe(200);
    expect((await list()).find((d) => d.id === 'dec_3')).toMatchObject({ authority: 'agent' });

    // Withdraw the owner's own dec_1, and undo it.
    const w = await owner('POST', '/api/decisions/dec_1/withdraw', { reason: 'Revisit.' });
    expect(w.body.decision).toMatchObject({ status: 'withdrawn' });
    expect(contextDecisions((await step('get_context', { id: 'RCP-14' })).structured)).toEqual([]);
    expect((await undo(w.body.mutation_id)).status).toBe(200);
    expect(
      contextDecisions((await step('get_context', { id: 'RCP-14' })).structured).map((d) => d.id),
    ).toEqual(['dec_1']);

    // Record on a label, and supersede it as the owner.
    const r = await owner('POST', '/api/decisions', {
      project: 'RCP',
      scope: { kind: 'label', id: 'mobile' },
      title: 'Touch targets are 44 px',
      decision: 'At least 44 × 44 px.',
      rationale: 'Apple HIG.',
    });
    expect(r.body.decision).toMatchObject({
      authority: 'owner',
      scope: { kind: 'label', id: 'mobile' },
    });
    const s = await owner('POST', '/api/decisions', {
      project: 'RCP',
      scope: { kind: 'label', id: 'mobile' },
      title: 'Touch targets are 48 px',
      decision: 'At least 48 × 48 px.',
      supersedes: (r.body.decision as Decision).id,
    });
    expect(s.status).toBe(200);
    const label = await owner(
      'GET',
      '/api/decisions?project=RCP&scope_kind=label&scope_id=mobile&include_inactive=true',
    );
    expect((label.body.items as Decision[]).map((d) => [d.title, d.status])).toEqual([
      ['Touch targets are 48 px', 'active'],
      ['Touch targets are 44 px', 'superseded'],
    ]);
    // Owner errors: a stale version is 409; an unknown record is 404.
    expect(
      (await owner('POST', '/api/decisions/dec_2/confirm', { expected_version: 9 })).status,
    ).toBe(409);
    expect((await owner('POST', '/api/decisions/dec_nope/withdraw', { reason: 'x' })).status).toBe(
      404,
    );
  });
});

describe('MCP_SPEC §10 test 16: get_context never marks notes read', () => {
  it('counts unread owner notes; get_item delivers them once', async () => {
    h = await startHarness();
    const sql = h.server.runtime.db.sqlite;
    const t = h.server.clock.now().toISOString();
    sql
      .prepare(
        `INSERT INTO owner_notes (id, item_id, text, read_by_agent_at, created_at, updated_at) VALUES ('note_x', 'RCP-14', 'Prefer metric.', NULL, ?, ?)`,
      )
      .run(t, t);
    for (const budget of ['small', 'medium', 'large']) {
      const ctx = await step('get_context', { id: 'RCP-14', budget });
      expect((ctx.structured.context as S).item).toMatchObject({ unread_owner_notes: 1 });
      expect(ctx.text).toContain('notes_unread: 1');
      expect(ctx.text).not.toContain('Prefer metric.');
    }
    expect(
      sql.prepare("SELECT read_by_agent_at FROM owner_notes WHERE id = 'note_x'").get(),
    ).toEqual({
      read_by_agent_at: null,
    });
    const item = await step('get_item', { id: 'RCP-14' });
    expect(item.text).toContain('Prefer metric.');
    const again = await step('get_context', { id: 'RCP-14' });
    expect((again.structured.context as S).item).toMatchObject({ unread_owner_notes: 0 });
    expectNotFound(await fails('get_context', { id: 'RCP-999' }));
  });
});

describe('get_context RCP-14 budgets (MCP_SPEC §3.2: medium ≤ 3,000)', () => {
  it('small, medium and large fit their budgets; the text is printed with its tokens', async () => {
    h = await startHarness();
    const limits = { small: 1_000, medium: 3_000, large: 8_000 } as const;
    const measured: string[] = ['', '| get_context RCP-14 | tokens | budget |', '|---|---:|---:|'];
    for (const budget of ['small', 'medium', 'large'] as const) {
      const res = expectOk(await h.call('get_context', { id: 'RCP-14', budget }));
      const n = tokens(res.text);
      measured.push(`| ${budget} | ${n} | ${limits[budget]} |`);
      transcript.push(
        `> get_context {"id":"RCP-14","budget":"${budget}"}  (${n} tokens)`,
        res.text,
        '',
      );
      expect(n).toBeLessThanOrEqual(limits[budget]);
      // All six parts the seed has for RCP-14 are present at every size.
      for (const head of [
        'decisions:',
        'epic RCP-1',
        'labels:',
        'blocked_by:',
        'blocks:',
        'planning_docs:',
      ]) {
        expect(res.text).toContain(head);
      }
    }
    transcript.push(measured.join('\n'), '');
  });
});

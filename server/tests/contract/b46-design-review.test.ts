/**
 * A declared change to an approved design always needs the owner (owner
 * decision 39; BUILD_SPEC §5.21 B46; FR-185–FR-187; SC-026): with or without
 * an overlap, in every Overlap handling mode. Until the owner approves it,
 * that item is paused; everything else continues.
 */
import { CSRF_HEADER_NAME, OVERLAP_HANDLING } from '@docket/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { ORIGIN, parseSetCookies } from '../integration/harness.js';
import { expectOk, expectToolError, startHarness, type ContractHarness } from './harness.js';

let h: ContractHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

type S = Record<string, unknown>;
type Review = S & { id: string; version: number; state: string; decided_by: string | null };

const sql = () => h!.server.runtime.db.sqlite;

async function owner() {
  const app = h!.server.app;
  const res = await app.request(`${ORIGIN}/api/session/unlock`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: h!.server.runtime.secrets.ownerKey() }),
  });
  const cookies = parseSetCookies(res);
  const csrf = cookies.docket_csrf!.value;
  const cookie = `docket_owner=${cookies.docket_owner!.value}; docket_csrf=${csrf}`;
  return async (method: string, path: string, body?: unknown) => {
    const r = await app.request(`${ORIGIN}${path}`, {
      method,
      headers: {
        cookie,
        ...(method === 'GET'
          ? {}
          : { 'content-type': 'application/json', [CSRF_HEADER_NAME]: csrf }),
      },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    });
    return { status: r.status, body: (await r.json()) as S };
  };
}
type Api = Awaited<ReturnType<typeof owner>>;

async function start() {
  h = await startHarness();
  const api = await owner();
  for (const key of ['model:Token', 'table:decks', 'file:src/shared.ts']) {
    expect((await api('POST', '/api/projects/RCP/shared-parts', { key })).status).toBe(200);
  }
  return api;
}

const DESIGN = 'Decision 12: tokens never expire';
const designed = (part = 'model:Token.expiresAt', note = DESIGN, change = 'change') => ({
  part,
  change,
  design_impact: 'changes_approved_design',
  design_note: note,
});
const plain = (part: string, change = 'change') => ({ part, change });

const declare = (id: string, changes: S[]) => h!.call('declare_shared_changes', { id, changes });

async function ready(title: string, changes: S[] | null) {
  const created = expectOk(
    await h!.call('create_item', { project: 'RCP', type: 'Task', title, status: 'planning' }),
  );
  const id = (created.structured.item as { id: string }).id;
  expectOk(await h!.call('declare_shared_changes', changes ? { id, changes } : { id, none: true }));
  expectOk(await h!.call('set_status', { id, status: 'ready' }));
  return id;
}

const claim = (id: string, client = h!.b) => h!.call('claim_lead', { id }, client);
const needsYou = async (api: Api) => (await api('GET', '/api/needs-you?scope=RCP')).body;
const cards = async (api: Api) => (await needsYou(api)).design_reviews as Review[];
const statusOf = (id: string) =>
  (sql().prepare('SELECT status FROM items WHERE id = ?').get(id) as { status: string }).status;
const startable = async () =>
  (
    expectOk(await h!.call('search_items', { project: 'RCP', filter: 'ready_to_start' })).structured
      .items as { id: string }[]
  ).map((i) => i.id);
const decide = (api: Api, r: Review, decision: string, note?: string) =>
  api('POST', `/api/design-reviews/${r.id}/decide`, {
    expected_version: r.version,
    decision,
    ...(note ? { note } : {}),
  });
const undo = (api: Api, id: unknown) => api('POST', `/api/mutations/${String(id)}/undo`);
const packet = (id: string) => ({
  id,
  built_from_commit: '9c0e7f2',
  estimate: '2 min',
  how: ['Open it.'],
  checked: [],
});

describe('with no overlap', () => {
  it('reaches the owner, refuses the claim, and leaves other items alone', async () => {
    const api = await start();
    const id = await ready('Let tokens expire', [designed()]);
    const other = await ready('Unrelated', [plain('table:decks')]);

    const list = await cards(api);
    expect(list).toMatchObject([
      {
        state: 'open',
        item: { id },
        entries: [{ part: 'model:Token.expiresAt', change: 'change', note: DESIGN }],
        decided_by: null,
      },
    ]);
    expect(list[0]!.explanation).toMatchObject({ who: 'owner' });
    expect((await needsYou(api)).overlaps).toEqual([]);

    const err = expectToolError(await claim(id), 'design_review');
    expect(err.message).toContain(DESIGN);
    expect(err.message).toContain('pick other work');
    expect(err.details).toMatchObject({ review_id: list[0]!.id, state: 'open' });
    expect(statusOf(id)).toBe('ready');

    const ids = await startable();
    expect(ids).not.toContain(id);
    expect(ids).toContain(other);
    expectOk(await claim(other));
  });

  it('counts as for you, and the ticket shows it', async () => {
    const api = await start();
    const id = await ready('Let tokens expire', [designed()]);
    const boot = (await api('GET', '/api/bootstrap')).body as { counts: { for_you: number } };
    expect(boot.counts.for_you).toBeGreaterThan(0);
    const shared = (await api('GET', `/api/items/${id}/shared`)).body;
    expect(shared.design_reviews).toMatchObject([{ state: 'open' }]);
  });
});

describe('with an overlap', () => {
  it('is one card, not an overlap question, and the other item keeps working', async () => {
    const api = await start();
    const other = await ready('Add scopes', [plain('model:Token.scopes', 'add')]);
    expectOk(await claim(other, h!.a));
    h!.server.clock.advance(1000);
    const id = await ready('Let tokens expire', [designed('model:Token.expiresAt', DESIGN, 'add')]);
    expectToolError(await claim(id), 'design_review');

    const needs = await needsYou(api);
    expect(needs.overlaps).toEqual([]);
    expect(needs.design_reviews).toMatchObject([{ item: { id } }]);
    expect(statusOf(other)).toBe('progress');
    expect(sql().prepare('SELECT count(*) AS n FROM links WHERE to_id = ?').get(other)).toEqual({
      n: 0,
    });
  });

  it('once approved, the overlap gets its usual classification', async () => {
    const api = await start();
    const other = await ready('Rework expiry', [plain('model:Token.expiresAt')]);
    expectOk(await claim(other, h!.a));
    h!.server.clock.advance(1000);
    const id = await ready('Let tokens expire', [designed()]);
    const [r] = await cards(api);
    expect((await decide(api, r!, 'approve')).status).toBe(200);
    // The same member: Docket sequences it. The design isn't asked about again.
    expectToolError(await claim(id), 'seam_conflict');
    expect(await cards(api)).toEqual([]);
  });
});

describe('already claimed', () => {
  async function claimed(api: Api) {
    const id = await ready('Let tokens expire', [plain('model:Token.expiresAt')]);
    expectOk(await h!.call('declare_human_review', { id, items: ['Check expiry.'] }));
    expectOk(await claim(id, h!.a));
    const out = expectOk(await declare(id, [designed()]));
    expect(out.structured.design_hold).toMatchObject({ state: 'open', notes: [DESIGN] });
    expect(out.text).toContain('design change waits for the owner: pause this item');
    const [r] = await cards(api);
    return { id, review: r! };
  }

  it('keeps the claim, tells the agent, and refuses a close', async () => {
    const api = await start();
    const created = await ready('Close me', [plain('model:Token.expiresAt')]);
    expectOk(await claim(created, h!.a));
    expectOk(await declare(created, [designed()]));
    expect(statusOf(created)).toBe('progress');
    const ctx = expectOk(await h!.call('get_context', { id: created }, h!.a));
    expect(ctx.text).toContain('design change waits for the owner');
    expectToolError(
      await h!.call('set_status', { id: created, status: 'done' }, h!.a),
      'design_review',
    );
    expect(statusOf(created)).toBe('progress');
    // The owner's own close waits for their decision too.
    const res = await api('PATCH', `/api/items/${created}`, {
      expected_version: (
        sql().prepare('SELECT version FROM items WHERE id = ?').get(created) as { version: number }
      ).version,
      status: 'done',
    });
    expect(res.status).toBe(409);
  });

  it('holds a packet: the review gate stays closed until the owner approves', async () => {
    const api = await start();
    const { id, review } = await claimed(api);
    const sent = expectOk(await h!.call('submit_packet', packet(id), h!.a));
    expect(sent.structured.held_design).toMatchObject({ state: 'open' });
    expect(sent.text).toContain('held for the owner: changes an approved design');
    expect(statusOf(id)).toBe('review');

    const view = (await api('GET', `/api/review/${id}`)).body as {
      packet: { round: number; items: { hr_item_id: string }[] };
    };
    const body = {
      round: view.packet.round,
      verdicts: view.packet.items.map((i) => ({ hr_item_id: i.hr_item_id, kind: 'approve' })),
    };
    const blocked = await api('POST', `/api/review/${id}/decisions`, body);
    expect(blocked.status).toBe(409);
    expect(JSON.stringify(blocked.body)).toContain('approved design');

    expect((await decide(api, review, 'approve')).status).toBe(200);
    const passed = await api('POST', `/api/review/${id}/decisions`, body);
    expect(passed.status, JSON.stringify(passed.body)).toBe(200);
  });

  it('Send back withdraws a held packet and returns the item; Undo restores both', async () => {
    const api = await start();
    const { id, review } = await claimed(api);
    expectOk(await h!.call('submit_packet', packet(id), h!.a));
    const res = await decide(api, review, 'send_back', 'Keep tokens permanent');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(statusOf(id)).toBe('progress');
    const state = () =>
      (sql().prepare('SELECT state FROM packets WHERE item_id = ?').get(id) as { state: string })
        .state;
    expect(state()).toBe('withdrawn');
    const back = await undo(api, res.body.mutation_id);
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect(statusOf(id)).toBe('review');
    expect(state()).toBe('open');
    expect(await cards(api)).toMatchObject([{ state: 'open' }]);
  });
});

describe('Approve the design change', () => {
  it('is recorded as the owner, tells the agent, frees the item, and can be undone', async () => {
    const api = await start();
    const id = await ready('Let tokens expire', [designed()]);
    const [r] = await cards(api);
    const res = await decide(api, r!, 'approve');
    expect(res.status).toBe(200);
    expect(res.body.review).toMatchObject({ state: 'approved', decided_by: 'owner' });
    expect(await cards(api)).toEqual([]);
    expect(
      sql().prepare('SELECT text FROM owner_notes WHERE item_id = ? ORDER BY rowid DESC').get(id),
    ).toMatchObject({ text: expect.stringContaining('Go ahead') as string });
    const event = sql()
      .prepare("SELECT actor_kind, summary FROM events WHERE type = 'design_review.decided'")
      .get() as { actor_kind: string; summary: string };
    expect(event.actor_kind).toBe('owner');
    expect(event.summary).toContain('You approved');

    const back = await undo(api, res.body.mutation_id);
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect(await cards(api)).toMatchObject([{ state: 'open' }]);
    expectToolError(await claim(id), 'design_review');

    const again = (await cards(api))[0]!;
    expect((await decide(api, again, 'approve')).status).toBe(200);
    expectOk(await claim(id));
  });

  it('refuses a stale card: the owner approves what they read', async () => {
    const api = await start();
    const id = await ready('Let tokens expire', [designed()]);
    const [r] = await cards(api);
    expectOk(await declare(id, [designed('model:Token.expiresAt', 'Decision 13: a new rule')]));
    expect((await decide(api, r!, 'approve')).status).toBe(409);
    expectToolError(await claim(id), 'design_review');
  });
});

describe('Send back', () => {
  it('needs a note', async () => {
    const api = await start();
    await ready('Let tokens expire', [designed()]);
    const [r] = await cards(api);
    expect((await decide(api, r!, 'send_back')).status).toBe(400);
    expect((await cards(api))[0]!.state).toBe('open');
  });

  it('keeps the item paused with the owner’s note, asks nothing new, and is undoable', async () => {
    const api = await start();
    const id = await ready('Let tokens expire', [designed()]);
    const [r] = await cards(api);
    const res = await decide(api, r!, 'send_back', 'Keep tokens permanent');
    expect(res.status).toBe(200);
    expect(res.body.review).toMatchObject({ state: 'sent_back', decided_by: 'owner' });
    expect(await cards(api)).toEqual([]);
    const err = expectToolError(await claim(id), 'design_review');
    expect(err.message).toContain('Keep tokens permanent');
    expect(await startable()).not.toContain(id);

    // The same declaration again doesn't reopen what the owner said no to.
    expectOk(await declare(id, [designed()]));
    expect(await cards(api)).toEqual([]);
    expectToolError(await claim(id), 'design_review');

    const back = await undo(api, res.body.mutation_id);
    expect(back.status, JSON.stringify(back.body)).toBe(409); // the re-declaration came after it
  });

  it('reworking the item so it no longer changes the design frees it', async () => {
    const api = await start();
    const id = await ready('Let tokens expire', [designed()]);
    const [r] = await cards(api);
    await decide(api, r!, 'send_back', 'Keep tokens permanent');
    const out = expectOk(await declare(id, [plain('model:Token.scopes', 'add')]));
    expect(out.structured.design_hold).toBeUndefined();
    expectOk(await claim(id));
  });

  it('a materially different design change asks again', async () => {
    const api = await start();
    const id = await ready('Let tokens expire', [designed()]);
    const [r] = await cards(api);
    await decide(api, r!, 'send_back', 'Not like that');
    expectOk(
      await declare(id, [designed('model:Token.expiresAt', 'Decision 12: expire in 90 days')]),
    );
    expect(await cards(api)).toMatchObject([
      { state: 'open', entries: [{ note: 'Decision 12: expire in 90 days' }] },
    ]);
  });
});

describe('re-declaring after an approval', () => {
  async function approved(api: Api) {
    const id = await ready('Let tokens expire', [designed()]);
    const [r] = await cards(api);
    expect((await decide(api, r!, 'approve')).status).toBe(200);
    return id;
  }

  it('the same declaration, or the same words spaced differently, doesn’t ask again', async () => {
    const api = await start();
    const id = await approved(api);
    expectOk(await declare(id, [designed()]));
    expectOk(
      await declare(id, [
        designed('model:Token.expiresAt', '  decision 12:  tokens NEVER expire '),
      ]),
    );
    expect(await cards(api)).toEqual([]);
    expectOk(await claim(id));
  });

  it('a non-design part alongside it doesn’t ask again', async () => {
    const api = await start();
    const id = await approved(api);
    expectOk(await declare(id, [designed(), plain('table:decks')]));
    expect(await cards(api)).toEqual([]);
  });

  it.each([
    ['the design note', () => designed('model:Token.expiresAt', 'Decision 14: rotate tokens')],
    ['the affected part', () => designed('model:Token.scopes')],
    ['the kind of change', () => designed('model:Token.expiresAt', DESIGN, 'remove')],
  ])('a change to %s asks again and pauses the item', async (_name, next) => {
    const api = await start();
    const id = await approved(api);
    const out = expectOk(await declare(id, [next()]));
    expect(out.structured.design_hold).toMatchObject({ state: 'open' });
    expect(await cards(api)).toHaveLength(1);
    expectToolError(await claim(id), 'design_review');
  });

  it('dropping the design change asks nothing', async () => {
    const api = await start();
    const id = await approved(api);
    expectOk(await declare(id, [plain('model:Token.expiresAt')]));
    expect(await cards(api)).toEqual([]);
    expectOk(await claim(id));
  });
});

describe('only the owner can clear it', () => {
  it('an agent can’t clear an open review by dropping the flag or declaring none', async () => {
    const api = await start();
    const id = await ready('Let tokens expire', [designed()]);
    expectOk(await declare(id, [plain('model:Token.expiresAt')]));
    expect(await cards(api)).toHaveLength(1);
    expectToolError(await claim(id), 'design_review');
    expectOk(await h!.call('declare_shared_changes', { id, none: true }));
    expect(await cards(api)).toHaveLength(1);
    expectToolError(await claim(id), 'design_review');
  });

  it('no MCP tool decides it, and the route needs the owner’s session', async () => {
    const api = await start();
    await ready('Let tokens expire', [designed()]);
    const [r] = await cards(api);
    const tools = (await h!.a.listTools()).tools.map((t) => t.name);
    expect(tools.filter((n) => /design/i.test(n))).toEqual([]);
    const token = h!.server.runtime.secrets.agentToken();
    const res = await h!.server.app.request(`${ORIGIN}/api/design-reviews/${r!.id}/decide`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ expected_version: r!.version, decision: 'approve' }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect((await cards(api))[0]!.state).toBe('open');
  });

  it('Docket’s classifier doesn’t clear it, even when it runs the pair in parallel', async () => {
    const api = await start();
    const other = await ready('Shared file', [plain('file:src/shared.ts')]);
    expectOk(await claim(other, h!.a));
    h!.server.clock.advance(1000);
    const id = await ready('Designed', [plain('file:src/shared.ts')]);
    expectOk(await claim(id));
    expectOk(await declare(id, [designed('file:src/shared.ts', 'AC 3')]));
    const row = sql().prepare('SELECT outcome, decided_by FROM part_overlaps').get();
    expect(row).toEqual({ outcome: 'parallel', decided_by: 'docket' });
    expect(await cards(api)).toMatchObject([{ state: 'open' }]);
    expectToolError(await h!.call('set_status', { id, status: 'done' }, h!.b), 'design_review');
  });

  it('the owner’s own edit can withdraw it, and Undo brings it back', async () => {
    const api = await start();
    const id = await ready('Let tokens expire', [designed()]);
    const res = await api('PUT', `/api/items/${id}/shared`, {
      changes: [{ part: 'model:Token.expiresAt', change: 'change' }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await cards(api)).toEqual([]);
    expectOk(await claim(id));
  });

  it('canceling the item withdraws its review', async () => {
    const api = await start();
    const id = await ready('Let tokens expire', [designed()]);
    expectOk(await h!.call('set_status', { id, status: 'canceled', reason: 'Not needed' }));
    expect(await cards(api)).toEqual([]);
  });
});

describe('in every Overlap handling mode', () => {
  it.each(OVERLAP_HANDLING)('%s: it reaches the owner and pauses only that item', async (mode) => {
    const api = await start();
    expect((await api('PUT', '/api/settings/overlap-handling', { mode })).status).toBe(200);
    const id = await ready('Let tokens expire', [designed()]);
    const other = await ready('Unrelated', [plain('table:decks')]);
    expect(await cards(api)).toMatchObject([{ item: { id }, state: 'open' }]);
    expectToolError(await claim(id), 'design_review');
    expectOk(await claim(other));
    const [r] = await cards(api);
    expect((await decide(api, r!, 'approve')).status).toBe(200);
    expectOk(await claim(id));
  });

  it.each(OVERLAP_HANDLING)('%s: a per-project override doesn’t turn it off', async (mode) => {
    const api = await start();
    await api('PUT', '/api/settings/overlap-handling', { project: 'RCP', mode });
    const id = await ready('Let tokens expire', [designed()]);
    expectToolError(await claim(id), 'design_review');
  });
});

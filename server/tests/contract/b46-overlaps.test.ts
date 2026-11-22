/**
 * Overlaps reach the owner only when they need the owner (owner decision 39;
 * BUILD_SPEC §5.21; MCP_SPEC §5.15; tasks.md T198), end to end through the MCP
 * tools and the owner API. The classification's every path is in
 * unit/overlap-policy.test.ts; decision 36's behaviour, now *Ask on every
 * overlap*, is pinned by us18-shared-contracts.test.ts.
 */
import { spawnSync } from 'node:child_process';
import { CSRF_HEADER_NAME } from '@docket/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { claimedAt, planRadar, radarTriggers, type RadarPlan } from '../../src/domain/radar.js';
import { OWNER_ACTOR } from '../../src/domain/write.js';
import { classifyLegacyOverlapsOnce, radarRunOnce, startRadar } from '../../src/jobs/sweeper.js';
import { makeOverlapRepo } from '../fixtures/radar-repo.js';
import { tempDir } from '../helpers.js';
import { ORIGIN, parseSetCookies } from '../integration/harness.js';
import { expectOk, expectToolError, startHarness, type ContractHarness } from './harness.js';

let h: ContractHarness | undefined;
let tmp: { dir: string; cleanup(): void } | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
  tmp?.cleanup();
  tmp = undefined;
});

type S = Record<string, unknown>;
type Change = S & { part: string; change: string };

const HAS_GIT = spawnSync('git', ['--version'], { windowsHide: true }).status === 0;
const sql = () => h!.server.runtime.db.sqlite;
const hours = (n: number) => n * 3_600_000;

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

const PARTS = [
  'model:Token',
  'table:decks',
  'endpoint:POST /decks/{id}/export',
  'file:src/shared.ts',
  'other:billing',
];

async function start(env: Record<string, string> = {}) {
  h = await startHarness({ env });
  const api = await owner();
  for (const key of PARTS) {
    const paths = key === 'file:src/shared.ts' ? ['src/shared.ts'] : [];
    expect((await api('POST', '/api/projects/RCP/shared-parts', { key, paths })).status).toBe(200);
  }
  return api;
}

/** A new Ready item with this declaration. */
async function ready(title: string, changes: Change[] | null) {
  const created = expectOk(
    await h!.call('create_item', { project: 'RCP', type: 'Task', title, status: 'planning' }),
  );
  const id = (created.structured.item as { id: string }).id;
  expectOk(await h!.call('declare_shared_changes', changes ? { id, changes } : { id, none: true }));
  expectOk(await h!.call('set_status', { id, status: 'ready' }));
  return id;
}

const claim = (id: string, client = h!.b, branch?: string) =>
  h!.call('claim_lead', { id, ...(branch ? { branch } : {}) }, client);

/** Two items claimed in order; the second claim's result is returned. */
async function pair(a: Change[], b: Change[]) {
  const first = await ready('First', a);
  expectOk(await claim(first, h!.a));
  h!.server.clock.advance(1000);
  const second = await ready('Second', b);
  return { first, second, result: await claim(second) };
}

const rowFor = (a: string, b: string) => {
  const [x, y] = a < b ? [a, b] : [b, a];
  return sql()
    .prepare("SELECT * FROM part_overlaps WHERE item_a = ? AND item_b = ? AND state <> 'resolved'")
    .get(x, y) as (S & { id: string; link_id: string | null }) | undefined;
};
const blockers = (id: string) =>
  (
    sql()
      .prepare("SELECT from_id, satisfied_when FROM links WHERE to_id = ? AND type = 'blocks'")
      .all(id) as { from_id: string; satisfied_when: string }[]
  ).map((l) => `${l.from_id}:${l.satisfied_when}`);
const partId = (key: string) =>
  (sql().prepare('SELECT id FROM shared_parts WHERE key = ?').get(key) as { id: string }).id;
const needsYou = async (api: Api) => (await api('GET', '/api/needs-you?scope=RCP')).body;
const statusOf = (id: string) =>
  (sql().prepare('SELECT status FROM items WHERE id = ?').get(id) as { status: string }).status;
const eventsOf = (type: string, id: string) =>
  sql()
    .prepare('SELECT actor_kind, summary, data FROM events WHERE type = ? AND item_id = ?')
    .all(type, id) as { actor_kind: string; summary: string; data: string }[];
const readyToStart = async () =>
  (
    expectOk(await h!.call('search_items', { project: 'RCP', filter: 'ready_to_start' })).structured
      .items as { id: string }[]
  ).map((i) => i.id);

describe('run in parallel', () => {
  it('add-only changes to different members both claim, recorded as Docket on both tickets', async () => {
    const api = await start();
    const { first, second, result } = await pair(
      [{ part: 'model:Token.expiresAt', change: 'add' }],
      [{ part: 'model:Token.scopes', change: 'add' }],
    );
    expectOk(result);
    expect(statusOf(second)).toBe('progress');
    expect(rowFor(first, second)).toMatchObject({
      state: 'compatible',
      outcome: 'parallel',
      reason: 'different_members',
      decided_by: 'docket',
      link_id: null,
    });
    for (const id of [first, second]) {
      const [e] = eventsOf('overlap.decided', id);
      expect(e!.actor_kind).toBe('system');
      expect(e!.summary).toContain('Docket runs');
      expect(JSON.parse(e!.data)).toMatchObject({ decided_by: 'docket', decision: 'parallel' });
    }
    const needs = await needsYou(api);
    expect(needs.overlaps).toEqual([]);
    expect(needs.overlaps_handled).toMatchObject({ count: 1 });
  });

  it('a file-only overlap claims too', async () => {
    await start();
    const { first, second, result } = await pair(
      [{ part: 'file:src/shared.ts', change: 'change' }],
      [{ part: 'file:src/shared.ts', change: 'remove' }],
    );
    expectOk(result);
    expect(rowFor(first, second)).toMatchObject({ outcome: 'parallel', reason: 'file_only' });
  });

  it('existing declarations keep working as bare parts', async () => {
    await start();
    const id = await ready('Bare', [{ part: 'model:Token', change: 'change' }]);
    const row = sql()
      .prepare('SELECT part_key, member, design_impact FROM item_shared_changes WHERE item_id = ?')
      .get(id);
    expect(row).toEqual({ part_key: 'model:Token', member: null, design_impact: 'none' });
  });

  it('a member in new_parts is not a part of its own, so siblings still meet', async () => {
    await start();
    const created = expectOk(
      await h!.call('create_item', {
        project: 'RCP',
        type: 'Task',
        title: 'X',
        status: 'planning',
      }),
    );
    const id = (created.structured.item as { id: string }).id;
    const out = expectOk(
      await h!.call('declare_shared_changes', {
        id,
        changes: [{ part: 'model:Token.expiresAt', change: 'add' }],
        new_parts: [{ key: 'model:Token.expiresAt' }],
      }),
    );
    expect(out.structured.registered).toEqual([]);
    expect(
      sql().prepare("SELECT count(*) AS n FROM shared_parts WHERE key LIKE 'model:Token%'").get(),
    ).toEqual({ n: 1 });
  });

  it('a member of an unregistered part is refused, naming it', async () => {
    await start();
    const created = expectOk(
      await h!.call('create_item', {
        project: 'RCP',
        type: 'Task',
        title: 'X',
        status: 'planning',
      }),
    );
    const id = (created.structured.item as { id: string }).id;
    expectToolError(
      await h!.call('declare_shared_changes', {
        id,
        changes: [{ part: 'model:Nope.field', change: 'add' }],
      }),
      'validation',
    );
  });
});

describe('sequence automatically', () => {
  it.each([
    ['the same member', 'model:Token.a', 'add', 'model:Token.a', 'add', 'same_member'],
    [
      'a change to a part',
      'model:Token.a',
      'change',
      'model:Token.b',
      'add',
      'change_touches_part',
    ],
    ['a bare part', 'model:Token', 'add', 'model:Token.b', 'add', 'bare_part'],
    ['an unclear part', 'other:billing', 'add', 'other:billing', 'add', 'unclear'],
  ])(
    '%s: a merged blocker, first claimed goes first, seam_conflict, no owner card',
    async (_name, a, howA, b, howB, reason) => {
      const api = await start();
      const { first, second, result } = await pair(
        [{ part: a, change: howA }],
        [{ part: b, change: howB }],
      );
      const err = expectToolError(result, 'seam_conflict');
      expect(err.message).toContain('Docket queued');
      expect(err.details).toMatchObject({ with: [first], outcome: 'sequence' });
      expect(statusOf(second)).toBe('ready');
      expect(blockers(second)).toEqual([`${first}:merged`]);
      expect(rowFor(first, second)).toMatchObject({
        state: 'sequenced',
        outcome: 'sequence',
        reason,
        decided_by: 'docket',
      });
      expect((await needsYou(api)).overlaps).toEqual([]);
      expect(await readyToStart()).not.toContain(second);
    },
  );

  it('claiming again opens no second row and adds no second blocker', async () => {
    await start();
    const { first, second } = await pair(
      [{ part: 'table:decks', change: 'change' }],
      [{ part: 'table:decks', change: 'change' }],
    );
    const again = await claim(second);
    expect(again.isError).toBe(true);
    expect(blockers(second)).toEqual([`${first}:merged`]);
    expect(sql().prepare('SELECT count(*) AS n FROM part_overlaps').get()).toEqual({ n: 1 });
  });

  it('canceling the item that goes first frees the waiting one, with no owner problem', async () => {
    const api = await start();
    const { first, second } = await pair(
      [{ part: 'table:decks', change: 'change' }],
      [{ part: 'table:decks', change: 'change' }],
    );
    expect(blockers(second)).toEqual([`${first}:merged`]);
    expectOk(
      await h!.call('set_status', { id: first, status: 'canceled', reason: 'Not needed' }, h!.a),
    );
    expect(blockers(second)).toEqual([]);
    const needs = await needsYou(api);
    expect((needs.problems as { kind: string }[]).map((p) => p.kind)).not.toContain(
      'canceled_blocker',
    );
    expectOk(await claim(second));
  });

  it('a blocker someone else added stays when its item is canceled', async () => {
    await start();
    const first = await ready('First', null);
    const second = await ready('Second', null);
    expectOk(await h!.call('link_items', { from: first, to: second, type: 'blocks' }));
    expectOk(await h!.call('set_status', { id: first, status: 'canceled', reason: 'No' }));
    expect(blockers(second)).toHaveLength(1);
  });

  it('narrowing a declaration reclassifies the pair and removes the blocker Docket added', async () => {
    await start();
    const { first, second } = await pair(
      [{ part: 'model:Token.a', change: 'add' }],
      [{ part: 'model:Token', change: 'add' }],
    );
    expect(blockers(second)).toHaveLength(1);
    expectOk(
      await h!.call('declare_shared_changes', {
        id: second,
        changes: [{ part: 'model:Token.b', change: 'add' }],
      }),
    );
    // Still Ready: the pair it's in is classified again, and Docket's blocker goes.
    expect(blockers(second)).toEqual([]);
    expect(rowFor(first, second)).toMatchObject({ outcome: 'parallel', state: 'compatible' });
    expectOk(await claim(second));
  });

  it('a change in progress reclassifies at once and keeps both claims', async () => {
    await start();
    const { first, second, result } = await pair(
      [{ part: 'model:Token.a', change: 'add' }],
      [{ part: 'model:Token.b', change: 'add' }],
    );
    expectOk(result);
    const out = expectOk(
      await h!.call('declare_shared_changes', {
        id: second,
        changes: [{ part: 'model:Token.a', change: 'change' }],
      }),
    );
    expect(out.structured.overlaps).toMatchObject([
      { with: { id: first }, outcome: 'sequence', reason: 'same_member' },
    ]);
    expect(statusOf(second)).toBe('progress');
    expect(blockers(second)).toEqual([`${first}:merged`]);
    // The waiting agent hears about it.
    expect(
      (
        sql().prepare('SELECT text FROM owner_notes WHERE item_id = ?').all(second) as {
          text: string;
        }[]
      ).some((n) => n.text.startsWith('Docket:')),
    ).toBe(true);
    // And back: different members again removes Docket's blocker.
    expectOk(
      await h!.call('declare_shared_changes', {
        id: second,
        changes: [{ part: 'model:Token.b', change: 'add' }],
      }),
    );
    expect(blockers(second)).toEqual([]);
    expect(rowFor(first, second)).toMatchObject({ outcome: 'parallel', link_id: null });
  });
});

describe('the owner', () => {
  it('a design note is required with changes_approved_design', async () => {
    await start();
    const created = expectOk(
      await h!.call('create_item', {
        project: 'RCP',
        type: 'Task',
        title: 'X',
        status: 'planning',
      }),
    );
    expectToolError(
      await h!.call('declare_shared_changes', {
        id: (created.structured.item as { id: string }).id,
        changes: [
          { part: 'model:Token', change: 'change', design_impact: 'changes_approved_design' },
        ],
      }),
      'validation',
    );
  });

  it('a sequence that would create a blocker cycle reaches the owner, with no link added', async () => {
    const api = await start();
    const first = await ready('First', [{ part: 'table:decks', change: 'change' }]);
    expectOk(await claim(first, h!.a));
    h!.server.clock.advance(1000);
    const second = await ready('Second', [{ part: 'table:decks', change: 'change' }]);
    const middle = await ready('Middle', null);
    // second → middle → first: running first before second would close a loop.
    expectOk(await h!.call('link_items', { from: second, to: middle, type: 'blocks' }));
    expectOk(await h!.call('link_items', { from: middle, to: first, type: 'blocks' }));
    expectToolError(await claim(second), 'seam_conflict');
    expect((await needsYou(api)).overlaps).toMatchObject([
      { outcome: 'owner', reason: 'blocker_cycle', state: 'open' },
    ]);
    expect(blockers(second)).toEqual([]);
  });

  it('disputed ownership reaches the owner', async () => {
    const api = await start();
    const { result } = await pair(
      [{ part: 'model:Token.a', change: 'add' }],
      [{ part: 'model:Token.b', change: 'add', disputed: true }],
    );
    expectToolError(result, 'seam_conflict');
    expect((await needsYou(api)).overlaps).toMatchObject([{ reason: 'disputed' }]);
  });

  it('an auto-handled overlap still unresolved after the grace period reaches the owner', async () => {
    const api = await start({ DOCKET_OVERLAP_GRACE_HOURS: '2' });
    const { first, second } = await pair(
      [{ part: 'table:decks', change: 'change' }],
      [{ part: 'table:decks', change: 'change' }],
    );
    expect((await needsYou(api)).overlaps).toEqual([]);
    h!.server.clock.advance(hours(2) + 1000);
    const needs = await needsYou(api);
    expect(needs.overlaps).toMatchObject([
      {
        decided_by: 'docket',
        state: 'sequenced',
        reached_you: 'Not settled by agents for 2 hours',
      },
    ]);
    // The owner keeps the order: it is theirs now, and leaves Needs you.
    const id = rowFor(first, second)!.id;
    const kept = await api('POST', `/api/overlaps/${id}/overrule`, { decision: 'order' });
    expect(kept.status).toBe(200);
    expect((await needsYou(api)).overlaps).toEqual([]);
    expect(blockers(second)).toEqual([`${first}:merged`]);
  });
});

describe('Overlap handling', () => {
  const put = (api: Api, body: S) => api('PUT', '/api/settings/overlap-handling', body);

  it('defaults to Agents resolve; a global change applies; a project override wins', async () => {
    const api = await start();
    const read = async () => (await api('GET', '/api/settings/overlap-handling')).body;
    expect((await read()).default).toBe('agents_resolve');
    expect(((await read()).projects as S[]).find((p) => p.key === 'RCP')).toMatchObject({
      override: null,
      effective: 'agents_resolve',
    });

    expect((await put(api, { mode: 'ask_every' })).status).toBe(200);
    expect(((await read()).projects as S[]).find((p) => p.key === 'RCP')).toMatchObject({
      override: null,
      effective: 'ask_every',
    });

    expect((await put(api, { project: 'RCP', mode: 'agents_resolve' })).status).toBe(200);
    expect(((await read()).projects as S[]).find((p) => p.key === 'RCP')).toMatchObject({
      override: 'agents_resolve',
      effective: 'agents_resolve',
    });

    expect((await put(api, { project: 'RCP', mode: null })).status).toBe(200);
    expect(((await read()).projects as S[]).find((p) => p.key === 'RCP')).toMatchObject({
      override: null,
      effective: 'ask_every',
    });
    expect((await put(api, { mode: null })).status).toBe(400);
  });

  it('no MCP tool writes it', async () => {
    await start();
    const tools = await h!.a.listTools();
    expect(tools.tools.map((t) => t.name).filter((n) => /overlap|handling/i.test(n))).toEqual([]);
  });

  it('Ask on shared data: a model overlap is the owner’s, a file overlap is not', async () => {
    const api = await start();
    await put(api, { project: 'RCP', mode: 'ask_shared_data' });
    const model = await pair(
      [{ part: 'model:Token.a', change: 'add' }],
      [{ part: 'model:Token.b', change: 'add' }],
    );
    expectToolError(model.result, 'seam_conflict');
    expect((await needsYou(api)).overlaps).toMatchObject([{ reason: 'setting' }]);
    const file = await pair(
      [{ part: 'file:src/shared.ts', change: 'change' }],
      [{ part: 'file:src/shared.ts', change: 'change' }],
    );
    expectOk(file.result);
  });

  it('Ask on every overlap: even a file overlap is the owner’s', async () => {
    const api = await start();
    await put(api, { mode: 'ask_every' });
    const { result } = await pair(
      [{ part: 'file:src/shared.ts', change: 'change' }],
      [{ part: 'file:src/shared.ts', change: 'change' }],
    );
    expectToolError(result, 'seam_conflict');
    expect((await needsYou(api)).overlaps).toMatchObject([{ state: 'open', reason: 'setting' }]);
  });

  it('a pair the owner decided stays decided when the setting changes', async () => {
    const api = await start();
    await put(api, { mode: 'ask_every' });
    const { first, second } = await pair(
      [{ part: 'table:decks', change: 'change' }],
      [{ part: 'table:decks', change: 'change' }],
    );
    const id = rowFor(first, second)!.id;
    await api('POST', `/api/overlaps/${id}/decide`, { decision: 'compatible' });
    await put(api, { mode: 'agents_resolve' });
    expectOk(await claim(second));
    expect(rowFor(first, second)).toMatchObject({ state: 'compatible', decided_by: 'owner' });
    expect(blockers(second)).toEqual([]);
  });
});

describe('overrule and undo', () => {
  const undo = (api: Api, id: unknown) => api('POST', `/api/mutations/${String(id)}/undo`);

  it('Run in parallel removes Docket’s blocker; Undo puts the outcome and the blocker back', async () => {
    const api = await start();
    const { first, second } = await pair(
      [{ part: 'table:decks', change: 'change' }],
      [{ part: 'table:decks', change: 'change' }],
    );
    const id = rowFor(first, second)!.id;
    const res = await api('POST', `/api/overlaps/${id}/overrule`, { decision: 'parallel' });
    expect(res.status).toBe(200);
    expect(res.body.overlap).toMatchObject({ state: 'compatible', decided_by: 'owner' });
    expect(blockers(second)).toEqual([]);
    expectOk(await claim(second));
    // A claim since then blocks the undo, as for any other change.
    expect((await undo(api, res.body.mutation_id)).status).toBe(409);
  });

  it('Undo right after an overrule restores Docket’s sequence', async () => {
    const api = await start();
    const { first, second } = await pair(
      [{ part: 'table:decks', change: 'change' }],
      [{ part: 'table:decks', change: 'change' }],
    );
    const before = rowFor(first, second)!;
    const res = await api('POST', `/api/overlaps/${before.id}/overrule`, { decision: 'parallel' });
    const back = await undo(api, res.body.mutation_id);
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect(rowFor(first, second)).toMatchObject({
      state: 'sequenced',
      decided_by: 'docket',
      link_id: before.link_id,
    });
    expect(blockers(second)).toEqual([`${first}:merged`]);
  });

  it('Run in order on a parallel outcome adds the blocker; Undo removes it', async () => {
    const api = await start();
    const { first, second } = await pair(
      [{ part: 'model:Token.a', change: 'add' }],
      [{ part: 'model:Token.b', change: 'add' }],
    );
    const id = rowFor(first, second)!.id;
    const res = await api('POST', `/api/overlaps/${id}/overrule`, { decision: 'order' });
    expect(res.body.overlap).toMatchObject({ state: 'sequenced', decided_by: 'owner' });
    expect(blockers(second)).toEqual([`${first}:merged`]);
    expect((await undo(api, res.body.mutation_id)).status).toBe(200);
    expect(blockers(second)).toEqual([]);
    expect(rowFor(first, second)).toMatchObject({ state: 'compatible', decided_by: 'docket' });
  });

  it('an open owner question can’t be overruled; it is decided on its card', async () => {
    const api = await start();
    await api('PUT', '/api/settings/overlap-handling', { mode: 'ask_every' });
    const { first, second } = await pair(
      [{ part: 'table:decks', change: 'change' }],
      [{ part: 'table:decks', change: 'change' }],
    );
    const id = rowFor(first, second)!.id;
    expect((await api('POST', `/api/overlaps/${id}/overrule`, { decision: 'order' })).status).toBe(
      409,
    );
  });

  it('an owner declaration that changes an outcome stays undoable, with Docket’s part', async () => {
    const api = await start();
    const { first, second, result } = await pair(
      [{ part: 'model:Token.a', change: 'add' }],
      [{ part: 'model:Token.b', change: 'add' }],
    );
    expectOk(result);
    const res = await api('PUT', `/api/items/${second}/shared`, {
      changes: [{ part: 'model:Token.a', change: 'change' }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(blockers(second)).toEqual([`${first}:merged`]);
    const back = await undo(api, res.body.mutation_id);
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect(blockers(second)).toEqual([]);
    expect(rowFor(first, second)).toMatchObject({ outcome: 'parallel', decided_by: 'docket' });
  });
});

describe('undeclared shared files at hand-off', () => {
  const close = (id: string, files: string[], client = h!.b) =>
    h!.call('set_status', { id, status: 'done', changed_files: files }, client);

  it('a file nobody else touches joins the declaration as Docket, with no hold', async () => {
    const api = await start();
    const id = await ready('Solo', null);
    expectOk(await claim(id));
    expectOk(await close(id, ['src/shared.ts']));
    expect(statusOf(id)).toBe('done');
    expect(
      sql()
        .prepare('SELECT part_key, declared_by FROM item_shared_changes WHERE item_id = ?')
        .all(id),
    ).toEqual([{ part_key: 'file:src/shared.ts', declared_by: 'docket' }]);
    const [e] = eventsOf('shared.declared', id).filter((x) => x.actor_kind === 'system');
    expect(e!.summary).toContain('Docket added');
    expect((await needsYou(api)).undeclared_holds).toEqual([]);
  });

  it('a safe file overlap is recorded and doesn’t hold the packet path either', async () => {
    const api = await start();
    const other = await ready('Other', [{ part: 'file:src/shared.ts', change: 'change' }]);
    expectOk(await claim(other, h!.a));
    h!.server.clock.advance(1000);
    const id = await ready('Mine', null);
    expectOk(await claim(id));
    expectOk(await close(id, ['src/shared.ts']));
    expect((await needsYou(api)).undeclared_holds).toEqual([]);
  });

  it('a part that must be sequenced joins the declaration with a blocker, and doesn’t hold', async () => {
    const api = await start();
    expect(
      (
        await api('PATCH', `/api/shared-parts/${partId('table:decks')}`, {
          expected_version: 1,
          paths: ['db/decks/**'],
        })
      ).status,
    ).toBe(200);
    const other = await ready('Other', [{ part: 'table:decks.title', change: 'change' }]);
    expectOk(await claim(other, h!.a));
    h!.server.clock.advance(1000);
    const id = await ready('Mine', null);
    expectOk(await claim(id));
    expectOk(await close(id, ['db/decks/schema.sql']));
    expect((await needsYou(api)).undeclared_holds).toEqual([]);
    expect(blockers(id)).toEqual([`${other}:merged`]);
  });

  it('with Ask on every overlap it holds, as before', async () => {
    const api = await start();
    await api('PUT', '/api/settings/overlap-handling', { mode: 'ask_every' });
    const id = await ready('Solo', null);
    expectOk(await claim(id));
    expectToolError(await close(id, ['src/shared.ts']), 'not_declared');
    expect((await needsYou(api)).undeclared_holds).toMatchObject([
      { parts: ['file:src/shared.ts'] },
    ]);
  });

  it('an overlap with a change to an approved design still reaches the owner', async () => {
    const api = await start();
    const other = await ready('Designed', [{ part: 'file:src/shared.ts', change: 'change' }]);
    expectOk(await claim(other, h!.a));
    // Declared after the claim: the review pauses that item, and it keeps its claim.
    expectOk(
      await h!.call('declare_shared_changes', {
        id: other,
        changes: [
          {
            part: 'file:src/shared.ts',
            change: 'change',
            design_impact: 'changes_approved_design',
            design_note: 'AC 4',
          },
        ],
      }),
    );
    h!.server.clock.advance(1000);
    const id = await ready('Mine', null);
    expectOk(await claim(id));
    expectToolError(await close(id, ['src/shared.ts']), 'not_declared');
    expect((await needsYou(api)).undeclared_holds).toMatchObject([
      { parts: ['file:src/shared.ts'] },
    ]);
    expect(statusOf(id)).toBe('progress');
  });
});

describe('line conflicts (the radar)', () => {
  async function withRepo() {
    tmp = tempDir('docket-b46-');
    makeOverlapRepo(tmp.dir);
    const api = await start({ DOCKET_PUSH_ROOT: tmp.dir });
    expect((await api('PUT', '/api/projects/RCP/radar', { repo_path: 'overlap-app' })).status).toBe(
      200,
    );
    return api;
  }
  const findings = () =>
    sql().prepare('SELECT * FROM radar_findings WHERE cleared_at IS NULL').all() as S[];

  it.skipIf(!HAS_GIT)(
    'two add-only branches inserting at the same line: a text conflict with a merge order, no owner card, neither agent stopped',
    async () => {
      const api = await withRepo();
      const first = await ready('Add expiresAt', [
        { part: 'model:Token.expiresAt', change: 'add' },
      ]);
      expectOk(await claim(first, h!.a, 'add-a'));
      h!.server.clock.advance(1000);
      const second = await ready('Add scopes', [{ part: 'model:Token.scopes', change: 'add' }]);
      expectOk(await claim(second, h!.b, 'add-b'));

      // The meaning is safe, so both claims stand.
      expect(rowFor(first, second)).toMatchObject({
        outcome: 'parallel',
        reason: 'different_members',
      });

      await radarRunOnce(h!.server.runtime, 'RCP');
      const pairFinding = findings().find((f) => f.item_b !== null)!;
      expect(JSON.parse(pairFinding.files as string)).toEqual(['models.md']);
      expect(pairFinding.merge_first).toBe(first);

      // Neither agent stopped: both still lead, unblocked, with no blocker added.
      expect(statusOf(first)).toBe('progress');
      expect(statusOf(second)).toBe('progress');
      expect(blockers(first)).toEqual([]);
      expect(blockers(second)).toEqual([]);

      // No owner card; the leads are handling it.
      const needs = await needsYou(api);
      expect(needs.overlaps).toEqual([]);
      expect(
        (needs.problems as { kind: string }[]).filter((p) => p.kind === 'radar_conflict'),
      ).toEqual([]);
      expect(
        (needs.agent_problems as { kind: string }[]).filter((p) => p.kind === 'radar_conflict'),
      ).toHaveLength(1);

      // Both leads are told once, naming the file and who goes first.
      for (const id of [first, second]) {
        const notes = sql()
          .prepare("SELECT text FROM owner_notes WHERE item_id = ? AND text LIKE 'Docket%'")
          .all(id) as { text: string }[];
        expect(notes).toHaveLength(1);
        expect(notes[0]!.text).toContain('models.md');
        expect(notes[0]!.text).toContain(`${first} merges first`);
        expect(notes[0]!.text).toContain(`${second} rebases`);
      }
      const ctx = expectOk(await h!.call('get_context', { id: second }, h!.b));
      expect(ctx.text).toContain(`rebase after ${first} merges`);
      const mine = expectOk(await h!.call('get_context', { id: first }, h!.a));
      expect(mine.text).toContain('you merge first');

      // A second run changes nothing and tells nobody again.
      const before = sql().prepare('SELECT count(*) AS n FROM owner_notes').get();
      await radarRunOnce(h!.server.runtime, 'RCP');
      expect(sql().prepare('SELECT count(*) AS n FROM owner_notes').get()).toEqual(before);

      // The overlap's evidence shows the real conflict; the outcome is unchanged.
      const row = rowFor(first, second)!;
      expect(JSON.parse(row.evidence as string).text_conflict).toEqual(['models.md']);
      expect(row.outcome).toBe('parallel');
    },
    60_000,
  );

  it.skipIf(!HAS_GIT)(
    'a clean trial merge doesn’t override a same-member sequence',
    async () => {
      await withRepo();
      const first = await ready('A', [{ part: 'model:Token.expiresAt', change: 'change' }]);
      expectOk(await claim(first, h!.a, 'clean-a'));
      h!.server.clock.advance(1000);
      const second = await ready('B', [{ part: 'model:Token.expiresAt', change: 'change' }]);
      expectToolError(await claim(second, h!.b, 'clean-b'), 'seam_conflict');
      await radarRunOnce(h!.server.runtime, 'RCP');
      expect(findings().filter((f) => f.item_b !== null)).toEqual([]);
      expect(rowFor(first, second)).toMatchObject({ state: 'sequenced', outcome: 'sequence' });
      expect(blockers(second)).toEqual([`${first}:merged`]);
    },
    60_000,
  );

  it.skipIf(!HAS_GIT)(
    'the merge order: a branch already merged goes first, whoever claimed earlier',
    async () => {
      await withRepo();
      const first = await ready('A', [{ part: 'file:src/shared.ts', change: 'change' }]);
      expectOk(await claim(first, h!.a, 'add-a'));
      h!.server.clock.advance(1000);
      const second = await ready('B', [{ part: 'file:src/shared.ts', change: 'change' }]);
      expectOk(await claim(second, h!.b, 'add-b'));
      const r = {
        db: h!.server.runtime.db,
        actor: OWNER_ACTOR,
        now: h!.server.clock.now().toISOString(),
      };
      const orderOf = (plan: RadarPlan) =>
        plan.checks.find((c) => c.item_b !== null && c.files.length > 0)?.merge_first;
      expect(orderOf(await planRadar(r, h!.server.runtime.config, 'RCP'))).toBe(first);
      expect(claimedAt(r.db, first) < claimedAt(r.db, second)).toBe(true);
    },
    60_000,
  );

  it('a reported branch or commit asks for a run; the radar’s own events don’t', async () => {
    tmp = tempDir('docket-b46-');
    const api = await start({ DOCKET_PUSH_ROOT: tmp.dir });
    const db = h!.server.runtime.db;
    db.sqlite.prepare("UPDATE projects SET repo_path = 'x' WHERE key = 'RCP'").run();
    const seq = (type: string) =>
      (
        db.sqlite
          .prepare(
            `INSERT INTO events (at, actor_kind, project_key, type, summary, data, mutation_id)
             VALUES ('2026-11-06T11:00:00.000Z', 'system', 'RCP', ?, 's', '{}', 'mut_t') RETURNING seq`,
          )
          .get(type) as { seq: number }
      ).seq;
    expect(radarTriggers(db, [seq('branch.reported')])).toEqual(['RCP']);
    expect(radarTriggers(db, [seq('commit.reported')])).toEqual(['RCP']);
    expect(radarTriggers(db, [seq('radar.found'), seq('radar.cleared')])).toEqual([]);
    void api;
  });

  it.skipIf(!HAS_GIT)(
    'the radar runs soon after a branch report, debounced to one run',
    async () => {
      await withRepo();
      const runtime = h!.server.runtime;
      const radar = startRadar(runtime, { intervalMs: null, debounceMs: 20, minGapMs: 0 });
      try {
        const first = await ready('A', [{ part: 'file:src/shared.ts', change: 'change' }]);
        expectOk(await claim(first, h!.a, 'add-a'));
        const second = await ready('B', [{ part: 'file:src/shared.ts', change: 'change' }]);
        expectOk(await claim(second, h!.b, 'add-b'));
        await expect
          .poll(() => findings().filter((f) => f.item_b !== null).length, { timeout: 10_000 })
          .toBe(1);
      } finally {
        await radar.stop();
      }
    },
    60_000,
  );
});

describe('existing overlaps', () => {
  /** An overlap as decision 36 stored it: no classification. */
  async function legacy(state: 'open' | 'compatible' | 'sequenced') {
    const first = await ready('Old A', [{ part: 'table:decks', change: 'change' }]);
    expectOk(await claim(first, h!.a));
    h!.server.clock.advance(1000);
    const second = await ready('Old B', [{ part: 'table:decks', change: 'change' }]);
    sql().prepare('DELETE FROM part_overlaps').run();
    sql().prepare("DELETE FROM links WHERE to_id = ? AND type = 'blocks'").run(second);
    const [a, b] = first < second ? [first, second] : [second, first];
    const at = h!.server.clock.now().toISOString();
    sql()
      .prepare(
        `INSERT INTO part_overlaps (id, project_key, item_a, item_b, claimed_first, parts, state,
           raised_at, decided_by, decided_at, version, created_at, updated_at)
         VALUES ('pov_legacy', 'RCP', ?, ?, ?, '["table:decks"]', ?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(
        a,
        b,
        first,
        state,
        at,
        state === 'open' ? null : 'owner',
        state === 'open' ? null : at,
        at,
        at,
      );
    return { first, second };
  }

  it('an open question gets the new rule at startup', async () => {
    const api = await start();
    const { first, second } = await legacy('open');
    expect(classifyLegacyOverlapsOnce(h!.server.runtime)).toBe(1);
    expect(rowFor(first, second)).toMatchObject({
      state: 'sequenced',
      decided_by: 'docket',
      reason: 'bare_part',
    });
    expect((await needsYou(api)).overlaps).toEqual([]);
    // Once only.
    expect(classifyLegacyOverlapsOnce(h!.server.runtime)).toBe(0);
  });

  it.each(['compatible', 'sequenced'] as const)(
    'a pair the owner decided (%s) stays decided',
    async (state) => {
      await start();
      const { first, second } = await legacy(state);
      const before = rowFor(first, second);
      expect(classifyLegacyOverlapsOnce(h!.server.runtime)).toBe(0);
      expect(rowFor(first, second)).toEqual(before);
      expect(blockers(second)).toEqual([]);
    },
  );

  it('a question that no longer applies resolves', async () => {
    await start();
    const { first, second } = await legacy('open');
    sql().prepare('DELETE FROM item_shared_changes WHERE item_id = ?').run(second);
    expect(classifyLegacyOverlapsOnce(h!.server.runtime)).toBe(1);
    expect(rowFor(first, second)).toBeUndefined();
  });
});

describe('unattended agents keep working (SC-025)', () => {
  it('two agents drain the queue; Needs you gets only the level 3 overlap', async () => {
    const api = await start();
    const parts: [string, Change[]][] = [
      ['Add expiresAt', [{ part: 'model:Token.expiresAt', change: 'add' }]],
      ['Add scopes', [{ part: 'model:Token.scopes', change: 'add' }]],
      ['Rewrite Token', [{ part: 'model:Token.scopes', change: 'change' }]],
      ['Shared file 1', [{ part: 'file:src/shared.ts', change: 'change' }]],
      ['Shared file 2', [{ part: 'file:src/shared.ts', change: 'change' }]],
      [
        'Design change',
        [
          {
            part: 'file:src/shared.ts',
            change: 'change',
            design_impact: 'changes_approved_design',
            design_note: 'Decision 7',
          },
        ],
      ],
    ];
    const ids: string[] = [];
    for (const [title, changes] of parts) ids.push(await ready(title, changes));
    const started = new Set<string>();
    const refused = new Set<string>();
    for (let turn = 0; turn < ids.length * 3; turn++) {
      const client = turn % 2 === 0 ? h!.a : h!.b;
      const next = (await readyToStart()).find(
        (id) => ids.includes(id) && !started.has(id) && !refused.has(id),
      );
      if (!next) break;
      const r = await claim(next, client);
      if (r.isError) refused.add(next);
      else started.add(next);
      h!.server.clock.advance(1000);
    }
    // Safe work started in parallel, and nobody waited on the owner to keep going.
    expect(started.has(ids[0]!)).toBe(true);
    expect(started.has(ids[1]!)).toBe(true);
    expect(started.has(ids[3]!)).toBe(true);
    expect(started.has(ids[4]!)).toBe(true);
    // Rewriting a member someone else adds waits behind it.
    expect(refused.has(ids[2]!)).toBe(true);
    expect(blockers(ids[2]!).length).toBeGreaterThan(0);

    const needs = await needsYou(api);
    // The only thing that needs the owner is the design change, and it paused only its item.
    expect(needs.overlaps).toEqual([]);
    expect(needs.design_reviews).toMatchObject([{ item: { id: ids[5] } }]);
    expect(started.has(ids[5]!)).toBe(false);
    expect((needs.overlaps_handled as { count: number }).count).toBeGreaterThanOrEqual(2);
  }, 60_000);
});

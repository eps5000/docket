/**
 * Step details (owner decision 33; B33, tasks.md T170; BUILD_SPEC §5.5;
 * MCP_SPEC §5.12; UI_SPEC §6.3.1a), through the official MCP SDK clients and
 * the owner's UI API:
 *
 * - `set_plan` stores `details` and `source` per step, as patches: omitted
 *   means unchanged, so a kept step carries them across revisions (patch and
 *   replace); `null` or empty clears; each change bumps `details_version`.
 * - `get_item` standard shows `has_details` and a `· details` marker, never
 *   the text; `full` carries and prints the details.
 * - `update_step` replaces details, with an optional version check, and
 *   changes only the details when the state is unchanged.
 * - Owner-added steps keep owner-set details: agents may change their state only.
 * - The write checks (secrets, item references) cover details and source.
 * - `get_step` reads one step in full, with its history, in structured and
 *   text-only sessions; a removed step is still readable.
 * - `PATCH /api/items/:id/work/:stepId/details` edits details with a version
 *   check, records an owner event carrying `via`, and is undoable.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ORIGIN, parseSetCookies } from '../integration/harness.js';
import {
  expectConflict,
  expectForbidden,
  expectNotFound,
  expectOk,
  expectValidation,
  startHarness,
  textOf,
  type ContractHarness,
} from './harness.js';

let h: ContractHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

type S = Record<string, unknown>;
type Step = S & {
  id: string;
  text: string;
  state: string;
  source: string | null;
  has_details: boolean;
  details_md?: string | null;
  details_version?: number;
};

async function start(env?: Record<string, string>): Promise<ContractHarness> {
  h = await startHarness({ env });
  return h;
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

const row = (id: string) =>
  h!.server.runtime.db.sqlite
    .prepare(
      'SELECT details_md, source, details_version, state, state_at FROM work_steps WHERE id = ?',
    )
    .get(id) as {
    details_md: string | null;
    source: string | null;
    details_version: number;
    state: string;
    state_at: string | null;
  };

const lastEvent = (type: string) => {
  const e = h!.server.runtime.db.sqlite
    .prepare(
      'SELECT summary, data, actor_kind FROM events WHERE type = ? ORDER BY seq DESC LIMIT 1',
    )
    .get(type) as { summary: string; data: string; actor_kind: string };
  return { ...e, data: JSON.parse(e.data) as S };
};

/** Claim RCP-17 (Ready in the seed) and publish a plan with two detailed steps. */
async function planWithDetails(client = h!.a) {
  const { run_id } = expectOk(
    await h!.call('claim_lead', { id: 'RCP-17', agent_label: 'w1' }, client),
  ).structured as { run_id: string };
  const r = expectOk(
    await h!.call(
      'set_plan',
      {
        id: 'RCP-17',
        run_id,
        steps: [
          { text: 'Reproduce the jump', details: '## Steps\n\n1. Open the planner\n2. Reload' },
          { text: 'Keep the week in the URL', source: 'GF-123' },
          { text: 'Add a regression test', details: 'Use `planner.spec.ts`.', source: 'GF-124' },
        ],
      },
      client,
    ),
  );
  const work = (r.structured as { work: Step[] }).work;
  return { run_id, work, ids: work.map((s) => s.id) };
}

describe('set_plan stores details and source (MCP_SPEC §5.12)', () => {
  it('on new steps: details_version 1 with details, 0 without; results carry only the marker', async () => {
    await start();
    const { work, ids } = await planWithDetails();
    expect(work.map((s) => [s.has_details, s.source])).toEqual([
      [true, null],
      [false, 'GF-123'],
      [true, 'GF-124'],
    ]);
    expect(work.every((s) => !('details_md' in s))).toBe(true);
    expect(row(ids[0]!)).toMatchObject({
      details_md: '## Steps\n\n1. Open the planner\n2. Reload',
      details_version: 1,
    });
    expect(row(ids[1]!)).toMatchObject({ details_md: null, details_version: 0, source: 'GF-123' });
    // The event records versions, never the text.
    expect(lastEvent('plan.updated').data.changed).toEqual({});
    expect(JSON.stringify(lastEvent('plan.updated').data)).not.toContain('Open the planner');
  });

  it('patches: omitted keeps them across revisions; null or empty clears; the same text changes nothing', async () => {
    await start();
    const { run_id, ids } = await planWithDetails();
    const [a, b, c] = ids as [string, string, string];
    // A revision that changes a's text and b's state, and adds a step, keeps every detail.
    expectOk(
      await h!.call('set_plan', {
        id: 'RCP-17',
        run_id,
        reason: 'Narrow the repro',
        steps: [
          { id: a, text: 'Reproduce the jump after reload' },
          { id: b, state: 'current' },
          { text: 'Ship it' },
        ],
      }),
    );
    expect(row(a)).toMatchObject({
      details_version: 1,
      details_md: expect.stringContaining('Reload'),
    });
    expect(row(c)).toMatchObject({ details_version: 1, source: 'GF-124' });
    // Replace mode keeps details on the steps it lists.
    expectOk(
      await h!.call('set_plan', {
        id: 'RCP-17',
        run_id,
        reason: 'Restate',
        mode: 'replace',
        steps: [{ id: c }, { id: a }, { id: b }],
      }),
    );
    expect(row(c)).toMatchObject({ details_version: 1, details_md: 'Use `planner.spec.ts`.' });
    // Writing the same details again changes nothing; new text bumps; empty and null clear.
    const same = {
      id: 'RCP-17',
      run_id,
      reason: 'r',
      steps: [{ id: c, details: 'Use `planner.spec.ts`.' }],
    };
    expectOk(await h!.call('set_plan', same));
    expect(row(c).details_version).toBe(1);
    expectOk(
      await h!.call('set_plan', {
        id: 'RCP-17',
        run_id,
        reason: 'r',
        steps: [{ id: c, details: 'New' }],
      }),
    );
    expect(row(c)).toMatchObject({ details_md: 'New', details_version: 2 });
    const changed = lastEvent('plan.updated').data.changed as Record<string, S>;
    expect(changed[c]).toEqual({ details_version: { old: 1, new: 2 } });
    expectOk(
      await h!.call('set_plan', {
        id: 'RCP-17',
        run_id,
        reason: 'r',
        steps: [{ id: c, details: '  ' }],
      }),
    );
    expect(row(c)).toMatchObject({ details_md: null, details_version: 3 });
    expectOk(
      await h!.call('set_plan', {
        id: 'RCP-17',
        run_id,
        reason: 'r',
        steps: [{ id: a, details: null, source: null }],
      }),
    );
    expect(row(a)).toMatchObject({ details_md: null, details_version: 2, source: null });
  });

  it('refuses details over 10,000 characters and sources over 100, with the limit', async () => {
    await start();
    const { run_id, ids } = await planWithDetails();
    const tooLong = expectValidation(
      await h!.call('set_plan', {
        id: 'RCP-17',
        run_id,
        reason: 'r',
        steps: [{ id: ids[0], details: 'x'.repeat(10_001) }],
      }),
    );
    expect(tooLong.message).toMatch(/10000|10,000/);
    expectValidation(
      await h!.call('set_plan', {
        id: 'RCP-17',
        run_id,
        reason: 'r',
        steps: [{ id: ids[0], source: 's'.repeat(101) }],
      }),
    );
  });

  it('runs the write checks on details and source: secrets are refused, unknown item IDs warn', async () => {
    await start();
    const { run_id, ids } = await planWithDetails();
    const secret = expectValidation(
      await h!.call('set_plan', {
        id: 'RCP-17',
        run_id,
        reason: 'r',
        steps: [{ id: ids[0], details: 'Use ghp_abcdefghijklmnopqrstuvwxyz0123456789 to push' }],
      }),
    );
    expect(secret.message).toMatch(/secret/i);
    expect(row(ids[0]!).details_md).not.toContain('ghp_');
    const r = expectOk(
      await h!.call('set_plan', {
        id: 'RCP-17',
        run_id,
        reason: 'r',
        steps: [{ id: ids[0], details: 'Same root cause as RCP-999.' }],
      }),
    );
    expect(r.structured.warnings).toEqual(["RCP-999 doesn't exist"]);
    expect(r.text).toContain("! RCP-999 doesn't exist");
  });
});

describe('get_item shows a marker in standard and the details in full', () => {
  it('standard: has_details and "· details", never the text; full: details_md and the text', async () => {
    await start();
    const { ids } = await planWithDetails();
    const std = expectOk(await h!.call('get_item', { id: 'RCP-17' }));
    const work = (std.structured.item as { checklist: { work: Step[] } }).checklist.work;
    expect(work.every((s) => !('details_md' in s) && !('details_version' in s))).toBe(true);
    expect(std.text).toContain(`${ids[0]} Reproduce the jump · details`);
    expect(std.text).toContain(`${ids[1]} Keep the week in the URL · source GF-123\n`);
    expect(std.text).toContain(`${ids[2]} Add a regression test · source GF-124 · details`);
    expect(std.text).not.toContain('Open the planner');

    const full = expectOk(await h!.call('get_item', { id: 'RCP-17', view: 'full' }));
    const fw = (full.structured.item as { checklist: { work: Step[] } }).checklist.work;
    expect(fw.map((s) => [s.details_md, s.details_version])).toEqual([
      ['## Steps\n\n1. Open the planner\n2. Reload', 1],
      [null, 0],
      ['Use `planner.spec.ts`.', 1],
    ]);
    expect(full.text).toContain('      details:\n        ## Steps\n\n        1. Open the planner');
  });
});

describe('update_step replaces details (MCP_SPEC §5.12)', () => {
  it('replaces with a version check; the same state changes the details only; null clears', async () => {
    await start();
    const { run_id, ids } = await planWithDetails();
    const b = ids[1]!;
    const before = row(b);
    const r = expectOk(
      await h!.call('update_step', {
        id: 'RCP-17',
        run_id,
        step_id: b,
        state: 'todo',
        details: 'Store `?week=` in the URL',
        expected_details_version: 0,
      }),
    );
    expect((r.structured.step as Step).has_details).toBe(true);
    expect(row(b)).toMatchObject({ details_version: 1, state: 'todo', state_at: before.state_at });
    const detailsOnly = lastEvent('step.updated').data;
    expect(detailsOnly).toMatchObject({ step_id: b, details_version: { old: 0, new: 1 } });
    expect(detailsOnly).not.toHaveProperty('state');
    expect(lastEvent('step.updated').summary).toContain('updated the details of');

    const stale = expectConflict(
      await h!.call('update_step', {
        id: 'RCP-17',
        run_id,
        step_id: b,
        state: 'todo',
        details: 'Other',
        expected_details_version: 0,
      }),
    );
    expect(stale.message).toContain('now v1, you sent v0');
    expect((stale.current as Step).details_md).toBe('Store `?week=` in the URL');

    // A state change with new details does both.
    expectOk(
      await h!.call('update_step', {
        id: 'RCP-17',
        run_id,
        step_id: b,
        state: 'current',
        details: null,
      }),
    );
    expect(row(b)).toMatchObject({ details_md: null, details_version: 2, state: 'current' });
    expect(lastEvent('step.updated').data).toMatchObject({
      state: { old: 'todo', new: 'current' },
      details_version: { old: 1, new: 2 },
    });
    // Without details, update_step works as before.
    expectOk(await h!.call('update_step', { id: 'RCP-17', run_id, step_id: b, state: 'done' }));
    expect(row(b)).toMatchObject({ state: 'done', details_version: 2 });
  });
});

describe("owner-added steps keep the owner's details", () => {
  it("agents can't change an owner step's details or source, only its state", async () => {
    await start();
    const { run_id } = await planWithDetails();
    const owner = await ownerApi();
    const added = await owner('POST', '/api/items/RCP-17/work', { text: 'Check on a phone' });
    expect(added.status).toBe(200);
    const sid = (added.body.step as Step).id;
    const set = await owner('PATCH', `/api/items/RCP-17/work/${sid}/details`, {
      details: 'Owner notes',
      expected_version: 0,
    });
    expect(set.status).toBe(200);
    expectForbidden(
      await h!.call('set_plan', {
        id: 'RCP-17',
        run_id,
        reason: 'r',
        steps: [{ id: sid, details: 'Mine' }],
      }),
    );
    expectForbidden(
      await h!.call('set_plan', {
        id: 'RCP-17',
        run_id,
        reason: 'r',
        steps: [{ id: sid, source: 'X-1' }],
      }),
    );
    expectForbidden(
      await h!.call('update_step', {
        id: 'RCP-17',
        run_id,
        step_id: sid,
        state: 'todo',
        details: 'Mine',
      }),
    );
    expectOk(
      await h!.call('update_step', { id: 'RCP-17', run_id, step_id: sid, state: 'current' }),
    );
    expect(row(sid)).toMatchObject({
      details_md: 'Owner notes',
      details_version: 1,
      state: 'current',
    });
  });
});

describe('get_step (MCP_SPEC §5.12)', () => {
  it('returns the step in full with its history; the text block ends with the details verbatim', async () => {
    await start();
    const { run_id, ids } = await planWithDetails();
    const a = ids[0]!;
    await h!.call('set_plan', {
      id: 'RCP-17',
      run_id,
      reason: 'Narrow it',
      steps: [{ id: a, text: 'Reproduce the jump after reload', change_reason: 'Only on reload' }],
    });
    await h!.call('update_step', { id: 'RCP-17', run_id, step_id: a, state: 'current' });
    await h!.call('log_subagent', {
      id: 'RCP-17',
      run_id,
      step_id: a,
      name: 'explorer',
      outcome: 'Found the reset in usePlannerWeek',
      provenance: 'relayed',
    });
    await h!.call('update_step', {
      id: 'RCP-17',
      run_id,
      step_id: a,
      state: 'current',
      details: '## Steps\n\n1. Open the planner\n2. Reload\n\nResets in `usePlannerWeek`.',
    });

    const r = expectOk(await h!.call('get_step', { id: 'RCP-17', step_id: a }));
    const step = r.structured.step as Step;
    expect(step).toMatchObject({
      id: a,
      text: 'Reproduce the jump after reload',
      state: 'current',
      has_details: true,
      details_version: 2,
      details_md: '## Steps\n\n1. Open the planner\n2. Reload\n\nResets in `usePlannerWeek`.',
    });
    const history = r.structured.history as S[];
    expect(history.map((x) => [x.change, x.from ?? null, x.to ?? null])).toEqual([
      ['added', null, null],
      ['text', 'Reproduce the jump', 'Reproduce the jump after reload'],
      ['state', 'todo', 'current'],
      ['details', 'v1', 'v2'],
    ]);
    expect(history[1]!.note).toBe('Only on reload');
    expect(history.every((x) => typeof x.by === 'string' && x.by.length > 0)).toBe(true);
    const lines = r.text.split('\n');
    expect(lines[0]).toBe(
      `${a} Reproduce the jump after reload · current · on RCP-17 · details v2`,
    );
    expect(r.text).toContain(
      '  subagents:\n    relayed explorer: Found the reset in usePlannerWeek',
    );
    expect(r.text.endsWith(`characters, verbatim):\n${step.details_md}`)).toBe(true);
    console.log(
      [
        '',
        '--- get_step structuredContent ---',
        JSON.stringify(r.structured, null, 2),
        '--- get_step text ---',
        r.text,
      ].join('\n'),
    );
  });

  it('reads a removed step by its id; unknown steps and items are not_found; it is a read', async () => {
    await start();
    const { run_id, ids } = await planWithDetails();
    await h!.call('set_plan', { id: 'RCP-17', run_id, reason: 'Drop it', remove: [ids[2]] });
    const gone = expectOk(await h!.call('get_step', { id: 'RCP-17', step_id: ids[2] }));
    expect((gone.structured.step as Step).details_md).toBe('Use `planner.spec.ts`.');
    expectNotFound(await h!.call('get_step', { id: 'RCP-17', step_id: 'wst_nope' }));
    expectNotFound(await h!.call('get_step', { id: 'RCP-14', step_id: ids[0] }));
    expectNotFound(await h!.call('get_step', { id: 'RCP-999', step_id: ids[0] }));
    const events = h!.server.runtime.db.sqlite
      .prepare('SELECT count(*) AS n FROM events')
      .get() as {
      n: number;
    };
    await h!.call('get_step', { id: 'RCP-17', step_id: ids[0] });
    expect(
      (
        h!.server.runtime.db.sqlite.prepare('SELECT count(*) AS n FROM events').get() as {
          n: number;
        }
      ).n,
    ).toBe(events.n);
  });

  it('text-only sessions get the same text block and no structuredContent', async () => {
    await start({ DOCKET_TEXT_ONLY_CLIENTS: 'claude-code' });
    const { ids } = await planWithDetails(h!.b);
    const structured = expectOk(await h!.call('get_step', { id: 'RCP-17', step_id: ids[0] }, h!.b));
    const res = await h!.call('get_step', { id: 'RCP-17', step_id: ids[0] });
    expect(res.isError ?? false).toBe(false);
    expect(res.structuredContent).toBeUndefined();
    expect(textOf(res)).toBe(structured.text);
    console.log(['', '--- get_step text-only (claude-code) ---', textOf(res)].join('\n'));
  });
});

describe('PATCH /api/items/:id/work/:stepId/details (UI_SPEC §6.3.1a)', () => {
  it('edits with a version check, records an owner event with via, and is undoable', async () => {
    await start();
    const { ids } = await planWithDetails();
    const owner = await ownerApi();
    const path = `/api/items/RCP-17/work/${ids[1]}/details`;
    const ok = await owner('PATCH', path, {
      details: '## Owner\n\nKeep `week`.',
      expected_version: 0,
    });
    expect(ok.status).toBe(200);
    expect(ok.body.step).toMatchObject({
      details_md: '## Owner\n\nKeep `week`.',
      details_version: 1,
      has_details: true,
    });
    expect(typeof ok.body.mutation_id).toBe('string');
    const e = lastEvent('step.updated');
    expect(e.actor_kind).toBe('owner');
    expect(e.data).toMatchObject({
      step_id: ids[1],
      details_version: { old: 0, new: 1 },
      via: 'browser',
    });
    expect(e.summary).toContain('You edited the details of');

    const stale = await owner('PATCH', path, { details: 'Late', expected_version: 0 });
    expect(stale.status).toBe(409);
    expect((stale.body.error as S).code).toBe('conflict');
    expect(((stale.body.error as S).current as Step).details_version).toBe(1);

    // An agent sees the change.
    const seen = expectOk(await h!.call('get_step', { id: 'RCP-17', step_id: ids[1] }));
    expect((seen.structured.step as Step).details_md).toBe('## Owner\n\nKeep `week`.');

    const undone = await owner('POST', `/api/mutations/${ok.body.mutation_id as string}/undo`);
    expect(undone.status).toBe(200);
    expect(row(ids[1]!)).toMatchObject({ details_md: null, details_version: 0 });

    const secret = await owner('PATCH', path, {
      details: 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      expected_version: 0,
    });
    expect(secret.status).toBe(400);
    expect(row(ids[1]!).details_md).toBeNull();

    const missing = await owner('PATCH', '/api/items/RCP-17/work/wst_nope/details', {
      details: 'x',
      expected_version: 0,
    });
    expect(missing.status).toBe(404);
    const tooLong = await owner('PATCH', path, {
      details: 'x'.repeat(10_001),
      expected_version: 0,
    });
    expect(tooLong.status).toBe(400);
  });
});

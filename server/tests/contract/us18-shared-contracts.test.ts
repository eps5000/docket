/**
 * Shared changes, the B38 contract (owner decision 36; BUILD_SPEC §5.21;
 * MCP_SPEC §5.15; UI_SPEC §6.3.6; tasks.md T182), through the official MCP
 * client SDK and the owner API:
 *
 * - `declare_shared_changes` replaces an item's declaration or declares none,
 *   registers `new_parts` (never single-writer), and returns the in-flight
 *   items that declare the same parts, except pairs a `blocks` link already
 *   sequences; the item's version doesn't move;
 * - `list_shared_parts` reads the registry with in-flight declarations;
 * - the owner's registry and declaration routes, undoable, and the radar
 *   card's defaults.
 *
 * B39 (T183, T184) made B38's `it.todo` list true, each as a test below: the
 * Ready gate, overlaps at the claim and their decisions, leases, the hold at
 * hand-off, `get_context.shared`, the conflict radar (against a fixture repo,
 * proven read-only) and SC-023's unattended two-agent run.
 */
import { CSRF_HEADER_NAME } from '@docket/shared';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { radarRunOnce } from '../../src/jobs/sweeper.js';
import {
  git,
  hashGitDir,
  makeBranchRepo,
  makeEpicRepo,
  makeRadarRepo,
} from '../fixtures/radar-repo.js';
import { hostGitFactsFor } from '../../src/domain/host-git.js';
import { RADAR_OFF_UNREADABLE } from '../../src/domain/radar.js';
import { gitSettings, hostGitPass } from '../host-git.js';
import { insertItem, insertProject, tempDir } from '../helpers.js';
import { ORIGIN, parseSetCookies } from '../integration/harness.js';
import {
  CONTRACT_NOW,
  expectOk,
  expectToolError,
  expectValidation,
  startHarness,
  tokens,
  type ContractHarness,
} from './harness.js';
import { writeDefaultHandling } from '../../src/domain/overlap-policy.js';

let h: ContractHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

type S = Record<string, unknown>;

const sql = () => h!.server.runtime.db.sqlite;
/** Whether the git CLI is on PATH (the radar test needs it). */
const HAS_GIT = spawnSync('git', ['--version'], { windowsHide: true }).status === 0;

/** B76: the trial merges of two items' branches the helper last sent for a project. */
function gitPairs(server: ContractHarness['server'], key: string): Record<string, unknown> {
  const p = server.runtime.db.sqlite
    .prepare('SELECT repo_path, main_branch FROM projects WHERE key = ?')
    .get(key) as { repo_path: string | null; main_branch: string };
  return hostGitFactsFor(server.runtime.db, { key, ...p })?.pairs ?? {};
}
const count = (q: string, ...params: unknown[]) =>
  (
    sql()
      .prepare(q)
      .get(...params) as { n: number }
  ).n;
const version = (id: string) =>
  (sql().prepare('SELECT version FROM items WHERE id = ?').get(id) as { version: number }).version;

/** An owner client: unlock, then requests with the session cookie and the CSRF header. */
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

const declare = (args: S) => h!.call('declare_shared_changes', args);

/**
 * Decision 39 (B46): *Ask on every overlap* is decision 36's behaviour, which
 * this file pins. b46-overlaps.test.ts covers the default, *Agents resolve*.
 */
async function askEveryHarness(opts?: Parameters<typeof startHarness>[0]) {
  const harness = await startHarness(opts);
  writeDefaultHandling(harness.server.runtime.db, 'ask_every', CONTRACT_NOW.toISOString());
  return harness;
}

describe('declare_shared_changes (MCP_SPEC §5.15)', () => {
  it('registers new parts, replaces the declaration, and returns in-flight overlaps', async () => {
    h = await askEveryHarness();
    const first = expectOk(
      await declare({
        id: 'RCP-18',
        changes: [{ part: 'Model:Recipe', change: 'change', note: 'Adds source URL' }],
        new_parts: [{ key: 'model:Recipe', paths: ['./server/src/models/recipe.ts'] }],
      }),
    );
    expect(first.structured).toMatchObject({
      declaration: {
        item_id: 'RCP-18',
        state: 'declared',
        changes: [
          { part: 'model:Recipe', kind: 'model', change: 'change', note: 'Adds source URL' },
        ],
        declared_by: 'claude',
      },
      registered: ['model:Recipe'],
      overlaps: [],
    });
    expect(first.text).toBe('Declared 1 change on RCP-18 · registered model:Recipe');

    // RCP-14 (In progress) overlaps RCP-18 on model:Recipe; the part is reused, not re-registered.
    const before = version('RCP-14');
    const second = expectOk(
      await declare({
        id: 'RCP-14',
        changes: [
          { part: 'model:Recipe', change: 'change' },
          { part: 'table:shopping_lists', change: 'add' },
        ],
        new_parts: [{ key: 'model:Recipe' }, { key: 'Table:Shopping_Lists', kind: 'table' }],
      }),
    );
    expect(second.structured.registered).toEqual(['table:shopping_lists']);
    expect(second.structured.overlaps).toEqual([
      {
        with: { id: 'RCP-18', title: 'Import recipes from URL', status: 'progress' },
        parts: ['model:Recipe'],
        outcome: 'owner',
        reason: 'setting',
      },
    ]);
    expect(second.text).toBe(
      'Declared 2 changes on RCP-14 · registered table:shopping_lists · overlaps RCP-18 on model:Recipe (owner decides)',
    );
    // A declaration isn't an edit of the item: its version doesn't move.
    expect(version('RCP-14')).toBe(before);

    // RCP-21 is blocked by RCP-14 (a blocks link): that pair is sequenced, so only RCP-18 overlaps.
    const third = expectOk(
      await declare({ id: 'RCP-21', changes: [{ part: 'model:Recipe', change: 'change' }] }),
    );
    expect((third.structured.overlaps as { with: { id: string } }[]).map((o) => o.with.id)).toEqual(
      ['RCP-18'],
    );

    // An item in Inbox may declare; it sees the in-flight items, and isn't in flight itself.
    const inbox = expectOk(
      await declare({ id: 'RCP-20', changes: [{ part: 'model:Recipe', change: 'remove' }] }),
    );
    expect((inbox.structured.overlaps as { with: { id: string } }[]).map((o) => o.with.id)).toEqual(
      ['RCP-14', 'RCP-18', 'RCP-21'],
    );

    // Replacing: RCP-14 drops model:Recipe; then declares none.
    expectOk(
      await declare({
        id: 'RCP-14',
        changes: [{ part: 'table:shopping_lists', change: 'change', note: 'Index' }],
      }),
    );
    expect(
      sql()
        .prepare("SELECT part_key, change, note FROM item_shared_changes WHERE item_id = 'RCP-14'")
        .all(),
    ).toEqual([{ part_key: 'table:shopping_lists', change: 'change', note: 'Index' }]);
    const none = expectOk(await declare({ id: 'RCP-14', none: true }));
    expect(none.structured.declaration).toMatchObject({
      state: 'none',
      changes: [],
      declared_by: 'claude',
    });
    expect(none.text).toBe('Declared none on RCP-14');
    expect(count("SELECT count(*) AS n FROM item_shared_changes WHERE item_id = 'RCP-14'")).toBe(0);
    expect(
      count("SELECT count(*) AS n FROM items WHERE id = 'RCP-14' AND shared_none_at IS NOT NULL"),
    ).toBe(1);
    // Declaring parts again clears shared_none_at.
    expectOk(await declare({ id: 'RCP-14', changes: [{ part: 'model:Recipe', change: 'add' }] }));
    expect(
      count("SELECT count(*) AS n FROM items WHERE id = 'RCP-14' AND shared_none_at IS NULL"),
    ).toBe(1);
    expect(version('RCP-14')).toBe(before);

    // Events: one shared.declared per call, one shared_part.saved per registered part.
    expect(count("SELECT count(*) AS n FROM events WHERE type = 'shared.declared'")).toBe(7);
    expect(count("SELECT count(*) AS n FROM events WHERE type = 'shared_part.saved'")).toBe(2);
    expect(
      sql().prepare('SELECT created_by, single_writer FROM shared_parts ORDER BY key').all(),
    ).toEqual([
      { created_by: 'claude', single_writer: 0 },
      { created_by: 'claude', single_writer: 0 },
    ]);
  });

  it('refuses unknown or archived parts, closed items, and single_writer from agents', async () => {
    h = await askEveryHarness();
    const unknown = expectValidation(
      await declare({ id: 'RCP-14', changes: [{ part: 'model:Ghost', change: 'add' }] }),
    );
    expect(unknown.message).toContain("isn't registered in RCP: model:Ghost");
    expect(unknown.details).toEqual({ parts: ['model:Ghost'] });

    const done = expectValidation(await declare({ id: 'RCP-11', none: true }));
    expect(done.message).toBe('RCP-11 is done; declare shared changes on open items only.');

    expectValidation(
      await declare({
        id: 'RCP-14',
        changes: [{ part: 'model:Recipe', change: 'add' }],
        new_parts: [{ key: 'model:Recipe', single_writer: true }],
      }),
    );
    expectValidation(await declare({ id: 'RCP-14', changes: [{ part: 'Recipe', change: 'add' }] }));
    expectToolError(await declare({ id: 'RCP-99', none: true }), 'not_found');
    // Nothing was written by any of these.
    expect(count('SELECT count(*) AS n FROM shared_parts')).toBe(0);
    expect(count("SELECT count(*) AS n FROM events WHERE type LIKE 'shared%'")).toBe(0);

    const ownerApi = await owner();
    const created = await ownerApi('POST', '/api/projects/RCP/shared-parts', {
      key: 'model:Recipe',
    });
    const part = created.body.part as { id: string; version: number };
    await ownerApi('PATCH', `/api/shared-parts/${part.id}`, {
      expected_version: part.version,
      archived: true,
    });
    const archived = expectValidation(
      await declare({ id: 'RCP-14', changes: [{ part: 'model:Recipe', change: 'add' }] }),
    );
    expect(archived.message).toContain('is archived: model:Recipe');
  });

  it('a secret in a note is refused before anything is stored', async () => {
    h = await askEveryHarness();
    const err = expectValidation(
      await declare({
        id: 'RCP-14',
        changes: [
          { part: 'model:Recipe', change: 'add', note: 'token ghp_abcdefghijklmnopqrstuvwxyz0123' },
        ],
        new_parts: [{ key: 'model:Recipe' }],
      }),
    );
    expect(err.message).toMatch(/^Looks like a secret/);
    expect(count('SELECT count(*) AS n FROM shared_parts')).toBe(0);
  });
});

describe('list_shared_parts (MCP_SPEC §5.15)', () => {
  it('lists parts by key with their in-flight declarations, and writes nothing', async () => {
    h = await askEveryHarness();
    expectOk(
      await declare({
        id: 'RCP-18',
        changes: [{ part: 'model:Recipe', change: 'change', note: 'Adds source URL' }],
        new_parts: [
          { key: 'model:Recipe', paths: ['server/src/models/recipe.ts'] },
          { key: 'other:Feature Flags' },
        ],
      }),
    );
    expectOk(await declare({ id: 'RCP-20', changes: [{ part: 'model:Recipe', change: 'add' }] }));
    const events = count('SELECT count(*) AS n FROM events');
    const r = expectOk(await h.call('list_shared_parts', { project: 'RCP' }));
    expect(r.structured).toEqual({
      project: 'RCP',
      parts: [
        {
          key: 'model:Recipe',
          kind: 'model',
          paths: ['server/src/models/recipe.ts'],
          single_writer: false,
          note: null,
          created_by: 'claude',
          archived: false,
          // RCP-20 is in Inbox: not in flight.
          in_flight: [
            {
              id: 'RCP-18',
              title: 'Import recipes from URL',
              status: 'progress',
              change: 'change',
              note: 'Adds source URL',
            },
          ],
          lease: null,
        },
        {
          key: 'other:feature-flags',
          kind: 'other',
          paths: [],
          single_writer: false,
          note: null,
          created_by: 'claude',
          archived: false,
          in_flight: [],
          lease: null,
        },
      ],
    });
    expect(r.text.split('\n')).toEqual([
      'Shared parts in RCP: 2',
      '- model:Recipe · paths server/src/models/recipe.ts',
      '    RCP-18 Import recipes from URL · progress · change · Adds source URL',
      '- other:feature-flags',
    ]);
    expect(count('SELECT count(*) AS n FROM events')).toBe(events);
    expectToolError(await h.call('list_shared_parts', { project: 'ZZZ' }), 'not_found');
  });
});

describe('the owner API (UI_SPEC §6.3.6)', () => {
  it('creates, edits, archives and restores registry parts; creating and editing are undoable', async () => {
    h = await askEveryHarness();
    const api = await owner();
    const created = await api('POST', '/api/projects/RCP/shared-parts', {
      key: 'File: .\\server\\src\\db\\migrations\\meta\\_journal.json',
      single_writer: true,
      note: 'One migration at a time',
    });
    expect(created.status).toBe(200);
    const part = created.body.part as S & { id: string; version: number };
    expect(part).toMatchObject({
      key: 'file:server/src/db/migrations/meta/_journal.json',
      kind: 'file',
      single_writer: true,
      created_by: 'owner',
      archived_at: null,
      version: 1,
      in_flight: [],
      lease: null,
    });
    expect(part.id).toMatch(/^spt_/);
    expect(
      (
        await api('POST', '/api/projects/RCP/shared-parts', {
          key: 'file:server/src/db/migrations/meta/_journal.json',
        })
      ).status,
    ).toBe(400);

    const edited = await api('PATCH', `/api/shared-parts/${part.id}`, {
      expected_version: 1,
      paths: ['server/src/db/migrations/**'],
      single_writer: false,
    });
    expect(edited.body.part).toMatchObject({
      paths: ['server/src/db/migrations/**'],
      single_writer: false,
      version: 2,
    });
    const stale = await api('PATCH', `/api/shared-parts/${part.id}`, {
      expected_version: 1,
      note: null,
    });
    expect(stale.status).toBe(409);

    // Undo the edit: back to version 1's values.
    const undo = await api('POST', `/api/mutations/${edited.body.mutation_id as string}/undo`);
    expect(undo.status).toBe(200);
    const listed = await api('GET', '/api/projects/RCP/shared-parts');
    expect((listed.body.parts as S[])[0]).toMatchObject({ paths: [], single_writer: true });

    // Archive hides it unless include_archived; restore brings it back.
    const v = (listed.body.parts as { version: number }[])[0]!.version;
    await api('PATCH', `/api/shared-parts/${part.id}`, { expected_version: v, archived: true });
    expect(((await api('GET', '/api/projects/RCP/shared-parts')).body.parts as S[]).length).toBe(0);
    const all = await api('GET', '/api/projects/RCP/shared-parts?include_archived=true');
    expect((all.body.parts as S[])[0]).toMatchObject({ archived: true });
    expect((await api('GET', '/api/projects/ZZZ/shared-parts')).status).toBe(404);
    expect(
      (await api('PATCH', '/api/shared-parts/spt_nope', { expected_version: 1, archived: true }))
        .status,
    ).toBe(404);
  });

  it('reads and edits an item’s declaration; the edit is undoable; new parts may be single-writer', async () => {
    h = await askEveryHarness();
    const api = await owner();
    const empty = await api('GET', '/api/items/RCP-14/shared');
    expect(empty.body).toEqual({
      declaration: {
        item_id: 'RCP-14',
        state: 'not_declared',
        changes: [],
        declared_by: null,
        declared_at: null,
      },
      // B40, B41: no branch reported or found yet.
      branches: { reported: [], discovered: null, matches: [] },
      overlaps: [],
      leases: [],
      findings: [],
      holds: [],
    });

    const put = await api('PUT', '/api/items/RCP-14/shared', {
      changes: [{ part: 'file:server/src/db/schema.ts', change: 'change', note: 'Adds a column' }],
      new_parts: [{ key: 'file:server/src/db/schema.ts', single_writer: true }],
    });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({
      registered: ['file:server/src/db/schema.ts'],
      declaration: { state: 'declared', declared_by: 'owner' },
    });
    expect(sql().prepare('SELECT single_writer, created_by FROM shared_parts').get()).toEqual({
      single_writer: 1,
      created_by: 'owner',
    });

    const none = await api('PUT', '/api/items/RCP-14/shared', { none: true });
    expect((none.body.declaration as S).state).toBe('none');
    const undo = await api('POST', `/api/mutations/${none.body.mutation_id as string}/undo`);
    expect(undo.status).toBe(200);
    const back = await api('GET', '/api/items/RCP-14/shared');
    expect(back.body.declaration).toMatchObject({
      state: 'declared',
      changes: [{ part: 'file:server/src/db/schema.ts', change: 'change', note: 'Adds a column' }],
    });
    expect((await api('PUT', '/api/items/RCP-11/shared', { none: true })).status).toBe(400);
    expect((await api('GET', '/api/items/RCP-99/shared')).status).toBe(404);
  });

  it('the radar card is off with no repository; unknown decisions and leases are not_found', async () => {
    h = await askEveryHarness();
    const api = await owner();
    expect((await api('GET', '/api/projects/RCP/radar')).body).toEqual({
      project: 'RCP',
      repo_path: null,
      main_branch: 'main',
      state: 'off',
      off_reason: 'Radar off: no repository',
      last_run_at: null,
      last_duration_ms: null,
      helper: { state: 'none', checked_at: null },
      findings: [],
    });
    for (const [path, body] of [
      ['/api/overlaps/pov_1/decide', { decision: 'sequence' }],
      ['/api/undeclared-holds/udh_1/decide', { decision: 'send_back' }],
      ['/api/leases/pls_1/release', {}],
    ] as const) {
      expect((await api('POST', path, body)).status, path).toBe(404);
    }
  });

  it('PATCH /api/items/:id takes override_reason only with status ready', async () => {
    h = await askEveryHarness();
    const api = await owner();
    const v = version('RCP-23');
    const ok = await api('PATCH', '/api/items/RCP-23', {
      expected_version: v,
      status: 'ready',
      override_reason: 'Docs only; touches no shared part',
    });
    expect(ok.status).toBe(200);
    const bad = await api('PATCH', '/api/items/RCP-23', {
      expected_version: v + 1,
      priority: 1,
      override_reason: 'x',
    });
    expect(bad.status).toBe(400);
  });
});

// ---- B39 (T183, T184): the guards, leases, holds, context and radar ----

type R = Awaited<ReturnType<ContractHarness['call']>>;

const items = (r: R) => (expectOk(r).structured.items as { id: string }[]).map((i) => i.id);
const status = (id: string) =>
  (sql().prepare('SELECT status FROM items WHERE id = ?').get(id) as { status: string }).status;
const events = (type: string, item?: string) =>
  sql()
    .prepare(
      `SELECT summary, data FROM events WHERE type = ? ${item ? 'AND item_id = ?' : ''} ORDER BY seq`,
    )
    .all(...(item ? [type, item] : [type])) as { summary: string; data: string }[];

/** Register `model:Recipe` (paths in server/src/models) and `table:decks` as the owner. */
async function registry(api: Awaited<ReturnType<typeof owner>>, extra: S[] = []) {
  for (const part of [
    { key: 'model:Recipe', paths: ['server/src/models/recipe.ts'] },
    { key: 'table:decks', paths: ['server/src/db/decks/**'] },
    ...extra,
  ]) {
    expect((await api('POST', '/api/projects/RCP/shared-parts', part)).status).toBe(200);
  }
}

/** A new item, declared (none unless `parts`), moved to Ready and claimed by `client`. */
async function started(title: string, client = h!.a, parts?: string[]) {
  const created = expectOk(
    await h!.call(
      'create_item',
      { project: 'RCP', type: 'Task', title, status: 'planning' },
      client,
    ),
  );
  const id = (created.structured.item as { id: string }).id;
  expectOk(
    await declare(
      parts
        ? { id, changes: parts.map((part) => ({ part, change: 'change' })) }
        : { id, none: true },
    ),
  );
  expectOk(await h!.call('set_status', { id, status: 'ready' }, client));
  const claim = expectOk(await h!.call('claim_lead', { id }, client));
  return { id, run_id: claim.structured.run_id as string };
}

describe('the Ready gate (FR-159)', () => {
  it('set_status ready on an item without a declaration (or none) is not_declared, for agents and the owner', async () => {
    h = await askEveryHarness();
    const created = expectOk(
      await h.call('create_item', {
        project: 'RCP',
        type: 'Task',
        title: 'Tags',
        status: 'planning',
      }),
    );
    const id = (created.structured.item as { id: string }).id;
    const refused = expectToolError(
      await h.call('set_status', { id, status: 'ready' }),
      'not_declared',
    );
    expect(refused.message).toBe(
      `Declare the shared parts ${id} will change (or none) with declare_shared_changes, then move it to Ready. It also has no outcome and no acceptance criteria.`,
    );
    expect(status(id)).toBe('planning');
    expectOk(await declare({ id, none: true }));
    expect(
      (expectOk(await h.call('set_status', { id, status: 'ready' })).structured.item as S).status,
    ).toBe('ready');

    // The owner too, without a reason.
    const api = await owner();
    const res = await api('PATCH', '/api/items/RCP-23', {
      expected_version: version('RCP-23'),
      status: 'ready',
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: { code: 'not_declared' } });
    expect((res.body.error as S).message).toContain('or give a reason to move it anyway');
    expect(status('RCP-23')).toBe('planning');

    // Giving up work (In progress → Ready) isn't gated: the item was Ready before.
    const claim = expectOk(await h.call('claim_lead', { id: 'RCP-17' }));
    expectOk(
      await h.call('set_status', {
        id: 'RCP-17',
        status: 'ready',
        run_id: claim.structured.run_id,
      }),
    );
    expect(status('RCP-17')).toBe('ready');
  });

  it('the owner moves an undeclared item to Ready with override_reason, recorded in Activity', async () => {
    h = await askEveryHarness();
    const api = await owner();
    const res = await api('PATCH', '/api/items/RCP-23', {
      expected_version: version('RCP-23'),
      status: 'ready',
      override_reason: 'Templates only; touches no shared part',
    });
    expect(res.status).toBe(200);
    expect(status('RCP-23')).toBe('ready');
    const ev = events('item.status_changed', 'RCP-23').at(-1)!;
    expect(ev.summary).toBe(
      'You moved RCP-23 from planning to ready without declaring its shared changes: Templates only; touches no shared part',
    );
    expect(JSON.parse(ev.data)).toMatchObject({
      override_reason: 'Templates only; touches no shared part',
    });
    // A declared item records no override.
    expectOk(await declare({ id: 'RCP-27', none: true }));
    await api('PATCH', '/api/items/RCP-27', {
      expected_version: version('RCP-27'),
      status: 'ready',
      override_reason: 'Not needed',
    });
    expect(events('item.status_changed', 'RCP-27').at(-1)!.summary).toBe(
      'You moved RCP-27 from planning to ready',
    );
  });
});

describe('overlaps at the claim (FR-160)', () => {
  /** RCP-14 (In progress) and RCP-17 (Ready) both declare model:Recipe. */
  async function overlapping() {
    h = await askEveryHarness();
    const api = await owner();
    await registry(api);
    expectOk(
      await declare({ id: 'RCP-14', changes: [{ part: 'model:Recipe', change: 'change' }] }),
    );
    expectOk(await declare({ id: 'RCP-17', changes: [{ part: 'model:Recipe', change: 'add' }] }));
    return api;
  }

  it('claim_lead on an item whose parts overlap an in-flight item is seam_conflict { with, parts }, and the item stays Ready', async () => {
    await overlapping();
    const err = expectToolError(
      await h!.call('claim_lead', { id: 'RCP-17' }, h!.b),
      'seam_conflict',
    );
    expect(err.message).toBe(
      'RCP-17 changes model:Recipe, like RCP-14 (In progress). Pick other work: the owner has been asked whether they can run together.',
    );
    expect(err.details).toEqual({ with: ['RCP-14'], parts: ['model:Recipe'] });
    expect(status('RCP-17')).toBe('ready');
    expect(count("SELECT count(*) AS n FROM runs WHERE item_id = 'RCP-17'")).toBe(0);
    // The refusal is a rejected claim the owner sees.
    expect(events('claim.rejected', 'RCP-17').map((e) => e.summary)).toEqual([
      'Lead claim by codex refused: RCP-17 overlaps RCP-14 on model Recipe',
    ]);
    // Two Ready items that declare the same part don't refuse each other's first claim.
    expectOk(await declare({ id: 'RCP-25', changes: [{ part: 'table:decks', change: 'add' }] }));
    expectOk(await declare({ id: 'RCP-22', changes: [{ part: 'table:decks', change: 'change' }] }));
    expect(count("SELECT count(*) AS n FROM part_overlaps WHERE parts LIKE '%decks%'")).toBe(0);
    expectOk(await h!.call('claim_lead', { id: 'RCP-25' }));
  });

  it('the refused claim opens one part_overlaps row and one Needs you card; claiming the same pair again opens no second', async () => {
    const api = await overlapping();
    for (let i = 0; i < 3; i++) {
      expectToolError(await h!.call('claim_lead', { id: 'RCP-17' }, h!.b), 'seam_conflict');
    }
    expect(
      sql().prepare('SELECT item_a, item_b, claimed_first, parts, state FROM part_overlaps').all(),
    ).toEqual([
      {
        item_a: 'RCP-14',
        item_b: 'RCP-17',
        claimed_first: 'RCP-14',
        parts: '["model:Recipe"]',
        state: 'open',
      },
    ]);
    // overlap.raised once on each item, not once per retry; a rejected claim per retry.
    expect(events('overlap.raised').map((e) => e.summary)).toEqual([
      'RCP-14 and RCP-17 both change model Recipe: RCP-17 waits until you decide',
      'RCP-14 and RCP-17 both change model Recipe: the claim of RCP-17 was refused until you decide',
    ]);
    expect(events('claim.rejected', 'RCP-17')).toHaveLength(3);
    const needs = await api('GET', '/api/needs-you?scope=all');
    expect(needs.body.overlaps).toMatchObject([
      {
        items: [
          { id: 'RCP-14', status: 'progress' },
          { id: 'RCP-17', status: 'ready' },
        ],
        parts: ['model:Recipe'],
        state: 'open',
      },
    ]);
    const before = await api('GET', '/api/bootstrap');
    expect((before.body.counts as { for_you: number }).for_you).toBeGreaterThan(0);
    // The owner has been asked: ready_to_start leaves RCP-17 out, so agents move on.
    expect(
      items(await h!.call('search_items', { project: 'RCP', filter: 'ready_to_start' })),
    ).not.toContain('RCP-17');
    // The item's Shared changes section shows it.
    const shared = await api('GET', '/api/items/RCP-17/shared');
    expect((shared.body.overlaps as S[])[0]).toMatchObject({ state: 'open' });
  });

  it('Run one after the other adds a merged blocks link from the item claimed first; the other is startable once it merges', async () => {
    const api = await overlapping();
    expectToolError(await h!.call('claim_lead', { id: 'RCP-17' }, h!.b), 'seam_conflict');
    const id = (sql().prepare('SELECT id FROM part_overlaps').get() as { id: string }).id;
    const res = await api('POST', `/api/overlaps/${id}/decide`, { decision: 'sequence' });
    expect(res.status).toBe(200);
    const overlap = res.body.overlap as S & { link_id: string };
    expect(overlap).toMatchObject({ state: 'sequenced', decided_by: 'owner' });
    expect(
      sql()
        .prepare('SELECT from_id, to_id, type, satisfied_when FROM links WHERE id = ?')
        .get(overlap.link_id),
    ).toEqual({
      from_id: 'RCP-14',
      to_id: 'RCP-17',
      type: 'blocks',
      satisfied_when: 'merged',
    });
    expect(events('overlap.decided').map((e) => e.summary)).toEqual([
      'You chose to run RCP-14 and RCP-17 one after the other: RCP-17 waits until RCP-14 is merged',
      'You chose to run RCP-14 and RCP-17 one after the other: RCP-17 waits until RCP-14 is merged',
    ]);
    // Deciding twice is a conflict; the card is gone.
    expect(
      (await api('POST', `/api/overlaps/${id}/decide`, { decision: 'compatible' })).status,
    ).toBe(409);
    expect((await api('GET', '/api/needs-you?scope=all')).body.overlaps).toEqual([]);

    // RCP-17 is blocked by RCP-14 until it is merged.
    const blocked = expectValidation(await h!.call('claim_lead', { id: 'RCP-17' }, h!.b));
    expect(blocked.message).toContain('RCP-17 is blocked by RCP-14');
    sql().prepare("UPDATE items SET status = 'done' WHERE id = 'RCP-14'").run();
    expect(
      items(await h!.call('search_items', { project: 'RCP', filter: 'ready_to_start' })),
    ).not.toContain('RCP-17');
    expectOk(
      await h!.call('link_artifact', {
        id: 'RCP-14',
        kind: 'pr',
        label: 'PR #60',
        url: 'https://example.test/pr/60',
        state: 'merged',
      }),
    );
    expect(
      items(await h!.call('search_items', { project: 'RCP', filter: 'ready_to_start' })),
    ).toContain('RCP-17');
    expectOk(await h!.call('claim_lead', { id: 'RCP-17' }, h!.b));
  });

  it("They're compatible records the pair; its note is posted to both items as an owner note; the claim then succeeds", async () => {
    const api = await overlapping();
    expectToolError(await h!.call('claim_lead', { id: 'RCP-17' }, h!.b), 'seam_conflict');
    const id = (sql().prepare('SELECT id FROM part_overlaps').get() as { id: string }).id;
    expect(
      (await api('POST', `/api/overlaps/${id}/decide`, { decision: 'sequence', note: 'x' })).status,
    ).toBe(400);
    const res = await api('POST', `/api/overlaps/${id}/decide`, {
      decision: 'compatible',
      note: 'RCP-17 only adds a field; RCP-14 reads it.',
    });
    expect(res.body.overlap).toMatchObject({
      state: 'compatible',
      note: 'RCP-17 only adds a field; RCP-14 reads it.',
      link_id: null,
    });
    expect(
      sql()
        .prepare(
          "SELECT item_id, text FROM owner_notes WHERE text LIKE 'Runs alongside%' ORDER BY item_id",
        )
        .all(),
    ).toEqual([
      {
        item_id: 'RCP-14',
        text: 'Runs alongside RCP-17 (both change model Recipe): RCP-17 only adds a field; RCP-14 reads it.',
      },
      {
        item_id: 'RCP-17',
        text: 'Runs alongside RCP-14 (both change model Recipe): RCP-17 only adds a field; RCP-14 reads it.',
      },
    ]);
    const claim = expectOk(await h!.call('claim_lead', { id: 'RCP-17' }, h!.b));
    expect((claim.structured.item as S).status).toBe('progress');
    // The pair stays compatible: re-declaring raises nothing new.
    expectOk(
      await declare({ id: 'RCP-17', changes: [{ part: 'model:Recipe', change: 'change' }] }),
    );
    expect(count("SELECT count(*) AS n FROM part_overlaps WHERE state = 'open'")).toBe(0);
  });

  it('declaring later, while in progress, flags both items ("Now overlaps …") and raises the question, keeping the claim', async () => {
    h = await askEveryHarness();
    await registry(await owner());
    expectOk(
      await declare({ id: 'RCP-14', changes: [{ part: 'model:Recipe', change: 'change' }] }),
    );
    const leadBefore = sql()
      .prepare("SELECT id, state FROM runs WHERE item_id = 'RCP-18' AND is_lead = 1")
      .get();
    const r = expectOk(
      await declare({ id: 'RCP-18', changes: [{ part: 'model:Recipe', change: 'add' }] }),
    );
    expect(r.text).toContain('overlaps RCP-14 on model:Recipe');
    expect(sql().prepare('SELECT item_a, item_b, state FROM part_overlaps').all()).toEqual([
      { item_a: 'RCP-14', item_b: 'RCP-18', state: 'open' },
    ]);
    expect(events('overlap.raised', 'RCP-14').map((e) => e.summary)).toEqual([
      "Now overlaps RCP-18 on model Recipe: you've been asked whether they can run together",
    ]);
    expect(events('overlap.raised', 'RCP-18').map((e) => e.summary)).toEqual([
      "Now overlaps RCP-14 on model Recipe: you've been asked whether they can run together",
    ]);
    // The claim isn't revoked.
    expect(status('RCP-18')).toBe('progress');
    expect(
      sql().prepare("SELECT id, state FROM runs WHERE item_id = 'RCP-18' AND is_lead = 1").get(),
    ).toEqual(leadBefore);
    // Dropping the part resolves the undecided question.
    expectOk(await declare({ id: 'RCP-18', none: true }));
    expect(sql().prepare('SELECT state FROM part_overlaps').get()).toEqual({ state: 'resolved' });
  });
});

describe('leases (FR-161)', () => {
  const JOURNAL = 'file:server/src/db/migrations/meta/_journal.json';

  it('take_lease on a single-writer part returns held_until; a second item gets lease_held with the holder and expiry', async () => {
    h = await askEveryHarness();
    const api = await owner();
    await registry(api, [{ key: JOURNAL, single_writer: true }]);
    const t = expectOk(await h.call('take_lease', { id: 'RCP-14', part: JOURNAL }));
    expect(t.structured).toMatchObject({
      part: JOURNAL,
      item_id: 'RCP-14',
      held_until: '2026-11-06T13:00:00.000Z',
      renewed: false,
    });
    expect(t.text).toBe(`Lease on ${JOURNAL} for RCP-14 · until 13:00Z`);
    // Codex leads RCP-15: the part is held.
    const held = expectToolError(
      await h.call('take_lease', { id: 'RCP-15', part: JOURNAL }, h.b),
      'lease_held',
    );
    expect(held.message).toBe(
      `${JOURNAL} is leased to RCP-14 (claude · orca-w3) until 13:00 UTC. Work on something else.`,
    );
    expect(held.current).toEqual({
      item_id: 'RCP-14',
      holder: 'claude · orca-w3',
      held_until: '2026-11-06T13:00:00.000Z',
    });
    // Renewing moves the expiry and writes no event.
    h.server.clock.advance(30 * 60_000);
    const renewed = expectOk(await h.call('take_lease', { id: 'RCP-14', part: JOURNAL }));
    expect(renewed.structured).toMatchObject({
      held_until: '2026-11-06T13:30:00.000Z',
      renewed: true,
    });
    expect(renewed.text).toBe(`Lease on ${JOURNAL} for RCP-14 · until 13:30Z · renewed`);
    expect(events('lease.taken')).toHaveLength(1);
    // list_shared_parts shows the holder.
    const list = expectOk(await h.call('list_shared_parts', { project: 'RCP' }));
    expect(
      (list.structured.parts as { key: string; lease: unknown }[]).find((p) => p.key === JOURNAL)!
        .lease,
    ).toEqual({
      item_id: 'RCP-14',
      held_until: '2026-11-06T13:30:00.000Z',
    });
    // Not single-writer, not the lead, unknown part.
    expect(
      expectValidation(await h.call('take_lease', { id: 'RCP-14', part: 'model:Recipe' })).message,
    ).toContain("isn't single-writer");
    expectToolError(await h.call('take_lease', { id: 'RCP-14', part: JOURNAL }, h.b), 'forbidden');
    expectToolError(
      await h.call('take_lease', { id: 'RCP-14', part: 'table:ghosts' }),
      'not_found',
    );
  });

  it('a lease ends on release_lease, owner release, Done, hand-off (submit_packet or set_status done) and expiry', async () => {
    h = await askEveryHarness({ env: { DOCKET_LEASE_MINUTES: '10' } });
    const api = await owner();
    await registry(api, [{ key: JOURNAL, single_writer: true }]);
    const reasons = () =>
      (
        sql()
          .prepare(
            'SELECT end_reason FROM part_leases WHERE ended_at IS NOT NULL ORDER BY ended_at, rowid',
          )
          .all() as {
          end_reason: string;
        }[]
      ).map((r) => r.end_reason);

    // The holder releases it.
    expectOk(await h.call('take_lease', { id: 'RCP-14', part: JOURNAL }));
    const rel = expectOk(await h.call('release_lease', { id: 'RCP-14', part: JOURNAL }));
    expect(rel.text).toBe(`Released lease on ${JOURNAL} for RCP-14`);
    expectToolError(await h.call('release_lease', { id: 'RCP-14', part: JOURNAL }), 'not_found');

    // The owner releases it (Release lease in the item's Shared changes section).
    expectOk(await h.call('take_lease', { id: 'RCP-14', part: JOURNAL }));
    const lease = (
      (await api('GET', '/api/items/RCP-14/shared')).body.leases as { id: string; holder: string }[]
    )[0]!;
    expect(lease.holder).toBe('claude · orca-w3');
    const owned = await api('POST', `/api/leases/${lease.id}/release`, {});
    expect(owned.body.lease).toMatchObject({ end_reason: 'owner_released' });
    expect((await api('POST', `/api/leases/${lease.id}/release`, {})).status).toBe(409);

    // Done (set_status done) ends it.
    const done = await started('Close it');
    expectOk(await h.call('take_lease', { id: done.id, part: JOURNAL }));
    expectOk(await h.call('set_status', { id: done.id, status: 'done', run_id: done.run_id }));

    // A hand-off (submit_packet) ends it.
    const handed = await started('Hand it off');
    expectOk(await h.call('take_lease', { id: handed.id, part: JOURNAL }));
    expectOk(await h.call('declare_human_review', { id: handed.id, items: ['Look at it.'] }));
    expectOk(
      await h.call('submit_packet', {
        id: handed.id,
        built_from_commit: '9c0e7f2',
        estimate: '2 min',
        how: ['Open it.'],
        checked: [],
      }),
    );

    // Expiry: lazy. Reads skip it; the next take ends it as expired.
    expectOk(await h.call('take_lease', { id: 'RCP-14', part: JOURNAL }));
    h.server.clock.advance(11 * 60_000);
    const listed = expectOk(await h.call('list_shared_parts', { project: 'RCP' }));
    expect(
      (listed.structured.parts as { key: string; lease: unknown }[]).find((p) => p.key === JOURNAL)!
        .lease,
    ).toBeNull();
    expect(((await api('GET', '/api/items/RCP-14/shared')).body.leases as unknown[]).length).toBe(
      0,
    );
    expectOk(await h.call('take_lease', { id: 'RCP-15', part: JOURNAL }, h.b));
    expect(reasons()).toEqual(['released', 'owner_released', 'done', 'handed_off', 'expired']);
    expect(events('lease.ended').map((e) => e.summary)).toEqual([
      `Lease on ${JOURNAL} for RCP-14 ended: released`,
      `Lease on ${JOURNAL} for RCP-14 ended: released by you`,
      `Lease on ${JOURNAL} for ${done.id} ended: the item is done`,
      `Lease on ${JOURNAL} for ${handed.id} ended: the item was handed off`,
      `Lease on ${JOURNAL} for RCP-14 ended: it expired`,
    ]);
  });
});

describe('changed files at hand-off (FR-162)', () => {
  const FILES = ['server/src/models/recipe.ts', 'server/src/db/decks/schema.ts', 'README.md'];
  const packet = (id: string, extra: S = {}) => ({
    id,
    built_from_commit: '9c0e7f2',
    estimate: '2 min',
    how: ['Open it.'],
    checked: [],
    ...extra,
  });

  it('submit_packet with changed_files mapping to undeclared parts holds the packet (held_undeclared) and raises the question', async () => {
    h = await askEveryHarness();
    const api = await owner();
    await registry(api);
    const t = await started('Recipe source', h.a, ['model:Recipe']);
    expectOk(await h.call('declare_human_review', { id: t.id, items: ['Import a recipe.'] }));
    const r = expectOk(
      await h.call('submit_packet', packet(t.id, { changed_files: FILES, branch: 'feat/source' })),
    );
    expect(r.structured.held_undeclared).toEqual(['table:decks']);
    expect(r.text).toContain('held for the owner: undeclared table:decks');
    expect(status(t.id)).toBe('review');
    expect(
      sql().prepare('SELECT held_undeclared, branch FROM packets WHERE item_id = ?').get(t.id),
    ).toEqual({
      held_undeclared: '["table:decks"]',
      branch: 'feat/source',
    });
    const hold = (await api('GET', '/api/needs-you?scope=all')).body.undeclared_holds as S[];
    expect(hold).toMatchObject([
      {
        item: { id: t.id },
        via: 'submit_packet',
        parts: ['table:decks'],
        files: ['server/src/db/decks/schema.ts'],
        state: 'open',
      },
    ]);
    expect(events('undeclared.held', t.id).map((e) => e.summary)).toEqual([
      `${t.id} changed shared parts it didn't declare: table decks`,
    ]);
    // The packet shows the hold, and its review gate stays closed.
    const review = await api('GET', `/api/review/${t.id}`);
    const p = review.body.packet as { shared: S; items: { hr_item_id: string }[] };
    expect(p.shared).toMatchObject({
      held_undeclared: ['table:decks'],
      hold_id: hold[0]!.id,
      not_reported: false,
    });
    const decided = await api('POST', `/api/review/${t.id}/decisions`, {
      round: 1,
      verdicts: [{ hr_item_id: p.items[0]!.hr_item_id, kind: 'approve' }],
    });
    expect(decided.status).toBe(409);
    expect((decided.body.error as S).message).toContain(
      "changed shared parts it didn't declare (table:decks)",
    );
  });

  it('set_status done with changed files mapping to undeclared parts is not_declared, raises the question, and leaves the item', async () => {
    h = await askEveryHarness();
    await registry(await owner());
    const t = await started('Deck export');
    for (let i = 0; i < 2; i++) {
      const err = expectToolError(
        await h.call('set_status', {
          id: t.id,
          status: 'done',
          run_id: t.run_id,
          changed_files: FILES,
          branch: 'feat/x',
        }),
        'not_declared',
      );
      expect(err.details).toEqual({
        undeclared: ['model:Recipe', 'table:decks'],
        files: ['server/src/models/recipe.ts', 'server/src/db/decks/schema.ts'],
      });
      expect(err.message).toContain(
        "changed shared parts it didn't declare: model:Recipe, table:decks",
      );
    }
    expect(status(t.id)).toBe('progress');
    // One question, not one per retry.
    expect(sql().prepare('SELECT via, packet_id, state FROM undeclared_holds').all()).toEqual([
      { via: 'set_status', packet_id: null, state: 'open' },
    ]);
    expect(events('undeclared.held')).toHaveLength(1);
    // Files that map to declared parts, or to no part, close normally.
    expectOk(
      await declare({
        id: t.id,
        changes: [
          { part: 'model:Recipe', change: 'change' },
          { part: 'table:decks', change: 'add' },
        ],
      }),
    );
    expectOk(
      await h.call('set_status', {
        id: t.id,
        status: 'done',
        run_id: t.run_id,
        changed_files: FILES,
      }),
    );
    expect(status(t.id)).toBe('done');
  });

  it('Add to the declaration adds the parts and releases the hold; Send back returns the item with an owner note', async () => {
    h = await askEveryHarness();
    const api = await owner();
    await registry(api);
    // Add to the declaration: the parts join it, and the packet opens for review.
    const a = await started('Add them', h.a, ['model:Recipe']);
    expectOk(await h.call('declare_human_review', { id: a.id, items: ['Look.'] }));
    expectOk(await h.call('submit_packet', packet(a.id, { changed_files: FILES })));
    const holdA = (
      sql().prepare('SELECT id FROM undeclared_holds WHERE item_id = ?').get(a.id) as { id: string }
    ).id;
    const added = await api('POST', `/api/undeclared-holds/${holdA}/decide`, { decision: 'add' });
    expect(added.body.hold).toMatchObject({ state: 'added', decided_by: 'owner' });
    expect(
      (
        (await api('GET', `/api/items/${a.id}/shared`)).body.declaration as {
          changes: { part: string }[];
        }
      ).changes.map((c) => c.part),
    ).toEqual(['model:Recipe', 'table:decks']);
    const review = await api('GET', `/api/review/${a.id}`);
    const pa = review.body.packet as { shared: S; items: { hr_item_id: string }[] };
    expect(pa.shared.held_undeclared).toBeNull();
    const ok = await api('POST', `/api/review/${a.id}/decisions`, {
      round: 1,
      verdicts: [{ hr_item_id: pa.items[0]!.hr_item_id, kind: 'approve' }],
    });
    expect(ok.status).toBe(200);
    expect(
      (await api('POST', `/api/undeclared-holds/${holdA}/decide`, { decision: 'add' })).status,
    ).toBe(409);

    // Send back: the held packet is withdrawn, the item returns to In progress with a note.
    const b = await started('Send it back', h.a, ['model:Recipe']);
    expectOk(await h.call('declare_human_review', { id: b.id, items: ['Look.'] }));
    expectOk(await h.call('submit_packet', packet(b.id, { changed_files: FILES })));
    const holdB = (
      sql().prepare('SELECT id FROM undeclared_holds WHERE item_id = ?').get(b.id) as { id: string }
    ).id;
    const back = await api('POST', `/api/undeclared-holds/${holdB}/decide`, {
      decision: 'send_back',
      note: 'Keep the decks table out of this one.',
    });
    expect(back.body.hold).toMatchObject({
      state: 'sent_back',
      note: 'Keep the decks table out of this one.',
    });
    expect(status(b.id)).toBe('progress');
    expect(sql().prepare('SELECT state FROM packets WHERE item_id = ?').get(b.id)).toEqual({
      state: 'withdrawn',
    });
    expect(sql().prepare('SELECT text FROM owner_notes WHERE item_id = ?').all(b.id)).toEqual([
      { text: 'Keep the decks table out of this one.' },
    ]);
    expect((await api('GET', '/api/needs-you?scope=all')).body.undeclared_holds).toEqual([]);
  });

  it('an item with declarations that hands off without changed_files shows "Changed files not reported" on the packet', async () => {
    h = await askEveryHarness();
    const api = await owner();
    await registry(api);
    const t = await started('No files', h.a, ['model:Recipe']);
    expectOk(await h.call('declare_human_review', { id: t.id, items: ['Look.'] }));
    expectOk(await h.call('submit_packet', packet(t.id)));
    const p = (await api('GET', `/api/review/${t.id}`)).body.packet as { shared: S };
    expect(p.shared).toEqual({
      changed_files: null,
      branch: null,
      held_undeclared: null,
      hold_id: null,
      not_reported: true,
    });
    // Declared none: nothing to report against.
    const none = await started('Declared none');
    expectOk(await h.call('declare_human_review', { id: none.id, items: ['Look.'] }));
    expectOk(await h.call('submit_packet', packet(none.id)));
    expect(
      ((await api('GET', `/api/review/${none.id}`)).body.packet as { shared: S }).shared
        .not_reported,
    ).toBe(false);
  });
});

describe('get_context.shared (FR-164)', () => {
  it('get_context.shared lists the declaration, overlapping and up to 30 other in-flight declarations, leases and findings, within budget', async () => {
    h = await askEveryHarness();
    const api = await owner();
    const keys = Array.from({ length: 6 }, (_, i) => `table:recipe_part_${i}`);
    await registry(api, [
      { key: 'file:server/src/db/schema.ts', single_writer: true },
      ...keys.map((key) => ({ key })),
    ]);
    expectOk(
      await declare({
        id: 'RCP-14',
        changes: [
          { part: 'model:Recipe', change: 'change', note: 'Adds units' },
          { part: 'file:server/src/db/schema.ts', change: 'change' },
        ],
      }),
    );
    // RCP-18 overlaps on model:Recipe; seven other in-flight items declare six parts each (42).
    expectOk(
      await declare({
        id: 'RCP-18',
        changes: [{ part: 'model:Recipe', change: 'add', note: 'Source URL' }],
      }),
    );
    for (const id of ['RCP-12', 'RCP-15', 'RCP-16', 'RCP-17', 'RCP-19', 'RCP-21', 'RCP-22']) {
      expectOk(
        await declare({
          id,
          changes: keys.map((part) => ({ part, change: 'change', note: `For ${id}` })),
        }),
      );
    }
    expectOk(await h.call('take_lease', { id: 'RCP-14', part: 'file:server/src/db/schema.ts' }));
    const t = '2026-11-06T11:00:00.000Z';
    sql()
      .prepare(
        `INSERT INTO radar_findings (id, project_key, branch_a, branch_b, item_a, item_b, files, seen_at, created_at, updated_at)
         VALUES ('rdf_1', 'RCP', 'rcp-14-list', 'rcp-18-import', 'RCP-14', 'RCP-18', '["server/src/models/recipe.ts"]', ?, ?, ?)`,
      )
      .run(t, t, t);

    const ctx = expectOk(await h.call('get_context', { id: 'RCP-14' }));
    const shared = (ctx.structured.context as S).shared as {
      declaration: S;
      overlapping: { id: string; part: string }[];
      in_flight: unknown[];
      leases: unknown[];
      radar: unknown[];
      truncated: boolean;
    };
    expect(shared.declaration).toEqual({
      state: 'declared',
      changes: [
        { part: 'file:server/src/db/schema.ts', kind: 'file', change: 'change', note: null },
        { part: 'model:Recipe', kind: 'model', change: 'change', note: 'Adds units' },
      ],
    });
    expect(shared.overlapping).toEqual([
      {
        id: 'RCP-18',
        title: 'Import recipes from URL',
        status: 'progress',
        change: 'add',
        note: 'Source URL',
        part: 'model:Recipe',
      },
    ]);
    expect(shared.in_flight).toHaveLength(30);
    expect(shared.truncated).toBe(true);
    expect(shared.leases).toEqual([
      { part: 'file:server/src/db/schema.ts', held_until: '2026-11-06T13:00:00.000Z' },
    ]);
    expect(shared.radar).toEqual([
      {
        with: 'RCP-18',
        branch: 'rcp-18-import',
        own_branch: 'rcp-14-list',
        files: ['server/src/models/recipe.ts'],
      },
    ]);
    const lines = ctx.text.split('\n');
    expect(lines).toContain('shared: file:server/src/db/schema.ts change, model:Recipe change');
    expect(lines).toContain('  overlaps:');
    expect(lines).toContain(
      '  - RCP-18 Import recipes from URL · progress · model:Recipe add · Source URL',
    );
    expect(lines).toContain('  lease file:server/src/db/schema.ts until 13:00Z');
    expect(lines).toContain(
      '  conflict ahead with RCP-18 (rcp-14-list vs rcp-18-import) · 1 file · server/src/models/recipe.ts',
    );
    expect(lines).toContain('  …truncated; see list_shared_parts RCP');
    // Within the medium budget (3,000 tokens), and cut to fit the small one.
    expect(tokens(ctx.text)).toBeLessThanOrEqual(3_000);
    const small = expectOk(await h.call('get_context', { id: 'RCP-14', budget: 'small' }));
    expect(tokens(small.text)).toBeLessThanOrEqual(1_000);
    const smallShared = (small.structured.context as S).shared as
      { in_flight: unknown[]; truncated: boolean } | undefined;
    if (smallShared) {
      expect(smallShared.truncated).toBe(true);
      expect(smallShared.in_flight.length).toBeLessThan(30);
    } else {
      expect(small.text).toContain('shared changes; read them with list_shared_parts RCP');
    }
    // An undeclared item is told to declare.
    const bare = expectOk(await h.call('get_context', { id: 'RCP-25' }));
    expect(bare.text).toContain('shared: not declared; declare_shared_changes before Ready');
  });
});

describe('the conflict radar (FR-163; T184)', () => {
  let tmp: { dir: string; cleanup(): void } | undefined;
  afterEach(() => {
    tmp?.cleanup();
    tmp = undefined;
  });

  // CI's no-network contract run uses a bare node image without git; the main test step
  // (and every developer machine) has it and runs the read-only proof.
  it.skipIf(!HAS_GIT)(
    'B76: the helper trial-merges in-flight branches read-only and Docket judges from its facts',
    async () => {
      tmp = tempDir('docket-radar-');
      const fixture = makeRadarRepo(tmp.dir);
      const notRepo = join(tmp.dir, 'not-a-repo');
      mkdirSync(notRepo);
      // B76: no DOCKET_PUSH_ROOT: Docket doesn't need the folder to read.
      h = await askEveryHarness();
      const api = await owner();
      const pass = () => hostGitPass(h!.server, { home: tmp!.dir });

      // Settings: a full path on the host; a relative path or a bad branch name is refused.
      expect(
        (await api('PUT', '/api/projects/RCP/radar', { repo_path: '../elsewhere' })).status,
      ).toBe(400);
      expect((await api('PUT', '/api/projects/RCP/radar', { repo_path: 'nope' })).status).toBe(400);
      expect(
        (
          await api('PUT', '/api/projects/RCP/radar', {
            repo_path: fixture.repo,
            main_branch: '-x',
          })
        ).status,
      ).toBe(400);
      const set = await api('PUT', '/api/projects/RCP/radar', {
        repo_path: fixture.repo,
        main_branch: 'main',
      });
      expect(set.status).toBe(200);
      // Until the helper reports, the radar waits for it and decides nothing.
      expect(set.body.radar).toMatchObject({
        repo_path: fixture.repo,
        state: 'waiting',
        off_reason: null,
        helper: { state: 'none', checked_at: null },
      });
      expect(events('project.updated').at(-1)!.summary).toBe(
        `You set the conflict radar for RCP to read ${fixture.repo} (main branch main)`,
      );

      // Two items in flight on worktree branches; the branch comes from claim_lead.
      expectOk(await h.call('claim_lead', { id: 'RCP-17', branch: 'feat/a' }));
      expectOk(await h.call('claim_lead', { id: 'RCP-25', branch: 'feat/b' }, h.b));
      const c = await started('Other file');
      // B41: an agent reports its branch with its declaration.
      expectOk(await declare({ id: c.id, none: true, branches: ['feat/c'] }));

      const waiting = await api('POST', '/api/projects/RCP/radar/run', {});
      expect(waiting.body.radar).toMatchObject({ state: 'waiting', findings: [] });

      // What Docket asks the helper for: the items, their branches, and nothing else secret.
      const asked = (gitSettings(h.server).projects as Record<string, unknown>[])[0]!;
      expect(asked).toMatchObject({ key: 'RCP', main_branch: 'main' });
      expect((asked.items as { id: string; branches: string[] }[]).map((i) => i.branches)).toEqual(
        expect.arrayContaining([['feat/a'], ['feat/b'], ['feat/c']]),
      );

      const before = hashGitDir(fixture.repo);
      await pass();
      // Read-only: every file under .git is byte-for-byte the same.
      expect(hashGitDir(fixture.repo)).toEqual(before);
      const run = await api('POST', '/api/projects/RCP/radar/run', {});
      expect(run.status).toBe(200);

      const radar = run.body.radar as { state: string; last_run_at: string; findings: S[] };
      expect(radar.state).toBe('ok');
      expect(radar.last_run_at).toBe('2026-11-06T11:00:00.000Z');
      const found = radar.findings.map((f) => [
        f.branch_a,
        f.branch_b,
        (f.item_a as S).id,
        (f.item_b as S | null)?.id ?? null,
        f.files,
      ]);
      expect(found).toEqual(
        expect.arrayContaining([
          ['feat/b', 'main', 'RCP-25', null, ['notes.txt']],
          ['feat/a', 'feat/b', 'RCP-17', 'RCP-25', ['shared.txt']],
        ]),
      );
      expect(found).toHaveLength(2);
      // B41: findings name both branches.
      expect(events('radar.found', 'RCP-17').map((e) => e.summary)).toEqual([
        'Heading for a conflict with RCP-25: 1 file · feat/a vs feat/b',
      ]);
      expect(
        events('radar.found', 'RCP-25')
          .map((e) => e.summary)
          .sort(),
      ).toEqual([
        'Heading for a conflict with RCP-17: 1 file · feat/b vs feat/a',
        'Heading for a conflict with main: 1 file · feat/b vs main',
      ]);
      // Both items show it; Needs you lists it under Problems; agents see it in their context.
      expect(
        ((await api('GET', '/api/items/RCP-17/shared')).body.findings as unknown[]).length,
      ).toBe(1);
      expect(
        ((await api('GET', '/api/items/RCP-25/shared')).body.findings as unknown[]).length,
      ).toBe(2);
      // B42: both items have a lead, so the agents handle them first (decision 37).
      const needs = (await api('GET', '/api/needs-you?scope=all')).body;
      const problems = needs.agent_problems as { kind: string; item_id: string; reason: string }[];
      expect(
        problems
          .filter((p) => p.kind === 'radar_conflict')
          .map((p) => p.reason)
          .sort(),
      ).toEqual([
        'Heading for a conflict with RCP-25: 1 file · shared.txt (feat/a vs feat/b)',
        'Heading for a conflict with main: 1 file · notes.txt (feat/b vs main)',
      ]);
      expect((needs.problems as { kind: string }[]).map((p) => p.kind)).not.toContain(
        'radar_conflict',
      );
      expect(expectOk(await h.call('get_context', { id: 'RCP-17' })).text).toContain(
        'conflict ahead with RCP-25 (feat/a vs feat/b) · 1 file · shared.txt',
      );

      // A second run with nothing new writes no event (the scheduler's path).
      const n = count('SELECT count(*) AS n FROM events');
      await radarRunOnce(h.server.runtime, 'RCP');
      expect(count('SELECT count(*) AS n FROM events')).toBe(n);

      // feat/b goes back to main. Until the helper reads it again, nothing clears; once its
      // facts are older than three passes they're stale, which is never clear either.
      git(fixture.worktrees['feat/b'], 'reset', '-q', '--hard', 'main');
      h.server.clock.advance(11 * 60_000);
      const stale = await api('POST', '/api/projects/RCP/radar/run', {});
      expect(stale.body.radar).toMatchObject({ state: 'stale', helper: { state: 'stale' } });
      expect((stale.body.radar as { findings: unknown[] }).findings).toHaveLength(2);
      expect(events('radar.cleared')).toEqual([]);

      await pass();
      const cleared = await api('POST', '/api/projects/RCP/radar/run', {});
      expect((cleared.body.radar as { findings: unknown[] }).findings).toEqual([]);
      expect(
        events('radar.cleared')
          .map((e) => e.summary)
          .sort(),
      ).toEqual([
        'No longer heading for a conflict with RCP-17 · feat/b vs feat/a',
        'No longer heading for a conflict with RCP-25 · feat/a vs feat/b',
        'No longer heading for a conflict with main · feat/b vs main',
      ]);

      // A folder the helper can't read as a repository: the radar says so; turning it off too.
      await api('PUT', '/api/projects/RCP/radar', { repo_path: notRepo });
      await pass();
      const off = await api('POST', '/api/projects/RCP/radar/run', {});
      expect(off.body.radar).toMatchObject({ state: 'off', off_reason: RADAR_OFF_UNREADABLE });
      const none = await api('PUT', '/api/projects/RCP/radar', { repo_path: null });
      expect(none.body.radar).toMatchObject({
        repo_path: null,
        state: 'off',
        off_reason: 'Radar off: no repository',
      });
    },
    30_000,
  ); // the helper's git runs in a child process; slow under a full parallel run

  it('B76: without DOCKET_PUSH_ROOT a full host path is accepted and the card waits for the helper', async () => {
    h = await askEveryHarness();
    const api = await owner();
    const relative = await api('PUT', '/api/projects/RCP/radar', { repo_path: 'recipe-app' });
    expect(relative.status).toBe(400);
    expect((relative.body.error as S).message).toContain('full path on this computer');
    const res = await api('PUT', '/api/projects/RCP/radar', {
      repo_path: 'C:/Users/sample/code/recipe-app',
    });
    expect(res.status).toBe(200);
    const run = await api('POST', '/api/projects/RCP/radar/run', {});
    expect(run.body.radar).toMatchObject({
      state: 'waiting',
      helper: { state: 'none', checked_at: null },
      findings: [],
    });
    // The helper is asked to read it on the host, by that path.
    expect(gitSettings(h.server)).toMatchObject({
      enabled: true,
      projects: [{ key: 'RCP', host_path: 'C:/Users/sample/code/recipe-app' }],
    });
  });

  it('B76: with DOCKET_PUSH_ROOT but no host mapping, a folder inside it is refused', async () => {
    tmp = tempDir('docket-radar-root-');
    h = await askEveryHarness({ env: { DOCKET_PUSH_ROOT: tmp.dir } });
    const api = await owner();
    const res = await api('PUT', '/api/projects/RCP/radar', {
      repo_path: `${tmp.dir.replace(/\\/g, '/')}/recipe-app`,
    });
    expect(res.status).toBe(400);
    expect((res.body.error as S).message).toContain('DOCKET_PUSH_HOST_PATH');
  });
});

describe('B40: the radar sees in-flight branches', () => {
  let tmp: { dir: string; cleanup(): void } | undefined;
  afterEach(() => {
    tmp?.cleanup();
    tmp = undefined;
  });

  // B41: the item's branches, reported (a set) and found by the radar.
  type Branches = {
    reported: { name: string; reported_by: string | null; reported_at: string }[];
    discovered: string | null;
    matches: string[];
  };

  it.skipIf(!HAS_GIT)(
    'discovers one branch per key (or Jira key), uses none when several match, and a reported branch wins, leaving .git unchanged',
    async () => {
      tmp = tempDir('docket-radar-b40-');
      const { repo } = makeBranchRepo(tmp.dir);
      h = await askEveryHarness();
      const api = await owner();
      const db = h.server.runtime.db;
      insertProject(db, 'GF');
      for (const id of ['GF-239', 'GF-280', 'GF-281']) {
        insertItem(db, { id, status: 'progress' });
      }
      sql().prepare("UPDATE items SET jira_key = 'GAMEFLOW-280' WHERE id = 'GF-280'").run();
      expect(
        (await api('PUT', '/api/projects/GF/radar', { repo_path: repo, main_branch: 'main' }))
          .status,
      ).toBe(200);
      const branch = async (id: string) =>
        (await api('GET', `/api/items/${id}/shared`)).body.branches as Branches;
      const findings = (radar: S) =>
        (radar.findings as S[]).map((f) => [
          f.branch_a,
          f.branch_b,
          (f.item_a as S).id,
          f.source_a,
          f.source_b,
          f.files,
        ]);

      // Before any run: no branch reported or found.
      expect(await branch('GF-239')).toEqual({ reported: [], discovered: null, matches: [] });

      const before = hashGitDir(repo);
      await hostGitPass(h.server, { home: tmp!.dir });
      const run = await api('POST', '/api/projects/GF/radar/run', {});
      expect(run.status).toBe(200);
      // Read-only: every file under .git (worktrees' admin folders included) is unchanged.
      expect(hashGitDir(repo)).toEqual(before);

      // Discovered: the item key (any case, gf-2390-decoy left out) and the Jira key.
      expect(await branch('GF-239')).toEqual({
        reported: [],
        discovered: 'eps5000/gf-239-visual-shell',
        matches: [],
      });
      expect(await branch('GF-280')).toEqual({
        reported: [],
        discovered: 'feature/GAMEFLOW-280-x',
        matches: [],
      });
      // Ambiguous: two branches name GF-281, so the radar uses neither.
      expect(await branch('GF-281')).toEqual({
        reported: [],
        discovered: null,
        matches: ['gf-281-a', 'gf-281-b'],
      });
      expect(events('branch.discovered').map((e) => e.summary)).toEqual([
        'Branch found by the radar for GF-239: eps5000/gf-239-visual-shell',
        'Branch found by the radar for GF-280: feature/GAMEFLOW-280-x',
        'Several branches match GF-281; report the branch: gf-281-a, gf-281-b',
      ]);
      expect(findings(run.body.radar as S)).toEqual([
        ['eps5000/gf-239-visual-shell', 'main', 'GF-239', 'discovered', null, ['shared.txt']],
      ]);
      const found = events('radar.found', 'GF-239');
      expect(found.map((e) => e.summary)).toEqual([
        'Heading for a conflict with main: 1 file · eps5000/gf-239-visual-shell (found by the radar) vs main',
      ]);
      expect(JSON.parse(found[0]!.data)).toMatchObject({ source: 'discovered' });

      // Nothing new: a second run writes no event and still leaves .git alone.
      const n = count('SELECT count(*) AS n FROM events');
      await radarRunOnce(h.server.runtime, 'GF');
      expect(count('SELECT count(*) AS n FROM events')).toBe(n);
      expect(hashGitDir(repo)).toEqual(before);

      // An agent reports GF-281's branch with its declaration; a bad name is refused.
      const bad = expectValidation(await declare({ id: 'GF-281', none: true, branch: '-x' }));
      expect(bad.message).toContain("isn't a branch name");
      const v281 = version('GF-281');
      const declared = expectOk(await declare({ id: 'GF-281', none: true, branch: 'gf-281-a' }));
      expect(declared.text).toBe('Declared none on GF-281 · branch gf-281-a');
      expect(version('GF-281')).toBe(v281);
      expect(events('branch.reported', 'GF-281').map((e) => e.summary)).toEqual([
        "claude reported GF-281's branch: gf-281-a",
      ]);
      expect((await branch('GF-281')).reported).toMatchObject([
        { name: 'gf-281-a', reported_by: 'claude' },
      ]);

      // The owner adds a branch for GF-239: it wins over the one the radar found.
      const set = await api('POST', '/api/items/GF-239/shared/branches', {
        op: 'add',
        branch: 'spike/shell-rework',
      });
      expect(set.status).toBe(200);
      expect(set.body.branches).toMatchObject({
        reported: [{ name: 'spike/shell-rework', reported_by: 'owner' }],
        discovered: 'eps5000/gf-239-visual-shell',
      });
      expect(events('branch.reported', 'GF-239').map((e) => e.summary)).toEqual([
        "You added spike/shell-rework to GF-239's branches",
      ]);
      expect(
        (await api('POST', '/api/items/GF-239/shared/branches', { op: 'add', branch: 'a..b' }))
          .status,
      ).toBe(400);

      await hostGitPass(h.server, { home: tmp!.dir });
      const second = await api('POST', '/api/projects/GF/radar/run', {});
      expect(hashGitDir(repo)).toEqual(before);
      // spike/shell-rework is clean, so GF-239's finding clears; gf-281-a (reported) conflicts.
      expect(findings(second.body.radar as S)).toEqual([
        ['gf-281-a', 'main', 'GF-281', 'reported', null, ['shared.txt']],
      ]);
      expect(events('radar.found', 'GF-281').map((e) => e.summary)).toEqual([
        'Heading for a conflict with main: 1 file · gf-281-a vs main',
      ]);
      expect(events('radar.cleared', 'GF-239').map((e) => e.summary)).toEqual([
        'No longer heading for a conflict with main · eps5000/gf-239-visual-shell vs main',
      ]);

      // Removing the owner's only branch falls back to the one the radar found.
      const cleared = await api('POST', '/api/items/GF-239/shared/branches', {
        op: 'remove',
        branch: 'spike/shell-rework',
      });
      expect(cleared.body.branches).toEqual({
        reported: [],
        discovered: 'eps5000/gf-239-visual-shell',
        matches: [],
      });
      expect(events('branch.reported', 'GF-239').at(-1)!.summary).toBe(
        "You removed spike/shell-rework from GF-239's branches; the radar looks for one",
      );
      await hostGitPass(h.server, { home: tmp!.dir });
      const third = await api('POST', '/api/projects/GF/radar/run', {});
      expect(findings(third.body.radar as S)).toEqual(
        expect.arrayContaining([
          ['eps5000/gf-239-visual-shell', 'main', 'GF-239', 'discovered', null, ['shared.txt']],
          ['gf-281-a', 'main', 'GF-281', 'reported', null, ['shared.txt']],
        ]),
      );
      expect(hashGitDir(repo)).toEqual(before);

      // The owner's report is undoable.
      const again = await api('POST', '/api/items/GF-239/shared/branches', {
        op: 'add',
        branch: 'gf-2390-decoy',
      });
      expect(again.status).toBe(200);
      const undo = await api('POST', `/api/mutations/${again.body.mutation_id as string}/undo`);
      expect(undo.status).toBe(200);
      expect(await branch('GF-239')).toEqual({
        reported: [],
        discovered: 'eps5000/gf-239-visual-shell',
        matches: [],
      });
    },
    30_000,
  );
});

describe('B41: several branches per item', () => {
  let tmp: { dir: string; cleanup(): void } | undefined;
  afterEach(() => {
    tmp?.cleanup();
    tmp = undefined;
  });

  type Branches = {
    reported: { name: string; reported_by: string | null; reported_at: string }[];
    discovered: string | null;
    matches: string[];
  };

  it.skipIf(!HAS_GIT)(
    'trial-merges every reported branch, flags only cross-item pairs naming both branches, and leaves .git unchanged',
    async () => {
      tmp = tempDir('docket-radar-b41-');
      const { repo } = makeEpicRepo(tmp.dir);
      h = await askEveryHarness();
      const api = await owner();
      const db = h.server.runtime.db;
      insertProject(db, 'GF');
      insertItem(db, { id: 'GF-217', status: 'progress' });
      insertItem(db, { id: 'GF-235', status: 'progress' });
      expect(
        (await api('PUT', '/api/projects/GF/radar', { repo_path: repo, main_branch: 'main' }))
          .status,
      ).toBe(200);
      const branches = async (id: string) =>
        (await api('GET', `/api/items/${id}/shared`)).body.branches as Branches;
      const names = async (id: string) => (await branches(id)).reported.map((b) => b.name);
      const findings = (radar: S) =>
        (radar.findings as S[]).map((f) => [
          f.branch_a,
          f.branch_b,
          (f.item_a as S).id,
          (f.item_b as S | null)?.id ?? null,
          f.files,
        ]);

      // GF-217 reports two branches with its declaration; GF-235's one comes from its claim.
      const v217 = version('GF-217');
      const declared = expectOk(
        await declare({ id: 'GF-217', none: true, branches: ['gf-217-api', 'gf-217-web'] }),
      );
      expect(declared.text).toBe('Declared none on GF-217 · branches gf-217-api, gf-217-web');
      expect(version('GF-217')).toBe(v217);
      expect(events('branch.reported', 'GF-217').map((e) => e.summary)).toEqual([
        "claude reported GF-217's branches: gf-217-api, gf-217-web",
      ]);
      expectOk(await h.call('claim_lead', { id: 'GF-235', branch: 'gf-235-b' }, h.b));
      expect(await names('GF-217')).toEqual(['gf-217-api', 'gf-217-web']);
      expect(await names('GF-235')).toEqual(['gf-235-b']);

      const before = hashGitDir(repo);
      await hostGitPass(h.server, { home: tmp!.dir });
      const run = await api('POST', '/api/projects/GF/radar/run', {});
      expect(run.status).toBe(200);
      // Read-only: every file under .git (worktrees' admin folders included) is unchanged.
      expect(hashGitDir(repo)).toEqual(before);

      // Every branch was checked against main (all clean); the one cross-item pair conflicts.
      // gf-217-api and gf-217-web conflict too (api.txt), but they are the same item's.
      expect(findings(run.body.radar as S)).toEqual([
        ['gf-217-api', 'gf-235-b', 'GF-217', 'GF-235', ['shared.txt']],
      ]);
      // B41: the helper never trial-merges two branches of one item, so it sends no such pair.
      const pairs = gitPairs(h.server, 'GF');
      expect(Object.keys(pairs)).toEqual(['gf-217-api\u0000gf-235-b']);
      expect(hashGitDir(repo)).toEqual(before);
      expect(events('radar.found', 'GF-217').map((e) => e.summary)).toEqual([
        'Heading for a conflict with GF-235: 1 file · gf-217-api vs gf-235-b',
      ]);
      expect(events('radar.found', 'GF-235').map((e) => e.summary)).toEqual([
        'Heading for a conflict with GF-217: 1 file · gf-235-b vs gf-217-api',
      ]);
      // B42: the items have leads, so the agents handle it first (decision 37).
      const problems = (await api('GET', '/api/needs-you?scope=all')).body.agent_problems as {
        kind: string;
        reason: string;
      }[];
      expect(problems.filter((p) => p.kind === 'radar_conflict').map((p) => p.reason)).toEqual([
        'Heading for a conflict with GF-235: 1 file · shared.txt (gf-217-api vs gf-235-b)',
      ]);
      expect(expectOk(await h.call('get_context', { id: 'GF-235' })).text).toContain(
        'conflict ahead with GF-217 (gf-235-b vs gf-217-api) · 1 file · shared.txt',
      );
      // Discovery runs only for items with no reported branch: none here.
      expect(events('branch.discovered')).toEqual([]);

      // Nothing new: a second run writes no event.
      const n = count('SELECT count(*) AS n FROM events');
      await radarRunOnce(h.server.runtime, 'GF');
      expect(count('SELECT count(*) AS n FROM events')).toBe(n);

      // Replacing the set: gf-217-web keeps who reported it first; the finding clears.
      const first = (await branches('GF-217')).reported[1]!;
      expectOk(await declare({ id: 'GF-217', none: true, branches: ['gf-217-web'] }));
      expect((await branches('GF-217')).reported).toEqual([first]);
      expect(events('branch.reported', 'GF-217').at(-1)!.summary).toBe(
        "claude reported GF-217's branch: gf-217-web",
      );
      await hostGitPass(h.server, { home: tmp!.dir });
      const second = await api('POST', '/api/projects/GF/radar/run', {});
      expect(findings(second.body.radar as S)).toEqual([]);
      expect(events('radar.cleared', 'GF-217').map((e) => e.summary)).toEqual([
        'No longer heading for a conflict with GF-235 · gf-217-api vs gf-235-b',
      ]);
      // The same set again records nothing.
      const m = count("SELECT count(*) AS n FROM events WHERE type = 'branch.reported'");
      expectOk(await declare({ id: 'GF-217', none: true, branches: ['gf-217-web'] }));
      expect(count("SELECT count(*) AS n FROM events WHERE type = 'branch.reported'")).toBe(m);

      // Clearing: an empty list; the radar then looks by name and finds both GF-217 branches.
      const cleared = expectOk(await declare({ id: 'GF-217', none: true, branches: [] }));
      expect(cleared.text).toBe('Declared none on GF-217 · branches cleared');
      expect(events('branch.reported', 'GF-217').at(-1)!.summary).toBe(
        "claude cleared GF-217's branches; the radar looks for one",
      );
      await hostGitPass(h.server, { home: tmp!.dir });
      await api('POST', '/api/projects/GF/radar/run', {});
      expect(await branches('GF-217')).toEqual({
        reported: [],
        discovered: null,
        matches: ['gf-217-api', 'gf-217-web'],
      });

      // branch is a list of one: it replaces the set too, and the conflict is back.
      expectOk(await declare({ id: 'GF-217', none: true, branch: 'gf-217-api' }));
      expect(await names('GF-217')).toEqual(['gf-217-api']);
      await hostGitPass(h.server, { home: tmp!.dir });
      const third = await api('POST', '/api/projects/GF/radar/run', {});
      expect(findings(third.body.radar as S)).toEqual([
        ['gf-217-api', 'gf-235-b', 'GF-217', 'GF-235', ['shared.txt']],
      ]);
      expect(hashGitDir(repo)).toEqual(before);
    },
    30_000,
  );

  it('claim_lead, submit_packet and set_status add their branch; the owner adds and removes (undoable); at most 10', async () => {
    h = await askEveryHarness();
    const api = await owner();
    const names = async (id: string) =>
      ((await api('GET', `/api/items/${id}/shared`)).body.branches as Branches).reported.map(
        (b) => b.name,
      );

    // A claim adds its branch to what the declaration reported.
    const created = expectOk(
      await h.call('create_item', {
        project: 'RCP',
        type: 'Task',
        title: 'Epic part',
        status: 'planning',
      }),
    );
    const id = (created.structured.item as { id: string }).id;
    expectOk(await declare({ id, none: true, branches: ['rcp-a'] }));
    expectOk(await h.call('set_status', { id, status: 'ready' }));
    expectOk(await h.call('claim_lead', { id, branch: 'rcp-b' }));
    expect(await names(id)).toEqual(['rcp-a', 'rcp-b']);
    const reported = ((await api('GET', `/api/items/${id}/shared`)).body.branches as Branches)
      .reported[1]!;
    expect(reported).toMatchObject({ name: 'rcp-b', reported_by: 'claude' });

    // A hand-off adds its branch; one already there stays as it is.
    expectOk(await h.call('declare_human_review', { id, items: ['Open it.'] }));
    expectOk(
      await h.call('submit_packet', {
        id,
        built_from_commit: '9c0e7f2',
        estimate: '2 min',
        how: ['Open it.'],
        checked: [],
        branch: 'rcp-c',
      }),
    );
    expect(await names(id)).toEqual(['rcp-a', 'rcp-b', 'rcp-c']);

    // set_status to done adds the close's branch (on another item).
    const other = expectOk(
      await h.call('create_item', {
        project: 'RCP',
        type: 'Task',
        title: 'Closed',
        status: 'planning',
      }),
    );
    const closedId = (other.structured.item as { id: string }).id;
    expectOk(await declare({ id: closedId, none: true }));
    expectOk(await h.call('set_status', { id: closedId, status: 'ready' }));
    expectOk(await h.call('claim_lead', { id: closedId, workspace: { branch: 'rcp-ws' } }));
    expect(await names(closedId)).toEqual(['rcp-ws']);
    expectOk(await h.call('set_status', { id: closedId, status: 'done', branch: 'rcp-done' }));
    expect(await names(closedId)).toEqual(['rcp-ws', 'rcp-done']);

    // The owner adds and removes one; each is undoable.
    const add = await api('POST', `/api/items/${id}/shared/branches`, {
      op: 'add',
      branch: 'rcp-d',
    });
    expect(add.status).toBe(200);
    expect((add.body.branches as Branches).reported.map((b) => [b.name, b.reported_by])).toEqual([
      ['rcp-a', 'claude'],
      ['rcp-b', 'claude'],
      ['rcp-c', 'claude'],
      ['rcp-d', 'owner'],
    ]);
    const remove = await api('POST', `/api/items/${id}/shared/branches`, {
      op: 'remove',
      branch: 'rcp-a',
    });
    expect(await names(id)).toEqual(['rcp-b', 'rcp-c', 'rcp-d']);
    expect(
      events('branch.reported', id)
        .map((e) => e.summary)
        .slice(-2),
    ).toEqual([`You added rcp-d to ${id}'s branches`, `You removed rcp-a from ${id}'s branches`]);
    expect(
      (await api('POST', `/api/mutations/${remove.body.mutation_id as string}/undo`)).status,
    ).toBe(200);
    expect(await names(id)).toEqual(['rcp-a', 'rcp-b', 'rcp-c', 'rcp-d']);
    // Adding one already there, or removing one that isn't, records nothing.
    const n = count("SELECT count(*) AS n FROM events WHERE type = 'branch.reported'");
    await api('POST', `/api/items/${id}/shared/branches`, { op: 'add', branch: 'rcp-d' });
    await api('POST', `/api/items/${id}/shared/branches`, { op: 'remove', branch: 'nope' });
    expect(count("SELECT count(*) AS n FROM events WHERE type = 'branch.reported'")).toBe(n);

    // At most 10: declaring 11 is refused; the owner can't add an 11th; a claim's drops the oldest.
    const ten = Array.from({ length: 10 }, (_, i) => `rcp-${i}`);
    expectValidation(await declare({ id, none: true, branches: [...ten, 'rcp-x'] }));
    expectOk(await declare({ id, none: true, branches: ten }));
    const full = await api('POST', `/api/items/${id}/shared/branches`, {
      op: 'add',
      branch: 'rcp-x',
    });
    expect(full.status).toBe(400);
    expect((full.body.error as S).message).toContain('already has 10 branches');
    const third = expectOk(
      await h.call('create_item', {
        project: 'RCP',
        type: 'Task',
        title: 'Full',
        status: 'planning',
      }),
    );
    const fullId = (third.structured.item as { id: string }).id;
    expectOk(await declare({ id: fullId, none: true, branches: ten }));
    expectOk(await h.call('set_status', { id: fullId, status: 'ready' }));
    expectOk(await h.call('claim_lead', { id: fullId, branch: 'rcp-new' }));
    expect(await names(fullId)).toEqual([...ten.slice(1), 'rcp-new']);
  });
});

describe('SC-023: unattended agents never start overlapping work without an owner decision', () => {
  it('SC-023: two agents claiming overlapping items unattended start no overlapping work without an owner decision', async () => {
    h = await askEveryHarness();
    const api = await owner();
    await registry(api);
    // Four new P1 items (ahead of the seed's Ready work): two change model:Recipe.
    const ids: string[] = [];
    for (const [title, parts] of [
      ['Recipe units', ['model:Recipe']],
      ['Recipe source', ['model:Recipe']],
      ['Deck export', ['table:decks']],
      ['Copy edits', null],
    ] as const) {
      const r = expectOk(
        await h.call('create_item', {
          project: 'RCP',
          type: 'Task',
          title,
          status: 'planning',
          priority: 1,
        }),
      );
      const id = (r.structured.item as { id: string }).id;
      expectOk(
        await declare(
          parts
            ? { id, changes: parts.map((part) => ({ part, change: 'change' })) }
            : { id, none: true },
        ),
      );
      expectOk(await h.call('set_status', { id, status: 'ready' }));
      ids.push(id);
    }
    const [units, source] = ids as [string, string];
    const log: string[] = [];
    const agents = [
      { name: 'claude', client: h.a, started: [] as string[] },
      { name: 'codex', client: h.b, started: [] as string[] },
    ];

    /** No two claimed items share a declared part unless the owner decided the pair. */
    const assertNoUndecidedOverlap = () => {
      const rows = sql()
        .prepare(
          `SELECT a.item_id AS x, b.item_id AS y FROM item_shared_changes a
           JOIN item_shared_changes b ON a.part_key = b.part_key AND a.item_id < b.item_id
           JOIN items ia ON ia.id = a.item_id JOIN items ib ON ib.id = b.item_id
           WHERE ia.status IN ('progress', 'review') AND ib.status IN ('progress', 'review')
             AND ia.id IN (${ids.map(() => '?').join(', ')}) AND ib.id IN (${ids.map(() => '?').join(', ')})`,
        )
        .all(...ids, ...ids) as { x: string; y: string }[];
      for (const r of rows) {
        expect(
          count(
            "SELECT count(*) AS n FROM part_overlaps WHERE item_a = ? AND item_b = ? AND state IN ('compatible', 'sequenced')",
            r.x,
            r.y,
          ),
          `${r.x} and ${r.y} both started without an owner decision`,
        ).toBe(1);
      }
    };

    /** One unattended turn: take the first startable item of ours that claims; never wait. */
    const turn = async (agent: (typeof agents)[number]) => {
      const ready = items(
        await h!.call('search_items', { project: 'RCP', filter: 'ready_to_start' }, agent.client),
      );
      for (const id of ready.filter((x) => ids.includes(x))) {
        const r = await h!.call('claim_lead', { id }, agent.client);
        if (!r.isError) {
          agent.started.push(id);
          log.push(`${agent.name}: claimed ${id}`);
          return;
        }
        const code = (r.structuredContent as { code: string }).code;
        log.push(`${agent.name}: ${id} refused (${code}); picks other work`);
        expect(['seam_conflict', 'conflict']).toContain(code);
      }
      log.push(`${agent.name}: nothing startable; moves on`);
    };

    for (let round = 0; round < 4; round++) {
      for (const agent of agents) {
        await turn(agent);
        assertNoUndecidedOverlap();
      }
    }
    // One of the two Recipe items started; the other waits on the owner, still Ready.
    const startedAll = agents.flatMap((a) => a.started);
    expect(startedAll.filter((id) => id === units || id === source)).toHaveLength(1);
    const waiting = startedAll.includes(units) ? source : units;
    expect(status(waiting)).toBe('ready');
    expect(count("SELECT count(*) AS n FROM part_overlaps WHERE state = 'open'")).toBe(1);
    // Each agent moved on to other startable work rather than waiting.
    for (const agent of agents) expect(agent.started.length).toBeGreaterThan(0);
    expect(new Set(startedAll)).toEqual(new Set(ids.filter((id) => id !== waiting)));

    // The owner decides: they're compatible. The next unattended turn starts it.
    const id = (
      sql().prepare("SELECT id FROM part_overlaps WHERE state = 'open'").get() as { id: string }
    ).id;
    expect(
      (await api('POST', `/api/overlaps/${id}/decide`, { decision: 'compatible' })).status,
    ).toBe(200);
    log.push('owner: marked the pair compatible');
    for (const agent of agents) {
      await turn(agent);
      assertNoUndecidedOverlap();
    }
    expect(status(waiting)).toBe('progress');
    console.log(`SC-023 run:\n  ${log.join('\n  ')}`);
  });
});

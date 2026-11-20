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
 * The `it.todo` entries at the end are what B39 (T183, T184) must make true.
 */
import { CSRF_HEADER_NAME } from '@docket/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { ORIGIN, parseSetCookies } from '../integration/harness.js';
import {
  expectOk,
  expectToolError,
  expectValidation,
  startHarness,
  type ContractHarness,
} from './harness.js';

let h: ContractHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

type S = Record<string, unknown>;

const sql = () => h!.server.runtime.db.sqlite;
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

describe('declare_shared_changes (MCP_SPEC §5.15)', () => {
  it('registers new parts, replaces the declaration, and returns in-flight overlaps', async () => {
    h = await startHarness();
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
      },
    ]);
    expect(second.text).toBe(
      'Declared 2 changes on RCP-14 · registered table:shopping_lists · overlaps RCP-18 on model:Recipe',
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
    h = await startHarness();
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
    h = await startHarness();
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
    h = await startHarness();
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

  it('get_context has no shared section until B39 fills it', async () => {
    h = await startHarness();
    expectOk(
      await declare({
        id: 'RCP-14',
        changes: [{ part: 'model:Recipe', change: 'add' }],
        new_parts: [{ key: 'model:Recipe' }],
      }),
    );
    const ctx = expectOk(await h.call('get_context', { id: 'RCP-14' }));
    expect((ctx.structured.context as S).shared).toBeUndefined();
    expect(ctx.text).not.toContain('shared:');
  });
});

describe('the owner API (UI_SPEC §6.3.6)', () => {
  it('creates, edits, archives and restores registry parts; creating and editing are undoable', async () => {
    h = await startHarness();
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
    h = await startHarness();
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

  it('the radar card is off with no repository; decisions, lease release and radar runs are 501 until B39', async () => {
    h = await startHarness();
    const api = await owner();
    expect((await api('GET', '/api/projects/RCP/radar')).body).toEqual({
      project: 'RCP',
      repo_path: null,
      main_branch: 'main',
      state: 'off',
      off_reason: 'Radar off: no repository',
      last_run_at: null,
      findings: [],
    });
    for (const [method, path, body] of [
      ['POST', '/api/overlaps/pov_1/decide', { decision: 'sequence' }],
      ['POST', '/api/undeclared-holds/udh_1/decide', { decision: 'send_back' }],
      ['POST', '/api/leases/pls_1/release', {}],
      ['PUT', '/api/projects/RCP/radar', { repo_path: 'recipe-app' }],
      ['POST', '/api/projects/RCP/radar/run', {}],
    ] as const) {
      const r = await api(method, path, body);
      expect(r.status, path).toBe(501);
    }
  });

  it('PATCH /api/items/:id takes override_reason only with status ready', async () => {
    h = await startHarness();
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

/** What B39 (T183, T184) must make true; each becomes a real test there. */
describe('B39 will make these true (BUILD_SPEC §5.21)', () => {
  it.todo(
    'set_status ready on an item without a declaration (or none) is not_declared, for agents and the owner',
  );
  it.todo('the owner moves an undeclared item to Ready with override_reason, recorded in Activity');
  it.todo(
    'claim_lead on an item whose parts overlap an in-flight item is seam_conflict { with, parts }, and the item stays Ready',
  );
  it.todo(
    'the refused claim opens one part_overlaps row and one Needs you card; claiming the same pair again opens no second',
  );
  it.todo(
    'Run one after the other adds a merged blocks link from the item claimed first; the other is startable once it merges',
  );
  it.todo(
    "They're compatible records the pair; its note is posted to both items as an owner note; the claim then succeeds",
  );
  it.todo(
    'declaring later, while in progress, flags both items ("Now overlaps …") and raises the question, keeping the claim',
  );
  it.todo(
    'take_lease on a single-writer part returns held_until; a second item gets lease_held with the holder and expiry',
  );
  it.todo(
    'a lease ends on release_lease, owner release, Done, hand-off (submit_packet or set_status done) and expiry',
  );
  it.todo(
    'submit_packet with changed_files mapping to undeclared parts holds the packet (held_undeclared) and raises the question',
  );
  it.todo(
    'set_status done with changed files mapping to undeclared parts is not_declared, raises the question, and leaves the item',
  );
  it.todo(
    'Add to the declaration adds the parts and releases the hold; Send back returns the item with an owner note',
  );
  it.todo(
    'an item with declarations that hands off without changed_files shows "Changed files not reported" on the packet',
  );
  it.todo(
    'get_context.shared lists the declaration, overlapping and up to 30 other in-flight declarations, leases and findings, within budget',
  );
  it.todo(
    'the radar trial-merges in-flight branches with merge-tree and a temporary object directory, leaving .git unchanged',
  );
  it.todo(
    'SC-023: two agents claiming overlapping items unattended start no overlapping work without an owner decision',
  );
});

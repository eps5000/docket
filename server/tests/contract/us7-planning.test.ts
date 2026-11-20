/**
 * US7 over MCP and the UI API (tasks.md T124, T125): the worked flow
 * MCP_SPEC §7.8 (planning a new epic: `put_document`, `upsert_label`), the
 * document tools' errors and idempotency, and the owner's planning routes as
 * the screens call them: quick capture, inline edits with `warnings` and a
 * `409` that carries the latest text, cancel with undo, archive, the label
 * page and *Move N to Ready*, and document content.
 *
 * The compact text of every step is printed (PR evidence).
 */
import { createHash } from 'node:crypto';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { ORIGIN, parseSetCookies } from '../integration/harness.js';
import {
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

const transcript: string[] = [];
afterAll(() => {
  if (transcript.length > 0) console.log(transcript.join('\n'));
});

type S = Record<string, unknown>;

async function step(name: string, args: S, client = h!.a) {
  const out = expectOk(await h!.call(name, args, client));
  transcript.push(`> ${name} ${JSON.stringify(args).slice(0, 200)}`, out.text, '');
  return out;
}

async function fails(name: string, args: S, client = h!.a): Promise<CallToolResult> {
  const res = await h!.call(name, args, client);
  transcript.push(`> ${name} ${JSON.stringify(args).slice(0, 200)}`, textOf(res), '');
  return res;
}

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
    const type = r.headers.get('content-type') ?? '';
    const text = await r.text();
    transcript.push(
      `owner ${method} ${path} ${body === undefined ? '' : JSON.stringify(body)}`.trim(),
      `→ ${r.status} ${type.startsWith('application/json') ? text.slice(0, 300) : `(${type})`}`,
      '',
    );
    return {
      status: r.status,
      headers: r.headers,
      text,
      body: (type.startsWith('application/json') && text ? JSON.parse(text) : {}) as S,
    };
  };
}

const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const version = (id: string) =>
  (
    h!.server.runtime.db.sqlite.prepare('SELECT version FROM items WHERE id = ?').get(id) as {
      version: number;
    }
  ).version;

describe('flow §7.8: planning a new epic', () => {
  it('creates the epic, stores its PRD, versions it, labels the initiative', async () => {
    h = await startHarness();
    const epic = await step('create_item', {
      project: 'RCP',
      type: 'Epic',
      title: 'Leftovers',
      status: 'planning',
      outcome_md: 'Use what is left over.',
    });
    const id = (epic.structured.item as { id: string }).id;
    const v1 = await step('put_document', {
      item_id: id,
      name: 'leftovers-prd.md',
      kind: 'planning',
      content_text: '# Leftovers PRD\n',
    });
    expect(v1.structured).toMatchObject({
      version_no: 1,
      sha256: sha('# Leftovers PRD\n'),
      size: 16,
    });
    expect(v1.text).toMatch(/^Stored leftovers-prd\.md v1 · dv_\w+ · 16 bytes$/);
    const v2 = await step('put_document', {
      item_id: id,
      name: 'leftovers-prd.md',
      kind: 'planning',
      content_text: '# Leftovers PRD\n\nv2\n',
    });
    expect(v2.structured).toMatchObject({ document_id: v1.structured.document_id, version_no: 2 });
    const shot = Buffer.from('fake png bytes');
    const png = await step('put_document', {
      item_id: id,
      name: 'flow.png',
      kind: 'packet_attachment',
      content_base64: shot.toString('base64'),
    });
    expect(png.structured).toMatchObject({ version_no: 1, sha256: sha(shot), size: shot.length });

    const label = await step('upsert_label', {
      project: 'RCP',
      name: 'leftovers',
      brief_md: 'Cook once, eat twice.',
    });
    expect(label.structured).toEqual({
      project: 'RCP',
      name: 'leftovers',
      brief_md: 'Cook once, eat twice.',
    });
    await step('update_item', { id, expected_version: version(id), add_labels: ['leftovers'] });

    // get_item lists the newest version; get_context reads the PRD from disk.
    const item = await step('get_item', { id, view: 'full' });
    const docs = (item.structured.item as { documents: { name: string; latest: S }[] }).documents;
    expect(docs.map((x) => [x.name, x.latest.version_no])).toEqual([
      ['flow.png', 1],
      ['leftovers-prd.md', 2],
    ]);
    const ctx = await step('get_context', { id });
    expect(JSON.stringify(ctx.structured)).toContain('v2');
  });

  it('put_document errors: kind brief, both or neither content, unknown item, size', async () => {
    h = await startHarness();
    const brief = expectValidation(
      await fails('put_document', {
        item_id: 'RCP-2',
        name: 'brief.md',
        kind: 'brief',
        content_text: 'x',
      }),
    );
    expect(brief.details?.fields).toMatchObject({ kind: expect.stringContaining('planning') });
    expectValidation(
      await fails('put_document', {
        item_id: 'RCP-2',
        name: 'a.md',
        kind: 'planning',
        content_text: 'x',
        content_base64: 'eA==',
      }),
    );
    expectValidation(
      await fails('put_document', { item_id: 'RCP-2', name: 'a.md', kind: 'planning' }),
    );
    expectNotFound(
      await fails('put_document', {
        item_id: 'RCP-999',
        name: 'a.md',
        kind: 'planning',
        content_text: 'x',
      }),
    );
    const secret = expectValidation(
      await fails('put_document', {
        item_id: 'RCP-2',
        name: 'a.md',
        kind: 'planning',
        content_text: 'key: ghp_abcdefghijklmnopqrstuvwxyz0123',
      }),
    );
    expect(secret.message).toMatch(/^Looks like a secret/);
  });

  it('put_document is idempotent: a replay stores no new version', async () => {
    h = await startHarness();
    const args = {
      item_id: 'RCP-2',
      name: 'pantry-ux.md',
      kind: 'planning',
      content_text: '# UX',
      idempotency_key: 'doc-1',
    };
    const first = await step('put_document', args);
    const again = await step('put_document', args);
    expect(again.structured).toEqual({ ...first.structured, replayed: true });
    const n = h.server.runtime.db.sqlite
      .prepare("SELECT count(*) AS n FROM documents WHERE name = 'pantry-ux.md'")
      .get() as { n: number };
    expect(n.n).toBe(1);
  });

  it('upsert_label: bad names are validation, an unknown project not_found', async () => {
    h = await startHarness();
    expectValidation(await fails('upsert_label', { project: 'RCP', name: 'Not A Label' }));
    expectNotFound(await fails('upsert_label', { project: 'ZZZ', name: 'x' }));
  });
});

describe('the owner’s planning routes', () => {
  it('quick capture, inline edits with warnings and a 409 that keeps the latest text', async () => {
    h = await startHarness();
    const owner = await ownerApi();
    const created = await owner('POST', '/api/items', {
      title: 'Leftovers ideas',
      type: 'Story',
      project: 'RCP',
      epic: 'RCP-1',
      notes: 'Rough.',
    });
    expect(created.status).toBe(200);
    const item = created.body.item as { id: string; status: string; version: number };
    expect(item.status).toBe('inbox');

    const edit = await owner('PATCH', `/api/items/${item.id}`, {
      expected_version: item.version,
      outcome_md: 'Builds on RCP-14 and RCP-999.',
    });
    expect(edit.status).toBe(200);
    expect(edit.body).toMatchObject({
      mutation_id: expect.stringMatching(/^mut_/),
      item: { id: item.id, outcome_md: 'Builds on RCP-14 and RCP-999.' },
      warnings: ["RCP-999 doesn't exist"],
    });

    // An agent edits it first; the owner's stale edit is refused with the latest text.
    await step(
      'update_item',
      {
        id: item.id,
        expected_version: item.version + 1,
        outcome_md: 'codex’s outcome.',
      },
      h.b,
    );
    const stale = await owner('PATCH', `/api/items/${item.id}`, {
      expected_version: item.version + 1,
      outcome_md: 'Mine.',
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatchObject({
      code: 'conflict',
      current: { outcome_md: 'codex’s outcome.', changed_by: 'codex' },
    });

    const moved = await owner('PATCH', `/api/items/${item.id}`, {
      expected_version: version(item.id),
      status: 'planning',
    });
    expect(moved.body).toMatchObject({ item: { status: 'planning' } });
    const undone = await owner('POST', `/api/mutations/${moved.body.mutation_id as string}/undo`);
    expect(undone.status).toBe(200);
  });

  it('cancel with undo, archive and Archive all, the label page and Move N to Ready', async () => {
    h = await startHarness();
    const owner = await ownerApi();
    const canceled = await owner('POST', '/api/items/RCP-14/cancel', {
      expected_version: version('RCP-14'),
      reason: 'Replaced by a new plan.',
    });
    expect(canceled.body).toMatchObject({ item: { status: 'canceled', lead: null } });
    // The agent's run is over.
    const run = (
      h.server.runtime.db.sqlite
        .prepare(
          "SELECT end_reason FROM runs WHERE item_id = 'RCP-14' AND is_lead = 1 ORDER BY created_at DESC LIMIT 1",
        )
        .get() as { end_reason: string }
    ).end_reason;
    expect(run).toBe('canceled');
    const back = await owner('POST', `/api/mutations/${canceled.body.mutation_id as string}/undo`);
    expect(back.status).toBe(200);
    expect(version('RCP-14')).toBeGreaterThan(0);

    const epic = await owner('POST', '/api/items/RCP-2/cancel', {
      expected_version: version('RCP-2'),
    });
    expect(epic.status).toBe(400);
    expect(epic.body.error).toMatchObject({
      code: 'validation',
      details: { open_children: ['RCP-15', 'RCP-21', 'RCP-25'] },
    });

    const one = await owner('POST', '/api/items/RCP-11/archive');
    expect(one.body).toMatchObject({ item: { id: 'RCP-11', archived: true } });
    const all = await owner('POST', '/api/archive', { ids: ['DOC-2'] });
    expect(all.body).toMatchObject({ archived: ['DOC-2'] });
    const un = await owner('POST', '/api/items/RCP-11/unarchive');
    expect(un.body).toMatchObject({ item: { archived: false } });
    const notDone = await owner('POST', '/api/items/RCP-20/archive');
    expect(notDone.status).toBe(400);

    const page = await owner('GET', '/api/labels/RCP/ui-refresh');
    expect(page.body).toMatchObject({ counts: { total: 4, done: 0, planning: 2 } });
    // The Ready gate (decision 36): undeclared items refuse the whole move.
    const gated = await owner('POST', '/api/labels/RCP/ui-refresh/move-to-ready');
    expect(gated.status).toBe(400);
    expect(gated.body).toMatchObject({
      error: { code: 'not_declared', details: { items: ['RCP-23', 'RCP-27'] } },
    });
    for (const id of ['RCP-23', 'RCP-27']) {
      expect((await owner('PUT', `/api/items/${id}/shared`, { none: true })).status).toBe(200);
    }
    const move = await owner('POST', '/api/labels/RCP/ui-refresh/move-to-ready');
    expect(move.body).toMatchObject({ moved: ['RCP-23', 'RCP-27'] });
    const unknown = await owner('GET', '/api/labels/RCP/nope');
    expect(unknown.status).toBe(404);
  });

  it('document content: a stored version comes back with its headers', async () => {
    h = await startHarness();
    const owner = await ownerApi();
    const doc = await step('put_document', {
      item_id: 'RCP-2',
      name: 'pantry-prd.md',
      kind: 'planning',
      content_text: '# Pantry',
    });
    const res = await owner(
      'GET',
      `/api/documents/${doc.structured.document_version_id as string}/content`,
    );
    expect(res.status).toBe(200);
    expect(res.text).toBe('# Pantry');
    expect(res.headers.get('content-disposition')).toBe("inline; filename*=UTF-8''pantry-prd.md");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });
});

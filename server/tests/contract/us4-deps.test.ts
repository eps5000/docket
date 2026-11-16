/**
 * US4 over MCP (tasks.md T104): the worked flow MCP_SPEC §7.11 (wait for the
 * merge), `dependency_subgraph` with `delay_days`, MCP_SPEC §10 test 14
 * (`satisfied_when`) and the item-reference half of test 15, through the
 * official SDK client against a seeded server. The owner's side (the review
 * decision that closes RCP-19, the project rule, removing a cycle link, a
 * text edit with a warning) goes through the UI API with an owner session.
 *
 * The compact text of every step is printed (PR evidence).
 */
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

/** Call a tool through client `a`, keep its compact text for the transcript, return both. */
async function step(name: string, args: S): Promise<{ structured: S; text: string }> {
  const res = await h!.call(name, args);
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
  const cookie = `tl_owner=${cookies.tl_owner!.value}; tl_csrf=${cookies.tl_csrf!.value}`;
  return async (method: string, path: string, body?: unknown) => {
    const r = await req(path, {
      method,
      headers: {
        cookie,
        ...(method === 'GET' ? {} : { 'x-tasklite-csrf': cookies.tl_csrf!.value }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, body: (await r.json()) as S };
  };
}

const readyToStart = async (project = 'RCP') =>
  (
    (await step('search_items', { project, filter: 'ready_to_start', fields: ['id'] })).structured
      .items as { id: string }[]
  ).map((i) => i.id);

describe('MCP_SPEC §7.11: stricter dependency, wait for the merge', () => {
  it('RCP-16 waits for RCP-19 to be merged, not just done; the reported merge clears it', async () => {
    h = await startHarness();
    const owner = await ownerApi();

    let summary = await step('get_item', { id: 'RCP-16', view: 'summary' });
    expect((summary.structured.item as S).blocked_by).toEqual(['DOC-4', 'RCP-19']);

    // The seed already sets this link to merged; calling again updates it in place.
    const linked = await step('link_items', {
      from: 'RCP-19',
      to: 'RCP-16',
      type: 'blocks',
      satisfied_when: 'merged',
    });
    expect(linked.structured).toMatchObject({
      from: 'RCP-19',
      to: 'RCP-16',
      type: 'blocks',
      satisfied_when: 'merged',
      updated: true,
    });
    expect(linked.text).toMatch(/^Updated lnk_\S+ · RCP-19 blocks RCP-16 · clears when merged$/);

    // RCP-19 closes as done: the owner approves its packet (US3's flow, through the API).
    const review = await owner('GET', '/api/review/RCP-19');
    const packet = review.body as { packet: { round: number; items: { hr_item_id: string }[] } };
    const decided = await owner('POST', '/api/review/RCP-19/decisions', {
      round: packet.packet.round,
      verdicts: packet.packet.items.map((i) => ({ hr_item_id: i.hr_item_id, kind: 'approve' })),
    });
    expect(decided.status).toBe(200);
    expect(
      h.server.runtime.db.sqlite.prepare("SELECT status FROM items WHERE id = 'RCP-19'").get(),
    ).toEqual({ status: 'done' });

    summary = await step('get_item', { id: 'RCP-16', view: 'summary' });
    expect((summary.structured.item as S).blocked_by).toEqual(['DOC-4', 'RCP-19']);
    const standard = await step('get_item', { id: 'RCP-16' });
    expect(standard.text).toContain(
      'blocked_by: DOC-4 progress waiting for done, RCP-19 done waiting for merge',
    );
    const blockers = ((standard.structured.item as S).links as { blocked_by: S[] }).blocked_by;
    expect(blockers.find((b) => b.id === 'RCP-19')).toMatchObject({
      satisfied_when: 'merged',
      cleared: false,
      waiting_for: 'merge',
    });

    await step('link_artifact', {
      id: 'RCP-19',
      kind: 'pr',
      label: 'PR #52',
      url: 'https://github.com/example/recipes/pull/52',
      state: 'merged',
    });
    summary = await step('get_item', { id: 'RCP-16', view: 'summary' });
    expect((summary.structured.item as S).blocked_by).toEqual(['DOC-4']);
    expect(await readyToStart()).not.toContain('RCP-16');
  });
});

describe('MCP_SPEC §10 test 14: satisfied_when gates ready_to_start', () => {
  it('done, merged and verified each gate correctly; a link override beats the project default', async () => {
    h = await startHarness();
    const owner = await ownerApi();
    // RCP-11 is done in the seed and blocks RCP-12 (review) and RCP-14 (progress).
    // Use fresh items so ready_to_start is easy to read.
    const make = async (title: string) =>
      (
        (await step('create_item', { project: 'RCP', type: 'Task', title, status: 'planning' }))
          .structured.item as { id: string }
      ).id;
    const blocker = await make('Blocker with review');
    const dep = await make('Dependent');
    await step('set_status', { id: dep, status: 'ready' });
    await step('link_items', { from: blocker, to: dep, type: 'blocks' });
    expect(await readyToStart()).not.toContain(dep);

    // verified without human review items: validation.
    const refused = await fails('link_items', {
      from: blocker,
      to: dep,
      type: 'blocks',
      satisfied_when: 'verified',
    });
    expect(expectValidation(refused).message).toBe(
      `Declare human review on ${blocker}, or use done.`,
    );

    // done: closing the blocker makes the dependent startable.
    await step('set_status', { id: blocker, status: 'ready' });
    await step('set_status', { id: blocker, status: 'progress' });
    await step('set_status', { id: blocker, status: 'done' });
    expect(await readyToStart()).toContain(dep);

    // The owner sets the project rule to PR merged: blocked again, with the toast's count.
    const patched = await owner('PATCH', '/api/projects/RCP', { default_satisfied_when: 'merged' });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({
      project: { key: 'RCP', default_satisfied_when: 'merged' },
      unblocked: [],
    });
    expect(patched.body.reblocked).toContain(dep);
    expect(typeof patched.body.mutation_id).toBe('string');
    expect(await readyToStart()).not.toContain(dep);

    // A link override (done) beats the project default (merged).
    await step('link_items', { from: blocker, to: dep, type: 'blocks', satisfied_when: 'done' });
    expect(await readyToStart()).toContain(dep);

    // Back to merged on the link: blocked until the merge is reported.
    await step('link_items', { from: blocker, to: dep, type: 'blocks', satisfied_when: 'merged' });
    expect(await readyToStart()).not.toContain(dep);
    await step('link_artifact', { id: blocker, kind: 'pr', label: 'PR #9', state: 'merged' });
    expect(await readyToStart()).toContain(dep);

    // The change feed recorded the rule changes.
    const changes = await step('get_changes', {
      cursor: '0',
      types: ['project.updated', 'link.updated'],
    });
    const types = (changes.structured.events as { type: string }[]).map((e) => e.type);
    expect(types).toEqual(['project.updated', 'link.updated', 'link.updated']);
  });
});

describe('cycles and link errors over MCP', () => {
  it('a link that would close a cycle is refused with the path; other errors are well-formed', async () => {
    h = await startHarness();
    // RCP-11 blocks RCP-12, which blocks RCP-22.
    const cycle = await fails('link_items', { from: 'RCP-22', to: 'RCP-11', type: 'blocks' });
    const err = expectValidation(cycle);
    expect(err.details).toEqual({ cycle: ['RCP-11', 'RCP-12', 'RCP-22', 'RCP-11'] });
    expect(err.message).toContain('RCP-11 → RCP-12 → RCP-22 → RCP-11');

    expectValidation(await fails('link_items', { from: 'RCP-22', to: 'RCP-22', type: 'blocks' }));
    expectNotFound(await fails('link_items', { from: 'RCP-22', to: 'RCP-999', type: 'blocks' }));
    expectNotFound(await fails('unlink_items', { from: 'RCP-22', to: 'RCP-11', type: 'blocks' }));

    const removed = await step('unlink_items', { from: 'RCP-12', to: 'RCP-22', type: 'blocks' });
    expect(removed.structured).toEqual({ removed: true });
    expect(removed.text).toBe('Removed link RCP-12 blocks RCP-22');
  });

  it('the owner fixes the imported DOC-7 ⇄ DOC-8 cycle from Problems, and undo puts it back', async () => {
    h = await startHarness();
    const owner = await ownerApi();
    const needs = await owner('GET', '/api/needs-you?scope=all');
    const problem = (
      needs.body.problems as { kind: string; related: string[]; reason: string }[]
    ).find((p) => p.kind === 'cycle')!;
    expect(problem.reason).toBe(
      'Dependency cycle in imported data: DOC-7 ⇄ DOC-8. None of them can start until one link is removed.',
    );
    const detail = await owner('GET', '/api/items/DOC-7');
    const links = detail.body.links as { link_id: string; from: string; to: string }[];
    const back = links.find((l) => l.from === 'DOC-8' && l.to === 'DOC-7')!;
    const del = await owner('DELETE', `/api/links/${back.link_id}`);
    expect(del.status).toBe(200);
    expect(del.body).toMatchObject({ removed: true, unblocked: ['DOC-7'] });
    const after = await owner('GET', '/api/needs-you?scope=all');
    expect((after.body.problems as { kind: string }[]).some((p) => p.kind === 'cycle')).toBe(false);
    const undo = await owner('POST', `/api/mutations/${String(del.body.mutation_id)}/undo`);
    expect(undo.status).toBe(200);
    const again = await owner('GET', '/api/needs-you?scope=all');
    expect((again.body.problems as { kind: string }[]).some((p) => p.kind === 'cycle')).toBe(true);
  });
});

describe('dependency_subgraph', () => {
  it('walks up and down to depth, labels dates, and finds what a delay puts at risk', async () => {
    h = await startHarness();
    const both = await step('dependency_subgraph', { id: 'RCP-12' });
    const ids = (both.structured.nodes as { id: string }[]).map((n) => n.id);
    expect(ids).toEqual(['RCP-12', 'RCP-11', 'RCP-22', 'RCP-23']);
    expect(both.structured.edges).toEqual([
      { from: 'RCP-11', to: 'RCP-12', type: 'blocks' },
      { from: 'RCP-12', to: 'RCP-22', type: 'blocks' },
      { from: 'RCP-12', to: 'RCP-23', type: 'blocks' },
    ]);
    const node = (id: string) =>
      (
        both.structured.nodes as { id: string; date_source: string; planned_start: string | null }[]
      ).find((n) => n.id === id)!;
    expect(node('RCP-22')).toMatchObject({ date_source: 'entered' });
    expect(node('RCP-23')).toMatchObject({ date_source: 'none', planned_start: null });
    expect(both.structured.at_risk).toEqual([]);

    // RCP-12 ends 11-07 (shifted); RCP-22 starts 11-16. A 10-day slip pushes RCP-12 past it.
    const delayed = await step('dependency_subgraph', { id: 'RCP-12', delay_days: 10 });
    const risk = delayed.structured.at_risk as { id: string; reason: string }[];
    expect(risk.map((r) => r.id)).toEqual(['RCP-22']);
    expect(risk[0]!.reason).toMatch(
      /^planned start \d{4}-\d{2}-\d{2} is on or before RCP-12's planned end \d{4}-\d{2}-\d{2} after a 10-day slip$/,
    );
    expect(delayed.text).toContain('RCP-22 at risk: planned start');

    const up = await step('dependency_subgraph', { id: 'RCP-16', direction: 'up', depth: 1 });
    expect((up.structured.nodes as { id: string }[]).map((n) => n.id)).toEqual([
      'RCP-16',
      'DOC-4',
      'RCP-19',
    ]);
    const down = await step('dependency_subgraph', { id: 'RCP-11', direction: 'down', depth: 1 });
    expect((down.structured.nodes as { id: string }[]).map((n) => n.id)).toEqual([
      'RCP-11',
      'RCP-12',
      'RCP-14',
    ]);

    const cyc = await step('dependency_subgraph', { id: 'DOC-7' });
    expect(cyc.structured.cycles).toEqual([['DOC-7', 'DOC-8']]);
    expect(cyc.text).toContain('cycle: DOC-7 → DOC-8');

    expectValidation(await fails('dependency_subgraph', { id: 'RCP-12', depth: 6 }));
    expectNotFound(await fails('dependency_subgraph', { id: 'RCP-999' }));
  });
});

describe('MCP_SPEC §10 test 15 (references): item IDs that don’t exist warn', () => {
  it('add_note, update_item and an owner text edit accept the write with a warning', async () => {
    h = await startHarness();
    const owner = await ownerApi();

    const note = await step('add_note', {
      id: 'RCP-14',
      text: 'Unit merging also affects RCP-99; see `RCP-98` in the fixture.',
    });
    expect(note.structured.warnings).toEqual(["RCP-99 doesn't exist"]);
    expect(note.text.split('\n').at(-1)).toBe("! RCP-99 doesn't exist");

    const item = await step('get_item', { id: 'RCP-22', view: 'summary' });
    const updated = await step('update_item', {
      id: 'RCP-22',
      expected_version: (item.structured.item as { version: number }).version,
      outcome_md: 'Shared links open the plan read-only. Follows RCP-12 and RCP-97; UTF-8 safe.',
    });
    expect(updated.structured.warnings).toEqual(["RCP-97 doesn't exist"]);
    expect(updated.text).toMatch(/\n! RCP-97 doesn't exist$/);

    // No warning when every ID exists.
    const clean = await step('add_note', { id: 'RCP-14', text: 'Waiting on RCP-12.' });
    expect(clean.structured.warnings).toBeUndefined();
    expect(clean.text).not.toContain('!');

    // The owner's text edits go through the same write path.
    const added = await owner('POST', '/api/items/RCP-14/human-review', {
      text: 'Compare the totals with RCP-96 on your phone.',
    });
    expect(added.status).toBe(200);
    expect(added.body.warnings).toEqual(["RCP-96 doesn't exist"]);
    transcript.push(
      '> POST /api/items/RCP-14/human-review',
      JSON.stringify(added.body.warnings),
      '',
    );
  });
});

describe('the owner views carry the outside cards', () => {
  it('the item page and Work → Map include blockers from outside their scope', async () => {
    h = await startHarness();
    const owner = await ownerApi();
    const detail = await owner('GET', '/api/items/RCP-16');
    expect((detail.body.outside as { id: string }[]).map((i) => i.id).sort()).toEqual([
      'DOC-4',
      'RCP-19',
    ]);
    const epic = await owner('GET', '/api/items/RCP-1');
    expect((epic.body.outside as { id: string }[]).map((i) => i.id)).toContain('DOC-4');
    const work = await owner('GET', '/api/work?scope=RCP&epic=RCP-1&layout=map');
    expect((work.body.outside as { id: string }[]).map((i) => i.id)).toEqual(['DOC-4']);
    const links = work.body.links as { from: string; to: string }[];
    expect(links).toContainEqual(expect.objectContaining({ from: 'DOC-4', to: 'RCP-16' }));
    const settings = await owner('GET', '/api/settings');
    expect(settings.status).toBe(200);
    expect((settings.body.projects as { key: string }[]).map((p) => p.key)).toEqual(['DOC', 'RCP']);
  });
});

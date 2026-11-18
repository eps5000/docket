/**
 * US3 over MCP (tasks.md T089): the worked flows MCP_SPEC §7.3 (packet,
 * changes, second round), §7.4 (a commit after handing off) and §7.9
 * (cleanup of deferred checks), through the official SDK client against a
 * seeded server. The owner's side goes through the UI API with an owner
 * session, as the packet screen sends it. Plus each review tool's error
 * codes, idempotent replay and a two-client submit race.
 *
 * The compact text of the §7.3 round trip is printed (PR evidence).
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { parseSetCookies } from '../integration/harness.js';
import {
  expectConflict,
  expectForbidden,
  expectNotFound,
  expectOk,
  expectValidation,
  startHarness,
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
const ok = (r: CallToolResult) => expectOk(r).structured;

/** Call a tool, keep its compact text for the transcript, return the structured result. */
async function step(name: string, args: S, client = h!.a): Promise<S> {
  const res = await h!.call(name, args, client);
  const { structured, text } = expectOk(res);
  transcript.push(`> ${name} ${JSON.stringify(args)}`, text, '');
  return structured;
}

/** An owner session on the in-process server, and a JSON request helper. */
async function ownerApi(harness: ContractHarness) {
  const res = await harness.server.request('/api/session/unlock', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: harness.server.runtime.secrets.ownerKey() }),
  });
  const cookies = parseSetCookies(res);
  const cookie = `docket_owner=${cookies.docket_owner!.value}; docket_csrf=${cookies.docket_csrf!.value}`;
  return async (method: string, path: string, body?: unknown) => {
    const r = await harness.server.request(path, {
      method,
      headers: {
        cookie,
        ...(method === 'GET' ? {} : { 'x-docket-csrf': cookies.docket_csrf!.value }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, body: (await r.json()) as S };
  };
}

/** put_document is US7's (T124); attach a document version the way it will store one. */
function attachFixture(harness: ContractHarness, itemId: string, name: string): string {
  const sql = harness.server.runtime.db.sqlite;
  const t = harness.server.clock.now().toISOString();
  sql
    .prepare(
      `INSERT INTO documents (id, project_key, item_id, name, kind, created_at, updated_at) VALUES (?, 'RCP', ?, ?, 'packet_attachment', ?, ?)`,
    )
    .run(`doc_${name}`, itemId, name, t, t);
  sql
    .prepare(
      `INSERT INTO document_versions (id, document_id, version_no, mime, size, sha256, path, created_by, created_at, updated_at)
       VALUES (?, ?, 1, 'video/mp4', 10, 'abc', ?, 'claude', ?, ?)`,
    )
    .run(`dv_${name}`, `doc_${name}`, `RCP/doc_${name}/v1/${name}`, t, t);
  return `dv_${name}`;
}

const ITEMS = [
  'On your phone, drag recipes between days and meal slots. Does it feel right?',
  'Move a recipe using only the keyboard (Space, arrows, Enter).',
];

describe('§7.3 with human review: packet, changes, second round', () => {
  it('declare → submit round 1 → owner sends back (step + bug) → resumable → get_review → round 2', async () => {
    h = await startHarness();
    const api = await ownerApi(h);
    transcript.push('## §7.3 round 1 → changes → round 2', '');

    const { run_id } = (await step('claim_lead', { id: 'RCP-17', agent_label: 'orca-w1' })) as {
      run_id: string;
    };
    const declared = (await step('declare_human_review', { id: 'RCP-17', items: ITEMS })) as {
      human_review: { id: string; state: string; added_by_client: string }[];
    };
    expect(declared.human_review.map((x) => [x.state, x.added_by_client])).toEqual([
      ['declared', 'claude'],
      ['declared', 'claude'],
    ]);
    const [hr1, hr2] = declared.human_review.map((x) => x.id) as [string, string];
    await step('report_commit', { id: 'RCP-17', run_id, sha: '7d21aa3', branch: 'rcp-17-planner' });
    const dvA = attachFixture(h, 'RCP-17', 'drag-phone.mp4');
    const r1 = (await step('submit_packet', {
      id: 'RCP-17',
      run_id,
      built_from_commit: '7d21aa3',
      estimate: '10 min',
      how: [
        'Open the preview build at http://127.0.0.1:5173 (branch rcp-17-planner).',
        'Drag three recipes.',
      ],
      checked: [
        { text: '214 unit and integration tests pass', provenance: 'ci', evidence: 'CI build #88' },
      ],
      gaps: ['Not tested on Android.'],
      attachments: [{ document_version_id: dvA, caption: 'Screen recording · 24 s' }],
    })) as { round: number; display_id: string; item: S };
    expect(r1.round).toBe(1);
    expect(r1.display_id).toMatch(/^pkt-[0-9a-f]{4}$/);
    expect(r1.item.status).toBe('review');
    await step('finish_run', {
      run_id,
      result: 'finished',
      summary: 'Built drag-and-drop; packet round 1 submitted.',
    });

    // The owner opens the packet and sends both items back.
    const screen = await api('GET', '/api/review/RCP-17');
    expect(screen.status).toBe(200);
    const packet = screen.body.packet as {
      round: number;
      items: { hr_item_id: string; text: string }[];
      attachments: { name: string; caption: string }[];
    };
    expect(packet.items.map((x) => x.text)).toEqual(ITEMS);
    expect(packet.attachments).toEqual([
      {
        document_version_id: dvA,
        name: 'drag-phone.mp4',
        mime: 'video/mp4',
        caption: 'Screen recording · 24 s',
      },
    ]);
    const decided = await api('POST', '/api/review/RCP-17/decisions', {
      round: 1,
      verdicts: [
        {
          hr_item_id: hr1,
          kind: 'changes',
          note: 'Drop targets are too small on my phone',
          into: 'checklist',
        },
        {
          hr_item_id: hr2,
          kind: 'changes',
          note: 'After a reload the planner jumps back to the current week',
          into: 'bug',
        },
      ],
    });
    expect(decided.status).toBe(200);
    expect(decided.body).toMatchObject({ outcome: 'progress', item: { status: 'progress' } });
    expect(decided.body.mutation_id).toMatch(/^mut_/);
    const bug = (decided.body.created as { id: string; kind: string }[])[0]!;
    expect(bug.kind).toBe('bug');
    transcript.push(
      `(owner) POST /api/review/RCP-17/decisions → outcome progress, created bug ${bug.id}`,
      '',
    );

    // Later, a new session (another client) picks it up.
    const resumable = (await step('search_items', { filter: 'resumable' }, h.b)) as {
      items: { id: string }[];
    };
    expect(resumable.items.map((x) => x.id)).toContain('RCP-17');
    const review = (await step('get_review', { id: 'RCP-17' }, h.b)) as {
      rounds: {
        round: number;
        state: string;
        items: {
          hr_item_id: string;
          decision: { kind: string; note: string; into: string; result_ref: string };
        }[];
      }[];
    };
    expect(review.rounds).toHaveLength(1);
    expect(review.rounds[0]!.state).toBe('decided');
    const [d1, d2] = review.rounds[0]!.items.map((x) => x.decision);
    expect(d1).toMatchObject({
      kind: 'changes',
      note: 'Drop targets are too small on my phone',
      into: 'checklist',
    });
    expect(d1!.result_ref).toMatch(/^wst_/);
    expect(d2).toMatchObject({ kind: 'changes', into: 'bug', result_ref: bug.id });

    const claim2 = (await step('claim_lead', { id: 'RCP-17', agent_label: 'orca-w3' }, h.b)) as {
      run_id: string;
    };
    const item = (await step('get_item', { id: 'RCP-17' }, h.b)) as {
      item: {
        checklist: {
          work: { text: string; from_review: unknown }[];
          human_review: { state: string }[];
        };
      };
    };
    expect(item.item.checklist.work).toEqual([
      expect.objectContaining({
        text: 'Drop targets are too small on my phone',
        from_review: { round: 1, hr_item_id: hr1 },
      }),
    ]);
    expect(item.item.checklist.human_review.map((x) => x.state)).toEqual(['declared', 'declared']);
    await step('report_commit', { id: 'RCP-17', run_id: claim2.run_id, sha: '9c0e7f2' }, h.b);
    const r2 = (await step(
      'submit_packet',
      {
        id: 'RCP-17',
        run_id: claim2.run_id,
        built_from_commit: '9c0e7f2',
        estimate: '10 min',
        how: ['Open the preview build again.', 'Drag three recipes on your phone.'],
        checked: [
          {
            text: 'Drop targets are 48px tall on touch',
            provenance: 'agent',
            evidence: 'measured in devtools',
          },
        ],
        gaps: [`The reload bug is tracked in ${bug.id} and is not fixed here.`],
      },
      h.b,
    )) as { round: number; item: S };
    expect(r2.round).toBe(2);
    expect(r2.item.status).toBe('review');
    // The bug is a Bug in Ready, linked back.
    const bugItem = ok(await h.call('get_item', { id: bug.id })) as {
      item: S & { links: { relates: { id: string }[] } };
    };
    expect(bugItem.item).toMatchObject({ type: 'Bug', status: 'ready', epic: 'RCP-1' });
    expect(bugItem.item.links.relates.map((x) => x.id)).toEqual(['RCP-17']);
  });

  it('approvals carry forward: an approved item stays approved, round 2 holds only the rest', async () => {
    h = await startHarness();
    const api = await ownerApi(h);
    const { run_id } = ok(await h.call('claim_lead', { id: 'RCP-17' })) as { run_id: string };
    const [a, b] = (
      (ok(await h.call('declare_human_review', { id: 'RCP-17', items: ITEMS })) as S)
        .human_review as { id: string }[]
    ).map((x) => x.id);
    const base = { id: 'RCP-17', run_id, estimate: '5 min', how: ['Try it.'], checked: [] };
    expectOk(await h.call('submit_packet', { ...base, built_from_commit: '1111111' }));
    expect(
      (
        await api('POST', '/api/review/RCP-17/decisions', {
          round: 1,
          verdicts: [
            { hr_item_id: a, kind: 'approve' },
            { hr_item_id: b, kind: 'changes', note: 'Enter does nothing', into: 'checklist' },
          ],
        })
      ).status,
    ).toBe(200);
    expectOk(await h.call('submit_packet', { ...base, built_from_commit: '2222222' }));
    const review = ok(await h.call('get_review', { id: 'RCP-17' })) as {
      rounds: { items: { hr_item_id: string }[] }[];
    };
    expect(review.rounds[1]!.items.map((x) => x.hr_item_id)).toEqual([b]);
    const decided = await api('POST', '/api/review/RCP-17/decisions', {
      round: 2,
      verdicts: [{ hr_item_id: b, kind: 'approve' }],
    });
    expect(decided.body).toMatchObject({ outcome: 'done', item: { status: 'done' } });
    const item = ok(await h.call('get_item', { id: 'RCP-17', view: 'full' })) as {
      item: S & { checklist: { human_review: { state: string }[] } };
    };
    expect(item.item.closed_by).toBe('owner');
    expect(item.item.checklist.human_review.map((x) => x.state)).toEqual(['approved', 'approved']);
  });
});

describe('§7.4 a commit after handing off', () => {
  it('report_commit returns stale_packets; the owner asks for a fresh packet; the item is resumable with a note', async () => {
    h = await startHarness();
    const api = await ownerApi(h);
    transcript.push('## §7.4 a commit after handing off', '');
    const out = (await step('report_commit', { id: 'RCP-19', sha: 'c71e002' })) as {
      stale_packets: { item_id: string; round: number; packet_id: string }[];
    };
    expect(out.stale_packets).toEqual([
      { item_id: 'RCP-19', round: 1, packet_id: expect.stringMatching(/^pkt_/) as string },
    ]);
    const screen = await api('GET', '/api/review/RCP-19');
    expect((screen.body.packet as { stale: boolean }).stale).toBe(true);
    const refreshed = await api('POST', '/api/review/RCP-19/refresh', {
      packet_id: out.stale_packets[0]!.packet_id,
    });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body).toMatchObject({ item: { status: 'progress' } });
    const resumable = (await step('search_items', { project: 'RCP', filter: 'resumable' })) as {
      items: { id: string }[];
    };
    expect(resumable.items.map((x) => x.id)).toContain('RCP-19');
    const item = (await step('get_item', {
      id: 'RCP-19',
      fields: ['unread_owner_notes', 'packets', 'status'],
    })) as {
      item: { unread_owner_notes: { text: string }[]; packets: { state: string }[] };
    };
    expect(item.item.unread_owner_notes.map((n) => n.text)).toEqual([
      'Please submit a fresh packet; code changed after b41d2e0.',
    ]);
    expect(item.item.packets.map((p) => p.state)).toEqual(['withdrawn']);
    // Delivered once (§5.7): the next read returns nothing new.
    const again = ok(
      await h.call('get_item', { id: 'RCP-19', fields: ['unread_owner_notes'] }),
    ) as {
      item: { unread_owner_notes: unknown[] };
    };
    expect(again.item.unread_owner_notes).toEqual([]);
  });
});

describe('§7.9 cleanup of deferred checks', () => {
  it('deferred_reviews lists the deferred check and its follow-up ticket', async () => {
    h = await startHarness();
    transcript.push('## §7.9 cleanup of deferred checks', '');
    const out = (await step('deferred_reviews', { project: 'RCP' })) as {
      items: S[];
      next_cursor: string | null;
    };
    expect(out.items).toEqual([
      expect.objectContaining({
        item_id: 'RCP-11',
        text: 'Sign in from a second browser and confirm the session is separate.',
        follow_up: { id: 'RCP-29', status: 'inbox' },
      }),
    ]);
    expect(out.next_cursor).toBeNull();
    // Either work the follow-up like any other ticket, or add_note on the original.
    expectOk(
      await h.call('add_note', {
        id: 'RCP-11',
        text: 'Plan: verify with a second Chrome profile in RCP-29.',
      }),
    );
  });
});

describe('review tool errors (FR-026)', () => {
  it('submit_packet: validation for each guard, not_found for an unknown item', async () => {
    h = await startHarness();
    const { run_id } = ok(await h.call('claim_lead', { id: 'RCP-17' })) as { run_id: string };
    const base = {
      id: 'RCP-17',
      run_id,
      built_from_commit: 'abc1234',
      estimate: '5 min',
      how: ['Try it.'],
      checked: [],
    };
    expect(expectValidation(await h.call('submit_packet', base)).message).toContain('set_status');
    expectOk(await h.call('declare_human_review', { id: 'RCP-17', items: ['Try it on a phone.'] }));
    expectOk(await h.call('submit_packet', base));
    expect(expectValidation(await h.call('submit_packet', base)).message).toContain('already open');
    expect(
      expectValidation(await h.call('submit_packet', { ...base, id: 'RCP-12', run_id: undefined }))
        .message,
    ).toContain('already open');
    expectNotFound(await h.call('submit_packet', { ...base, id: 'RCP-99', run_id: undefined }));
  });

  it('update_human_review: forbidden on owner-added and locked items, conflict on a stale version', async () => {
    h = await startHarness();
    const api = await ownerApi(h);
    const added = await api('POST', '/api/items/RCP-14/human-review', {
      text: 'Try it on your phone',
    });
    expect(added.status).toBe(200);
    const ownerItem = added.body.hr_item as { id: string; version: number; added_by: string };
    expect(ownerItem.added_by).toBe('owner');
    expect(
      expectForbidden(
        await h.call('update_human_review', {
          id: 'RCP-14',
          hr_item_id: ownerItem.id,
          expected_version: 1,
          text: 'x',
        }),
      ).message,
    ).toContain('owner');
    const own = (
      (ok(await h.call('declare_human_review', { id: 'RCP-14', items: ['Read the export.'] })) as S)
        .human_review as { id: string; text: string }[]
    ).find((x) => x.text === 'Read the export.')!;
    expectConflict(
      await h.call('update_human_review', {
        id: 'RCP-14',
        hr_item_id: own.id,
        expected_version: 7,
        text: 'x',
      }),
    );
    const locked = h.server.runtime.db.sqlite
      .prepare("SELECT id, version FROM hr_items WHERE item_id = 'RCP-12' LIMIT 1")
      .get() as { id: string; version: number };
    expect(
      expectForbidden(
        await h.call('update_human_review', {
          id: 'RCP-12',
          hr_item_id: locked.id,
          expected_version: locked.version,
          remove: true,
        }),
      ).message,
    ).toContain('locked');
    expectNotFound(
      await h.call('update_human_review', {
        id: 'RCP-14',
        hr_item_id: 'hr_nope',
        expected_version: 1,
        text: 'x',
      }),
    );
  });

  it('get_review and deferred_reviews: not_found for unknown IDs; an empty review for an item without packets', async () => {
    h = await startHarness();
    expectNotFound(await h.call('get_review', { id: 'RCP-99' }));
    expect(ok(await h.call('get_review', { id: 'RCP-14' }))).toEqual({ rounds: [] });
    expectNotFound(await h.call('deferred_reviews', { project: 'ZZZ' }));
    expectValidation(await h.call('deferred_reviews', { cursor: 'nope' }));
  });

  it('the owner decision: validation without a note for changes, conflict for a stale round', async () => {
    h = await startHarness();
    const api = await ownerApi(h);
    const hrs = h.server.runtime.db.sqlite
      .prepare(
        "SELECT id FROM hr_items WHERE item_id = 'RCP-12' AND state = 'ready' ORDER BY position",
      )
      .all() as { id: string }[];
    const noNote = await api('POST', '/api/review/RCP-12/decisions', {
      round: 2,
      verdicts: [
        { hr_item_id: hrs[0]!.id, kind: 'changes', into: 'bug' },
        { hr_item_id: hrs[1]!.id, kind: 'approve' },
      ],
    });
    expect(noNote.status).toBe(400);
    const stale = await api('POST', '/api/review/RCP-12/decisions', {
      round: 1,
      verdicts: hrs.map((x) => ({ hr_item_id: x.id, kind: 'approve' })),
    });
    expect(stale.status).toBe(409);
  });
});

describe('idempotency and concurrency', () => {
  it('submit_packet with the same idempotency_key replays; with new arguments it is refused', async () => {
    h = await startHarness();
    const { run_id } = ok(await h.call('claim_lead', { id: 'RCP-17' })) as { run_id: string };
    expectOk(await h.call('declare_human_review', { id: 'RCP-17', items: ['Try it on a phone.'] }));
    const args = {
      id: 'RCP-17',
      run_id,
      built_from_commit: 'abc1234',
      estimate: '5 min',
      how: ['Try it.'],
      checked: [],
      idempotency_key: 'pkt-1',
    };
    const first = ok(await h.call('submit_packet', args));
    const again = ok(await h.call('submit_packet', args));
    expect(again.packet_id).toBe(first.packet_id);
    expect(again.replayed).toBe(true);
    expectValidation(await h.call('submit_packet', { ...args, estimate: '6 min' }));
  });

  it('two clients submit at once: exactly one round is created', async () => {
    h = await startHarness();
    const { run_id } = ok(await h.call('claim_lead', { id: 'RCP-17' })) as { run_id: string };
    expectOk(await h.call('declare_human_review', { id: 'RCP-17', items: ['Try it on a phone.'] }));
    const args = {
      id: 'RCP-17',
      built_from_commit: 'abc1234',
      estimate: '5 min',
      how: ['Try it.'],
      checked: [],
    };
    const results = await Promise.all([
      h.call('submit_packet', { ...args, run_id }),
      h.call('submit_packet', args, h.b),
    ]);
    expect(results.filter((r) => !r.isError)).toHaveLength(1);
    const n = h.server.runtime.db.sqlite
      .prepare("SELECT count(*) AS n FROM packets WHERE item_id = 'RCP-17'")
      .get() as { n: number };
    expect(n.n).toBe(1);
  });
});

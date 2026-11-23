/**
 * docket-relay (owner decision 46) against the real app: the summaries it
 * matches, the routes it reads, and the promise that reading an item never
 * uses up an agent's one-time delivery. Orca is a stub here; nothing is sent.
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { waitCheckOnce } from '../../src/jobs/sweeper.js';
import { tempDir, type TempDir } from '../helpers.js';
import { ORIGIN } from '../integration/harness.js';
import { expectOk, startHarness, type ContractHarness } from './harness.js';

const TOOL = join(import.meta.dirname, '..', '..', '..', 'tools', 'docket-relay', 'lib');
const lib = (name: string) => import(/* @vite-ignore */ pathToFileURL(join(TOOL, name)).href);

const { classifyEvent } = await lib('classify.mjs');
const { createDocket } = await lib('docket.mjs');
const { createRelay } = await lib('relay.mjs');
const { openStore } = await lib('store.mjs');

const SECRET = 'PRIVATE-OWNER-TEXT';
const ORCHESTRATOR = { name: 'producer-x', dispatch_id: 'ctx_real1', run_id: 'run_home1' };

interface Sent {
  to: string;
  subject: string;
  body: string;
}

interface Relay {
  pollOnce: (signal?: AbortSignal, timeoutS?: number) => Promise<unknown>;
  flushDue: () => Promise<void>;
  state: {
    cursor: string | null;
    hold: { reason: string } | null;
    counters: Record<string, number>;
    undelivered: unknown[];
  };
}

interface FeedRow {
  type: string;
  item_id: string | null;
  actor: string;
  summary: string;
}

let h: ContractHarness | undefined;
let dir: TempDir | undefined;

afterEach(async () => {
  await h?.close();
  h = undefined;
  dir?.cleanup();
  dir = undefined;
});

const api = async (method: string, path: string, body?: unknown) => {
  const response = await h!.server.request(path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  expect(response.status, `${method} ${path}: ${text}`).toBe(200);
  return JSON.parse(text) as Record<string, unknown>;
};

const detail = async (id: string) =>
  (await api('GET', `/api/items/${id}`)) as {
    item: { version: number; priority: number; runs: { run_state: string }[] };
    answer_unread: boolean;
    links: { link_id: string; from: string; to: string }[];
  };

const fetchImpl = (url: string, init: RequestInit) =>
  h!.server.request(url.slice(ORIGIN.length), init);

function makeRelay(sent: Sent[]): Relay {
  dir ??= tempDir('docket-relay-real-');
  return createRelay({
    docket: createDocket({ baseUrl: ORIGIN, fetchImpl }),
    orca: {
      showDispatch: () => Promise.resolve({ found: true, runId: 'run_home1' }),
      showRun: (id: string) => Promise.resolve({ found: id === 'run_home1', active: true }),
      send: (message: Sent) => {
        sent.push(message);
        return Promise.resolve({ ok: true });
      },
    },
    store: openStore(dir.dir),
    now: () => h!.server.clock.now().getTime(),
    sleep: () => Promise.resolve(),
  });
}

const step = async (relay: Relay) => {
  await relay.pollOnce(undefined, 0);
  await relay.flushDue();
};

const cursorNow = async () =>
  ((await api('GET', '/agent/changes/wait?timeout_s=0')) as { next_cursor: string }).next_cursor;

const feedSince = async (cursor: string) =>
  (
    (await api('GET', `/agent/changes/wait?cursor=${cursor}&timeout_s=0&limit=200`)) as {
      events: FeedRow[];
    }
  ).events;

const claim = async (id = 'RCP-17') =>
  expectOk(await h!.call('claim_lead', { id, agent_label: 'orca-w3', orchestrator: ORCHESTRATOR }));

describe('docket-relay on the real server', () => {
  it('tells the coordinator of an answer, which stays unread until the agent reads it', async () => {
    h = await startHarness();
    await claim();
    const sent: Sent[] = [];
    const relay = makeRelay(sent);
    await relay.pollOnce(undefined, 0);

    const asked = expectOk(await h.call('ask_owner', { id: 'RCP-17', question: 'Which unit?' }));
    await step(relay);
    expect(sent).toEqual([]);

    await api('POST', '/api/items/RCP-17/answer', {
      question_id: asked.structured.question_id,
      text: SECRET,
    });
    await step(relay);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe('run:run_home1');
    expect(sent[0]!.body).toContain('RCP-17 was updated from the owner side in Docket (answer).');
    expect(sent[0]!.body).toContain('dispatch ctx_real1');
    expect(sent[0]!.body).toContain("Don't call get_item RCP-17");
    expect(JSON.stringify(sent)).not.toContain(SECRET);

    // The relay's read delivered nothing, and left the run as it was.
    const after = await detail('RCP-17');
    expect(after.answer_unread).toBe(true);
    expect(after.item.runs[0]!.run_state).toBe('needs_input');

    const read = expectOk(await h.call('get_item', { id: 'RCP-17' }));
    expect(read.text).toContain(SECRET);
    expect((await detail('RCP-17')).answer_unread).toBe(false);
  });

  it('batches an owner note for the coordinator, naming the dispatch as information', async () => {
    h = await startHarness();
    await claim();
    const sent: Sent[] = [];
    const relay = makeRelay(sent);
    await relay.pollOnce(undefined, 0);
    await api('POST', '/api/items/RCP-17/notes', { text: SECRET });
    await step(relay);
    expect(sent).toEqual([]);
    h.server.clock.advance(60_000);
    await step(relay);
    expect(sent.map((message) => message.to)).toEqual(['run:run_home1']);
    expect(sent[0]!.body).toContain('for information only: Docket run');
    expect(sent[0]!.body).toContain('dispatch ctx_real1.');
    expect(JSON.stringify(sent)).not.toContain(SECRET);
  });

  it('classifies what the owner really writes', async () => {
    h = await startHarness();
    const cursor = await cursorNow();
    const before = await detail('RCP-17');

    await api('PATCH', '/api/items/RCP-17', {
      expected_version: before.item.version,
      title: 'A new title',
      acceptance: ['One thing is true'],
    });
    const edited = await detail('RCP-17');
    await api('PATCH', '/api/items/RCP-17', {
      expected_version: edited.item.version,
      outcome_md: 'A new outcome',
      description_md: 'A new description',
    });
    const again = await detail('RCP-17');
    await api('PATCH', '/api/items/RCP-17', {
      expected_version: again.item.version,
      priority: again.item.priority === 2 ? 1 : 2,
    });
    await api('POST', '/api/items/RCP-17/notes', { text: SECRET });
    await api('POST', '/api/decisions', {
      project: 'RCP',
      scope: { kind: 'item', id: 'RCP-17' },
      title: 'A decision',
      decision: 'Decided.',
    });

    expectOk(await h.call('link_items', { from: 'RCP-19', to: 'RCP-17', type: 'blocks' }));
    const linked = await detail('RCP-17');
    const link = linked.links.find((row) => row.from === 'RCP-19' && row.to === 'RCP-17');
    await api('DELETE', `/api/links/${link!.link_id}`);

    const row = await detail('RCP-14');
    await api('POST', '/api/items/RCP-14/cancel', {
      expected_version: row.item.version,
      reason: SECRET,
    });

    const seen = (await feedSince(cursor)).map((event) => ({
      type: event.type,
      item: event.item_id,
      kinds: classifyEvent(event)?.kinds ?? null,
    }));
    const kindsOf = (type: string, item = 'RCP-17') =>
      seen.filter((event) => event.type === type && event.item === item).map((e) => e.kinds);

    expect(kindsOf('item.updated')).toEqual([
      ['title', 'acceptance'],
      ['description', 'outcome'],
      null,
    ]);
    expect(kindsOf('owner_note.added')).toEqual([['note']]);
    expect(kindsOf('decision.published')).toEqual([['decision']]);
    // Added by an agent, removed by the owner.
    expect(kindsOf('link.added')).toEqual([null]);
    expect(kindsOf('link.removed')).toEqual([['blocker']]);
    expect(kindsOf('item.status_changed', 'RCP-14')).toContainEqual(['canceled']);
  });

  it('ignores what agents write, including on a ticket with a live lead', async () => {
    h = await startHarness();
    await claim();
    const sent: Sent[] = [];
    const relay = makeRelay(sent);
    await relay.pollOnce(undefined, 0);
    const cursor = await cursorNow();

    expectOk(await h.call('add_note', { id: 'RCP-17', text: 'An agent note.' }));
    const row = await detail('RCP-17');
    expectOk(
      await h.call('update_item', {
        id: 'RCP-17',
        expected_version: row.item.version,
        outcome_md: 'An agent outcome.',
      }),
    );

    const events = await feedSince(cursor);
    expect(events.length).toBeGreaterThan(0);
    expect(events.map(classifyEvent)).toEqual(events.map(() => null));
    h.server.clock.advance(5 * 60_000);
    await step(relay);
    expect(sent).toEqual([]);
  });

  it('sends nothing for a ticket with no live lead', async () => {
    h = await startHarness();
    const sent: Sent[] = [];
    const relay = makeRelay(sent);
    await relay.pollOnce(undefined, 0);
    await api('POST', '/api/items/RCP-16/notes', { text: SECRET });
    await step(relay);
    h.server.clock.advance(60_000);
    await step(relay);
    expect(sent).toEqual([]);
    expect(relay.state.counters.no_live_lead).toBe(1);
    expect(relay.state.undelivered).toEqual([]);
  });

  it('tells the coordinator of the real run.resume_ready, and leaves the lead parked', async () => {
    h = await startHarness();
    await claim();
    const runId = (
      (await detail('RCP-17')).item.runs[0] as unknown as {
        run_id: string;
      }
    ).run_id;
    expectOk(
      await h.call('park_run', {
        run_id: runId,
        reason: 'Waiting for RCP-16.',
        waiting_on: { items: ['RCP-16'] },
      }),
    );
    const sent: Sent[] = [];
    const relay = makeRelay(sent);
    await relay.pollOnce(undefined, 0);

    h.server.clock.advance(60_000);
    const doneAt = h.server.clock.now().toISOString();
    h.server.runtime.db.sqlite
      .prepare("UPDATE items SET status = 'done', closed_at = ?, updated_at = ? WHERE id = ?")
      .run(doneAt, doneAt, 'RCP-16');
    h.server.clock.advance(60_000);
    waitCheckOnce(h.server.runtime);

    const events = await feedSince('0');
    const ready = events.filter((event) => event.type === 'run.resume_ready');
    expect(ready).toHaveLength(1);
    expect(ready[0]).toMatchObject({ item_id: 'RCP-17', actor: 'system' });

    await step(relay);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: 'run:run_home1', subject: 'Docket: RCP-17 can resume' });
    expect(sent[0]!.body).toMatch(/^What RCP-17 was waiting for has cleared in Docket\. /);
    expect((await detail('RCP-17')).item.runs[0]!.run_state).toBe('parked');
  });

  it('holds on the real feed when its cursor is ahead, without moving it', async () => {
    h = await startHarness();
    await claim();
    const sent: Sent[] = [];
    const relay = makeRelay(sent);
    await step(relay);
    const cursor = relay.state.cursor!;
    relay.state.cursor = String(Number(cursor) + 50);
    await api('POST', '/api/items/RCP-17/notes', { text: SECRET });
    await step(relay);
    expect(relay.state.hold?.reason).toBe('cursor_ahead');
    expect(relay.state.cursor).toBe(String(Number(cursor) + 50));
    expect(sent).toEqual([]);
  });

  it('starts at the end of the real feed', async () => {
    h = await startHarness();
    await claim();
    await api('POST', '/api/items/RCP-17/notes', { text: SECRET });
    const sent: Sent[] = [];
    const relay = makeRelay(sent);
    await step(relay);
    h.server.clock.advance(5 * 60_000);
    await step(relay);
    expect(sent).toEqual([]);
  });
});

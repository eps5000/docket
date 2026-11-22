/**
 * Waiting on the change feed (owner decision 40; MCP_SPEC §5.2): the
 * `GET /agent/changes/wait` long-poll and `get_changes { wait_s }`.
 */
import { EventEmitter } from 'node:events';
import { LIMITS } from '@docket/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChangeWaiters } from '../../src/domain/change-wait.js';
import { ORIGIN, PROTECTED_MODE, createTestServer } from '../integration/harness.js';
import { expectOk, expectValidation, startHarness, type ContractHarness } from './harness.js';

let h: ContractHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const latest = (x: ContractHarness) =>
  (
    x.server.runtime.db.sqlite.prepare('SELECT max(seq) AS seq FROM events').get() as {
      seq: number;
    }
  ).seq;

const waiting = async (x: ContractHarness, n = 1) => {
  await vi.waitFor(() => expect(x.server.runtime.changes.size).toBe(n), { timeout: 2_000 });
};

const note = (x: ContractHarness, id: string) => x.call('add_note', { id, text: 'A short note.' });

describe('GET /agent/changes/wait', () => {
  it('wakes on the commit, with the new cursor and one line per event', async () => {
    h = await startHarness();
    const cursor = latest(h);
    const pending = h.server.request(
      `/agent/changes/wait?cursor=${cursor}&timeout_s=20&format=text`,
    );
    await waiting(h);
    expectOk(await note(h, 'RCP-14'));
    const res = await pending;
    expect(res.status).toBe(200);
    const lines = (await res.text()).trimEnd().split('\n');
    expect(lines[0]).toBe(`changed cursor=${latest(h)} events=1`);
    expect(lines[1]).toMatch(new RegExp(`^${latest(h)} RCP-14 \\S+ `));
    expect(h.server.runtime.changes.size).toBe(0);
  });

  it('answers at once when a matching event already exists', async () => {
    h = await startHarness();
    const cursor = latest(h);
    expectOk(await note(h, 'RCP-14'));
    const res = await h.server.request(`/agent/changes/wait?cursor=${cursor}&timeout_s=20`);
    const body = (await res.json()) as { status: string; next_cursor: string; events: unknown[] };
    expect(body.status).toBe('changed');
    expect(body.next_cursor).toBe(String(latest(h)));
    expect(body.events).toHaveLength(1);
  });

  it('at the timeout: no events and the same cursor', async () => {
    h = await startHarness();
    const cursor = latest(h);
    const res = await h.server.request(
      `/agent/changes/wait?cursor=${cursor}&timeout_s=1&format=text`,
    );
    expect(await res.text()).toBe(`timeout cursor=${cursor} events=0\n`);
    expect(h.server.runtime.changes.size).toBe(0);
  });

  it('without a cursor it waits from now, and timeout_s=0 just reports the cursor', async () => {
    h = await startHarness();
    const res = await h.server.request('/agent/changes/wait?timeout_s=0&format=text');
    expect(await res.text()).toBe(`timeout cursor=${latest(h)} events=0\n`);
  });

  it('a cursor past the end of the feed (a restored database) counts as the end', async () => {
    h = await startHarness();
    const res = await h.server.request('/agent/changes/wait?cursor=999999&timeout_s=0&format=text');
    expect(await res.text()).toBe(`timeout cursor=${latest(h)} events=0\n`);
  });

  it('only a matching event wakes it: item, project and types', async () => {
    h = await startHarness();
    const cursor = latest(h);
    const byItem = h.server.request(
      `/agent/changes/wait?cursor=${cursor}&item_id=RCP-17&timeout_s=20&format=text`,
    );
    const byType = h.server.request(
      `/agent/changes/wait?cursor=${cursor}&types=question.asked&timeout_s=1&format=text`,
    );
    await waiting(h, 2);
    expectOk(await note(h, 'RCP-14'));
    await new Promise((r) => setTimeout(r, 30));
    expect(h.server.runtime.changes.size).toBe(2);
    expectOk(await note(h, 'RCP-17'));
    expect((await (await byItem).text()).split('\n')[1]).toContain(' RCP-17 ');
    expect(await (await byType).text()).toMatch(/^timeout /);
  });

  it('releases the waiter when the client disconnects', async () => {
    h = await startHarness();
    const abort = new AbortController();
    const pending = h.server.app.request(
      `${ORIGIN}/agent/changes/wait?cursor=${latest(h)}&timeout_s=60`,
      { signal: abort.signal },
    );
    await waiting(h);
    abort.abort();
    await vi.waitFor(() => expect(h!.server.runtime.changes.size).toBe(0));
    await Promise.resolve(pending).catch(() => undefined);
  });

  it('releases every waiter at shutdown, with 503 so the script retries', async () => {
    h = await startHarness();
    const cursor = latest(h);
    const a = h.server.request(`/agent/changes/wait?cursor=${cursor}&timeout_s=60`);
    const b = h.server.request(`/agent/changes/wait?cursor=${cursor}&timeout_s=60`);
    await waiting(h, 2);
    h.server.runtime.bus.emit('close');
    const [ra, rb] = await Promise.all([a, b]);
    expect([ra.status, rb.status]).toEqual([503, 503]);
    expect(ra.headers.get('retry-after')).toBe('1');
    expect(h.server.runtime.changes.size).toBe(0);
  });

  it('many waiters cost one read per commit', async () => {
    h = await startHarness();
    const { changes } = h.server.runtime;
    const cursor = latest(h);
    const waits = Array.from({ length: 200 }, () =>
      changes.wait({ cursor, item_id: 'RCP-14', timeoutMs: 10_000 }),
    );
    expect(changes.size).toBe(200);
    const stmt = (changes as unknown as { afterStmt: { all: (...a: unknown[]) => unknown } })
      .afterStmt;
    const reads = vi.spyOn(stmt, 'all');
    expectOk(await note(h, 'RCP-14'));
    await Promise.all(waits);
    expect(reads).toHaveBeenCalledTimes(1);
    expect(changes.size).toBe(0);
    reads.mockRestore();
  });

  it('one shared scan catches writes that never reach the bus (the CLI)', async () => {
    h = await startHarness();
    // A waiter set on its own bus: this process's commits don't wake it.
    const offBus = new ChangeWaiters(h.server.runtime.db, new EventEmitter(), 20);
    const waited = offBus.wait({ cursor: latest(h), timeoutMs: 5_000 });
    expectOk(await note(h, 'RCP-14'));
    await expect(waited).resolves.toMatchObject({ status: 'changed' });
    offBus.close();
  });

  it.each([
    ['cursor=abc', 'cursor'],
    ['types=not.an.event', 'types'],
    ['timeout_s=301', 'timeout_s'],
    ['project=lower', 'project'],
    ['nonsense=1', 'query'],
  ])('rejects %s', async (query, field) => {
    h = await startHarness();
    const res = await h.server.request(`/agent/changes/wait?${query}`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('validation');
    if (field !== 'query') expect(body.error.message).toContain(field);
  });
});

describe('the wait route follows the trust mode and the network guards', () => {
  const url = '/agent/changes/wait?timeout_s=0';

  it('local trust: no token needed, and one sent is ignored', async () => {
    const s = createTestServer({ log: () => {} });
    try {
      expect((await s.request(url)).status).toBe(200);
      const sent = await s.request(url, { headers: { authorization: 'Bearer wrong' } });
      expect(sent.status).toBe(200);
    } finally {
      await s.cleanup();
    }
  });

  it('protected mode: 401 without the agent token, 200 with it', async () => {
    const s = createTestServer({ env: PROTECTED_MODE, log: () => {} });
    try {
      expect((await s.request(url)).status).toBe(401);
      const wrong = await s.request(url, { headers: { authorization: 'Bearer wrong' } });
      expect(wrong.status).toBe(401);
      const right = await s.request(url, {
        headers: { authorization: `Bearer ${s.runtime.secrets.agentToken()}` },
      });
      expect(right.status).toBe(200);
    } finally {
      await s.cleanup();
    }
  });

  it('a bad Host gets 421 and a foreign Origin 403', async () => {
    const s = createTestServer({ log: () => {} });
    try {
      const host = await s.app.request(`http://evil.test${url}`, {
        headers: { host: 'evil.test' },
      });
      expect(host.status).toBe(421);
      const origin = await s.request(url, { headers: { origin: 'https://evil.test' } });
      expect(origin.status).toBe(403);
    } finally {
      await s.cleanup();
    }
  });
});

describe('get_changes { wait_s }', () => {
  it('holds until a matching event, then returns it', async () => {
    h = await startHarness();
    const cursor = String(latest(h));
    const pending = h.call('get_changes', { cursor, item_id: 'RCP-14', wait_s: 20 });
    await waiting(h);
    expectOk(await note(h, 'RCP-14'));
    const { structured } = expectOk(await pending);
    expect(structured.events).toHaveLength(1);
    expect(structured.next_cursor).toBe(String(latest(h)));
  });

  it('answers with no events at wait_s', async () => {
    h = await startHarness();
    const cursor = String(latest(h));
    const { structured } = expectOk(await h.call('get_changes', { cursor, wait_s: 1 }));
    expect(structured).toEqual({ events: [], next_cursor: cursor });
  });

  it('without a cursor it answers at once with the latest', async () => {
    h = await startHarness();
    const { structured } = expectOk(await h.call('get_changes', { wait_s: 45 }));
    expect(structured.next_cursor).toBe(String(latest(h)));
    expect(h.server.runtime.changes.size).toBe(0);
  });

  it(`is capped at ${LIMITS.changes_wait_s} s, below the shortest client limit (60 s)`, async () => {
    expect(LIMITS.changes_wait_s).toBeLessThan(60);
    h = await startHarness();
    expectValidation(await h.call('get_changes', { wait_s: LIMITS.changes_wait_s + 1 }));
    expectValidation(await h.call('get_changes', { wait_s: 0 }));
  });
});

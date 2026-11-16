/**
 * Liveness over MCP (BUILD_SPEC §5.4; MCP_SPEC §1 "Liveness"; tasks.md T072):
 * - a session that holds its server→client (`GET`) stream open makes its
 *   run *live*; without the stream the same calls only make it *reported*
 *   (verification V1);
 * - the sweeper pings the open runs' sessions over that stream, every 60 s;
 *   an answered ping is a *session* signal.
 *
 * A raw Streamable HTTP client, so the test decides whether the stream is open.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadSampleSeed } from '../../src/db/seed/loader.js';
import { PING_MS, pingOnce, startSweeper } from '../../src/jobs/sweeper.js';
import { TestClock } from '../helpers.js';
import { MCP_HEADERS, createTestServer, initializeBody, type TestServer } from './harness.js';

let s: TestServer;
let auth: Record<string, string>;
let nextId = 10;

beforeEach(() => {
  s = createTestServer({ clock: new TestClock(new Date('2026-11-06T11:00:00.000Z')) });
  loadSampleSeed(s.runtime.db, { now: s.clock.now(), docsDir: s.runtime.config.paths.docs });
  auth = { ...MCP_HEADERS, authorization: `Bearer ${s.runtime.secrets.agentToken()}` };
});
afterEach(async () => {
  await s.cleanup();
});

/** A raw session: initialize, then the initialized notification. */
async function session(clientName = 'claude-code') {
  const res = await s.request('/mcp', {
    method: 'POST',
    headers: auth,
    body: initializeBody(clientName),
  });
  const sessionId = res.headers.get('mcp-session-id')!;
  await res.text();
  const headers = { ...auth, 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18' };
  await s.request('/mcp', {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await s.request('/mcp', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: nextId++,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    });
    return (
      (await r.json()) as {
        result: { structuredContent: Record<string, unknown>; isError?: boolean };
      }
    ).result;
  };
  /** Open the GET stream; returns a reader of its SSE messages. */
  const openStream = async () => {
    const r = await s.request('/mcp', {
      method: 'GET',
      headers: { ...headers, accept: 'text/event-stream' },
    });
    expect(r.status).toBe(200);
    const reader = r.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const next = async (timeoutMs = 2_000): Promise<{ id: number; method: string } | null> => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const m = /data: (.*)\n\n/.exec(buffer);
        if (m) {
          buffer = buffer.slice(m.index + m[0].length);
          return JSON.parse(m[1]!) as { id: number; method: string };
        }
        const left = deadline - Date.now();
        if (left <= 0) return null;
        const chunk = await Promise.race([
          reader.read(),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), left)),
        ]);
        if (chunk === null || chunk.done) return null;
        buffer += decoder.decode(chunk.value, { stream: true });
      }
    };
    const answer = (id: number) =>
      s.request('/mcp', {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', id, result: {} }),
      });
    return { next, answer, close: () => reader.cancel() };
  };
  return { sessionId, call, openStream };
}

const runState = (id: string) =>
  s.runtime.services.items.get(
    {
      db: s.runtime.db,
      actor: { kind: 'system', client: null, label: null },
      now: s.clock.now().toISOString(),
    },
    { id, view: 'summary' },
  ).item.lead?.run_state;
const signal = (runId: string) =>
  s.runtime.db.sqlite
    .prepare('SELECT last_signal_kind, last_signal_at FROM runs WHERE id = ?')
    .get(runId) as {
    last_signal_kind: string;
    last_signal_at: string;
  };

describe('live versus reported', () => {
  it('without a GET stream the run shows reported; with one it shows live', async () => {
    const a = await session();
    expect(s.runtime.mcp.hasStream(a.sessionId)).toBe(false);
    const claim = await a.call('claim_lead', { id: 'RCP-17', agent_label: 'orca-w3' });
    const runId = claim.structuredContent.run_id as string;
    expect(signal(runId).last_signal_kind).toBe('report');
    expect(runState('RCP-17')).toBe('reported');
    await a.call('get_item', { id: 'RCP-17', view: 'summary', run_id: runId });
    expect(runState('RCP-17')).toBe('reported');

    const stream = await a.openStream();
    expect(s.runtime.mcp.hasStream(a.sessionId)).toBe(true);
    await a.call('get_item', { id: 'RCP-17', view: 'summary', run_id: runId });
    expect(signal(runId).last_signal_kind).toBe('session');
    expect(runState('RCP-17')).toBe('live');

    // The stream goes away: later calls are reports again, and live lapses after the window.
    await stream.close();
    await new Promise((r) => setTimeout(r, 20));
    expect(s.runtime.mcp.hasStream(a.sessionId)).toBe(false);
    s.clock.advance(60_000);
    await a.call('get_item', { id: 'RCP-17', view: 'summary', run_id: runId });
    expect(signal(runId).last_signal_kind).toBe('report');
    expect(runState('RCP-17')).toBe('reported');
  });

  it('a call naming the run from another session is a report, even with that session streaming', async () => {
    const a = await session();
    const b = await session('codex-mcp-client');
    await a.openStream();
    await b.openStream();
    const runId = (await a.call('claim_lead', { id: 'RCP-17' })).structuredContent.run_id as string;
    expect(runState('RCP-17')).toBe('live');
    await b.call('get_item', { id: 'RCP-17', view: 'summary', run_id: runId });
    expect(signal(runId).last_signal_kind).toBe('report');
    expect(runState('RCP-17')).toBe('reported');
  });
});

describe('pings (every 60 s to sessions of open runs)', () => {
  it('pings a streaming session; the answer is a session signal that renews the lease', async () => {
    const a = await session();
    const stream = await a.openStream();
    const runId = (await a.call('claim_lead', { id: 'RCP-17' })).structuredContent.run_id as string;
    s.clock.advance(5 * 60_000);
    expect(runState('RCP-17')).toBe('reported');

    const pinging = pingOnce(s.runtime, 2_000);
    const ping = await stream.next();
    expect(ping?.method).toBe('ping');
    await stream.answer(ping!.id);
    expect(await pinging).toEqual([runId]);
    expect(signal(runId)).toEqual({
      last_signal_kind: 'session',
      last_signal_at: s.clock.now().toISOString(),
    });
    expect(runState('RCP-17')).toBe('live');
    const lease = s.runtime.db.sqlite
      .prepare('SELECT lease_expires_at FROM runs WHERE id = ?')
      .get(runId);
    expect(lease).toEqual({
      lease_expires_at: new Date(s.clock.now().getTime() + 3_600_000).toISOString(),
    });
  });

  it('an unanswered ping is no signal; a session without a stream is not pinged', async () => {
    const a = await session();
    const stream = await a.openStream();
    const b = await session('codex-mcp-client');
    await a.call('claim_lead', { id: 'RCP-17' });
    await b.call('claim_lead', { id: 'RCP-25' });
    s.clock.advance(5 * 60_000);
    expect(await pingOnce(s.runtime, 100)).toEqual([]);
    expect((await stream.next(100))?.method).toBe('ping');
    expect(runState('RCP-17')).toBe('reported');
    expect(runState('RCP-25')).toBe('reported');
  });

  it('the sweeper pings on its interval (60 s by default)', async () => {
    expect(PING_MS).toBe(60_000);
    const a = await session();
    const stream = await a.openStream();
    await a.call('claim_lead', { id: 'RCP-17' });
    const sweeper = startSweeper(s.runtime, { pingMs: 100, sweepMs: 60_000 });
    try {
      const pings: number[] = [];
      for (let i = 0; i < 3; i++) {
        const ping = await stream.next(1_000);
        expect(ping?.method).toBe('ping');
        pings.push(Date.now());
        await stream.answer(ping!.id);
      }
      // One per interval, never a burst.
      expect(pings[2]! - pings[0]!).toBeGreaterThanOrEqual(150);
    } finally {
      sweeper.stop();
    }
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { normaliseClientName } from '../../src/mcp/server.js';
import { MCP_HEADERS, createTestServer, initializeBody, type TestServer } from './harness.js';

let s: TestServer;
let auth: Record<string, string>;

beforeEach(() => {
  s = createTestServer();
  auth = { ...MCP_HEADERS, authorization: `Bearer ${s.runtime.secrets.agentToken()}` };
});
afterEach(async () => {
  await s.cleanup();
});

async function initialize(clientName: string) {
  const res = await s.request('/mcp', {
    method: 'POST',
    headers: auth,
    body: initializeBody(clientName),
  });
  expect(res.status).toBe(200);
  return { res, sessionId: res.headers.get('mcp-session-id')! };
}

describe('client identity', () => {
  it.each([
    ['codex-mcp-client', 'codex'],
    ['Codex', 'codex'],
    ['claude-code', 'claude'],
    ['Claude Desktop', 'claude'],
    ['my-agent', 'my-agent'],
    ['  ', 'unknown'],
  ])('normalises %j to %j', (name, expected) => {
    expect(normaliseClientName(name)).toBe(expected);
  });

  it('records the session ID and normalised client from initialize', async () => {
    const { sessionId } = await initialize('claude-code');
    expect(s.runtime.mcp.session(sessionId)).toMatchObject({
      session_id: sessionId,
      client: 'claude',
      client_name: 'claude-code',
      client_version: '1.0.0',
    });
  });

  it('keeps simultaneous sessions apart', async () => {
    const a = await initialize('codex-mcp-client');
    const b = await initialize('claude-code');
    expect(a.sessionId).not.toBe(b.sessionId);
    expect(s.runtime.mcp.session(a.sessionId)?.client).toBe('codex');
    expect(s.runtime.mcp.session(b.sessionId)?.client).toBe('claude');
  });
});

describe('stateful sessions', () => {
  it('answers requests on an initialized session', async () => {
    const { sessionId } = await initialize('claude-code');
    const headers = { ...auth, 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18' };
    const note = await s.request('/mcp', {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    expect(note.status).toBe(202);
    const ping = await s.request('/mcp', {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }),
    });
    expect(ping.status).toBe(200);
    expect(await ping.json()).toEqual({ jsonrpc: '2.0', id: 2, result: {} });
  });

  it('answers 404 for an unknown session', async () => {
    const res = await s.request('/mcp', {
      method: 'POST',
      headers: { ...auth, 'mcp-session-id': 'no-such-session' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }),
    });
    expect(res.status).toBe(404);
  });

  it('rejects a non-initialize request without a session', async () => {
    const res = await s.request('/mcp', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }),
    });
    expect(res.status).toBe(400);
    expect(s.runtime.mcp.sessions()).toEqual([]);
  });

  it('ends a session on DELETE', async () => {
    const { sessionId } = await initialize('claude-code');
    const res = await s.request('/mcp', {
      method: 'DELETE',
      headers: { ...auth, 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18' },
    });
    expect(res.status).toBe(200);
    expect(s.runtime.mcp.session(sessionId)).toBeUndefined();
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MCP_HEADERS,
  ORIGIN,
  createTestServer,
  initializeBody,
  type TestServer,
} from './harness.js';

let s: TestServer;
let token: string;

beforeEach(() => {
  s = createTestServer();
  token = s.runtime.secrets.agentToken();
});

afterEach(async () => {
  await s.cleanup();
});

function initialize(headers: Record<string, string> = {}, url = `${ORIGIN}/mcp`) {
  return s.app.request(url, {
    method: 'POST',
    headers: { ...MCP_HEADERS, authorization: `Bearer ${token}`, ...headers },
    body: initializeBody(),
  });
}

describe('Host allowlist (DNS-rebinding guard)', () => {
  it.each(['/mcp', '/api/stream', '/api/session/unlock', '/readyz', '/'])(
    'answers 421 for a Host outside the allowlist on %s',
    async (path) => {
      const res = await s.app.request(`http://evil.example:7420${path}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(421);
    },
  );

  it('answers 421 for the right name on the wrong port', async () => {
    const res = await initialize({}, 'http://127.0.0.1:8080/mcp');
    expect(res.status).toBe(421);
  });

  it('accepts both default hosts', async () => {
    expect((await initialize({}, 'http://127.0.0.1:7420/mcp')).status).toBe(200);
    expect((await initialize({}, 'http://localhost:7420/mcp')).status).toBe(200);
  });

  it('uses DOCKET_ALLOWED_HOSTS when set', async () => {
    await s.cleanup();
    s = createTestServer({ env: { DOCKET_ALLOWED_HOSTS: 'tasklite.local:9000' } });
    token = s.runtime.secrets.agentToken();
    expect((await initialize({}, 'http://127.0.0.1:7420/mcp')).status).toBe(421);
    expect((await initialize({}, 'http://tasklite.local:9000/mcp')).status).toBe(200);
  });

  it('leaves /healthz open so the container healthcheck works on any port', async () => {
    const res = await s.app.request('http://127.0.0.1:8080/healthz');
    expect(res.status).toBe(200);
  });
});

describe('Origin allowlist', () => {
  it('answers 403 for a foreign Origin on /mcp', async () => {
    const res = await initialize({ origin: 'http://evil.example' });
    expect(res.status).toBe(403);
  });

  it('answers 403 for a foreign Origin on /api', async () => {
    const res = await s.request('/api/session/unlock', {
      method: 'POST',
      headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
      body: JSON.stringify({ key: s.runtime.secrets.ownerKey() }),
    });
    expect(res.status).toBe(403);
  });

  it('answers 403 for the opaque "null" Origin', async () => {
    expect((await initialize({ origin: 'null' })).status).toBe(403);
  });

  it('accepts the same-origin Origin header', async () => {
    expect((await initialize({ origin: 'http://127.0.0.1:7420' })).status).toBe(200);
    expect((await initialize({ origin: 'http://localhost:7420' })).status).toBe(200);
  });

  it('accepts requests without an Origin header (non-browser clients)', async () => {
    expect((await initialize()).status).toBe(200);
  });
});

describe('bearer token on /mcp', () => {
  it('answers 401 without a token, before any MCP handling', async () => {
    const res = await s.request('/mcp', {
      method: 'POST',
      headers: MCP_HEADERS,
      body: initializeBody(),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toMatch(/^Bearer/);
    expect(res.headers.get('mcp-session-id')).toBeNull();
  });

  it('answers 401 for a wrong token', async () => {
    expect((await initialize({ authorization: `Bearer ${token}x` })).status).toBe(401);
    expect((await initialize({ authorization: 'Bearer ' })).status).toBe(401);
    expect((await initialize({ authorization: token })).status).toBe(401);
  });

  it('answers 401 for the owner key used as a bearer token', async () => {
    const res = await initialize({ authorization: `Bearer ${s.runtime.secrets.ownerKey()}` });
    expect(res.status).toBe(401);
  });

  it('answers 401 on GET and DELETE without a token too', async () => {
    expect((await s.request('/mcp', { headers: { accept: 'text/event-stream' } })).status).toBe(
      401,
    );
    expect((await s.request('/mcp', { method: 'DELETE' })).status).toBe(401);
  });

  it('initializes a session with the right token', async () => {
    const res = await initialize();
    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-session-id')).toBeTruthy();
    const body = (await res.json()) as {
      result: { serverInfo: { name: string; version: string } };
    };
    expect(body.result.serverInfo.name).toBe('tasklite');
    expect(body.result.serverInfo.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('accepts DOCKET_TOKEN from the environment instead of the generated one', async () => {
    await s.cleanup();
    s = createTestServer({ env: { DOCKET_TOKEN: 'env-token-0123456789abcdef' } });
    token = 'env-token-0123456789abcdef';
    expect(s.runtime.secrets.agentToken()).toBe(token);
    expect((await initialize()).status).toBe(200);
  });
});

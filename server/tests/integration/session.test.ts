import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PROTECTED_MODE,
  createTestServer,
  parseSetCookies,
  readUntil,
  type TestServer,
} from './harness.js';

// Owner sessions are protected mode (decision 32); local trust is in trust-mode.test.ts.
let s: TestServer;

beforeEach(() => {
  s = createTestServer({ env: PROTECTED_MODE });
});

afterEach(async () => {
  await s.cleanup();
});

interface Unlocked {
  cookie: string;
  csrf: string;
}

async function unlock(key = s.runtime.secrets.ownerKey()): Promise<Unlocked> {
  const res = await s.request('/api/session/unlock', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'vitest' },
    body: JSON.stringify({ key }),
  });
  expect(res.status).toBe(200);
  const cookies = parseSetCookies(res);
  const owner = cookies.docket_owner!.value;
  const csrf = cookies.docket_csrf!.value;
  return { cookie: `docket_owner=${owner}; docket_csrf=${csrf}`, csrf };
}

/** A mutating API call that needs a session and CSRF; with neither problem it reaches the route (404 for an unknown mutation). */
function undoUnknown(headers: Record<string, string>) {
  return s.request('/api/mutations/mut_01JAAAAAAAAAAAAAAAAAAAAAAA/undo', {
    method: 'POST',
    headers,
  });
}

describe('every /api route requires an owner session', () => {
  it.each([
    ['GET', '/api/stream'],
    ['GET', '/api/bootstrap'],
    ['GET', '/api/anything/at/all'],
    ['POST', '/api/mutations/mut_x/undo'],
    ['POST', '/api/session/lock'],
    ['POST', '/api/session/rotate-key'],
  ])('%s %s answers 401 without a session', async (method, path) => {
    const res = await s.request(path, { method });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('forbidden');
    expect(body.error.message).toMatch(/unlock/i);
  });

  it("rejects the agents' bearer token on /api", async () => {
    const token = s.runtime.secrets.agentToken();
    const res = await s.request('/api/stream', { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(401);
  });

  it('rejects a tampered session cookie', async () => {
    const { cookie, csrf } = await unlock();
    const tampered = cookie.replace(/docket_owner=([^.;]+)\./, 'docket_owner=$1x.');
    expect((await undoUnknown({ cookie: tampered, 'x-docket-csrf': csrf })).status).toBe(401);
  });
});

describe('unlock', () => {
  it('sets an HttpOnly SameSite=Strict owner cookie with a 30-day expiry, and a CSRF cookie', async () => {
    const res = await s.request('/api/session/unlock', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: s.runtime.secrets.ownerKey() }),
    });
    expect(res.status).toBe(200);
    const cookies = parseSetCookies(res);
    expect(cookies.docket_owner?.attributes).toEqual(
      expect.arrayContaining(['Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=2592000']),
    );
    // The UI reads the CSRF cookie to echo it in a header, so it is not HttpOnly.
    expect(cookies.docket_csrf?.attributes).toEqual(
      expect.arrayContaining(['Path=/', 'SameSite=Strict', 'Max-Age=2592000']),
    );
    expect(cookies.docket_csrf?.attributes).not.toContain('HttpOnly');
    // The cookie is a signed session ID, not the key.
    expect(cookies.docket_owner?.value).not.toContain(s.runtime.secrets.ownerKey());
  });

  it('accepts the key with surrounding whitespace and in lower case', async () => {
    await unlock(`  ${s.runtime.secrets.ownerKey().toLowerCase()}\n`);
  });

  it('answers 403 for a wrong key and sets no cookie', async () => {
    const res = await s.request('/api/session/unlock', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }),
    });
    expect(res.status).toBe(403);
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it('answers 403 for the agent token used as the key', async () => {
    const res = await s.request('/api/session/unlock', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: s.runtime.secrets.agentToken() }),
    });
    expect(res.status).toBe(403);
  });

  it('answers 400 validation for a malformed body', async () => {
    const res = await s.request('/api/session/unlock', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nope: true }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('validation');
  });

  it('stores the session in the database, not the raw cookie value', async () => {
    const { cookie } = await unlock();
    const rows = s.runtime.db.sqlite.prepare('SELECT * FROM owner_sessions').all() as {
      id: string;
      user_agent: string;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.user_agent).toBe('vitest');
    const sid = /docket_owner=([^.;]+)/.exec(cookie)![1]!;
    expect(rows[0]!.id).not.toContain(sid);
  });
});

describe('CSRF double submit on mutations', () => {
  it('passes with the session and the matching header', async () => {
    const { cookie, csrf } = await unlock();
    expect((await undoUnknown({ cookie, 'x-docket-csrf': csrf })).status).toBe(404);
  });

  it('answers 403 without the header', async () => {
    const { cookie } = await unlock();
    const res = await undoUnknown({ cookie });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('forbidden');
  });

  it('answers 403 when the header does not match', async () => {
    const { cookie, csrf } = await unlock();
    expect((await undoUnknown({ cookie, 'x-docket-csrf': `${csrf}x` })).status).toBe(403);
  });

  it('answers 403 when the cookie and header agree but belong to another session', async () => {
    const a = await unlock();
    const b = await unlock();
    const mixed = a.cookie.replace(/docket_csrf=[^;]+/, `docket_csrf=${b.csrf}`);
    expect((await undoUnknown({ cookie: mixed, 'x-docket-csrf': b.csrf })).status).toBe(403);
  });

  it('does not need CSRF for reads', async () => {
    const { cookie } = await unlock();
    const res = await s.request('/api/stream', { headers: { cookie } });
    expect(res.status).toBe(200);
    await res.body?.cancel();
  });
});

describe('lock', () => {
  it('ends this browser session and clears the cookies', async () => {
    const { cookie, csrf } = await unlock();
    const res = await s.request('/api/session/lock', {
      method: 'POST',
      headers: { cookie, 'x-docket-csrf': csrf },
    });
    expect(res.status).toBe(200);
    const cleared = parseSetCookies(res);
    expect(cleared.docket_owner?.attributes).toContain('Max-Age=0');
    expect(cleared.docket_csrf?.attributes).toContain('Max-Age=0');
    expect((await undoUnknown({ cookie, 'x-docket-csrf': csrf })).status).toBe(401);
  });

  it('leaves other sessions alone', async () => {
    const a = await unlock();
    const b = await unlock();
    await s.request('/api/session/lock', {
      method: 'POST',
      headers: { cookie: a.cookie, 'x-docket-csrf': a.csrf },
    });
    expect((await undoUnknown({ cookie: b.cookie, 'x-docket-csrf': b.csrf })).status).toBe(404);
  });
});

describe('sliding 30-day expiry', () => {
  it('keeps a session alive while it is used, and ends it after 30 idle days', async () => {
    const { cookie, csrf } = await unlock();
    const day = 24 * 60 * 60 * 1000;
    s.clock.advance(29 * day);
    expect((await undoUnknown({ cookie, 'x-docket-csrf': csrf })).status).toBe(404);
    s.clock.advance(29 * day);
    expect((await undoUnknown({ cookie, 'x-docket-csrf': csrf })).status).toBe(404);
    s.clock.advance(30 * day + 1);
    expect((await undoUnknown({ cookie, 'x-docket-csrf': csrf })).status).toBe(401);
  });
});

describe('owner key rotation', () => {
  it('writes a new key, ends every session, and never returns the key', async () => {
    const oldKey = s.runtime.secrets.ownerKey();
    const a = await unlock();
    const b = await unlock();

    const res = await s.request('/api/session/rotate-key', {
      method: 'POST',
      headers: { cookie: a.cookie, 'x-docket-csrf': a.csrf },
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ rotated: true });

    const newKey = readFileSync(join(s.dataDir, 'secrets', 'owner-key'), 'utf8').trim();
    expect(newKey).not.toBe(oldKey);
    expect(newKey).toMatch(/^[A-Z2-7]{52}$/);
    expect(text).not.toContain(newKey);
    expect(parseSetCookies(res).docket_owner?.attributes).toContain('Max-Age=0');

    // Every old cookie is dead, the caller's included.
    expect((await undoUnknown({ cookie: a.cookie, 'x-docket-csrf': a.csrf })).status).toBe(401);
    expect((await undoUnknown({ cookie: b.cookie, 'x-docket-csrf': b.csrf })).status).toBe(401);

    // The old key no longer unlocks; the new one does.
    const stale = await s.request('/api/session/unlock', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: oldKey }),
    });
    expect(stale.status).toBe(403);
    await unlock(newKey);
  });

  it('needs CSRF', async () => {
    const { cookie } = await unlock();
    const res = await s.request('/api/session/rotate-key', { method: 'POST', headers: { cookie } });
    expect(res.status).toBe(403);
  });
});

describe('the live stream behind the session', () => {
  it('opens for an unlocked browser and sends a keep-alive comment', async () => {
    await s.cleanup();
    s = createTestServer({ keepAliveMs: 50 });
    const { cookie } = await unlock();
    const res = await s.request('/api/stream', { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/);
    const text = await readUntil(res, (t) => t.includes(': keep-alive'));
    expect(text).toContain(': keep-alive');
  });
});

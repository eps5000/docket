/**
 * Trust mode (owner decision 32; BUILD_SPEC §3; FR-141 to FR-143; T167).
 *
 * - **Local trust** (the default): the UI opens without unlocking, `/api`
 *   needs no session, `/mcp` needs no token (and ignores one), and `/unlock`
 *   goes home. Browser mutations still need the CSRF double submit; a client
 *   with no browser headers is a script, and its owner events record
 *   `via: script` with its user agent ("owner (script: curl/8.4.0)").
 * - **Protected mode** (`DOCKET_PROTECTED_MODE=on`): as before the decision
 *   (session.test.ts, guards.test.ts and routes.test.ts run in it).
 * - **Both modes:** the Host and Origin guards refuse, and no route or tool
 *   changes the mode.
 *
 * The matrix each mode produced is printed at the end (the PR's evidence).
 */
import { API_ROUTES, TOOL_NAMES, isMutation, needsCsrf, type RouteId } from '@docket/shared';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { loadSampleSeed } from '../../src/db/seed/loader.js';
import { shortUserAgent } from '../../src/api/session.js';
import {
  MCP_HEADERS,
  ORIGIN,
  PROTECTED_MODE,
  createTestServer,
  initializeBody,
  parseSetCookies,
  type TestServer,
} from './harness.js';

type Mode = 'local trust' | 'protected';
const MODES: [Mode, Record<string, string>][] = [
  ['local trust', {}],
  ['protected', PROTECTED_MODE],
];

const matrix = new Map<string, Partial<Record<Mode, string>>>();
const record = (row: string, mode: Mode, outcome: string) => {
  matrix.set(row, { ...matrix.get(row), [mode]: outcome });
};

afterAll(() => {
  const rows = [...matrix].map(
    ([row, r]) => `| ${row} | ${r['local trust'] ?? ''} | ${r.protected ?? ''} |`,
  );
  console.log(
    ['', '| Request | Local trust | Protected |', '|---|---|---|', ...rows, ''].join('\n'),
  );
});

let s: TestServer;
afterEach(async () => {
  await s?.cleanup();
});

function seeded(env: Record<string, string>): TestServer {
  s = createTestServer({ env });
  loadSampleSeed(s.runtime.db, { now: s.clock.now(), docsDir: s.runtime.config.paths.docs });
  return s;
}

const NOTE_PATH = API_ROUTES['items.addNote'].path.replace(':id', 'RCP-14');
const noteBody = (text = 'Check the units table first.') => JSON.stringify({ text });

/** A browser's cookies and CSRF value: unlocked (protected), or from its first API call (local). */
async function browser(mode: Mode): Promise<{ cookie: string; csrf: string }> {
  if (mode === 'protected') {
    const res = await s.request('/api/session/unlock', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: s.runtime.secrets.ownerKey() }),
    });
    const c = parseSetCookies(res);
    return {
      cookie: `docket_owner=${c.docket_owner!.value}; docket_csrf=${c.docket_csrf!.value}`,
      csrf: c.docket_csrf!.value,
    };
  }
  const res = await s.request('/api/bootstrap');
  const csrf = parseSetCookies(res).docket_csrf!.value;
  return { cookie: `docket_csrf=${csrf}`, csrf };
}

function lastOwnerEvent(): { data: Record<string, unknown> } {
  const row = s.runtime.db.sqlite
    .prepare("SELECT data FROM events WHERE actor_kind = 'owner' ORDER BY seq DESC LIMIT 1")
    .get() as { data: string };
  return { data: JSON.parse(row.data) as Record<string, unknown> };
}

function mcpInit(headers: Record<string, string> = {}) {
  return s.request('/mcp', {
    method: 'POST',
    headers: { ...MCP_HEADERS, ...headers },
    body: initializeBody('trust-test'),
  });
}

describe.each(MODES)('%s', (mode, env) => {
  const local = mode === 'local trust';

  it('UI access: the app opens; /unlock goes home in local trust', async () => {
    seeded(env);
    const home = await s.request('/work');
    expect(home.status).toBe(200);
    const unlock = await s.request('/unlock?next=%2Fagents');
    if (local) {
      expect(unlock.status).toBe(302);
      expect(unlock.headers.get('location')).toBe('/');
      // The page load gives the browser its CSRF cookie.
      expect(parseSetCookies(home).docket_csrf?.value).toMatch(/^[\w-]+\.[\w-]+$/);
    } else {
      expect(unlock.status).toBe(200);
      expect(await unlock.text()).toContain('<title>Docket</title>');
    }
    const api = await s.request('/api/bootstrap');
    expect(api.status).toBe(local ? 200 : 401);
    record('UI: open the app; `/unlock`', mode, local ? '200; 302 → `/`' : '200; Unlock screen');
    record('Owner API read, no session (`GET /api/bootstrap`)', mode, String(api.status));
  });

  it('an owner action from the browser (same Origin, CSRF) works and records via: browser', async () => {
    seeded(env);
    const b = await browser(mode);
    const res = await s.request(NOTE_PATH, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: ORIGIN,
        'sec-fetch-site': 'same-origin',
        cookie: b.cookie,
        'x-docket-csrf': b.csrf,
      },
      body: noteBody(),
    });
    expect(res.status).toBe(200);
    expect(lastOwnerEvent().data).toMatchObject({ via: 'browser' });
    expect(lastOwnerEvent().data.user_agent).toBeUndefined();
    record('Owner action from the browser (Origin + CSRF)', mode, '200, `via: browser`');
  });

  it('a browser mutation without the CSRF header is refused', async () => {
    seeded(env);
    const b = await browser(mode);
    const res = await s.request(NOTE_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: b.cookie },
      body: noteBody(),
    });
    expect(res.status).toBe(403);
    // A browser fetch always says where it came from, even without Origin.
    const fetchOnly = await s.request(NOTE_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
      body: noteBody(),
    });
    expect(fetchOnly.status).toBe(local ? 403 : 401);
    // A forged or unsigned CSRF pair is no better.
    const forged = await s.request(NOTE_PATH, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: ORIGIN,
        cookie: 'docket_csrf=abc.def',
        'x-docket-csrf': 'abc.def',
      },
      body: noteBody(),
    });
    expect(forged.status).toBe(local ? 403 : 401);
    record('Owner action from the browser without CSRF', mode, '403');
  });

  it('an owner action from a script (no browser headers)', async () => {
    seeded(env);
    const res = await s.request(NOTE_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'curl/8.4.0' },
      body: noteBody('Scripted note.'),
    });
    if (local) {
      expect(res.status).toBe(200);
      expect(lastOwnerEvent().data).toMatchObject({ via: 'script', user_agent: 'curl/8.4.0' });
      // Activity shows it: "owner (script: curl/8.4.0)".
      const item = await s.request('/api/items/RCP-14');
      const body = (await item.json()) as { activity: { actor: string; summary: string }[] };
      const row = body.activity.find((a) => a.actor.startsWith('owner (script'));
      expect(row?.actor).toBe('owner (script: curl/8.4.0)');
      record(
        'Owner action from a script (curl, no Origin)',
        mode,
        '200, `owner (script: curl/8.4.0)`',
      );
    } else {
      expect(res.status).toBe(401);
      record('Owner action from a script (curl, no Origin)', mode, '401');
    }
  });

  it('the agent token is no owner credential in protected mode, and is just ignored in local trust', async () => {
    seeded(env);
    const res = await s.request(NOTE_PATH, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${s.runtime.secrets.agentToken()}`,
      },
      body: noteBody(),
    });
    expect(res.status).toBe(local ? 200 : 401);
  });

  it('a foreign Origin is refused, with or without CSRF (Origin guard)', async () => {
    seeded(env);
    const b = await browser(mode);
    for (const headers of <Record<string, string>[]>[
      { origin: 'https://evil.example' },
      { origin: 'https://evil.example', cookie: b.cookie, 'x-docket-csrf': b.csrf },
      { origin: 'null' },
      { origin: 'http://127.0.0.1:8080' },
    ]) {
      const res = await s.request(NOTE_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: noteBody(),
      });
      expect(res.status).toBe(403);
    }
    const get = await s.request('/api/bootstrap', { headers: { origin: 'https://evil.example' } });
    expect(get.status).toBe(403);
    const mcp = await mcpInit({ origin: 'https://evil.example' });
    expect(mcp.status).toBe(403);
    record('Owner action or MCP from a foreign Origin', mode, '403');
  });

  it('a Host outside DOCKET_ALLOWED_HOSTS is refused (DNS-rebinding guard)', async () => {
    seeded(env);
    for (const path of ['/api/bootstrap', '/mcp', '/', '/unlock']) {
      const res = await s.app.request(`http://evil.example:7420${path}`, {
        method: path === '/mcp' ? 'POST' : 'GET',
        headers: path === '/mcp' ? MCP_HEADERS : {},
        body: path === '/mcp' ? initializeBody() : undefined,
      });
      expect(res.status).toBe(421);
    }
    record('Any request with a foreign Host', mode, '421');
  });

  it('MCP with and without a token', async () => {
    seeded(env);
    const none = await mcpInit();
    expect(none.status).toBe(local ? 200 : 401);
    const right = await mcpInit({ authorization: `Bearer ${s.runtime.secrets.agentToken()}` });
    expect(right.status).toBe(200);
    const wrong = await mcpInit({ authorization: 'Bearer tl_not-the-token-at-all' });
    expect(wrong.status).toBe(local ? 200 : 401);
    record('MCP `initialize` without a token', mode, String(none.status));
    record('MCP `initialize` with the token', mode, String(right.status));
    record('MCP `initialize` with a wrong token', mode, local ? '200 (ignored)' : '401');
  });

  it('/agent-upload follows the same rule as /mcp', async () => {
    seeded(env);
    const form = new FormData();
    form.set('item_id', 'RCP-2');
    form.set('kind', 'other');
    form.set('file', new Blob(['x']), 'a.md');
    const res = await s.request('/agent-upload', { method: 'POST', body: form });
    expect(res.status).toBe(local ? 200 : 401);
    record('`/agent-upload` without a token', mode, String(res.status));
  });

  it('Settings says which mode is on; Reveal token works only in protected mode', async () => {
    seeded(env);
    const b = await browser(mode);
    const settings = await s.request('/api/settings', { headers: { cookie: b.cookie } });
    const body = (await settings.json()) as {
      connections: { protected_mode: boolean; endpoint: { auth: string } };
    };
    expect(body.connections.protected_mode).toBe(!local);
    expect(body.connections.endpoint.auth).toBe(local ? 'none' : 'bearer');
    const reveal = await s.request('/api/settings/agent-token', { headers: { cookie: b.cookie } });
    expect(reveal.status).toBe(local ? 403 : 200);
    if (local) expect(await reveal.text()).not.toContain(s.runtime.secrets.agentToken());
    record('*Reveal token* (`GET /api/settings/agent-token`)', mode, local ? '403' : '200');
  });
});

describe('local trust details', () => {
  it('every API route is reachable without a session; browser mutations need CSRF, scripts do not', async () => {
    seeded({});
    const ids = Object.keys(API_ROUTES) as RouteId[];
    for (const id of ids) {
      const route = API_ROUTES[id];
      if (!route.path.startsWith('/api/') || route.auth !== 'session') continue;
      // Refused on purpose in local trust (above): the token is protected mode's.
      if (id === 'settings.agentToken') continue;
      const path = route.path.replace(/:(\w+)/g, 'x');
      const res = await s.request(path, { method: route.method });
      // Whatever the route says about the input, the guards let it through.
      expect([401, 403], `${id} without a session`).not.toContain(res.status);
      if (needsCsrf(route)) {
        const browserRes = await s.request(path, {
          method: route.method,
          headers: { origin: ORIGIN },
        });
        expect(browserRes.status, `${id} from a browser without CSRF`).toBe(403);
      } else {
        expect(isMutation(route) && route.auth === 'session').toBe(false);
      }
    }
  });

  it('the local CSRF cookie is signed, SameSite=Strict and readable by the page, and set once', async () => {
    seeded({});
    const first = await s.request('/api/bootstrap');
    const cookie = parseSetCookies(first).docket_csrf!;
    expect(cookie.attributes).toEqual(expect.arrayContaining(['Path=/', 'SameSite=Strict']));
    expect(cookie.attributes).not.toContain('HttpOnly');
    expect(s.runtime.sessions.checkLocalCsrf(cookie.value)).toBe(true);
    const again = await s.request('/api/bootstrap', {
      headers: { cookie: `docket_csrf=${cookie.value}` },
    });
    expect(parseSetCookies(again).docket_csrf).toBeUndefined();
    // A planted cookie is replaced, and rotating the owner key invalidates the old value.
    const planted = await s.request('/api/bootstrap', { headers: { cookie: 'docket_csrf=a.b' } });
    expect(parseSetCookies(planted).docket_csrf?.value).not.toBe('a.b');
    s.runtime.sessions.rotateKey();
    expect(s.runtime.sessions.checkLocalCsrf(cookie.value)).toBe(false);
  });

  it('an unlocked session still works in local trust (protected-mode browsers keep working)', async () => {
    seeded({});
    const res = await s.request('/api/session/unlock', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: s.runtime.secrets.ownerKey() }),
    });
    const c = parseSetCookies(res);
    const note = await s.request(NOTE_PATH, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: ORIGIN,
        cookie: `docket_owner=${c.docket_owner!.value}; docket_csrf=${c.docket_csrf!.value}`,
        'x-docket-csrf': c.docket_csrf!.value,
      },
      body: noteBody(),
    });
    expect(note.status).toBe(200);
    // Lock without a session has nothing to end.
    const lock = await s.request('/api/session/lock', { method: 'POST' });
    expect(lock.status).toBe(400);
  });

  it('records a short, printable user agent and never a secret-looking one', () => {
    expect(shortUserAgent('curl/8.4.0')).toBe('curl/8.4.0');
    expect(shortUserAgent('python-requests/2.32.3 extra stuff')).toBe('python-requests/2.32.3');
    expect(shortUserAgent(undefined)).toBe('unknown');
    expect(shortUserAgent('   ')).toBe('unknown');
    expect(shortUserAgent(`x${'y'.repeat(80)}`)).toHaveLength(40);
    expect(shortUserAgent('Bearer abcdefghijklmnopqrstuvwxyz')).toBe('redacted');
    const key = 'K'.repeat(52);
    expect(shortUserAgent(`tool/${key}`, [key])).toBe('redacted');
  });

  it('a secret in a script user agent never reaches the event', async () => {
    seeded({});
    const key = s.runtime.secrets.ownerKey();
    const res = await s.request(NOTE_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': `tool/${key}` },
      body: noteBody(),
    });
    expect(res.status).toBe(200);
    expect(lastOwnerEvent().data).toMatchObject({ via: 'script', user_agent: 'redacted' });
    const all = s.runtime.db.sqlite.prepare('SELECT data FROM events').all() as { data: string }[];
    expect(all.some((r) => r.data.includes(key))).toBe(false);
  });
});

describe('no route or tool changes the trust mode (FR-143)', () => {
  it('no API route or MCP tool names it, and the settings routes take no mode', () => {
    const named = /protect|trust|unlock-mode|security-mode/i;
    const routes = Object.entries(API_ROUTES).filter(
      ([id, r]) => named.test(id) || named.test(r.path),
    );
    expect(routes).toEqual([]);
    expect(TOOL_NAMES.filter((t) => named.test(t))).toEqual([]);
  });

  it('the mode comes only from the environment at startup', async () => {
    seeded({});
    expect(s.runtime.config.protectedMode).toBe(false);
    // Owner actions can't flip it: there is no mutation that touches it.
    const before = JSON.stringify(s.runtime.config);
    await s.request('/api/settings', { method: 'PATCH', body: '{"protected_mode":true}' });
    expect(JSON.stringify(s.runtime.config)).toBe(before);
    expect((await mcpInit()).status).toBe(200);
  });
});

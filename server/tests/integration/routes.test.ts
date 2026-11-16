/**
 * The UI API route contract (tasks.md T046; BUILD_SPEC §3, §7).
 *
 * For every route in the shared route table:
 * - it exists (a valid request never gets the "No API route" 404);
 * - without an owner session it gets 401 (`/agent-upload`: without the
 *   bearer token); unlock is the one route that needs neither;
 * - a mutation without the CSRF header gets 403;
 * - a bad request gets 400 `validation`: an unknown query key and, for
 *   routes with a body, an unknown body key, each with a did-you-mean when
 *   one is near; a malformed path parameter too;
 * - a valid request gets 501 `unavailable` "Not implemented yet: <METHOD path>"
 *   until a slice implements it, except B2's routes, which keep working.
 *
 * A summary table is printed at the end (PR evidence).
 */
import {
  API_ROUTES,
  ROUTE_IDS,
  needsCsrf,
  routeLabel,
  type ApiRouteDef,
  type RouteId,
} from '@tasklite/shared';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedId } from '../../src/db/seed/loader.js';
import { ORIGIN, createTestServer, parseSetCookies, type TestServer } from './harness.js';

/**
 * Routes that already work, and must keep their behaviour, not answer 501:
 * B2's, quick capture, which calls `items.create` (US1, B7) like `create_item`,
 * US2's read routes (B8, T080; content in us2-api.test.ts), US3's review
 * routes (B9, T094; content in the US3 tests), US11's recovery routes
 * (B10, T100; content in the US11 tests), US5's decisions routes (B12,
 * T115; content in us5-context.test.ts), and US6's steer routes (B13, T120;
 * content in the US6 tests).
 */
const B2_ROUTES: readonly RouteId[] = [
  'session.unlock',
  'session.lock',
  'session.rotateKey',
  'mutations.undo',
  'stream.get',
  'items.create',
  'bootstrap.get',
  'needsYou.get',
  'work.get',
  'items.get',
  'agents.list',
  'search.get',
  // US3 (B9, T094): the packet screen, the deferred follow-up and human review items.
  'review.get',
  'review.decide',
  'review.refresh',
  'deferred.followUp',
  'humanReview.add',
  'humanReview.update',
  'humanReview.remove',
  // US11 (B10, T100): Agents → Workspaces and the two recovery Problems actions.
  'workspaces.list',
  'resources.release',
  'runs.unpushedHandled',
  // US4 (B11, T107): removing a link, the project's blocker rule, and Settings (its project rows).
  'links.delete',
  'projects.patch',
  'settings.get',
  // US5 (B12, T115): the Decisions sections.
  'decisions.list',
  'decisions.create',
  'decisions.confirm',
  'decisions.withdraw',
  // US6 (B13, T120): steering a ticket (content in the US6 tests).
  'items.answer',
  'items.addNote',
  'items.release',
  'items.returnToReady',
  'steps.add',
  'steps.remove',
  'checks.add',
  'checks.remove',
  // US7 (B14, T124–T125): planning, archive, cancel, the label page and documents
  // (content in us7-planning.test.ts and us7-documents.test.ts).
  'items.patch',
  'items.archive',
  'items.unarchive',
  'archive.many',
  'items.cancel',
  'labels.get',
  'labels.moveToReady',
  'documents.content',
  'agentUpload.post',
];

interface Req {
  params?: Record<string, string>;
  query?: Record<string, string>;
  body?: Record<string, unknown>;
}

/** A valid request for every route. */
const VALID: Record<RouteId, Req> = {
  'session.unlock': { body: { key: '(owner key)' } },
  'session.lock': {},
  'session.rotateKey': {},
  'bootstrap.get': {},
  'needsYou.get': { query: { scope: 'RCP' } },
  'work.get': { query: { scope: 'all', layout: 'board', filter: 'blocked' } },
  'items.get': { params: { id: 'RCP-14' } },
  'agents.list': { query: { scope: 'all' } },
  'search.get': { query: { q: 'pantry' } },
  'stream.get': {},
  'review.get': { params: { id: 'RCP-12' }, query: { round: '2' } },
  'review.decide': {
    params: { id: 'RCP-12' },
    body: {
      round: 2,
      verdicts: [
        { hr_item_id: seedId('hr', 'RCP-12', 0), kind: 'approve' },
        {
          hr_item_id: seedId('hr', 'RCP-12', 1),
          kind: 'changes',
          note: 'Drag fails on touch.',
          into: 'bug',
        },
      ],
    },
  },
  'review.refresh': { params: { id: 'RCP-12' }, body: { packet_id: 'pkt_1' } },
  'deferred.followUp': { params: { hrId: 'hr_a' }, body: {} },
  'links.delete': { params: { linkId: 'lnk_1' }, body: {} },
  'projects.patch': { params: { key: 'RCP' }, body: { default_satisfied_when: 'merged' } },
  'decisions.list': {
    query: { project: 'RCP', scope_kind: 'epic', scope_id: 'RCP-1', include_inactive: 'true' },
  },
  'decisions.create': {
    body: {
      project: 'RCP',
      scope: { kind: 'project' },
      title: 'Units are metric internally',
      decision: 'Convert on display.',
    },
  },
  'decisions.confirm': { params: { id: 'dec_2' }, body: { expected_version: 1 } },
  'decisions.withdraw': { params: { id: 'dec_3' }, body: { reason: 'No longer applies.' } },
  'items.answer': {
    params: { id: 'RCP-14' },
    body: { question_id: 'q_1', text: 'Per serving.' },
  },
  'items.addNote': { params: { id: 'RCP-14' }, body: { text: 'Check the units table first.' } },
  'items.release': { params: { id: 'RCP-14' }, body: {} },
  'items.returnToReady': { params: { id: 'RCP-14' }, body: { reason: 'Re-plan first.' } },
  'steps.add': { params: { id: 'RCP-14' }, body: { text: 'Test with a 3-week plan' } },
  'steps.remove': { params: { id: 'RCP-14', stepId: 'wst_a' }, body: {} },
  'checks.add': { params: { id: 'RCP-14' }, body: { text: 'Export opens in Notes' } },
  'checks.remove': { params: { id: 'RCP-14', checkId: 'chk_a' }, body: {} },
  'humanReview.add': { params: { id: 'RCP-14' }, body: { text: 'Read the export on a phone.' } },
  'humanReview.update': {
    params: { id: 'RCP-14', hrId: 'hr_a' },
    body: { expected_version: 1, text: 'Read the export.' },
  },
  'humanReview.remove': { params: { id: 'RCP-14', hrId: 'hr_a' }, body: {} },
  'items.create': { body: { title: 'Pantry inventory schema', type: 'Story', project: 'RCP' } },
  'items.patch': {
    params: { id: 'RCP-14' },
    body: { expected_version: 7, title: 'Generate the shopping list', acceptance: ['One list'] },
  },
  'items.archive': { params: { id: 'RCP-3' }, body: {} },
  'items.unarchive': { params: { id: 'RCP-3' }, body: {} },
  'archive.many': { body: { ids: ['RCP-3', 'RCP-4'] } },
  'items.cancel': { params: { id: 'RCP-31' }, body: { expected_version: 1 } },
  'labels.get': { params: { project: 'RCP', name: 'ui-refresh' } },
  'labels.moveToReady': { params: { project: 'RCP', name: 'ui-refresh' }, body: {} },
  'documents.content': { params: { versionId: 'dv_1' } },
  'burndown.get': { query: { scope: 'RCP', epic: 'RCP-1' } },
  'jira.dryRun': {
    body: {
      site_url: 'https://example.atlassian.net',
      email: 'owner@example.test',
      api_token: 'jira-token-for-the-test',
      jira_project: 'ABC',
      target: { kind: 'new', key: 'ABC', name: 'Imported' },
    },
  },
  'jira.get': { params: { id: 'imp_1' } },
  'jira.commit': { params: { id: 'imp_1' }, body: {} },
  'jira.cancel': { params: { id: 'imp_1' }, body: {} },
  'settings.get': {},
  'projects.delete': { params: { key: 'RCP' }, body: { confirm_key: 'RCP' } },
  'diagnostics.calls': { query: { days: '7' } },
  'mutations.undo': { params: { id: 'mut_01JAAAAAAAAAAAAAAAAAAAAAAA' }, body: {} },
  'workspaces.list': { query: { scope: 'RCP', state: 'at_risk' } },
  'resources.release': { params: { id: 'rsc_1' }, body: { note: 'Stopped the dev server.' } },
  'runs.unpushedHandled': { params: { runId: 'run_21' }, body: {} },
  'agentUpload.post': { body: { item_id: 'RCP-2', kind: 'planning' } },
};

/** A path parameter value that fails its schema: a lower-cased item ID or key, a bad label, or blank. */
function badParam(name: string, valid: string): string {
  if (/^[A-Z]{2,5}(-\d+)?$/.test(valid)) return valid.toLowerCase();
  if (name === 'name') return 'Not A Label';
  return ' ';
}

// ---- Plumbing ----

let s: TestServer;
beforeEach(() => {
  s = createTestServer();
});
afterEach(async () => {
  await s.cleanup();
});

type Check = 'exists' | '401' | '403' | '400 query' | '400 body' | '400 param' | 'valid';
const results = new Map<RouteId, Partial<Record<Check, string>>>();
const record = (id: RouteId, check: Check, outcome: string) => {
  results.set(id, { ...results.get(id), [check]: outcome });
};

interface Session {
  cookie: string;
  csrf: string;
}

async function unlock(): Promise<Session> {
  const res = await s.request('/api/session/unlock', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: s.runtime.secrets.ownerKey() }),
  });
  expect(res.status).toBe(200);
  const cookies = parseSetCookies(res);
  return {
    cookie: `tl_owner=${cookies.tl_owner!.value}; tl_csrf=${cookies.tl_csrf!.value}`,
    csrf: cookies.tl_csrf!.value,
  };
}

function urlFor(route: ApiRouteDef, req: Req): string {
  const path = route.path.replace(/:([A-Za-z_]+)/g, (_, name: string) =>
    encodeURIComponent(req.params?.[name] ?? ''),
  );
  const qs = new URLSearchParams(req.query ?? {}).toString();
  return qs ? `${path}?${qs}` : path;
}

async function send(
  id: RouteId,
  req: Req,
  auth: { session?: Session; csrf?: boolean; bearer?: boolean } = {},
): Promise<Response> {
  const route = API_ROUTES[id];
  const headers: Record<string, string> = {};
  if (auth.session) {
    headers.cookie = auth.session.cookie;
    if (auth.csrf !== false) headers['x-tasklite-csrf'] = auth.session.csrf;
  }
  if (auth.bearer) headers.authorization = `Bearer ${s.runtime.secrets.agentToken()}`;
  let body: FormData | string | undefined;
  if (route.method !== 'GET') {
    const fields =
      req.body?.key === '(owner key)'
        ? { ...req.body, key: s.runtime.secrets.ownerKey() }
        : req.body;
    if (route.bodyKind === 'multipart') {
      const form = new FormData();
      for (const [k, v] of Object.entries(fields ?? {})) form.set(k, String(v));
      form.set('file', new Blob(['# Pantry PRD\n'], { type: 'text/markdown' }), 'pantry-prd.md');
      body = form;
    } else if (fields !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(fields);
    }
  }
  return s.request(urlFor(route, req), { method: route.method, headers, body });
}

async function errorOf(res: Response) {
  const json = (await res.json()) as {
    error: { code: string; message: string; details?: Record<string, unknown> };
  };
  return json.error;
}

/** Sign in the way the route expects. */
async function authFor(id: RouteId) {
  const route = API_ROUTES[id];
  if (route.auth === 'bearer') return { bearer: true };
  if (route.auth === 'none') return {};
  return { session: await unlock() };
}

/** A near-miss of the first key, which closestField will suggest back. */
const typo = (key: string) => `${key}x`;

const firstKey = (schema: unknown): string | null => {
  const def = (schema as { _zod: { def: { shape?: Record<string, unknown> } } })._zod.def;
  return def.shape ? (Object.keys(def.shape)[0] ?? null) : null;
};

// ---- The checks ----

describe.each(ROUTE_IDS)('%s', (id) => {
  const route = API_ROUTES[id];
  const label = routeLabel(route);

  it('rejects a request without credentials', async () => {
    if (route.auth === 'none') {
      // Unlock is reachable without a session: a wrong key is 403, not 401.
      const res = await s.request(route.path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: 'WRONG' }),
      });
      expect(res.status).toBe(403);
      record(id, '401', 'n/a (no session needed)');
      return;
    }
    const res = await send(id, VALID[id]);
    expect(res.status, label).toBe(401);
    const err = await errorOf(res);
    expect(err.code).toBe('forbidden');
    if (route.auth === 'bearer') {
      expect(res.headers.get('www-authenticate')).toMatch(/^Bearer/);
      // The owner session is not a substitute for the bearer token.
      const session = await unlock();
      expect((await send(id, VALID[id], { session })).status).toBe(401);
      record(id, '401', '401 (no bearer; session refused)');
    } else {
      // The agents' bearer token is not a substitute for the owner session.
      expect((await send(id, VALID[id], { bearer: true })).status).toBe(401);
      record(id, '401', '401');
    }
  });

  it('needs the CSRF header if it is a mutation', async () => {
    if (!needsCsrf(route)) {
      record(id, '403', 'n/a');
      return;
    }
    const session = await unlock();
    const res = await send(id, VALID[id], { session, csrf: false });
    expect(res.status, label).toBe(403);
    expect((await errorOf(res)).message).toMatch(/X-Tasklite-CSRF/);
    record(id, '403', '403');
  });

  it('rejects an unknown query key with validation', async () => {
    const auth = await authFor(id);
    const key = firstKey(route.query);
    const bad = key ? typo(key) : 'zz';
    const res = await send(id, { ...VALID[id], query: { ...VALID[id].query, [bad]: '1' } }, auth);
    expect(res.status, label).toBe(400);
    const err = await errorOf(res);
    expect(err.code).toBe('validation');
    expect(err.message).toContain(
      key ? `Unknown field "${bad}"; did you mean "${key}"?` : `Unknown field "${bad}".`,
    );
    record(id, '400 query', key ? '400 + did-you-mean' : '400');
  });

  it('rejects an unknown body key with validation and a did-you-mean', async () => {
    if (!route.body) {
      record(id, '400 body', 'n/a (GET)');
      return;
    }
    const auth = await authFor(id);
    const key = firstKey(route.body);
    const bad = key ? typo(key) : 'zz';
    const res = await send(id, { ...VALID[id], body: { ...VALID[id].body, [bad]: 'x' } }, auth);
    expect(res.status, label).toBe(400);
    const err = await errorOf(res);
    expect(err.code).toBe('validation');
    expect(err.message).toContain(
      key ? `Unknown field "${bad}"; did you mean "${key}"?` : `Unknown field "${bad}".`,
    );
    expect(err.details?.unknown).toEqual([{ field: bad, suggestion: key }]);
    record(id, '400 body', key ? '400 + did-you-mean' : '400');
  });

  it('rejects a malformed path parameter with validation', async () => {
    const names = Object.keys(VALID[id].params ?? {});
    if (names.length === 0) {
      record(id, '400 param', 'n/a');
      return;
    }
    const auth = await authFor(id);
    const first = names[0]!;
    const params = { ...VALID[id].params, [first]: badParam(first, VALID[id].params![first]!) };
    const res = await send(id, { ...VALID[id], params }, auth);
    expect(res.status, label).toBe(400);
    expect((await errorOf(res)).code).toBe('validation');
    record(id, '400 param', '400');
  });

  it('answers a valid request', async () => {
    const auth = await authFor(id);
    const res = await send(id, VALID[id], auth);
    if (B2_ROUTES.includes(id)) {
      expect(res.status, label).not.toBe(400);
      expect(res.status, label).not.toBe(501);
      expect([200, 404]).toContain(res.status);
      await res.body?.cancel();
      record(id, 'exists', 'yes');
      record(id, 'valid', `${res.status} (implemented)`);
      return;
    }
    const err = await errorOf(res);
    expect(res.status, `${label}: ${JSON.stringify(err)}`).toBe(501);
    expect(err).toEqual({ code: 'unavailable', message: `Not implemented yet: ${label}` });
    record(id, 'exists', 'yes');
    record(id, 'valid', '501 unavailable');
  });
});

describe('the B2 guards cover the new routes', () => {
  it('a foreign Origin gets 403 before the session check', async () => {
    const session = await unlock();
    const res = await s.request('/api/items', {
      method: 'POST',
      headers: {
        cookie: session.cookie,
        'x-tasklite-csrf': session.csrf,
        origin: 'http://evil.test',
        'content-type': 'application/json',
      },
      body: JSON.stringify(VALID['items.create'].body),
    });
    expect(res.status).toBe(403);
  });

  it('a Host outside the allowlist gets 421', async () => {
    const res = await s.app.request('http://evil.test:7420/api/bootstrap');
    expect(res.status).toBe(421);
  });

  it('a body that is not JSON gets validation', async () => {
    const session = await unlock();
    const res = await s.request('/api/items', {
      method: 'POST',
      headers: {
        cookie: session.cookie,
        'x-tasklite-csrf': session.csrf,
        'content-type': 'application/json',
      },
      body: '{not json',
    });
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe('validation');
  });

  it('a missing required field names it', async () => {
    const session = await unlock();
    const res = await s.request('/api/items', {
      method: 'POST',
      headers: {
        cookie: session.cookie,
        'x-tasklite-csrf': session.csrf,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ type: 'Task', project: 'RCP' }),
    });
    expect(res.status).toBe(400);
    const err = await errorOf(res);
    expect(err.message).toBe(
      'Invalid arguments for POST /api/items: title is required. Fix it and retry.',
    );
    expect(err.details).toEqual({ fields: { title: 'is required' } });
  });

  it('the absolute URL in tests is on the allowed host', () => {
    expect(ORIGIN).toBe('http://127.0.0.1:7420');
  });
});

afterAll(() => {
  const checks: Check[] = ['exists', '401', '403', '400 query', '400 body', '400 param', 'valid'];
  const rows = ROUTE_IDS.map(
    (id) =>
      `| ${routeLabel(API_ROUTES[id])} | ${checks.map((c) => results.get(id)?.[c] ?? '—').join(' | ')} |`,
  );
  console.log(
    [
      `Route contract: ${ROUTE_IDS.length} routes`,
      `| Route | ${checks.join(' | ')} |`,
      `|---|${checks.map(() => '---').join('|')}|`,
      ...rows,
    ].join('\n'),
  );
});

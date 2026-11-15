/**
 * The UI API route table (BUILD_SPEC §7; tasks.md T044): every route is
 * declared once, its inputs are strict, and its shape follows the rules the
 * server and the web client rely on.
 */
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  API_GROUPS,
  API_ROUTES,
  ROUTE_IDS,
  decideBody,
  decisionsQuery,
  diagnosticsQuery,
  isMutation,
  needsCsrf,
  patchItemBody,
  pathParams,
  routeLabel,
  validationError,
  workQuery,
  type RouteId,
} from '../src/index.js';

/** BUILD_SPEC §7, the clarification routes, and `/agent-upload` (§5.10). */
const EXPECTED = [
  'POST /api/session/unlock',
  'POST /api/session/lock',
  'POST /api/session/rotate-key',
  'GET /api/bootstrap',
  'GET /api/needs-you',
  'GET /api/work',
  'GET /api/burndown',
  'GET /api/items/:id',
  'POST /api/items',
  'PATCH /api/items/:id',
  'GET /api/diagnostics/calls',
  'POST /api/items/:id/archive',
  'POST /api/items/:id/unarchive',
  'POST /api/archive',
  'POST /api/items/:id/cancel',
  'POST /api/items/:id/work',
  'DELETE /api/items/:id/work/:stepId',
  'POST /api/items/:id/checks',
  'DELETE /api/items/:id/checks/:checkId',
  'POST /api/items/:id/human-review',
  'PATCH /api/items/:id/human-review/:hrId',
  'DELETE /api/items/:id/human-review/:hrId',
  'POST /api/items/:id/notes',
  'POST /api/items/:id/answer',
  'POST /api/items/:id/release',
  'POST /api/items/:id/return-to-ready',
  'DELETE /api/links/:linkId',
  'GET /api/review/:id',
  'POST /api/review/:id/decisions',
  'POST /api/review/:id/refresh',
  'POST /api/deferred/:hrId/follow-up',
  'GET /api/labels/:project/:name',
  'POST /api/labels/:project/:name/move-to-ready',
  'GET /api/agents',
  'GET /api/settings',
  'PATCH /api/projects/:key',
  'DELETE /api/projects/:key',
  'GET /api/decisions',
  'POST /api/decisions',
  'POST /api/decisions/:id/confirm',
  'POST /api/decisions/:id/withdraw',
  'GET /api/search',
  'GET /api/documents/:versionId/content',
  'POST /api/import/jira/dry-run',
  'GET /api/import/jira/:id',
  'POST /api/import/jira/:id/commit',
  'DELETE /api/import/jira/:id',
  'POST /api/mutations/:id/undo',
  'GET /api/stream',
  'POST /agent-upload',
];

const keysOf = (schema: z.ZodType): string[] => {
  const def = (
    schema as unknown as { _zod: { def: { type: string; shape?: object; in?: z.ZodType } } }
  )._zod.def;
  if (def.type === 'pipe' && def.in) return keysOf(def.in);
  return def.shape ? Object.keys(def.shape) : [];
};

describe('the route table', () => {
  it('has every BUILD_SPEC §7 route, the clarification routes and /agent-upload, once each', () => {
    const labels = ROUTE_IDS.map((id) => routeLabel(API_ROUTES[id]));
    expect(new Set(labels).size).toBe(labels.length);
    expect([...labels].sort()).toEqual([...EXPECTED].sort());
    expect(labels).toHaveLength(50);
  });

  it('puts each route in a known group, and every group has a route', () => {
    for (const id of ROUTE_IDS) expect(API_GROUPS).toContain(API_ROUTES[id].group);
    for (const group of API_GROUPS) {
      expect(
        ROUTE_IDS.some((id) => API_ROUTES[id].group === group),
        group,
      ).toBe(true);
    }
  });

  it.each(ROUTE_IDS)('%s: params match the path, GET has no body, mutations have one', (id) => {
    const r = API_ROUTES[id as RouteId];
    expect(keysOf(r.params).sort()).toEqual(pathParams(r.path).sort());
    if (r.method === 'GET') expect(r.body).toBeNull();
    else expect(r.body).not.toBeNull();
    expect(isMutation(r)).toBe(r.method !== 'GET');
  });

  it.each(ROUTE_IDS)('%s: params, query and body are strict', (id) => {
    const r = API_ROUTES[id as RouteId];
    for (const schema of [r.params, r.query, r.body]) {
      if (!schema) continue;
      const result = schema.safeParse({ zz_unknown: 1 });
      expect(result.success).toBe(false);
      expect(result.error!.issues.some((i) => i.code === 'unrecognized_keys')).toBe(true);
    }
  });

  it.each(ROUTE_IDS)('%s: an undoable route returns a mutation_id', (id) => {
    const r = API_ROUTES[id as RouteId];
    if (!r.undoable) return;
    expect(r.response.kind).toBe('json');
    if (r.response.kind === 'json') expect(keysOf(r.response.schema)).toContain('mutation_id');
  });

  it('auth: unlock has none, /agent-upload takes the bearer token, everything else the session', () => {
    for (const id of ROUTE_IDS) {
      const r = API_ROUTES[id];
      const expected =
        r.path === '/api/session/unlock'
          ? 'none'
          : r.path === '/agent-upload'
            ? 'bearer'
            : 'session';
      expect(r.auth, id).toBe(expected);
      expect(needsCsrf(r), id).toBe(expected === 'session' && r.method !== 'GET');
    }
  });

  it('/agent-upload is multipart; every other body is JSON', () => {
    for (const id of ROUTE_IDS) {
      expect(API_ROUTES[id].bodyKind, id).toBe(id === 'agentUpload.post' ? 'multipart' : 'json');
    }
  });
});

describe('strict inputs reuse the MCP did-you-mean message', () => {
  it('names an unknown body key and suggests the closest field', () => {
    const r = patchItemBody.safeParse({ expected_verison: 3, title: 'x' });
    const err = validationError('PATCH /api/items/:id', patchItemBody, r.error!);
    expect(err.code).toBe('validation');
    expect(err.message).toContain(
      'Unknown field "expected_verison"; did you mean "expected_version"?',
    );
    expect(err.details?.unknown).toEqual([
      { field: 'expected_verison', suggestion: 'expected_version' },
    ]);
  });

  it('names an unknown query key too', () => {
    const r = workQuery.safeParse({ layuot: 'map' });
    const err = validationError('GET /api/work', workQuery, r.error!);
    expect(err.message).toContain('Unknown field "layuot"; did you mean "layout"?');
  });
});

describe('field rules', () => {
  it('PATCH /api/items/:id needs expected_version and at least one change', () => {
    expect(patchItemBody.safeParse({ expected_version: 3 }).success).toBe(false);
    expect(patchItemBody.safeParse({ title: 'x' }).success).toBe(false);
    expect(patchItemBody.safeParse({ expected_version: 3, title: 'New title' }).success).toBe(true);
    expect(patchItemBody.safeParse({ expected_version: 3, status: 'done' }).success).toBe(false);
    expect(patchItemBody.safeParse({ expected_version: 3, title: 't'.repeat(201) }).success).toBe(
      false,
    );
  });

  it('review verdicts: changes needs a note and into; approve takes neither', () => {
    const ok = (v: object) => decideBody.safeParse({ round: 1, verdicts: [v] }).success;
    expect(ok({ hr_item_id: 'hr_a', kind: 'approve' })).toBe(true);
    expect(ok({ hr_item_id: 'hr_a', kind: 'approve', note: 'x' })).toBe(false);
    expect(ok({ hr_item_id: 'hr_a', kind: 'changes', note: 'Fix it' })).toBe(false);
    expect(ok({ hr_item_id: 'hr_a', kind: 'changes', note: 'Fix it', into: 'bug' })).toBe(true);
    expect(ok({ hr_item_id: 'hr_a', kind: 'defer', follow: 'ticket' })).toBe(true);
    expect(ok({ hr_item_id: 'hr_a', kind: 'approve', follow: 'ticket' })).toBe(false);
  });

  it('query values arrive as strings and are typed on the way in', () => {
    expect(diagnosticsQuery.parse({})).toEqual({ days: 7 });
    expect(diagnosticsQuery.parse({ days: '3' })).toEqual({ days: 3 });
    expect(diagnosticsQuery.safeParse({ days: '8' }).success).toBe(false);
    expect(decisionsQuery.parse({ project: 'RCP', include_inactive: 'true' })).toMatchObject({
      include_inactive: true,
    });
    expect(decisionsQuery.parse({ project: 'RCP', include_inactive: 'false' })).toMatchObject({
      include_inactive: false,
    });
    expect(decisionsQuery.safeParse({ project: 'RCP', scope_kind: 'epic' }).success).toBe(false);
    expect(workQuery.parse({})).toEqual({ scope: 'all', filter: 'all', layout: 'board' });
  });
});

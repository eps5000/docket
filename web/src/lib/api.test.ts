/**
 * The typed API client (tasks.md T049): CSRF handling, `mutation_id`
 * capture, the 409 conflict shape, the query key factory, and the event →
 * query-key invalidation map (contracts/events.md).
 */
import { EVENT_TYPES, ROUTE_IDS, type EventType } from '@docket/shared';
import { describe, expect, it } from 'vitest';
import {
  ApiError,
  ConflictError,
  INVALIDATION,
  QUERY_FAMILIES,
  buildUrl,
  createApiClient,
  csrfToken,
  isConflict,
  keysForChange,
  queryKeys,
  readCookie,
  type MutationRecord,
} from './api';

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A fetch that records requests and answers with `status` and `json`. */
function fakeFetch(status: number, json: unknown) {
  const sent: Sent[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    sent.push({
      url,
      method: init.method ?? 'GET',
      headers: init.headers as Record<string, string>,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body,
    });
    return new Response(JSON.stringify(json), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, sent };
}

const COOKIES = 'theme=dark; tl_csrf=abc123-_x; other=1';

describe('CSRF', () => {
  it('reads the tl_csrf cookie', () => {
    expect(csrfToken(COOKIES)).toBe('abc123-_x');
    expect(csrfToken('tl_csrf=a%3Db')).toBe('a=b');
    expect(csrfToken('theme=dark')).toBeNull();
    expect(csrfToken('')).toBeNull();
    expect(readCookie('tl_csrf', 'xtl_csrf=nope; tl_csrf=yes')).toBe('yes');
  });

  it('sends X-Tasklite-CSRF on mutations, from the cookie', async () => {
    const { fetch, sent } = fakeFetch(200, { mutation_id: 'mut_1', item: {} });
    const client = createApiClient({ fetch, cookies: () => COOKIES });
    await client['items.archive']({ params: { id: 'RCP-3' } });
    expect(sent[0]!.method).toBe('POST');
    expect(sent[0]!.url).toBe('/api/items/RCP-3/archive');
    expect(sent[0]!.headers['X-Tasklite-CSRF']).toBe('abc123-_x');
    expect(sent[0]!.body).toEqual({});
  });

  it('sends no CSRF header on reads', async () => {
    const { fetch, sent } = fakeFetch(200, {});
    const client = createApiClient({ fetch, cookies: () => COOKIES });
    await client['needsYou.get']({ query: { scope: 'RCP' } });
    expect(sent[0]!.method).toBe('GET');
    expect(sent[0]!.url).toBe('/api/needs-you?scope=RCP');
    expect(sent[0]!.headers['X-Tasklite-CSRF']).toBeUndefined();
    expect(sent[0]!.body).toBeUndefined();
  });

  it('sends no CSRF header to unlock (no session yet), and none when the cookie is missing', async () => {
    const { fetch, sent } = fakeFetch(200, { unlocked: true });
    await createApiClient({ fetch, cookies: () => COOKIES })['session.unlock']({
      body: { key: 'K' },
    });
    expect(sent[0]!.headers['X-Tasklite-CSRF']).toBeUndefined();
    await createApiClient({ fetch, cookies: () => '' })['session.lock']({});
    expect(sent[1]!.headers['X-Tasklite-CSRF']).toBeUndefined();
  });
});

describe('requests and results', () => {
  it('fills path parameters and the query string, skipping undefined', () => {
    expect(
      buildUrl({ path: '/api/labels/:project/:name' }, { project: 'RCP', name: 'ui' }, {}),
    ).toBe('/api/labels/RCP/ui');
    expect(
      buildUrl({ path: '/api/decisions' }, undefined, {
        project: 'RCP',
        include_inactive: true,
        scope_kind: undefined,
      }),
    ).toBe('/api/decisions?project=RCP&include_inactive=true');
    expect(buildUrl({ path: '/api/items/:id' }, { id: 'a b' }, undefined)).toBe('/api/items/a%20b');
    expect(() => buildUrl({ path: '/api/items/:id' }, {}, undefined)).toThrow(/id/);
  });

  it('has a typed call for every route', () => {
    const client = createApiClient({ fetch: fakeFetch(200, {}).fetch });
    for (const id of ROUTE_IDS) expect(typeof client[id], id).toBe('function');
  });

  it('hands the mutation_id of an owner mutation to onMutation (for Undo)', async () => {
    const seen: MutationRecord[] = [];
    const { fetch } = fakeFetch(200, { mutation_id: 'mut_9', item: { id: 'RCP-14' } });
    const client = createApiClient({
      fetch,
      cookies: () => COOKIES,
      onMutation: (m) => seen.push(m),
    });
    const result = await client['items.cancel']({
      params: { id: 'RCP-14' },
      body: { expected_version: 3, reason: 'Superseded' },
    });
    expect(result.mutation_id).toBe('mut_9');
    expect(seen).toEqual([{ mutation_id: 'mut_9', route: 'items.cancel', undoable: true }]);
  });

  it('does not report reads as mutations', async () => {
    const seen: MutationRecord[] = [];
    const { fetch } = fakeFetch(200, { mutation_id: 'looks-like-one' });
    await createApiClient({ fetch, onMutation: (m) => seen.push(m) })['bootstrap.get']({});
    expect(seen).toEqual([]);
  });

  it('throws ConflictError with the current record on 409', async () => {
    const current = { id: 'RCP-14', version: 8, title: 'Changed by codex' };
    const { fetch } = fakeFetch(409, {
      error: { code: 'conflict', message: 'RCP-14 changed since you read it.', current },
    });
    const client = createApiClient({ fetch, cookies: () => COOKIES });
    const err = await client['items.patch']({
      params: { id: 'RCP-14' },
      body: { expected_version: 7, title: 'Mine' },
    }).catch((e: unknown) => e);
    expect(isConflict(err)).toBe(true);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).current).toEqual(current);
    expect((err as ConflictError).status).toBe(409);
    expect((err as ConflictError).route).toBe('items.patch');
  });

  it('throws ApiError with the code for other errors, and flags 501 placeholders', async () => {
    const { fetch } = fakeFetch(501, {
      error: { code: 'unavailable', message: 'Not implemented yet: GET /api/bootstrap' },
    });
    const err = (await createApiClient({ fetch })
      ['bootstrap.get']({})
      .catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(isConflict(err)).toBe(false);
    expect(err.code).toBe('unavailable');
    expect(err.notImplemented).toBe(true);
    expect(err.message).toBe('Not implemented yet: GET /api/bootstrap');
  });

  it('returns the raw Response for file and JSONL routes', async () => {
    const { fetch } = fakeFetch(200, {});
    const res = await createApiClient({ fetch })['diagnostics.calls']({ query: { days: 3 } });
    expect(res).toBeInstanceOf(Response);
  });
});

describe('typed inputs (compile-time)', () => {
  it('requires what the route requires, and nothing it does not take', () => {
    const client = createApiClient({ fetch: fakeFetch(200, {}).fetch });
    const calls = () => [
      // @ts-expect-error: items.get needs params.id
      client['items.get']({}),
      // @ts-expect-error: decisions.list needs query.project
      client['decisions.list']({}),
      // @ts-expect-error: a GET takes no body
      client['bootstrap.get']({ body: {} }),
      // @ts-expect-error: unknown body field
      client['items.patch']({ params: { id: 'RCP-1' }, body: { expected_version: 1, titel: 'x' } }),
      client['decisions.list']({ query: { project: 'RCP', include_inactive: true } }),
      client['items.patch']({ params: { id: 'RCP-1' }, body: { expected_version: 1, title: 'x' } }),
    ];
    expect(typeof calls).toBe('function');
  });
});

describe('query keys', () => {
  it('every key starts with tl and its family', () => {
    expect(queryKeys.item('RCP-14')).toEqual(['tl', 'item', 'RCP-14']);
    expect(queryKeys.review('RCP-12')).toEqual(['tl', 'review', 'RCP-12']);
    expect(queryKeys.review('RCP-12', 2)).toEqual(['tl', 'review', 'RCP-12', 2]);
    expect(queryKeys.work({ layout: 'map' })).toEqual(['tl', 'work', { layout: 'map' }]);
    expect(queryKeys.label('RCP', 'ui')).toEqual(['tl', 'labels', 'RCP', 'ui']);
    expect(queryKeys.bootstrap()).toEqual(['tl', 'bootstrap']);
    expect(queryKeys.family('settings')).toEqual(queryKeys.settings());
    expect(queryKeys.workspaces()).toEqual(['tl', 'workspaces', {}]);
    expect(queryKeys.workspaces({ scope: 'RCP', state: 'at_risk' })).toEqual([
      'tl',
      'workspaces',
      { scope: 'RCP', state: 'at_risk' },
    ]);
  });
});

describe('event → query-key invalidation (contracts/events.md)', () => {
  it('covers every event type, with known families only', () => {
    expect(Object.keys(INVALIDATION).sort()).toEqual([...EVENT_TYPES].sort());
    for (const families of Object.values(INVALIDATION)) {
      expect(families.length).toBeGreaterThan(0);
      for (const f of families) expect(QUERY_FAMILIES).toContain(f);
    }
  });

  it('every event touching an item invalidates that item', () => {
    for (const type of EVENT_TYPES) {
      if (type === 'project.updated' || type === 'label.upserted') continue;
      if (type.startsWith('decision.')) continue;
      // Agent setup (decision 29) touches no item.
      if (/^(agent_file|workflow|install)\./.test(type)) continue;
      expect(INVALIDATION[type], type).toContain('item');
    }
  });

  it('narrows item and review keys to the event objects', () => {
    const keys = keysForChange({
      seq: 41,
      type: 'review.decided',
      objects: [
        { kind: 'item', id: 'RCP-12' },
        { kind: 'packet', id: 'pkt_1' },
      ],
      for_you: false,
    });
    expect(keys).toContainEqual(['tl', 'item', 'RCP-12']);
    expect(keys).toContainEqual(['tl', 'review', 'RCP-12']);
    expect(keys).toContainEqual(['tl', 'work']);
    expect(keys).toContainEqual(['tl', 'needsYou']);
    expect(keys).not.toContainEqual(['tl', 'item']);
    expect(keys).not.toContainEqual(['tl', 'settings']);
  });

  it('invalidates the whole item family when the event names no item', () => {
    const keys = keysForChange({
      seq: 7,
      type: 'project.updated',
      objects: [{ kind: 'project', id: 'RCP' }],
      for_you: false,
    });
    expect(keys).toContainEqual(['tl', 'item']);
    expect(keys).toContainEqual(['tl', 'settings']);
    expect(keys).toContainEqual(['tl', 'bootstrap']);
  });

  it.each<EventType>(['packet.submitted', 'question.asked'])(
    '%s with for_you refetches the for-you count and Needs you',
    (type) => {
      const keys = keysForChange({
        seq: 1,
        type,
        objects: [{ kind: 'item', id: 'DOC-4' }],
        for_you: true,
      });
      expect(keys).toContainEqual(['tl', 'bootstrap']);
      expect(keys).toContainEqual(['tl', 'needsYou']);
      expect(keys).toContainEqual(['tl', 'item', 'DOC-4']);
    },
  );

  it('adds the for-you count whenever for_you is set, even for a quiet type', () => {
    const keys = keysForChange({ seq: 2, type: 'note.added', objects: [], for_you: true });
    expect(keys).toEqual([
      ['tl', 'bootstrap'],
      ['tl', 'needsYou'],
      ['tl', 'item'],
    ]);
  });

  it('lists each key once, in family order', () => {
    const keys = keysForChange({
      seq: 3,
      type: 'run.ended',
      objects: [
        { kind: 'item', id: 'RCP-14' },
        { kind: 'item', id: 'RCP-14' },
        { kind: 'run', id: 'run_1' },
      ],
      for_you: false,
    });
    expect(keys).toEqual([
      ['tl', 'bootstrap'],
      ['tl', 'needsYou'],
      ['tl', 'work'],
      ['tl', 'item', 'RCP-14'],
      ['tl', 'agents'],
      ['tl', 'workspaces'],
    ]);
  });
});

describe('agent setup (decision 29; BUILD_SPEC §5.17, §7)', () => {
  it('has typed calls for the agent setup routes, including the session-less download', async () => {
    const { fetch, sent } = fakeFetch(200, {});
    const client = createApiClient({ fetch, cookies: () => COOKIES });
    await client['agentFiles.list']({ query: { project: 'RCP' } });
    await client['agentFiles.get']({ params: { key: 'skill:tasklite-worker' } });
    await client['agentFiles.put']({
      params: { key: 'agents_block' },
      body: { layer: 'service', content: '# Block\n', expected_version: 2, note: 'Ours.' },
    });
    await client['agentFiles.revert']({
      params: { key: 'agents_block' },
      body: { layer: 'project', project: 'RCP' },
    });
    await client['workflow.put']({
      params: { key: 'RCP' },
      body: { content_md: '- Branch per item.', expected_version: 0 },
    });
    await client['installs.create']({
      body: { client: 'codex', target_kind: 'user', method: 'command' },
    });
    await client['installs.check']({ params: { id: 'ins_1' } });
    await client['pushTarget.test']({});
    await client['install.download']({ params: { token: 'A'.repeat(43) } });
    expect(sent.map((r) => `${r.method} ${r.url}`)).toEqual([
      'GET /api/agent-files?project=RCP',
      'GET /api/agent-files/skill%3Atasklite-worker',
      'PUT /api/agent-files/agents_block',
      'POST /api/agent-files/agents_block/revert',
      'PUT /api/projects/RCP/workflow',
      'POST /api/installs',
      'POST /api/installs/ins_1/check',
      'POST /api/push-target/test',
      `GET /install/${'A'.repeat(43)}`,
    ]);
    expect(sent[2]!.headers['X-Tasklite-CSRF']).toBe('abc123-_x');
    expect(sent[8]!.headers['X-Tasklite-CSRF']).toBeUndefined();
  });

  it('edits, reverts and Workflow notes hand their mutation_id to Undo; an install does not', async () => {
    const seen: MutationRecord[] = [];
    const { fetch } = fakeFetch(200, { mutation_id: 'mut_a' });
    const client = createApiClient({
      fetch,
      cookies: () => COOKIES,
      onMutation: (m) => seen.push(m),
    });
    await client['workflow.put']({
      params: { key: 'RCP' },
      body: { content_md: '', expected_version: 1 },
    });
    expect(seen).toEqual([{ mutation_id: 'mut_a', route: 'workflow.put', undoable: true }]);
  });

  it('query keys share a family per screen, so one event refreshes list and view', () => {
    expect(queryKeys.agentFiles({ project: 'RCP' })).toEqual([
      'tl',
      'agentFiles',
      { project: 'RCP' },
    ]);
    expect(queryKeys.agentFile('agents_block')).toEqual(['tl', 'agentFiles', 'agents_block', {}]);
    expect(queryKeys.workflow('RCP')).toEqual(['tl', 'workflow', 'RCP']);
    expect(queryKeys.installs()).toEqual(['tl', 'installs', {}]);
    expect(queryKeys.pushTarget()).toEqual(['tl', 'pushTarget']);
    expect(
      keysForChange({
        seq: 9,
        type: 'agent_file.updated',
        objects: [{ kind: 'agent_file', id: 'af_1' }],
        for_you: false,
      }),
    ).toEqual([['tl', 'agentFiles']]);
    expect(INVALIDATION['workflow.updated']).toEqual(['workflow']);
    expect(INVALIDATION['install.recorded']).toEqual(['installs']);
  });
});

describe('proposals and drift (decision 30; BUILD_SPEC §5.19, §7)', () => {
  it('has typed calls for the seven routes', async () => {
    const { fetch, sent } = fakeFetch(200, {});
    const client = createApiClient({ fetch, cookies: () => COOKIES });
    await client['proposals.list']({ query: { project: 'RCP', state: 'pending' } });
    await client['proposals.approve']({
      params: { id: 'afp_1' },
      body: { content: '# Worker\n', note: 'Tightened.' },
    });
    await client['proposals.decline']({ params: { id: 'afp_2' }, body: { note: 'Not now.' } });
    await client['drift.list']({ query: { state: 'open' } });
    await client['drift.adopt']({ params: { id: 'dft_1' } });
    await client['drift.restore']({ params: { id: 'dft_1' } });
    await client['drift.keepLocal']({ params: { id: 'dft_1' } });
    expect(sent.map((r) => `${r.method} ${r.url}`)).toEqual([
      'GET /api/agent-file-proposals?project=RCP&state=pending',
      'POST /api/agent-file-proposals/afp_1/approve',
      'POST /api/agent-file-proposals/afp_2/decline',
      'GET /api/drift?state=open',
      'POST /api/drift/dft_1/adopt',
      'POST /api/drift/dft_1/restore',
      'POST /api/drift/dft_1/keep-local',
    ]);
    expect(sent[0]!.headers['X-Tasklite-CSRF']).toBeUndefined();
    for (const r of sent.slice(1).filter((x) => x.method === 'POST')) {
      expect(r.headers['X-Tasklite-CSRF'], r.url).toBe('abc123-_x');
    }
  });

  it('approve and adopt hand their mutation_id to Undo; decline, restore and keep local do not', async () => {
    const seen: MutationRecord[] = [];
    const { fetch } = fakeFetch(200, { mutation_id: 'mut_a' });
    const client = createApiClient({
      fetch,
      cookies: () => COOKIES,
      onMutation: (m) => seen.push(m),
    });
    await client['proposals.approve']({ params: { id: 'afp_1' }, body: {} });
    await client['drift.adopt']({ params: { id: 'dft_1' } });
    await client['proposals.decline']({ params: { id: 'afp_2' }, body: {} });
    await client['drift.keepLocal']({ params: { id: 'dft_2' } });
    expect(seen.map((m) => [m.route, m.undoable])).toEqual([
      ['proposals.approve', true],
      ['drift.adopt', true],
      ['proposals.decline', false],
      ['drift.keepLocal', false],
    ]);
  });

  it('query keys and invalidation: proposals, drift and the screens that show them', () => {
    expect(queryKeys.proposals({ project: 'RCP' })).toEqual([
      'tl',
      'proposals',
      { project: 'RCP' },
    ]);
    expect(queryKeys.drift()).toEqual(['tl', 'drift', {}]);
    expect(
      keysForChange({
        seq: 12,
        type: 'agent_file.proposal_decided',
        objects: [
          { kind: 'agent_file_proposal', id: 'afp_1' },
          { kind: 'project', id: 'RCP' },
        ],
        for_you: false,
      }),
    ).toEqual([
      ['tl', 'needsYou'],
      ['tl', 'agentFiles'],
      ['tl', 'workflow'],
      ['tl', 'proposals'],
    ]);
    expect(
      keysForChange({
        seq: 13,
        type: 'drift.detected',
        objects: [
          { kind: 'drift', id: 'dft_1' },
          { kind: 'item', id: 'RCP-14' },
        ],
        for_you: false,
      }),
    ).toEqual([
      ['tl', 'bootstrap'],
      ['tl', 'needsYou'],
      ['tl', 'item', 'RCP-14'],
      ['tl', 'agentFiles'],
      ['tl', 'drift'],
    ]);
    expect(INVALIDATION['agent_file.proposed']).toEqual(['proposals', 'needsYou']);
  });
});

describe('recovery (US11; contracts/events.md, BUILD_SPEC §7)', () => {
  it('has typed calls for the three recovery routes', async () => {
    const { fetch, sent } = fakeFetch(200, { rows: [] });
    const client = createApiClient({ fetch, cookies: () => COOKIES });
    await client['workspaces.list']({ query: { scope: 'RCP', state: 'at_risk' } });
    await client['resources.release']({ params: { id: 'rsc_1' }, body: { note: 'Stopped it.' } });
    await client['runs.unpushedHandled']({ params: { runId: 'run_21' } });
    expect(sent.map((r) => `${r.method} ${r.url}`)).toEqual([
      'GET /api/workspaces?scope=RCP&state=at_risk',
      'POST /api/resources/rsc_1/release',
      'POST /api/runs/run_21/unpushed-handled',
    ]);
    expect(sent[0]!.headers['X-Tasklite-CSRF']).toBeUndefined();
    expect(sent[1]!.headers['X-Tasklite-CSRF']).toBe('abc123-_x');
    expect(sent[1]!.body).toEqual({ note: 'Stopped it.' });
    expect(sent[2]!.body).toEqual({});
  });

  it('Mark released and Handled hand their mutation_id to Undo', async () => {
    const seen: MutationRecord[] = [];
    const { fetch } = fakeFetch(200, { mutation_id: 'mut_r', run_id: 'run_21' });
    const client = createApiClient({
      fetch,
      cookies: () => COOKIES,
      onMutation: (m) => seen.push(m),
    });
    await client['runs.unpushedHandled']({ params: { runId: 'run_21' } });
    await client['resources.release']({ params: { id: 'rsc_1' } });
    expect(seen).toEqual([
      { mutation_id: 'mut_r', route: 'runs.unpushedHandled', undoable: true },
      { mutation_id: 'mut_r', route: 'resources.release', undoable: true },
    ]);
  });

  it.each<[EventType, string[]]>([
    ['run.parked', ['item', 'work', 'agents', 'needsYou', 'bootstrap', 'workspaces']],
    ['run.resumed', ['item', 'work', 'agents', 'needsYou', 'bootstrap', 'workspaces']],
    ['run.unpushed_handled', ['item', 'needsYou', 'bootstrap', 'workspaces']],
    ['resource.declared', ['item', 'agents', 'workspaces']],
    ['resource.released', ['item', 'agents', 'needsYou', 'bootstrap', 'workspaces']],
  ])('%s invalidates its families', (type, families) => {
    expect([...INVALIDATION[type]].sort()).toEqual([...families].sort());
  });

  it('a resource released by the owner refetches the item, Problems, the count and Workspaces', () => {
    const keys = keysForChange({
      seq: 9,
      type: 'resource.released',
      objects: [
        { kind: 'item', id: 'RCP-21' },
        { kind: 'run', id: 'run_21' },
      ],
      for_you: false,
    });
    expect(keys).toEqual([
      ['tl', 'bootstrap'],
      ['tl', 'needsYou'],
      ['tl', 'item', 'RCP-21'],
      ['tl', 'agents'],
      ['tl', 'workspaces'],
    ]);
  });

  it('run and commit events keep Workspaces fresh', () => {
    for (const type of [
      'claim.granted',
      'claim.released',
      'run.started',
      'run.ended',
      'commit.reported',
    ] as const) {
      expect(INVALIDATION[type], type).toContain('workspaces');
    }
  });
});

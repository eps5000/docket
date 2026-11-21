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
  agentFileParams,
  approveProposalBody,
  createProjectBody,
  createSharedPartBody,
  decideHoldBody,
  decideOverlapBody,
  patchSharedPartBody,
  putItemSharedBody,
  postItemBranchesBody,
  putRadarBody,
  sharedPartsQuery,
  declineProposalBody,
  onboardingQuery,
  onboardingSessionSchema,
  stepDetailsBody,
  stepDetailsResponse,
  projectSchema,
  driftQuery,
  itemDetailResponse,
  needsYouResponse,
  proposalsQuery,
  createInstallBody,
  installTokenParams,
  putAgentFileBody,
  putWorkflowBody,
  revertAgentFileBody,
  decideBody,
  decisionsQuery,
  diagnosticsQuery,
  isMutation,
  problemSchema,
  releaseResourceBody,
  workspacesQuery,
  needsCsrf,
  patchItemBody,
  pathParams,
  routeLabel,
  validationError,
  workQuery,
  type RouteId,
} from '../src/index.js';

/** BUILD_SPEC §7, the clarification routes, the recovery routes (decision 26), the agent setup routes (decision 29), and `/agent-upload` (§5.10). */
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
  'GET /api/settings/agent-token',
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
  'GET /api/workspaces',
  'POST /api/resources/:id/release',
  'POST /api/runs/:runId/unpushed-handled',
  // Agent setup (decision 29; BUILD_SPEC §7; B21).
  'GET /api/agent-files',
  'GET /api/agent-files/:key',
  'PUT /api/agent-files/:key',
  'POST /api/agent-files/:key/revert',
  'GET /api/projects/:key/workflow',
  'PUT /api/projects/:key/workflow',
  'POST /api/installs',
  'GET /api/installs',
  'POST /api/installs/:id/check',
  'GET /api/install-state',
  'GET /api/push-target',
  'POST /api/push-target/test',
  'GET /install/:token',
  // Decision 30 (BUILD_SPEC §7): proposals and drift
  'GET /api/agent-file-proposals',
  'POST /api/agent-file-proposals/:id/approve',
  'POST /api/agent-file-proposals/:id/decline',
  'GET /api/drift',
  'POST /api/drift/:id/adopt',
  'POST /api/drift/:id/restore',
  'POST /api/drift/:id/keep-local',
  // Decision 31 (BUILD_SPEC §7): new project and the onboarding review
  'POST /api/projects',
  'GET /api/onboarding',
  'POST /api/onboarding/:id/reviewed',
  // Decision 36 (B38): shared changes and the conflict radar.
  'GET /api/projects/:key/shared-parts',
  'POST /api/projects/:key/shared-parts',
  'PATCH /api/shared-parts/:id',
  'GET /api/items/:id/shared',
  'PUT /api/items/:id/shared',
  // B40: the owner sets or clears the item's branch for the radar; B41: adds or removes one.
  'POST /api/items/:id/shared/branches',
  'POST /api/overlaps/:id/decide',
  'POST /api/undeclared-holds/:id/decide',
  'POST /api/leases/:id/release',
  'GET /api/projects/:key/radar',
  'PUT /api/projects/:key/radar',
  'POST /api/projects/:key/radar/run',
  // Decision 37 (B42): acknowledging a problem, and the owner's choice on a proposed resolution
  'POST /api/problems/acknowledge',
  'POST /api/resolutions/:id/decide',
  // Decision 38 (B44): acknowledging agents' project decisions on Needs you
  'POST /api/decisions/acknowledge',
  // Decision 33 (BUILD_SPEC §7; UI_SPEC §6.3.1a): the step dialog's details editor
  'PATCH /api/items/:id/work/:stepId/details',
  // Decision 33 (B34): the step dialog's contents
  'GET /api/items/:id/work/:stepId',
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
  it('has every BUILD_SPEC §7 route, the clarification, recovery, agent setup, proposals and drift, onboarding, shared changes, problem and decision-review routes and /agent-upload, once each', () => {
    const labels = ROUTE_IDS.map((id) => routeLabel(API_ROUTES[id]));
    expect(new Set(labels).size).toBe(labels.length);
    expect([...labels].sort()).toEqual([...EXPECTED].sort());
    expect(labels).toHaveLength(94);
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

  it('auth: unlock has none, /agent-upload the bearer token, /install/:token its token, everything else the session', () => {
    for (const id of ROUTE_IDS) {
      const r = API_ROUTES[id];
      const expected =
        r.path === '/api/session/unlock'
          ? 'none'
          : r.path === '/agent-upload'
            ? 'bearer'
            : r.path === '/install/:token'
              ? 'token'
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
  it('agent files: a key is agents_block or skill:<name>; a project layer needs a project, service takes none', () => {
    const key = (v: string) => agentFileParams.safeParse({ key: v }).success;
    expect(key('agents_block')).toBe(true);
    expect(key('skill:docket-worker')).toBe(true);
    for (const bad of ['readme', 'skill:', 'skill:Worker', `skill:${'a'.repeat(61)}`]) {
      expect(key(bad), bad).toBe(false);
    }
    const put = { content: '# Worker\n', expected_version: 0 };
    expect(putAgentFileBody.safeParse({ ...put, layer: 'service' }).success).toBe(true);
    expect(putAgentFileBody.safeParse({ ...put, layer: 'project', project: 'RCP' }).success).toBe(
      true,
    );
    expect(putAgentFileBody.safeParse({ ...put, layer: 'project' }).success).toBe(false);
    expect(putAgentFileBody.safeParse({ ...put, layer: 'service', project: 'RCP' }).success).toBe(
      false,
    );
    expect(putAgentFileBody.safeParse({ ...put, layer: 'bundled' }).success).toBe(false);
    expect(putAgentFileBody.safeParse({ ...put, layer: 'service', content: '' }).success).toBe(
      false,
    );
    expect(
      putAgentFileBody.safeParse({ ...put, layer: 'service', content: 'x'.repeat(50_001) }).success,
    ).toBe(false);
    // Content is kept exactly as written: not trimmed.
    expect(putAgentFileBody.parse({ ...put, layer: 'service', content: ' x \n' }).content).toBe(
      ' x \n',
    );
    expect(revertAgentFileBody.safeParse({ layer: 'project' }).success).toBe(false);
    for (const id of ['agentFiles.put', 'agentFiles.revert', 'workflow.put'] as const) {
      expect(API_ROUTES[id].undoable, id).toBe(true);
    }
  });

  it('workflow notes: 0–10,000 characters, so an empty version clears them', () => {
    expect(putWorkflowBody.safeParse({ content_md: '', expected_version: 3 }).success).toBe(true);
    expect(
      putWorkflowBody.safeParse({ content_md: 'x'.repeat(10_000), expected_version: 0 }).success,
    ).toBe(true);
    expect(
      putWorkflowBody.safeParse({ content_md: 'x'.repeat(10_001), expected_version: 0 }).success,
    ).toBe(false);
    expect(putWorkflowBody.safeParse({ content_md: 'x' }).success).toBe(false);
  });

  it('installs: push needs a path; the token is 43 base64url characters', () => {
    const base = { client: 'codex', target_kind: 'user', method: 'command' } as const;
    expect(createInstallBody.safeParse(base).success).toBe(true);
    expect(createInstallBody.safeParse({ ...base, method: 'push' }).success).toBe(false);
    expect(
      createInstallBody.safeParse({ ...base, method: 'push', path: 'C:/Users/me/code/recipes' })
        .success,
    ).toBe(true);
    expect(createInstallBody.safeParse({ ...base, client: 'cursor' }).success).toBe(false);
    expect(installTokenParams.safeParse({ token: 'A'.repeat(43) }).success).toBe(true);
    expect(installTokenParams.safeParse({ token: `${'a'.repeat(41)}-_` }).success).toBe(true);
    for (const bad of ['A'.repeat(42), 'A'.repeat(44), `${'A'.repeat(42)}=`]) {
      expect(installTokenParams.safeParse({ token: bad }).success, bad).toBe(false);
    }
    expect(API_ROUTES['install.download'].response.kind).toBe('file');
    expect(API_ROUTES['installs.create'].undoable).toBe(false);
  });

  it('proposals and drift (decision 30): filters, decision bodies, and which actions are undoable', () => {
    expect(proposalsQuery.safeParse({}).success).toBe(true);
    expect(proposalsQuery.safeParse({ project: 'RCP', state: 'pending' }).success).toBe(true);
    expect(proposalsQuery.safeParse({ state: 'open' }).success).toBe(false);
    expect(driftQuery.safeParse({ project: 'RCP', state: 'kept_local' }).success).toBe(true);
    expect(driftQuery.safeParse({ state: 'pending' }).success).toBe(false);
    expect(approveProposalBody.safeParse({}).success).toBe(true);
    const content = '  edited by the owner\n';
    expect(approveProposalBody.parse({ content, note: 'Tightened.' }).content).toBe(content);
    expect(approveProposalBody.safeParse({ content: 'x'.repeat(50_001) }).success).toBe(false);
    expect(approveProposalBody.safeParse({ note: 'n'.repeat(501) }).success).toBe(false);
    expect(declineProposalBody.safeParse({ note: 'Not this way.' }).success).toBe(true);
    expect(declineProposalBody.safeParse({ content: 'x' }).success).toBe(false);
    const undoable = (id: RouteId) => API_ROUTES[id].undoable;
    expect(undoable('proposals.approve')).toBe(true);
    expect(undoable('drift.adopt')).toBe(true);
    expect(undoable('proposals.decline')).toBe(false);
    expect(undoable('drift.restore')).toBe(false);
    expect(undoable('drift.keepLocal')).toBe(false);
  });

  it('existing responses gain optional decision 30 fields (needs-you count, drift problem, run instructions)', () => {
    expect(problemSchema.shape.kind.options).toContain('agent_files_drift');
    expect(problemSchema.shape.drift_id.safeParse(undefined).success).toBe(true);
    expect(needsYouResponse.shape.agent_file_proposals.safeParse(undefined).success).toBe(true);
    expect(itemDetailResponse.shape.run_instructions.safeParse(undefined).success).toBe(true);
    expect(
      itemDetailResponse.shape.run_instructions.safeParse([
        {
          run_id: 'run_1',
          install_id: 'ins_1',
          files: [
            {
              key: 'skill:docket-worker',
              name: 'docket-worker',
              source: 'project',
              version_no: 2,
              edited_locally: true,
              drift_id: 'dft_1',
            },
          ],
        },
      ]).success,
    ).toBe(true);
  });

  it('new project and onboarding (decision 31): bodies, filters, and nothing undoable', () => {
    const body = { key: 'GF', name: 'Gameflow' };
    expect(createProjectBody.safeParse(body).success).toBe(true);
    expect(
      createProjectBody.safeParse({ ...body, color: '#2b8a3e', default_satisfied_when: 'merged' })
        .success,
    ).toBe(true);
    expect(createProjectBody.safeParse({ key: 'GF' }).success).toBe(false);
    expect(createProjectBody.safeParse({ ...body, key: 'gf' }).success).toBe(false);
    expect(createProjectBody.safeParse({ ...body, name: 'x'.repeat(101) }).success).toBe(false);
    expect(createProjectBody.safeParse({ ...body, color: 'green' }).success).toBe(false);
    expect(
      createProjectBody.safeParse({ ...body, default_satisfied_when: 'shipped' }).success,
    ).toBe(false);
    expect(onboardingQuery.safeParse({}).success).toBe(true);
    expect(onboardingQuery.safeParse({ project: 'GF', state: 'ready_for_review' }).success).toBe(
      true,
    );
    expect(onboardingQuery.safeParse({ state: 'pending' }).success).toBe(false);
    expect(API_ROUTES['projects.create'].undoable).toBe(false);
    expect(API_ROUTES['projects.create'].group).toBe('settings');
    expect(API_ROUTES['onboarding.reviewed'].undoable).toBe(false);
  });

  it('step details (decision 33): details ≤ 10,000 or null, expected_version required, undoable', () => {
    expect(stepDetailsBody.safeParse({ details: '## Notes', expected_version: 0 }).success).toBe(
      true,
    );
    expect(stepDetailsBody.safeParse({ details: null, expected_version: 3 }).success).toBe(true);
    expect(
      stepDetailsBody.safeParse({ details: 'x'.repeat(10_000), expected_version: 1 }).success,
    ).toBe(true);
    expect(
      stepDetailsBody.safeParse({ details: 'x'.repeat(10_001), expected_version: 1 }).success,
    ).toBe(false);
    expect(stepDetailsBody.safeParse({ details: 'x' }).success).toBe(false);
    expect(stepDetailsBody.safeParse({ expected_version: 1 }).success).toBe(false);
    expect(
      stepDetailsBody.safeParse({ details: 'x', expected_version: 1, source: 'GF-1' }).success,
    ).toBe(false);
    const route = API_ROUTES['steps.details'];
    expect([route.method, route.group, route.undoable]).toEqual(['PATCH', 'steer', true]);
    expect(Object.keys(stepDetailsResponse.shape)).toEqual(
      expect.arrayContaining(['mutation_id', 'step']),
    );
  });

  it('existing responses gain optional decision 31 fields (onboarding reviews, created_by)', () => {
    expect(needsYouResponse.shape.onboarding_reviews.safeParse(undefined).success).toBe(true);
    const session = {
      id: 'onb_1',
      project: 'GF',
      project_name: 'Gameflow',
      started_by: 'claude · orca-w3',
      run_id: null,
      state: 'ready_for_review',
      summary: 'Created 12 items in Planning.',
      questions: ['Is the editor in scope?'],
      changes: { created: 12, enriched: 7, documents: 3, decisions: 2, proposals: 1 },
      workflow_proposal_id: 'afp_1',
      started_at: '2026-11-18T10:00:00Z',
      finished_at: '2026-11-18T10:40:00Z',
      reviewed_at: null,
    };
    expect(onboardingSessionSchema.safeParse(session).success).toBe(true);
    expect(needsYouResponse.shape.onboarding_reviews.safeParse([session]).success).toBe(true);
    const project = {
      key: 'GF',
      name: 'Gameflow',
      short_name: 'Gameflow',
      color: '#2b8a3e',
      default_satisfied_when: 'done',
      version: 1,
    };
    expect(projectSchema.safeParse(project).success).toBe(true);
    expect(projectSchema.safeParse({ ...project, created_by: null }).success).toBe(true);
    expect(projectSchema.safeParse({ ...project, created_by: 'claude · orca-w3' }).success).toBe(
      true,
    );
  });

  it('recovery: workspaces filter by scope and one state; release takes an optional note ≤ 500', () => {
    expect(workspacesQuery.parse({})).toEqual({ scope: 'all' });
    expect(workspacesQuery.parse({ scope: 'RCP', state: 'at_risk' })).toEqual({
      scope: 'RCP',
      state: 'at_risk',
    });
    expect(workspacesQuery.safeParse({ state: 'pruned' }).success).toBe(false);
    expect(releaseResourceBody.parse({})).toEqual({});
    expect(releaseResourceBody.parse({ note: 'Stopped it.' })).toEqual({ note: 'Stopped it.' });
    expect(releaseResourceBody.safeParse({ note: 'x'.repeat(501) }).success).toBe(false);
    expect(API_ROUTES['resources.release'].undoable).toBe(true);
    expect(API_ROUTES['runs.unpushedHandled'].undoable).toBe(true);
  });

  it('recovery problems name the run and the resources their actions need', () => {
    const row = {
      kind: 'orphaned_resources',
      item_id: 'RCP-21',
      title: 'Unit conversion table',
      reason: "RCP-21's run ended 03:12 but left: dev server :5173",
      related: [],
      link_id: null,
      run_id: 'run_21',
      resource_ids: ['rsc_1'],
    };
    expect(problemSchema.parse(row)).toEqual(row);
    for (const kind of ['unpushed_work', 'parked_too_long', 'resume_unattended']) {
      expect(problemSchema.safeParse({ ...row, kind }).success, kind).toBe(true);
    }
  });

  it('PATCH /api/items/:id needs expected_version and at least one change', () => {
    expect(patchItemBody.safeParse({ expected_version: 3 }).success).toBe(false);
    expect(patchItemBody.safeParse({ title: 'x' }).success).toBe(false);
    expect(patchItemBody.safeParse({ expected_version: 3, title: 'New title' }).success).toBe(true);
    expect(patchItemBody.safeParse({ expected_version: 3, status: 'done' }).success).toBe(false);
    expect(patchItemBody.safeParse({ expected_version: 3, title: 't'.repeat(201) }).success).toBe(
      false,
    );
  });

  it('review verdicts: changes needs a note and into; approve takes an optional note', () => {
    const ok = (v: object) => decideBody.safeParse({ round: 1, verdicts: [v] }).success;
    expect(ok({ hr_item_id: 'hr_a', kind: 'approve' })).toBe(true);
    // Owner decision 35: approve with a note, kept for the item, the epic or the project.
    expect(ok({ hr_item_id: 'hr_a', kind: 'approve', note: 'x' })).toBe(true);
    for (const keep of ['item', 'epic', 'project']) {
      expect(ok({ hr_item_id: 'hr_a', kind: 'approve', note: 'x', keep })).toBe(true);
    }
    expect(ok({ hr_item_id: 'hr_a', kind: 'approve', note: 'x', keep: 'label' })).toBe(false);
    expect(ok({ hr_item_id: 'hr_a', kind: 'approve', keep: 'epic' })).toBe(false);
    expect(ok({ hr_item_id: 'hr_a', kind: 'approve', note: 'n'.repeat(4_001) })).toBe(false);
    expect(ok({ hr_item_id: 'hr_a', kind: 'defer', note: 'x', keep: 'project' })).toBe(false);
    expect(ok({ hr_item_id: 'hr_a', kind: 'changes', note: 'x', into: 'bug', keep: 'item' })).toBe(
      false,
    );
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
    expect(workQuery.parse({})).toEqual({ scope: 'all', layout: 'board' });
  });

  it('shared changes (decision 36): bodies, normalised keys, the Ready override, what is undoable', () => {
    const part = createSharedPartBody.parse({
      key: 'Table: Decks',
      paths: ['./db/migrations/**'],
      single_writer: true,
    });
    expect(part).toMatchObject({ key: 'table:decks', paths: ['db/migrations/**'] });
    expect(createSharedPartBody.safeParse({ key: 'table:decks', kind: 'model' }).success).toBe(
      false,
    );
    expect(createSharedPartBody.safeParse({ key: 'decks' }).success).toBe(false);
    expect(patchSharedPartBody.safeParse({ expected_version: 1, archived: true }).success).toBe(
      true,
    );
    expect(patchSharedPartBody.safeParse({ expected_version: 1, note: null }).success).toBe(true);
    expect(patchSharedPartBody.safeParse({ expected_version: 1 }).success).toBe(false);
    expect(patchSharedPartBody.safeParse({ expected_version: 1, key: 'model:X' }).success).toBe(
      false,
    );
    expect(sharedPartsQuery.parse({ include_archived: 'true' })).toEqual({
      include_archived: true,
    });
    // The owner's declaration: the agent rules, and new parts may be single-writer.
    expect(putItemSharedBody.safeParse({ none: true }).success).toBe(true);
    expect(
      putItemSharedBody.safeParse({
        changes: [{ part: 'model:Token', change: 'change' }],
        new_parts: [{ key: 'model:Token', single_writer: true }],
      }).success,
    ).toBe(true);
    expect(putItemSharedBody.safeParse({}).success).toBe(false);
    expect(
      decideOverlapBody.safeParse({ decision: 'compatible', note: 'Disjoint fields' }).success,
    ).toBe(true);
    expect(decideOverlapBody.safeParse({ decision: 'sequence' }).success).toBe(true);
    expect(decideOverlapBody.safeParse({ decision: 'sequence', note: 'x' }).success).toBe(false);
    expect(decideOverlapBody.safeParse({ decision: 'merge' }).success).toBe(false);
    expect(decideHoldBody.safeParse({ decision: 'add' }).success).toBe(true);
    expect(decideHoldBody.safeParse({ decision: 'send_back', note: 'Split it' }).success).toBe(
      true,
    );
    expect(putRadarBody.safeParse({ repo_path: null }).success).toBe(true);
    expect(putRadarBody.safeParse({ repo_path: 'gameflow', main_branch: 'develop' }).success).toBe(
      true,
    );
    expect(putRadarBody.safeParse({}).success).toBe(false);
    // The Ready gate's owner override (BUILD_SPEC §5.21).
    expect(
      patchItemBody.safeParse({
        expected_version: 3,
        status: 'ready',
        override_reason: 'Docs only',
      }).success,
    ).toBe(true);
    expect(
      patchItemBody.safeParse({ expected_version: 3, priority: 1, override_reason: 'x' }).success,
    ).toBe(false);
    // B41: the owner adds or removes one of the item's branches for the radar, undoable.
    for (const op of ['add', 'remove']) {
      expect(
        postItemBranchesBody.safeParse({ op, branch: 'eps5000/gf-239-visual-shell' }).success,
      ).toBe(true);
    }
    expect(postItemBranchesBody.safeParse({ op: 'add' }).success).toBe(false);
    expect(postItemBranchesBody.safeParse({ op: 'set', branch: 'a' }).success).toBe(false);
    expect(postItemBranchesBody.safeParse({ op: 'add', branch: null }).success).toBe(false);
    expect(postItemBranchesBody.safeParse({ op: 'add', branch: 'x'.repeat(201) }).success).toBe(
      false,
    );
    const undoable = [
      'sharedParts.create',
      'sharedParts.update',
      'itemShared.put',
      'itemShared.branches',
    ] as const;
    for (const id of ROUTE_IDS.filter((r) => API_ROUTES[r].group === 'shared')) {
      expect(API_ROUTES[id].undoable, id).toBe((undoable as readonly string[]).includes(id));
    }
  });
});

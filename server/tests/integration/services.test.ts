/**
 * The domain service contracts and the adapters' wiring (tasks.md T047–T048):
 * - every service method starts as a stub that throws `NotImplementedError`;
 * - the MCP tools and the API routes reach the domain only through the
 *   services declared in domain/contracts.ts;
 * - implementing a service is all a slice needs: the tool and the route
 *   answer with its result, checked against their output schemas.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ItemSummary } from '@docket/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { NotImplementedError, type Services } from '../../src/domain/contracts.js';
import { createServices } from '../../src/domain/services.js';
import { expectOk, startHarness, type ContractHarness } from '../contract/harness.js';
import { createTestServer, parseSetCookies, type TestServer } from './harness.js';

const SRC = fileURLToPath(new URL('../../src/', import.meta.url));

const ITEM: ItemSummary = {
  id: 'RCP-1',
  project: 'RCP',
  type: 'Implementation',
  title: 'Pantry inventory schema',
  status: 'inbox',
  priority: 2,
  epic: null,
  epic_title: null,
  labels: [],
  blocked: false,
  blocked_by: [],
  unblocks: 0,
  lead: null,
  human_review: { declared: 0, ready: 0, approved: 0, deferred: 0 },
  planned_start: null,
  planned_end: null,
  effort: null,
  archived: false,
  jira_key: null,
  version: 1,
  updated_at: '2026-11-14T12:00:00.000Z',
};

describe('the service stubs', () => {
  const services = createServices({
    config: {} as never,
    secrets: {} as never,
    callLog: {} as never,
    clock: () => new Date(),
    log: () => {},
  });

  const methods = Object.entries(services).flatMap(([service, impl]) =>
    Object.keys(impl as object).map((method) => [service, method] as const),
  );

  it('cover every service T047 lists, plus diagnostics, recovery (T055), agent files and installs (T150), proposals and drift (T159), onboarding (T163), shared changes (T182), problems (T186), and undo', () => {
    expect(Object.keys(services).sort()).toEqual(
      [
        'agentFiles',
        'agentProposals',
        'archive',
        'backup',
        'checklist',
        'context',
        'decisions',
        'diagnostics',
        'digest',
        'documents',
        'drift',
        'evidence',
        'forecast',
        'humanReview',
        'items',
        'installs',
        'jiraImport',
        'links',
        'messages',
        'onboarding',
        'packets',
        'problems',
        'projects',
        'recovery',
        'reviewDecisions',
        'runs',
        'search',
        'sharedChanges',
        'subgraph',
        'sync',
        'undo',
        'usage',
        'views',
      ].sort(),
    );
  });

  /** Implemented already: undo (B2), US1's methods (B7, tasks.md T070–T075) and US2's read models (B8, T080, T084), US3's review services (B9), US11's recovery (B10, T099–T100), US4's links (B11, T106), US5's decisions and context (B12, T114), US6's steering (B13, T120) US7's planning, archive and documents (B14, T124–T125) US8's timeline, burn-down and forecast (B16, T136) US9's Jira import (B17, T140–T141) and US13's agent files and Workflow notes (B23, T153, T157). */
  const IMPLEMENTED: Record<string, readonly string[]> = {
    undo: ['undo'],
    // Decision 49 (B62).
    sync: ['source', 'ingest', 'github', 'setGithub', 'setGithubProject', 'itemGithub'],
    items: [
      'create',
      'update',
      'setStatus',
      'get',
      // US7 (B14, T125).
      'ownerPatch',
      'upsertLabel',
      'moveLabelToReady',
      // Decision 48 (B61).
      'split',
    ],
    runs: [
      'claim',
      'release',
      'startRun',
      'heartbeat',
      'finish',
      'recordSignal',
      'pausedParkNote',
      'expireLeases',
      'keepOpenRuns',
      'endSilentChildren',
      'openRunSessions',
      // Decision 42 (B50).
      'updateStatus',
      'recordActivity',
      'refreshActivity',
      'expireProducerHolds',
      // Decision 44 (B53).
      'expireCoordinatorParks',
      // US11 (B10, T099).
      'updateResources',
      'park',
      'resume',
      // US6 (B13, T120).
      'ownerRelease',
      'ownerHandoffEpic',
      'returnToReady',
    ],
    checklist: [
      'setPlan',
      'updateStep',
      'logSubagent',
      'setChecks',
      'updateCheck',
      // US6 (B13, T120).
      'ownerAddStep',
      'ownerRemoveStep',
      'ownerAddCheck',
      'ownerRemoveCheck',
      // Decision 33 (B33, T170): get_step and the step dialog's details editor.
      'getStep',
      'ownerGetStep',
      'ownerSetStepDetails',
    ],
    evidence: ['addNote', 'linkArtifact', 'reportCommit'],
    search: ['whoami', 'listProjects', 'searchItems', 'getChanges', 'palette'],
    digest: ['get'],
    // Decision 37 (B42): findProblem and itemProblems.
    views: [
      'bootstrap',
      'needsYou',
      'overview',
      'overviewItems',
      'brief',
      'work',
      'itemDetail',
      'agents',
      'settings',
      'labelPage',
      'findProblem',
      'itemProblems',
    ],
    // Decision 37 (B42, T186–T188).
    problems: ['acknowledge', 'propose', 'decide'],
    // US3 (B9, T091–T093), and the delivery receipt agreed for B9.
    humanReview: ['declare', 'update', 'ownerAdd', 'ownerUpdate', 'ownerRemove'],
    packets: ['submit', 'getReview', 'deferredReviews', 'screen', 'refresh', 'markStale'],
    reviewDecisions: ['decide', 'createFollowUp'],
    messages: ['markDelivered', 'askOwner', 'answer', 'addOwnerNote', 'withdraw'],
    // US11 (B10, T100).
    recovery: [
      'report',
      'workspaceStates',
      'itemResume',
      'workspaces',
      'worktreeCleanup',
      'ownerReleaseResource',
      'markUnpushedHandled',
    ],
    // US4 (B11, T106).
    links: ['link', 'unlink', 'blockState'],
    subgraph: ['dependencySubgraph', 'cycles', 'criticalPath', 'pickEpic'],
    // US4 (B11, T106) and US10 (B15, T130–T131).
    // US15 (B30, T164): create.
    projects: [
      'setDefaultSatisfiedWhen',
      'delete',
      'removeDeletedDocs',
      'create',
      'pause',
      'resume',
    ],
    backup: ['status', 'trouble', 'runNow'],
    diagnostics: ['calls'],
    // US5 (B12, T114).
    decisions: ['publish', 'list', 'withdraw', 'confirm', 'acknowledge'],
    context: ['getContext'],
    // US7 (B14, T124–T125).
    documents: ['put', 'stage', 'commitUpload', 'content'],
    archive: ['archive', 'unarchive', 'archiveMany', 'cancel', 'settleIdle'],
    // US8 (B16, T136).
    forecast: ['timeline', 'burndown', 'forecast'],
    // US9 (B17, T140–T141).
    jiraImport: ['dryRun', 'get', 'commit', 'cancel'],
    // US13 (B23, T153, T157): agent files and Workflow notes.
    agentFiles: ['syncBundled', 'list', 'get', 'put', 'revert', 'workflow', 'putWorkflow'],
    // US13 (B24, T155, T156): install and check.
    installs: [
      'prepare',
      'record',
      'list',
      'check',
      'bundleForToken',
      'markDownloaded',
      'pushTarget',
      'testPushTarget',
      // Decision 34 (B36, T175): install state.
      'state',
      // Decision 50 (B64): every project's state, uninstall, and marking a legacy install removed.
      'overview',
      'issueUninstall',
      'uninstallBundle',
      'markUninstallDownloaded',
      'recordUninstall',
      'markRemoved',
      // Decision 56 (B72): a project pulling its own update.
      'prepareUpdate',
      'recordUpdate',
      'updateBundle',
      'updateNoticeFor',
      'landedUpdates',
      'confirmLanded',
    ],
    // US14 (B27a, T160): proposals.
    agentProposals: ['files', 'propose', 'list', 'approve', 'decline'],
    // US14 (B27b, T161): drift.
    drift: [
      'recordReport',
      'checkPushInstalls',
      'recordChecks',
      'list',
      'adopt',
      'restorePrepare',
      'restoreRecord',
      'keepLocal',
      // Decision 50 (B64).
      'closeForRemovedInstall',
    ],
    // Decision 48 (B63): token use.
    usage: ['summary', 'item', 'settings', 'setSettings', 'syncConfig', 'ingest'],
    // US15 (B30, T164): onboarding.
    onboarding: ['start', 'finish', 'guide', 'list', 'markReviewed'],
    // Decision 36 (B38, T182; B39, T183–T184; B40, B41: the owner's branches): all of it.
    sharedChanges: [
      'declare',
      'listParts',
      'ownerList',
      'ownerCreate',
      'ownerUpdate',
      'itemShared',
      'ownerDeclare',
      'ownerBranches',
      'radar',
      'renewLease',
      'takeLease',
      'releaseLease',
      'ownerReleaseLease',
      'decideOverlap',
      'overruleOverlap',
      'decideDesignReview',
      'overlapHandling',
      'setOverlapHandling',
      'decideHold',
      'contextFor',
      'setRadar',
      'planRadar',
      'recordRadar',
      'finishRadar',
      'runRadar',
      'radarRunning',
      'stopRadar',
    ],
  };

  it.each(methods)('%s.%s throws NotImplementedError until its slice implements it', (s, m) => {
    if (IMPLEMENTED[s]?.includes(m)) return;
    const fn = (services[s as keyof Services] as unknown as Record<string, () => unknown>)[m]!;
    let thrown: unknown;
    try {
      fn();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(NotImplementedError);
    expect((thrown as NotImplementedError).operation).toBe(`${s}.${m}`);
    expect((thrown as NotImplementedError).code).toBe('unavailable');
  });
});

describe('adapters reach the domain only through contracts.ts', () => {
  const groupFiles = (dir: string) =>
    readdirSync(join(SRC, dir))
      .filter((f) => f.endsWith('.ts'))
      .map((f) => [`${dir}/${f}`, readFileSync(join(SRC, dir, f), 'utf8')] as const);

  it.each([...groupFiles('mcp/tools'), ...groupFiles('api/routes')])(
    '%s imports no domain module (it calls ctx.services)',
    (_name, source) => {
      expect(source).not.toMatch(/from '(\.\.\/)+domain\//);
    },
  );

  it.each([
    ['mcp/register.ts', readFileSync(join(SRC, 'mcp/register.ts'), 'utf8')],
    ['api/define.ts', readFileSync(join(SRC, 'api/define.ts'), 'utf8')],
  ])('%s imports only contracts, the write path and IDs from the domain', (_name, source) => {
    const imports = [...source.matchAll(/from '\.\.\/domain\/([\w-]+)\.js'/g)].map((m) => m[1]);
    for (const mod of imports) expect(['contracts', 'write', 'ids']).toContain(mod);
  });
});

describe('implementing a service is all a slice needs', () => {
  let s: TestServer | undefined;
  let h: ContractHarness | undefined;
  afterEach(async () => {
    await s?.cleanup();
    await h?.close();
    s = undefined;
    h = undefined;
  });

  async function unlock(server: TestServer) {
    const res = await server.request('/api/session/unlock', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: server.runtime.secrets.ownerKey() }),
    });
    const c = parseSetCookies(res);
    return {
      cookie: `docket_owner=${c.docket_owner!.value}; docket_csrf=${c.docket_csrf!.value}`,
      csrf: c.docket_csrf!.value,
    };
  }

  it('POST /api/items answers with the service result and the mutation ID', async () => {
    let received: unknown;
    s = createTestServer({
      services: {
        items: {
          create: (w, input) => {
            received = { actor: w.actor.kind, input };
            w.event({ type: 'item.created', summary: 'Created RCP-1', project_key: 'RCP' });
            return ITEM;
          },
        },
      },
    });
    const { cookie, csrf } = await unlock(s);
    const res = await s.request('/api/items', {
      method: 'POST',
      headers: { cookie, 'x-docket-csrf': csrf, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Pantry inventory schema', type: 'Story', project: 'RCP' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mutation_id: string; item: ItemSummary };
    expect(body.item).toEqual(ITEM);
    expect(body.mutation_id).toMatch(/^mut_/);
    // Quick capture maps onto items.create, as the owner, in Inbox.
    expect(received).toEqual({
      actor: 'owner',
      input: {
        project: 'RCP',
        type: 'Story',
        title: 'Pantry inventory schema',
        priority: 2,
        status: 'inbox',
        epic: undefined,
        description_md: undefined,
      },
    });
  });

  it('a result that breaks the response schema is a 500 internal, never sent as is', async () => {
    s = createTestServer({
      services: { views: { settings: () => ({ projects: 'oops' }) as never } },
    });
    const { cookie } = await unlock(s);
    const res = await s.request('/api/settings', { headers: { cookie } });
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('internal');
  });

  it('the whoami tool answers with the search service result', async () => {
    const whoami = {
      client: 'claude',
      session_id: 'mcp_1',
      server_version: '0.0.0',
      server_time: '2026-11-06T11:00:00.000Z',
      limits: { page_max: 50, changes_max: 200, document_mcp_bytes: 1, text_limits: {} },
      live_window_s: 120,
      stale_after_s: 1800,
      lease_s: 3600,
    };
    let caller: unknown;
    h = await startHarness({
      seed: false,
      services: {
        search: {
          whoami: (r, input) => {
            caller = { kind: r.actor.kind, client: r.actor.client, input: input.client };
            return whoami;
          },
        },
      },
    });
    const { structured } = expectOk(await h.call('whoami'));
    expect(structured).toEqual(whoami);
    expect(caller).toEqual({ kind: 'agent', client: 'claude', input: 'claude' });
  });
});

/**
 * The optional GitHub connection (owner decision 49; BUILD_SPEC §5.35): exact
 * key matching, PRs that mention several tickets, the naming rule, idempotent
 * ingest, every status, and Docket working with no connection at all. Nothing
 * here reaches GitHub: records are posted the way the collector posts them.
 */
import type { GithubPrRecord, SyncIngestBody } from '@docket/shared';
import { afterEach, describe, expect, it } from 'vitest';
import {
  branchNamesKey,
  isExemptBranch,
  keysInBranch,
  suggestedBranch,
  suggestedName,
} from '../../src/domain/git-naming.js';
import { linksFor } from '../../src/domain/sync.js';
import { OWNER_ACTOR, type Actor } from '../../src/domain/write.js';
import { createTestServer, PROTECTED_MODE, type TestServer } from '../integration/harness.js';
import { addProject, forceStatus, minutes, startDomain, type Domain } from '../us1-helpers.js';

const REPO = 'acme/web-app';
const RUN = { ok: true, interval_ms: 300_000 };

let d: Domain;
let agent: Actor;
let s: TestServer | undefined;

afterEach(async () => {
  await d?.cleanup();
  await s?.cleanup();
  s = undefined;
});

function start(connect = true) {
  d = startDomain({ seed: false });
  addProject(d, 'GF');
  addProject(d, 'OT');
  agent = d.agent('claude', { label: 'w1' });
  if (connect) {
    d.write(OWNER_ACTOR, (w, svc) => svc.sync.setGithub(w, { enabled: true }));
    setProject('GF', { github_repo: REPO });
  }
}

function setProject(
  key: string,
  over: Partial<{
    github_repo: string | null;
    branch_rule: 'off' | 'warn';
    branch_exempt: string[];
  }>,
) {
  const current = d.services.sync.github(d.read()).projects.find((p) => p.key === key)!;
  d.write(OWNER_ACTOR, (w, svc) =>
    svc.sync.setGithubProject(w, {
      key,
      github_repo: current.github_repo,
      branch_rule: current.branch_rule,
      branch_exempt: current.branch_exempt,
      ...over,
    }),
  );
}

const ticket = (title: string, project = 'GF') =>
  d.write(OWNER_ACTOR, (w, svc) =>
    svc.items.create(w, { project, type: 'Task', title, priority: 2, status: 'planning' }),
  ).id;

const pr = (number: number, over: Partial<GithubPrRecord> = {}): GithubPrRecord => ({
  key: `${REPO}#${number}`,
  kind: 'pr',
  repo: REPO,
  number,
  title: `Change ${number}`,
  head_branch: `dev/change-${number}`,
  state: 'open',
  draft: false,
  head_sha: 'a'.repeat(40),
  merged_at: null,
  ci: 'passed',
  opened_at: d.clock.now().toISOString(),
  remote_updated_at: d.clock.now().toISOString(),
  related_keys: [],
  ...over,
});

const ingest = (records: unknown[], run: SyncIngestBody['run'] = RUN) =>
  d.services.sync.ingest(d.server.runtime.write, 'github', {
    records: records as SyncIngestBody['records'],
    run,
  });
const panel = (id: string) => d.services.sync.itemGithub(d.read(), id);
const syncEvents = () =>
  d.rows<{ seq: number }>(`SELECT seq FROM events WHERE type = 'sync.ingested'`).length;
const state = () => d.services.sync.github(d.read()).state;

describe('finding the ticket key in a branch', () => {
  it('matches whole keys only', () => {
    expect(keysInBranch('dev/GF-243-fix-login')).toEqual(['GF-243']);
    expect(branchNamesKey('dev/GF-2430-other', ['GF-243'])).toBe(false);
    expect(branchNamesKey('dev/XGF-243-other', ['GF-243'])).toBe(false);
    expect(branchNamesKey('dev/gf-243-lower-case', ['GF-243'])).toBe(true);
  });

  it('never reads the owner segment as a key', () => {
    expect(keysInBranch('gf-243/fix-login')).toEqual([]);
    expect(keysInBranch('GF-243-no-owner')).toEqual(['GF-243']);
  });

  it('matches exemption patterns', () => {
    const patterns = ['mergify/*', 'main', '*docket-agent-files*'];
    expect(isExemptBranch('mergify/merge-queue/abc', patterns)).toBe(true);
    expect(isExemptBranch('main', patterns)).toBe(true);
    expect(isExemptBranch('dev/docket-agent-files-update', patterns)).toBe(true);
    expect(isExemptBranch('dev/main-menu', patterns)).toBe(false);
  });

  it('suggests a short branch and worktree name', () => {
    expect(suggestedName('GF-243', 'Fix the Login Page for new users today')).toBe(
      'GF-243-fix-the-login-page-for',
    );
    expect(suggestedBranch('GF-243', '!!!')).toBe('<owner>/GF-243');
  });
});

describe('primary and related links', () => {
  const lookup = (key: string) => (['GF-1', 'GF-2', 'GF-3'].includes(key) ? key : undefined);

  it('makes the one ticket in the branch primary', () => {
    expect(linksFor({ head_branch: 'dev/GF-1-x', related_keys: ['GF-2'] }, lookup)).toEqual({
      primary: 'GF-1',
      related: ['GF-2'],
    });
  });

  it('never makes a PR primary for every ticket it names', () => {
    expect(linksFor({ head_branch: 'dev/x', related_keys: ['GF-1', 'GF-2'] }, lookup)).toEqual({
      primary: null,
      related: ['GF-1', 'GF-2'],
    });
    expect(linksFor({ head_branch: 'dev/GF-1-and-GF-2', related_keys: [] }, lookup)).toEqual({
      primary: null,
      related: ['GF-1', 'GF-2'],
    });
  });

  it('does not repeat the primary ticket as related', () => {
    expect(linksFor({ head_branch: 'dev/GF-1-x', related_keys: ['GF-1'] }, lookup)).toEqual({
      primary: 'GF-1',
      related: [],
    });
  });
});

describe('ingest', () => {
  it('attaches a PR to its ticket, and GF-2430 never lands on GF-243', () => {
    start();
    const id = ticket('A ticket');
    const near = `dev/${id}0-other`;
    ingest([pr(1, { head_branch: `dev/${id}-fix` }), pr(2, { head_branch: near })]);
    const shown = panel(id);
    expect(shown.primary.map((p) => p.number)).toEqual([1]);
    expect(shown.primary[0]!.url).toBe(`https://github.com/${REPO}/pull/1`);
  });

  it('matches an imported Jira key', () => {
    start();
    const id = ticket('Imported');
    d.sql.prepare('UPDATE items SET jira_key = ? WHERE id = ?').run('GAMEFLOW-77', id);
    ingest([pr(3, { head_branch: 'dev/gamefLOW-77-fix' })]);
    expect(panel(id).primary.map((p) => p.number)).toEqual([3]);
  });

  it('keeps a PR that mentions several tickets as related on each', () => {
    start();
    const a = ticket('First');
    const b = ticket('Second');
    ingest([pr(4, { related_keys: [a, b] })]);
    for (const id of [a, b]) {
      expect(panel(id).primary).toEqual([]);
      expect(panel(id).related.map((p) => p.number)).toEqual([4]);
    }
  });

  it('never links a key from another project', () => {
    start();
    const other = ticket('Elsewhere', 'OT');
    ingest([pr(5, { head_branch: `dev/${other}-x`, related_keys: [other] })]);
    expect(panel(other).primary).toEqual([]);
    expect(panel(other).related).toEqual([]);
  });

  it('leaves out Mergify merge-queue PRs', () => {
    start();
    const id = ticket('Queued');
    const out = ingest([
      pr(6, { title: `merge queue: embarking ${id}`, related_keys: [id] }),
      pr(7, { head_branch: `mergify/merge-queue/${id}` }),
    ]);
    expect(out).toMatchObject({ accepted: 0, ignored: 2 });
    expect(d.rows('SELECT id FROM github_prs')).toEqual([]);
  });

  it('is idempotent: the same batch twice adds no event and changes nothing', () => {
    start();
    const id = ticket('Once');
    const batch = [pr(8, { head_branch: `dev/${id}-x` })];
    expect(ingest(batch).changed).toBe(1);
    const events = syncEvents();
    const updated = d.row<{ updated_at: string }>('SELECT updated_at FROM github_prs');
    d.clock.advance(minutes(5));
    expect(ingest(batch).changed).toBe(0);
    expect(syncEvents()).toBe(events);
    expect(d.row('SELECT updated_at FROM github_prs')).toEqual(updated);
    expect(panel(id).primary).toHaveLength(1);
  });

  it('shows only exact observed workflow runs for the current PR head and merge SHA', () => {
    start();
    const id = ticket('Exact CI');
    const at = d.clock.now().toISOString();
    const head = 'a'.repeat(40);
    const merged = 'b'.repeat(40);
    const runs = [
      {
        phase: 'pr_head' as const,
        run_id: 111,
        attempt: 2,
        head_sha: 'c'.repeat(40),
        status: 'failed' as const,
        observed_at: at,
      },
      {
        phase: 'main' as const,
        run_id: 222,
        attempt: 1,
        head_sha: merged,
        status: 'pending' as const,
        observed_at: at,
      },
      {
        phase: 'combined' as const,
        run_id: 999,
        attempt: 1,
        head_sha: 'e'.repeat(40),
        status: 'passed' as const,
        observed_at: at,
      },
    ];
    ingest([
      pr(81, {
        head_branch: `dev/${id}-x`,
        head_sha: head,
        state: 'merged',
        merged_at: at,
        merged_sha: merged,
        workflow_runs: runs,
      }),
      { key: `repo:${REPO}`, kind: 'repo', repo: REPO, ok: true, error: null, at },
    ]);
    expect(panel(id).primary[0]?.workflow_runs).toEqual(runs.slice(0, 2));
    expect(JSON.stringify(d.rows('SELECT * FROM github_prs'))).not.toContain('111');
    ingest([pr(81, { head_branch: `dev/${id}-x`, head_sha: 'd'.repeat(40) })]);
    expect(panel(id).primary[0]?.workflow_runs).toEqual([]);
  });

  it('fails closed on stale GitHub observations', () => {
    start();
    const id = ticket('Old CI');
    ingest([
      pr(82, {
        head_branch: `dev/${id}-x`,
        workflow_runs: [
          {
            phase: 'pr_head',
            run_id: 333,
            attempt: 1,
            head_sha: 'a'.repeat(40),
            status: 'passed',
            observed_at: d.clock.now().toISOString(),
          },
        ],
      }),
      {
        key: `repo:${REPO}`,
        kind: 'repo',
        repo: REPO,
        ok: true,
        error: null,
        at: d.clock.now().toISOString(),
      },
    ]);
    d.clock.advance(minutes(20));
    expect(panel(id).stale).toBe(true);
    expect(panel(id).primary[0]?.workflow_runs).toEqual([]);
  });

  it('moves a link when the PR changes, and records one event', () => {
    start();
    const a = ticket('First');
    const b = ticket('Second');
    ingest([pr(9, { head_branch: `dev/${a}-x` })]);
    ingest([
      pr(9, { head_branch: `dev/${b}-x`, state: 'merged', merged_at: d.clock.now().toISOString() }),
    ]);
    expect(panel(a).primary).toEqual([]);
    expect(panel(b).primary[0]!.state).toBe('merged');
    expect(syncEvents()).toBe(2);
  });

  it('attaches the run active when the PR opened', () => {
    start();
    const id = ticket('With a run');
    forceStatus(d, id, 'ready');
    const { run_id } = d.write(agent, (w, svc) => svc.runs.claim(w, { id, agent_label: 'w1' }));
    d.clock.advance(minutes(1));
    ingest([pr(10, { head_branch: `dev/${id}-x` })]);
    expect(panel(id).primary[0]!.run_id).toBe(run_id);
  });

  it('withholds a secret-looking title instead of failing the batch', () => {
    start();
    const id = ticket('Careful');
    const token = `ghp_${'a1B2'.repeat(10)}`;
    const out = ingest([pr(11, { head_branch: `dev/${id}-x`, title: `oops ${token}` })]);
    expect(out.accepted).toBe(1);
    expect(JSON.stringify(d.rows('SELECT * FROM github_prs'))).not.toContain(token);
    expect(JSON.stringify(d.rows('SELECT * FROM events'))).not.toContain(token);
    expect(panel(id).primary[0]!.title).toContain('withheld');
  });

  it('drops a malformed record and keeps the rest', () => {
    start();
    const id = ticket('Mixed');
    const out = ingest([
      { key: 'nope', kind: 'pr', repo: 'not a repo' },
      pr(12, { key: `${REPO}#999` }),
      pr(13, { head_branch: `dev/${id}-x` }),
    ]);
    expect(out).toMatchObject({ accepted: 1, ignored: 2 });
  });

  it('ignores PRs for a repository no project has, and everything while off', () => {
    start();
    expect(ingest([pr(14, { repo: 'acme/other', key: 'acme/other#14' })]).accepted).toBe(0);
    d.write(OWNER_ACTOR, (w, svc) => svc.sync.setGithub(w, { enabled: false }));
    expect(ingest([pr(15)])).toMatchObject({ accepted: 0, ignored: 1 });
    expect(d.rows('SELECT id FROM github_prs')).toEqual([]);
  });

  it('never wakes a waiter with no type filter', async () => {
    start();
    const { changes } = d.server.runtime;
    const cursor = d.row<{ seq: number }>('SELECT max(seq) AS seq FROM events').seq;
    ingest([pr(16)]);
    expect((await changes.wait({ cursor, timeoutMs: 1 })).status).toBe('timeout');
    expect((await changes.wait({ cursor, timeoutMs: 1, types: ['sync.ingested'] })).status).toBe(
      'changed',
    );
  });
});

describe('the naming rule never blocks', () => {
  const claim = (id: string, branch?: string) =>
    d.server.runtime.write.run({ actor: agent, operation: 'claim_lead', args: {} }, (w) =>
      d.services.runs.claim(w, { id, agent_label: 'w1', ...(branch ? { branch } : {}) }),
    );
  const ready = (title = 'Ticket') => {
    const id = ticket(title);
    forceStatus(d, id, 'ready');
    return id;
  };

  it('suggests a branch at claim', () => {
    start(false);
    const id = ready('Fix the login');
    const out = claim(id);
    expect(out.result.branch_hint).toBe(`<owner>/${id}-fix-the-login`);
    expect(out.warnings).toEqual([]);
  });

  it('warns on a branch without the key, shows it on the ticket and still claims', () => {
    start(false);
    const id = ready();
    const out = claim(id, 'dev/some-branch');
    expect(out.result.run_id).toBeTruthy();
    expect(out.result.branch_hint).toBeUndefined();
    expect(out.warnings.join(' ')).toContain(`doesn't name ${id}`);
    expect(panel(id).naming).toMatchObject({ unnamed: ['dev/some-branch'] });
  });

  it('says nothing for a correct or exempt branch', () => {
    start(false);
    const good = ready();
    expect(claim(good, `dev/${good}-work`).warnings).toEqual([]);
    expect(panel(good).naming).toBeNull();
    const exempt = ready();
    expect(claim(exempt, 'mergify/merge-queue/x').warnings).toEqual([]);
    expect(panel(exempt).naming).toBeNull();
  });

  it('is silent when the project turns it off', () => {
    start(false);
    setProject('GF', { branch_rule: 'off' });
    const id = ready();
    const out = claim(id, 'dev/anything');
    expect(out.warnings).toEqual([]);
    expect(out.result.branch_hint).toBeUndefined();
    expect(panel(id).naming).toBeNull();
  });

  it('warns once when a commit reports a branch without the key', () => {
    start(false);
    const id = ready();
    const commit = (sha: string) =>
      d.server.runtime.write.run({ actor: agent, operation: 'report_commit', args: {} }, (w) =>
        d.services.evidence.reportCommit(w, { id, sha, branch: 'dev/no-key', pushed: true }),
      );
    expect(commit('a'.repeat(40)).warnings.join(' ')).toContain(`doesn't name ${id}`);
    expect(commit('b'.repeat(40)).warnings).toEqual([]);
  });

  it('warns when declared branches lack the key', () => {
    start(false);
    const id = ready();
    const out = d.server.runtime.write.run(
      { actor: agent, operation: 'declare_shared_changes', args: {} },
      (w) =>
        d.services.sharedChanges.declare(w, { id, none: true, branches: ['dev/no-key'] } as never),
    );
    expect(out.warnings.join(' ')).toContain(`doesn't name ${id}`);
  });

  it('honours a project’s own exemptions', () => {
    start(false);
    setProject('GF', { branch_exempt: ['spike/*'] });
    const id = ready();
    expect(claim(id, 'spike/try-it').warnings).toEqual([]);
  });
});

describe('every Settings state', () => {
  it('is off by default, and Docket works with no connection', () => {
    start(false);
    const id = ticket('No GitHub');
    expect(state()).toBe('off');
    expect(panel(id)).toMatchObject({ enabled: false, primary: [], related: [] });
    expect(d.services.views.overview(d.read(), { scope: 'GF', window: '7d' }).flow).toMatchObject({
      merged_source: 'recorded',
      merged_synced_at: null,
    });
  });

  it('needs a repository, then the helper, then says connected', () => {
    start(false);
    d.write(OWNER_ACTOR, (w, svc) => svc.sync.setGithub(w, { enabled: true }));
    expect(state()).toBe('no_repos');
    setProject('GF', { github_repo: REPO });
    expect(state()).toBe('helper_not_running');
    ingest([
      {
        key: `repo:${REPO}`,
        kind: 'repo',
        repo: REPO,
        ok: true,
        error: null,
        at: d.clock.now().toISOString(),
      },
    ]);
    expect(state()).toBe('connected');
    expect(d.services.sync.github(d.read()).repos[0]).toMatchObject({
      repo: REPO,
      projects: ['GF'],
      error: null,
    });
  });

  it.each([
    ['gh_signed_out', 'gh_signed_out'],
    ['gh_missing', 'gh_missing'],
    ['rate_limited', 'rate_limited'],
    ['network', 'network'],
    ['collect_failed', 'error'],
  ])('reports %s', (code, expected) => {
    start();
    ingest([], { ok: false, error: code, interval_ms: 300_000 });
    expect(state()).toBe(expected);
    expect(d.services.sync.github(d.read()).last_error).toBe(code);
  });

  it('recovers on the next good run', () => {
    start();
    ingest([], { ok: false, error: 'network', interval_ms: 300_000 });
    ingest([]);
    expect(state()).toBe('connected');
    expect(d.services.sync.github(d.read()).last_error).toBeNull();
  });

  it('labels old data as stale, and calls a silent helper not running', () => {
    start();
    const id = ticket('Stale');
    ingest([pr(20, { head_branch: `dev/${id}-x` })]);
    expect(panel(id).stale).toBe(false);
    d.clock.advance(minutes(16));
    expect(state()).toBe('helper_not_running');
    expect(panel(id).stale).toBe(true);
    expect(panel(id).primary).toHaveLength(1);
  });

  it('keeps one repository’s failure apart from the others', () => {
    start();
    setProject('OT', { github_repo: 'acme/other' });
    const at = d.clock.now().toISOString();
    ingest([
      { key: `repo:${REPO}`, kind: 'repo', repo: REPO, ok: true, error: null, at },
      {
        key: 'repo:acme/other',
        kind: 'repo',
        repo: 'acme/other',
        ok: false,
        error: 'repo_not_found',
        at,
      },
    ]);
    const repos = d.services.sync.github(d.read()).repos;
    expect(repos.find((r) => r.repo === REPO)!.error).toBeNull();
    expect(repos.find((r) => r.repo === 'acme/other')!.error).toBe('repo_not_found');
  });
});

describe('Merged on Overview', () => {
  const flow = (scope = 'GF') => d.services.views.overview(d.read(), { scope, window: '7d' }).flow;
  const record = (id: string, label: string, url?: string) =>
    d.write(agent, (w, svc) =>
      svc.evidence.linkArtifact(w, {
        id,
        kind: 'pr',
        label,
        state: 'merged',
        ...(url ? { url } : {}),
      }),
    );
  const merged = (n: number, id: string) =>
    pr(n, {
      head_branch: `dev/${id}-x`,
      state: 'merged',
      merged_at: d.clock.now().toISOString(),
    });

  it('uses recorded artifacts when GitHub is off', () => {
    start(false);
    const id = ticket('Recorded');
    record(id, 'PR 1', `https://github.com/${REPO}/pull/1`);
    expect(flow()).toMatchObject({ merged: 1, merged_source: 'recorded' });
  });

  it('counts a PR once when it is both recorded and synced', () => {
    start();
    const id = ticket('Both');
    record(id, 'PR 30', `https://github.com/${REPO}/pull/30/files`);
    ingest([merged(30, id)]);
    expect(flow()).toMatchObject({ merged: 1, merged_source: 'github' });
  });

  it('keeps a recorded PR GitHub did not return, and drops one it can’t tell apart', () => {
    start();
    const id = ticket('History');
    record(id, 'Old PR', `https://github.com/${REPO}/pull/5`);
    record(id, 'No link');
    ingest([merged(31, id)]);
    expect(flow().merged).toBe(2);
  });

  it('says when the synced data is stale', () => {
    start();
    const id = ticket('Stale merge');
    ingest([merged(32, id)]);
    d.clock.advance(minutes(16));
    expect(flow()).toMatchObject({ merged: 1, merged_source: 'github_stale' });
  });

  it('leaves a project with no repository on recorded merges', () => {
    start();
    const id = ticket('Other project', 'OT');
    record(id, 'PR 2', 'https://github.com/acme/other/pull/2');
    ingest([merged(33, ticket('Connected'))]);
    expect(flow('OT')).toMatchObject({ merged: 1, merged_source: 'recorded' });
    expect(flow('all')).toMatchObject({ merged: 2, merged_source: 'github' });
  });

  it('never counts a related PR as the ticket’s merge', () => {
    start();
    const id = ticket('Only mentioned');
    ingest([
      pr(34, {
        related_keys: [id],
        state: 'merged',
        merged_at: d.clock.now().toISOString(),
      }),
    ]);
    d.write(OWNER_ACTOR, (w, svc) => {
      forceStatus(d, id, 'progress');
      return svc.items.setStatus(w, { id, status: 'done', reason: 'Done.' });
    });
    expect(flow().finished_without_merge).toBe(1);
  });
});

describe('deleting a project', () => {
  it('forgets its repository, so a revived key starts clean', () => {
    start();
    d.write(OWNER_ACTOR, (w, svc) => svc.projects.delete(w, { key: 'GF', confirm_key: 'GF' }));
    expect(d.rows('SELECT project_key FROM project_git')).toEqual([]);
    expect(d.services.sync.github(d.read()).repos).toEqual([]);
  });
});

describe('the ingest route', () => {
  const post = (server: TestServer, source: string, body: unknown) =>
    server.request(`/api/sync/${source}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('answers a script, as local trust does, and records it as the system', async () => {
    s = createTestServer({ log: () => {} });
    const res = await post(s, 'github', { records: [], run: RUN });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: 0, changed: 0, ignored: 0 });
  });

  it('says 404 for a source it does not know', async () => {
    s = createTestServer({ log: () => {} });
    expect((await post(s, 'nonsense', { records: [], run: RUN })).status).toBe(404);
    expect((await s.request('/api/sync/nonsense')).status).toBe(404);
  });

  it('refuses a bad name, a bad shape and too many records', async () => {
    s = createTestServer({ log: () => {} });
    expect((await post(s, 'BAD_NAME', { records: [], run: RUN })).status).toBe(400);
    expect((await post(s, 'github', { records: [{}], run: RUN })).status).toBe(400);
    const many = Array.from({ length: 501 }, (_, k) => ({ key: `k${k}` }));
    expect((await post(s, 'github', { records: many, run: RUN })).status).toBe(400);
  });

  it('caps the body size', async () => {
    s = createTestServer({ log: () => {} });
    const huge = 'x'.repeat(2 * 1024 * 1024 + 10);
    const res = await post(s, 'github', { records: [{ key: 'k', pad: huge }], run: RUN });
    expect(res.status).toBe(413);
  });

  it('needs the owner session in protected mode', async () => {
    s = createTestServer({ env: PROTECTED_MODE, log: () => {} });
    expect((await post(s, 'github', { records: [], run: RUN })).status).toBe(401);
    expect((await s.request('/api/sync/github')).status).toBe(401);
  });

  it('gives the runner its settings and status', async () => {
    s = createTestServer({ log: () => {} });
    const res = await s.request('/api/sync/github');
    expect(await res.json()).toMatchObject({
      name: 'github',
      settings: { enabled: false, repos: [] },
      status: { last_success_at: null, stale: false },
    });
  });
});

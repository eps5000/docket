/**
 * Reads pull requests for each connected repository (owner decision 49).
 *
 * Each run makes at most `MAX_REQUESTS` GitHub calls: the open PRs (their CI
 * can change without the PR's `updatedAt` moving), then what changed since the
 * last run, newest first, stopping at the watermark. Near the hourly limit it
 * stops and waits for the reset. PR bodies are read only to find ticket keys,
 * and are never sent to Docket, logged or stored.
 */
import { GhError } from './gh.mjs';

export const MAX_REQUESTS = 20;
export const MAX_PAGES_PER_QUERY = 6;
const CI_REQUESTS_RESERVED = 8;
const MERGED_CI_LOOKBACK_MS = 24 * 60 * 60_000;
/** Stop reading below this many points left in the shared 5,000 per hour. */
export const RATE_FLOOR = 500;
const PAGE_SIZE = 50;
const FIRST_RUN_DAYS = 30;
/** Read a little behind the watermark, so a change during the last run isn't missed. */
const OVERLAP_MS = 2 * 60_000;
const MAX_RELATED = 40;
const TITLE_MAX = 300;

const FIELDS = `number title state isDraft headRefName headRefOid createdAt updatedAt mergedAt mergeCommit{oid} body
commits(last:1){nodes{commit{statusCheckRollup{state}}}}`;

export const OPEN_QUERY = `query($owner:String!,$name:String!,$cursor:String){
rateLimit{remaining resetAt}
repository(owner:$owner,name:$name){pullRequests(first:${PAGE_SIZE},after:$cursor,states:OPEN,orderBy:{field:UPDATED_AT,direction:DESC}){
pageInfo{hasNextPage endCursor} nodes{${FIELDS}}}}}`;

export const CHANGED_QUERY = `query($owner:String!,$name:String!,$cursor:String){
rateLimit{remaining resetAt}
repository(owner:$owner,name:$name){pullRequests(first:${PAGE_SIZE},after:$cursor,orderBy:{field:UPDATED_AT,direction:DESC}){
pageInfo{hasNextPage endCursor} nodes{${FIELDS}}}}}`;

/** Mergify's temporary PRs: a merge queue's batch, never a piece of work. */
export function isMergeQueue(pr) {
  return (
    /^merge queue:/i.test(pr.title ?? '') || /^mergify\/merge-queue\//i.test(pr.headRefName ?? '')
  );
}

/** Ticket keys named in prose: upper case, whole tokens, at most `MAX_RELATED`. */
export function keysInText(...texts) {
  const keys = new Set();
  for (const text of texts) {
    for (const match of String(text ?? '').matchAll(
      /(?<![A-Za-z0-9-])[A-Z][A-Z0-9]{1,9}-\d{1,7}(?![A-Za-z0-9])/g,
    )) {
      keys.add(match[0]);
      if (keys.size >= MAX_RELATED) return [...keys];
    }
  }
  return [...keys];
}

const CI = {
  SUCCESS: 'passed',
  FAILURE: 'failed',
  ERROR: 'failed',
  PENDING: 'pending',
  EXPECTED: 'pending',
};

export function ciOf(pr) {
  const state = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state;
  return CI[state] ?? 'none';
}

const STATES = { OPEN: 'open', CLOSED: 'closed', MERGED: 'merged' };

/** One PR as Docket receives it. The body stays here. */
export function toRecord(repo, pr) {
  return {
    key: `${repo}#${pr.number}`,
    kind: 'pr',
    repo,
    number: pr.number,
    title: String(pr.title ?? '').slice(0, TITLE_MAX),
    head_branch: String(pr.headRefName ?? '').slice(0, 255),
    state: STATES[pr.state] ?? 'open',
    draft: pr.isDraft === true,
    head_sha: pr.headRefOid ?? null,
    merged_at: pr.mergedAt ?? null,
    ci: ciOf(pr),
    opened_at: pr.createdAt,
    remote_updated_at: pr.updatedAt,
    related_keys: keysInText(pr.title, pr.body),
    merged_sha: /^[0-9a-f]{40}$/i.test(pr.mergeCommit?.oid ?? '') ? pr.mergeCommit.oid : null,
  };
}

const runStatus = (run) => {
  if (['queued', 'in_progress', 'waiting', 'pending', 'requested'].includes(run.status))
    return 'pending';
  if (run.status !== 'completed') return null;
  if (run.conclusion === 'success') return 'passed';
  if (['failure', 'timed_out', 'action_required'].includes(run.conclusion)) return 'failed';
  return null;
};

/** A CI workflow run bound to an exact PR head or resulting-main commit. */
export function exactRun(pr, run, phase, at, commitLinked = false) {
  const id = run?.id;
  const attempt = run?.run_attempt;
  const sha = run?.head_sha;
  if (
    !Number.isSafeInteger(id) ||
    id < 1 ||
    !Number.isSafeInteger(attempt) ||
    attempt < 1 ||
    !/^[0-9a-f]{40}$/i.test(sha ?? '') ||
    run?.name !== 'ci' ||
    !['.github/workflows/ci.yml', '.github/workflows/ci.yml@'].some((path) =>
      path.endsWith('@') ? String(run.path ?? '').startsWith(path) : run.path === path,
    ) ||
    run.repository?.full_name !== pr.repo ||
    run.html_url !== `https://github.com/${pr.repo}/actions/runs/${id}`
  )
    return null;
  const status = runStatus(run);
  if (!status) return null;
  if (phase === 'pr_head') {
    if (run.event !== 'pull_request' || run.head_branch !== pr.head_branch) return null;
    const linked = run.pull_requests?.some(
      (link) => link.number === pr.number && link.head?.sha === pr.head_sha,
    );
    if (!linked && (!commitLinked || sha !== pr.head_sha || (run.pull_requests?.length ?? 0) > 0))
      return null;
  } else if (phase === 'main') {
    if (
      pr.state !== 'merged' ||
      run.event !== 'push' ||
      sha !== pr.merged_sha ||
      run.head_branch !== 'main'
    )
      return null;
  } else {
    // Queue membership has no verified source in this collector. It stays Unknown.
    return null;
  }
  return {
    phase,
    run_id: id,
    attempt,
    head_sha: sha,
    status,
    observed_at: at,
  };
}

function checkPage(response) {
  const errors = response?.errors ?? [];
  if (errors.some((e) => e.type === 'NOT_FOUND')) throw new GhError('repo_not_found');
  if (errors.some((e) => e.type === 'RATE_LIMITED')) throw new GhError('rate_limited');
  if (errors.some((e) => e.type === 'FORBIDDEN')) throw new GhError('repo_forbidden');
  const page = response?.data?.repository?.pullRequests;
  if (!page || !Array.isArray(page.nodes)) throw new GhError('gh_error');
  return { page, rate: response.data.rateLimit ?? null };
}

/** A failure that belongs to one repository: the others still sync. */
const REPO_ERRORS = new Set(['repo_not_found', 'repo_forbidden']);

/**
 * `collect` with its `gh` passed in. Returns `{ records, state }`. A failure
 * that affects everything (signed out, no network, rate limit) throws, so the
 * runner backs off and the old watermark stays.
 */
export async function collectWith(gh, { state, log, signal, settings }, now = Date.now) {
  const next = { repos: { ...(state?.repos ?? {}) }, paused_until: null };
  const records = new Map();
  const pausedUntil = Date.parse(state?.paused_until ?? '');
  if (Number.isFinite(pausedUntil) && pausedUntil > now()) {
    // A failure, so the old state stays and this can't read as a fresh sync.
    log('rate_paused', { until: state.paused_until });
    throw new GhError('rate_limited');
  }
  await gh.authStatus(signal);

  const repos = settings.repos.map((r) => r.repo);
  // Take turns, so one busy repository can't use every run's budget.
  const start = repos.length > 0 ? (state?.next_repo ?? 0) % repos.length : 0;
  const order = [...repos.slice(start), ...repos.slice(0, start)];
  let used = 0;
  let graphqlUsed = 0;
  let paused = null;
  let finished = 0;

  const fetchPage = async (query, owner, repoName, cursor) => {
    used += 1;
    graphqlUsed += 1;
    const response = await gh.graphql(query, { owner, name: repoName, cursor }, signal);
    const { page, rate } = checkPage(response);
    if (rate && rate.remaining < RATE_FLOOR) paused = rate.resetAt ?? null;
    return page;
  };
  const spent = () => used >= MAX_REQUESTS || paused !== null;
  const graphqlSpent = () => spent() || graphqlUsed >= MAX_REQUESTS - CI_REQUESTS_RESERVED;

  for (const repo of order) {
    if (graphqlSpent()) break;
    const [owner, repoName] = repo.split('/');
    const startedAt = now();
    const sinceText = next.repos[repo]?.since;
    const since = Number.isFinite(Date.parse(sinceText ?? ''))
      ? Date.parse(sinceText)
      : startedAt - FIRST_RUN_DAYS * 86_400_000;
    let complete = true;
    let oldest = startedAt;
    try {
      let cursor = null;
      for (let p = 0; p < MAX_PAGES_PER_QUERY; p += 1) {
        if (graphqlSpent()) {
          complete = false;
          break;
        }
        const page = await fetchPage(OPEN_QUERY, owner, repoName, cursor);
        for (const pr of page.nodes) {
          if (!isMergeQueue(pr)) records.set(`${repo}#${pr.number}`, toRecord(repo, pr));
        }
        if (!page.pageInfo?.hasNextPage) break;
        cursor = page.pageInfo.endCursor;
      }
      cursor = null;
      let reached = false;
      for (let p = 0; p < MAX_PAGES_PER_QUERY && !reached; p += 1) {
        if (graphqlSpent()) {
          complete = false;
          break;
        }
        const page = await fetchPage(CHANGED_QUERY, owner, repoName, cursor);
        for (const pr of page.nodes) {
          const at = Date.parse(pr.updatedAt);
          // A recent merged PR still needs CI identity even after the ordinary
          // change watermark passes it. The page cap and global budget bound this read.
          if (Number.isFinite(at) && at < Math.min(since, startedAt - MERGED_CI_LOOKBACK_MS)) {
            reached = true;
            break;
          }
          if (Number.isFinite(at)) oldest = Math.min(oldest, at);
          if (!isMergeQueue(pr)) records.set(`${repo}#${pr.number}`, toRecord(repo, pr));
        }
        if (!page.pageInfo?.hasNextPage) reached = true;
        else cursor = page.pageInfo.endCursor;
      }
      // More changes than the page cap (a first read): resume from the oldest one seen.
      const watermark = complete
        ? reached
          ? startedAt - OVERLAP_MS
          : oldest
        : (next.repos[repo]?.since ?? null);
      next.repos[repo] = { since: watermark ? new Date(watermark).toISOString() : null };
      if (complete) {
        finished += 1;
        records.set(`repo:${repo}`, {
          key: `repo:${repo}`,
          kind: 'repo',
          repo,
          ok: true,
          error: null,
          at: new Date(startedAt).toISOString(),
        });
      }
    } catch (err) {
      if (!REPO_ERRORS.has(err.code)) throw err;
      log('repo_failed', { repo, error: err.code });
      finished += 1;
      records.set(`repo:${repo}`, {
        key: `repo:${repo}`,
        kind: 'repo',
        repo,
        ok: false,
        error: err.code,
        at: new Date(startedAt).toISOString(),
      });
    }
  }
  // The PR rollup is a checks summary, not a workflow identity. Read a small
  // bounded set of exact Actions runs; a missing or ambiguous result stays absent.
  if (gh.workflowRuns) {
    const at = new Date(now()).toISOString();
    const candidates = [...records.values()]
      .filter((record) => record.kind === 'pr')
      .sort((a, b) => b.remote_updated_at.localeCompare(a.remote_updated_at));
    const offset = candidates.length ? (state?.next_ci_offset ?? 0) % candidates.length : 0;
    const ordered = [...candidates.slice(offset), ...candidates.slice(0, offset)];
    let examined = 0;
    for (const pr of ordered) {
      if (spent()) break;
      // Never publish one phase of a merged PR because its other phase ran
      // out of this cycle's budget. The offset retries it on a later cycle.
      if (MAX_REQUESTS - used < (pr.state === 'merged' ? 3 : 1)) break;
      examined += 1;
      const observed = [];
      const rest = async (filter) => {
        used += 1;
        const result = await gh.workflowRuns(pr.repo, filter, signal);
        return Array.isArray(result?.workflow_runs) ? result.workflow_runs : [];
      };
      if (
        (pr.state === 'open' || pr.state === 'merged') &&
        /^[A-Za-z0-9._/-]+$/.test(pr.head_branch)
      ) {
        const runs = await rest({ event: 'pull_request', branch: pr.head_branch });
        let exact = runs
          .map((run) => exactRun(pr, run, 'pr_head', at))
          .filter(Boolean)
          .sort((a, b) => b.run_id - a.run_id)[0];
        if (
          !exact &&
          pr.state === 'merged' &&
          /^[0-9a-f]{40}$/i.test(pr.head_sha ?? '') &&
          gh.commitPulls &&
          !spent() &&
          runs.some(
            (run) =>
              run?.event === 'pull_request' &&
              run?.head_branch === pr.head_branch &&
              run?.head_sha === pr.head_sha,
          )
        ) {
          used += 1;
          let pulls;
          try {
            pulls = await gh.commitPulls(pr.repo, pr.head_sha, signal);
          } catch (error) {
            if (error?.code !== 'gh_error') throw error;
            // A malformed or unavailable commit association is Unknown for
            // this PR; advance the bounded candidate rotation.
            log('ci_link_unavailable', { repo: pr.repo });
          }
          const matching =
            Array.isArray(pulls) && pulls.length < 100
              ? pulls.filter(
                  (link) =>
                    link.head?.sha === pr.head_sha &&
                    link.head?.ref === pr.head_branch &&
                    link.base?.repo?.full_name === pr.repo,
                )
              : [];
          const linked = matching.length === 1 && matching[0].number === pr.number;
          if (linked)
            exact = runs
              .map((run) => exactRun(pr, run, 'pr_head', at, true))
              .filter(Boolean)
              .sort((a, b) => b.run_id - a.run_id)[0];
        }
        if (exact) observed.push(exact);
      }
      if (pr.state === 'merged' && pr.merged_sha && !spent()) {
        const runs = await rest({ event: 'push', head_sha: pr.merged_sha });
        const exact = runs
          .map((run) => exactRun(pr, run, 'main', at))
          .filter(Boolean)
          .sort((a, b) => b.run_id - a.run_id)[0];
        if (exact) observed.push(exact);
      }
      pr.workflow_runs = observed;
    }
    next.next_ci_offset = candidates.length ? (offset + examined) % candidates.length : 0;
  }
  if (paused) {
    next.paused_until = paused;
    log('rate_low', { until: paused });
  }
  if (repos.length > 0) next.next_repo = (start + finished) % repos.length;
  log('github_read', { repos: repos.length, requests: used, prs: records.size });
  return { records: [...records.values()], state: next };
}

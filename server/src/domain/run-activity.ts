/**
 * Status that follows the work (owner decision 42; BUILD_SPEC §5.23).
 *
 * - **Producer holds.** A story has a stable producer across worker handoffs.
 *   While no worker leads it, the last lead run carries `producer_hold_until`
 *   and the item stays In progress for that producer alone.
 * - **Activity detection.** A parked run shows "activity since parked" when
 *   something real happened after it parked (commits on its reported branches,
 *   updates on the item, a blocker that cleared). A silent open run shows the
 *   same for commits, because its session may be working without Docket.
 *
 * Commits come from the host helper's git facts (B76: `sources/git.mjs` reads
 * them read-only on the host; Docket runs no git). A flag never changes a
 * run's state, and it stays until the run or a coordinator speaks, so it can't
 * flap. Clearing moves the baseline, so what was seen is not re-raised. When
 * the facts don't answer (the helper hasn't reported, they're stale, or they
 * don't reach back to the baseline), a raised flag stays as it is, so a
 * partial count never replaces what is stored.
 */
import type { ProducerHold, RunActivity, RunStatusUpdate, WaitingOn } from '@docket/shared';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import {
  BlockIndex,
  actorName,
  displayRunState,
  ms,
  projectCoordinators,
  windowsOf,
  type RunRow,
} from './model.js';
import { freshHostGit, type HostGitFacts } from './host-git.js';
import { reportedBranches, validBranch } from './radar.js';
import { projectPause } from './project-pause.js';
import { workEventSql } from './activity.js';
import { clearedSince, parkInfo, parseJson, storedWorkspace } from './recovery-model.js';

// ---- Stored shapes ----

/** `runs.park_activity`: the baseline to compare against, and the raised flag. */
export interface StoredActivity {
  since: string;
  flag: RunActivity | null;
}

export const storedActivity = (run: Pick<RunRow, 'park_activity'>): StoredActivity | null =>
  parseJson<StoredActivity>(run.park_activity);

export const storedStatusUpdate = (run: Pick<RunRow, 'status_update'>): RunStatusUpdate | null =>
  parseJson<RunStatusUpdate>(run.status_update);

export { projectCoordinators };

/** Is `name` this run's recorded orchestrator, or a coordinator registered for its project? */
export function namesCoordinator(
  db: Db,
  project: string,
  run: Pick<RunRow, 'orchestrator'>,
  name: string,
): boolean {
  return (
    parseJson<{ name?: string }>(run.orchestrator)?.name === name ||
    projectCoordinators(db, project).includes(name)
  );
}

// ---- Producer holds ----

export interface HoldRow extends ProducerHold {
  run_id: string;
}

/**
 * The hold on an In progress item with no active lead, if any: the newest lead
 * run carrying one. It counts until the sweeper ends it, so a claim just after
 * `until` can't slip in ahead of the item's return to Ready.
 */
export function producerHold(db: Db, itemId: string): HoldRow | null {
  const run = db.sqlite
    .prepare(
      `SELECT r.* FROM runs r JOIN items i ON i.id = r.item_id
       WHERE r.item_id = ? AND r.is_lead = 1 AND i.status = 'progress'
         AND r.producer IS NOT NULL AND r.producer_hold_until IS NOT NULL
       ORDER BY r.created_at DESC, r.id DESC LIMIT 1`,
    )
    .get(itemId) as RunRow | undefined;
  if (!run) return null;
  return {
    run_id: run.id,
    producer: run.producer!,
    until: run.producer_hold_until!,
    last_worker: actorName({ kind: 'agent', client: run.client, label: run.label }),
  };
}

/** Each item's producer, for cards: from its active lead, or its hold between workers. */
export function producersByItem(db: Db): Map<string, { name: string; between_workers: boolean }> {
  const out = new Map<string, { name: string; between_workers: boolean }>();
  for (const r of db.sqlite
    .prepare(
      `SELECT r.item_id, r.producer, r.state FROM runs r JOIN items i ON i.id = r.item_id
       WHERE r.is_lead = 1 AND r.producer IS NOT NULL AND (
         r.state IN ('open', 'needs_input', 'parked')
         OR (r.producer_hold_until IS NOT NULL AND i.status = 'progress'))
       ORDER BY r.created_at, r.id`,
    )
    .all() as { item_id: string; producer: string; state: string }[]) {
    out.set(r.item_id, {
      name: r.producer,
      between_workers: !['open', 'needs_input', 'parked'].includes(r.state),
    });
  }
  return out;
}

// ---- Activity detection ----

/** Item events that show real work happened. The park and resume bookkeeping isn't one. */
export const ACTIVITY_EVENTS = [
  'note.added',
  'owner_note.added',
  'commit.reported',
  'artifact.linked',
  'document.added',
  'plan.updated',
  'step.updated',
  'checks.updated',
  'check.updated',
  'subagent.logged',
  'run.started',
  'run.ended',
  'question.answered',
  'packet.submitted',
] as const;

/** How many of a run's branches one check reads. */
const MAX_BRANCHES = 10;

export interface ActivityFinding {
  run_id: string;
  item_id: string;
  /** The stored state and baseline the finding was read against. */
  state: RunRow['state'];
  baseline: string;
  activity: RunActivity;
  /** First time for this baseline: it gets one event. */
  raised: boolean;
  resume_ready: boolean;
}

type CommitCount = { count: number; last: string | null; branch: string | null };

/**
 * B76: commits on `branches` newer than `since`, from the host helper's facts
 * (local and origin refs, read on the host). `unknown` when the facts don't
 * answer: the helper hasn't reported, its facts are stale, or it didn't read
 * one of these branches from early enough.
 */
export function commitsFromFacts(
  facts: HostGitFacts | null,
  main: string,
  branches: readonly string[],
  since: string,
): CommitCount | 'unknown' {
  const seen = new Map<string, { at: number; branch: string }>();
  const after = ms(since);
  for (const branch of branches.slice(0, MAX_BRANCHES)) {
    if (branch === main || !validBranch(branch)) continue;
    const fact = facts?.commits[branch];
    if (!fact || fact.read !== 'ok' || ms(fact.since) > after) return 'unknown';
    for (const c of fact.commits) {
      const at = ms(c.at);
      if (at <= after) continue;
      if (!seen.has(c.sha)) seen.set(c.sha, { at, branch });
    }
  }
  let last: { sha: string; at: number; branch: string } | null = null;
  for (const [sha, c] of seen) if (!last || c.at > last.at) last = { sha, ...c };
  return { count: seen.size, last: last?.sha ?? null, branch: last?.branch ?? null };
}

const later = (a: string, b: string | null | undefined) => (b && ms(b) > ms(a) ? b : a);

const sameFacts = (a: RunActivity, b: RunActivity) =>
  a.kind === b.kind &&
  a.commits === b.commits &&
  a.last_commit === b.last_commit &&
  a.events === b.events &&
  a.cleared_items.join() === b.cleared_items.join();

interface Candidate {
  run: RunRow & { project_key: string };
  parked: boolean;
  baseline: string;
  branches: string[];
}

/** The parked and silent lead runs to check, each with its baseline and branches. */
function activityCandidates(db: Db, config: Config, now: string): Candidate[] {
  const runs = db.sqlite
    .prepare(
      `SELECT r.*, i.project_key AS project_key FROM runs r JOIN items i ON i.id = r.item_id
       WHERE r.is_lead = 1 AND r.state IN ('parked', 'open') ORDER BY r.created_at, r.id`,
    )
    .all() as (RunRow & { project_key: string })[];
  if (runs.length === 0) return [];
  const windows = windowsOf(config);
  // Decision 53: a paused project's parked runs raise nothing; what changed shows once it resumes.
  const paused = new Map<string, boolean>();
  const isPaused = (project: string) => {
    if (!paused.has(project)) paused.set(project, !!projectPause(db, project));
    return paused.get(project)!;
  };
  const out: Candidate[] = [];
  for (const run of runs) {
    if (run.state === 'parked' && isPaused(run.project_key)) continue;
    const parked = run.state === 'parked';
    if (!parked && displayRunState(run, windows, now) !== 'stale') continue;
    const stored = storedActivity(run);
    const baseline = parked
      ? (stored?.since ?? run.parked_at ?? run.updated_at)
      : later(run.last_signal_at, storedStatusUpdate(run)?.at);
    const branches = [
      ...new Set([
        ...reportedBranches(db, run.item_id).map((b) => b.name),
        ...(storedWorkspace(run)?.branch ? [storedWorkspace(run)!.branch!] : []),
      ]),
    ];
    out.push({ run, parked, baseline, branches });
  }
  return out;
}

/**
 * B76: what the host helper reads for commit activity, by project: each
 * branch once, from the earliest baseline any run needs it from.
 */
export function activityRequest(
  db: Db,
  config: Config,
  now: string,
): Map<string, { branch: string; since: string }[]> {
  const mains = new Map<string, string | null>();
  const mainOf = (project: string) => {
    if (!mains.has(project)) {
      const p = db.sqlite
        .prepare('SELECT repo_path, main_branch FROM projects WHERE key = ? AND deleted_at IS NULL')
        .get(project) as { repo_path: string | null; main_branch: string } | undefined;
      mains.set(project, p?.repo_path ? p.main_branch : null);
    }
    return mains.get(project)!;
  };
  const byProject = new Map<string, Map<string, string>>();
  for (const c of activityCandidates(db, config, now)) {
    const main = mainOf(c.run.project_key);
    if (main === null) continue;
    let branches = byProject.get(c.run.project_key);
    if (!branches) {
      branches = new Map();
      byProject.set(c.run.project_key, branches);
    }
    for (const branch of c.branches.slice(0, MAX_BRANCHES)) {
      if (branch === main || !validBranch(branch)) continue;
      const had = branches.get(branch);
      if (!had || ms(c.baseline) < ms(had)) branches.set(branch, c.baseline);
    }
  }
  return new Map(
    [...byProject].map(([key, branches]) => [
      key,
      [...branches].map(([branch, since]) => ({ branch, since })),
    ]),
  );
}

/**
 * What changed for each parked or silent lead run since its baseline. Commits
 * come from the host helper's facts (B76), so this runs no git. Returns only
 * what is new.
 */
export async function planRunActivity(
  db: Db,
  config: Config,
  now: string,
  signal?: AbortSignal,
): Promise<ActivityFinding[]> {
  const candidates = activityCandidates(db, config, now);
  if (candidates.length === 0) return [];
  const index = new BlockIndex(db);
  const facts = new Map<string, { repo: boolean; main: string; facts: HostGitFacts | null }>();
  const factsOf = (key: string) => {
    if (!facts.has(key)) {
      const p = db.sqlite
        .prepare('SELECT repo_path, main_branch FROM projects WHERE key = ? AND deleted_at IS NULL')
        .get(key) as { repo_path: string | null; main_branch: string } | undefined;
      facts.set(key, {
        repo: !!p?.repo_path,
        main: p?.main_branch ?? 'main',
        facts: p ? freshHostGit(db, { key, ...p }, now) : null,
      });
    }
    return facts.get(key)!;
  };
  const countEvents = db.sqlite.prepare(
    `SELECT count(*) AS n FROM events WHERE item_id = ? AND at > ?
     AND type IN (SELECT value FROM json_each(?)) AND ${workEventSql('events')}`,
  );
  const out: ActivityFinding[] = [];
  for (const { run, parked, baseline, branches } of candidates) {
    if (signal?.aborted) break;
    const stored = storedActivity(run);
    const waiting = parseJson<WaitingOn>(run.waiting_on) ?? {};
    const info = parked ? parkInfo(db, run, now, index) : null;
    const cleared = parked ? clearedSince(db, run, waiting, baseline, index) : [];
    const events = parked
      ? (
          countEvents.get(run.item_id, baseline, JSON.stringify(ACTIVITY_EVENTS)) as {
            n: number;
          }
        ).n
      : 0;
    const repo = factsOf(run.project_key);
    let commits: CommitCount;
    if (!repo.repo) {
      commits = { count: 0, last: null, branch: null };
    } else {
      const found = commitsFromFacts(repo.facts, repo.main, branches, baseline);
      if (found === 'unknown') {
        // A partial count never replaces a raised flag; without one, the other signs still count.
        if (stored?.flag) continue;
        commits = { count: 0, last: null, branch: null };
      } else {
        commits = found;
      }
    }
    const ready = info?.resume_ready === true && ms(info.ready_since!) > ms(baseline);
    if (commits.count === 0 && events === 0 && cleared.length === 0 && !ready) continue;

    const activity: RunActivity = {
      kind: parked ? 'since_parked' : 'since_signal',
      since: baseline,
      detected_at: stored?.flag?.detected_at ?? now,
      commits: commits.count,
      last_commit: commits.last,
      branch: commits.branch,
      events,
      cleared_items: cleared,
    };
    if (stored?.flag && sameFacts(stored.flag, activity)) continue;
    out.push({
      run_id: run.id,
      item_id: run.item_id,
      state: run.state,
      baseline,
      activity,
      raised: !stored?.flag,
      resume_ready: info?.resume_ready ?? false,
    });
  }
  return out;
}

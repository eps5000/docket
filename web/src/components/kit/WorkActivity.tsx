import type { CardActivity, CardGithub, GithubWorkflowRun } from '@docket/shared';

const LABEL: Record<CardActivity['state'], string> = {
  live: 'Live',
  reported: 'Last reported',
  waiting: 'Waiting',
  stale: 'Out of date',
  failed: 'Failed',
  unknown: 'Unknown',
};

/** Run and wait evidence for a Work row or card; workflow status is shown separately. */
export function WorkActivity({
  activity,
  github,
}: {
  activity: CardActivity | null | undefined;
  github?: CardGithub | null;
}) {
  const ci = activity?.state === 'live' ? null : ciProgress(github);
  if (!activity && !ci) return null;
  return (
    <span
      className={`work-activity wa-${activity?.state ?? 'unknown'}`}
      data-work-activity={activity?.state ?? 'unknown'}
    >
      {activity && (
        <>
          <span className="wa-heading">
            <i className="wa-dot" aria-hidden="true" />
            <span>{LABEL[activity.state]}</span>
            {activity.actor && <span className="wa-actor"> · {activity.actor}</span>}
          </span>
          {activity.action && <span className="wa-action">{activity.action}</span>}
        </>
      )}
      {ci && (
        <span className="wa-ci-progress" data-ci-progress="">
          {ci}
        </span>
      )}
    </span>
  );
}

/** Fixed, owner-facing CI progress text from fresh PR facts and exact main runs. */
function ciProgress(github: CardGithub | null | undefined): string | null {
  if (!github) return null;
  if (github.stale) return 'CI out of date';
  if (github.state === 'merged') {
    const main = github.workflow_runs.find((run) => run.phase === 'main');
    if (!main) return 'Waiting for resulting-main CI evidence';
    if (main.status === 'pending') return 'Waiting for resulting-main CI';
    if (main.status === 'failed') return 'Resulting-main CI failed';
    return null;
  }
  if (github.state !== 'open') return null;
  if (github.checks_status === 'failed') return 'CI failed (PR checks)';
  if (github.checks_status === 'pending') return 'Waiting for CI (PR checks)';
  if (github.checks_status === 'passed') return 'Waiting for merge';
  return null;
}

const safeRepo = (repo: string) =>
  /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) &&
  !repo.split('/').some((part) => part === '.' || part === '..');

export function safeGithubPrUrl(repo: string, number: number): string | null {
  return safeRepo(repo) && Number.isSafeInteger(number) && number > 0
    ? `https://github.com/${repo}/pull/${number}`
    : null;
}

export function safeGithubBranchUrl(repo: string, branch: string): string | null {
  return safeRepo(repo) &&
    branch.length > 0 &&
    branch.length <= 255 &&
    !Array.from(branch).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
    ? `https://github.com/${repo}/tree/${branch.split('/').map(encodeURIComponent).join('/')}`
    : null;
}

export function safeGithubRunUrl(repo: string, runId: number, attempt: number): string | null {
  return safeRepo(repo) &&
    Number.isSafeInteger(runId) &&
    runId > 0 &&
    Number.isSafeInteger(attempt) &&
    attempt > 0
    ? `https://github.com/${repo}/actions/runs/${runId}/attempts/${attempt}`
    : null;
}

const PHASES = [
  ['pr_head', 'PR run'],
  ['combined', 'Combined'],
  ['main', 'Main'],
] as const;

/** Exact workflow links only for observed runs; all missing phases say Unknown. */
export function CiPhases({
  repo,
  runs,
  stale,
}: {
  repo: string;
  runs: readonly GithubWorkflowRun[];
  stale: boolean;
}) {
  return (
    <span className="wa-ci-phases">
      {PHASES.map(([phase, label]) => {
        const run = stale ? undefined : runs.find((entry) => entry.phase === phase);
        const url = run && safeGithubRunUrl(repo, run.run_id, run.attempt);
        return (
          <span key={phase} className="wa-ci-phase" data-ci-phase={phase}>
            {url ? (
              <a href={url} target="_blank" rel="noreferrer noopener">
                {label} · {run.status} (run {run.run_id}, attempt {run.attempt})
                <span className="sr"> (opens GitHub)</span>
              </a>
            ) : (
              <span>
                {label} · {stale ? 'Out of date' : 'Unknown'}
              </span>
            )}
          </span>
        );
      })}
    </span>
  );
}

/** Sibling of the whole-card item link, so no anchor is nested inside another. */
export function GithubCiLinks({ github }: { github: CardGithub | null | undefined }) {
  if (!github) return null;
  const pr = safeGithubPrUrl(github.repo, github.number);
  return (
    <div className="wa-ci" aria-label={`GitHub CI for ${github.item_id}`}>
      {pr ? (
        <>
          <a href={pr} target="_blank" rel="noreferrer noopener">
            {github.item_id} PR #{github.number}
            <span className="sr"> (opens GitHub)</span>
          </a>
          <a href={`${pr}/checks`} target="_blank" rel="noreferrer noopener">
            PR checks · {github.stale ? 'Out of date' : github.checks_status}
            <span className="sr"> (opens GitHub)</span>
          </a>
        </>
      ) : (
        <span>PR link unavailable</span>
      )}
      <CiPhases repo={github.repo} runs={github.workflow_runs} stale={github.stale} />
    </div>
  );
}

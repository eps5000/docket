import { useQuery } from '@tanstack/react-query';
import type { SyncSourceResponse } from '@docket/shared';
import { Card, Chip, Skeleton, type ChipKind } from '../../components/kit';
import { QueryState } from '../../app/QueryState';
import { apiClient } from '../../app/queryClient';
import { queryKeys } from '../../lib/api';
import { formatAgo, isoTitle } from '../../lib/format';
import { HELPER_STEPS } from './GitHubCard';

export type WorktreeHelperState = 'not_running' | 'ok' | 'stale' | 'failed';

/** What each state says. Always words, never colour alone. */
export const WORKTREE_HELPER_STATUS: Record<
  WorktreeHelperState,
  { kind: ChipKind; label: string; help: string }
> = {
  not_running: {
    kind: 'warn',
    label: 'Helper not running',
    help: 'Until it reports, worktrees show as Unknown. The steps below set it up or start it.',
  },
  ok: {
    kind: 'ok',
    label: '✓ Up to date',
    help: 'The helper checks your worktrees every few minutes. It only reads, and it never sends file names.',
  },
  stale: {
    kind: 'warn',
    label: 'Out of date',
    help: 'The helper hasn’t reported lately, so the worktrees it read show as Unknown until it runs again.',
  },
  failed: {
    kind: 'bad',
    label: 'Last check failed',
    help: 'Run the helper’s status command on this computer to see why. It tries again by itself.',
  },
};

/** B76: the same states for the git source: the radar, branch discovery and commit activity. */
export const GIT_HELPER_STATUS: Record<
  WorktreeHelperState,
  { kind: ChipKind; label: string; help: string }
> = {
  not_running: {
    kind: 'warn',
    label: 'Waiting for the host helper',
    help: 'Until it reports, the conflict radar finds and clears nothing, and commit activity and unpushed work stay unverified. An older helper doesn’t read these yet: update it with the steps below.',
  },
  ok: {
    kind: 'ok',
    label: '✓ Up to date',
    help: 'The helper reads branches, trial merges and commits every few minutes. It only reads. The only file names it sends are the files in a real conflict.',
  },
  stale: {
    kind: 'warn',
    label: 'Out of date',
    help: 'The helper hasn’t reported lately, so the radar’s findings may be out of date and none clears until it runs again.',
  },
  failed: {
    kind: 'bad',
    label: 'Last check failed',
    help: 'Run the helper’s status command on this computer to see why. It tries again by itself.',
  },
};

const ERROR_TEXT: Record<string, string> = {
  git_missing: 'Git wasn’t found on this computer',
  collect_failed: 'The helper hit an unexpected error',
};

/** The server stops using the helper's facts at this age, so this says so at the same moment. */
const FRESH_MS = 10 * 60_000;

export function worktreeHelperState(
  status: SyncSourceResponse['status'],
  now: number = Date.now(),
): WorktreeHelperState {
  const old =
    status.last_success_at !== null && now - Date.parse(status.last_success_at) > FRESH_MS;
  if (status.stale || old) return 'stale';
  if (status.last_error) return 'failed';
  return status.last_success_at ? 'ok' : 'not_running';
}

function SourceStatus({
  data,
  table,
  attr,
}: {
  data: SyncSourceResponse;
  table: typeof WORKTREE_HELPER_STATUS;
  attr: 'data-worktree-helper' | 'data-git-helper';
}) {
  const state = worktreeHelperState(data.status);
  const status = table[state];
  const error = data.status.last_error;
  return (
    <dl className="kv" {...{ [attr]: state }}>
      <dt>Status</dt>
      <dd>
        <Chip kind={status.kind}>{status.label}</Chip>
        <div className="src">{status.help}</div>
      </dd>
      <dt>Last check</dt>
      <dd>
        {data.status.last_success_at ? (
          <span title={isoTitle(data.status.last_success_at)}>
            {formatAgo(data.status.last_success_at)}
          </span>
        ) : (
          'Never'
        )}
      </dd>
      {error && (
        <>
          <dt>Last error</dt>
          <dd>{ERROR_TEXT[error] ?? `Error: ${error}`}</dd>
        </>
      )}
    </dl>
  );
}

/**
 * Settings → Connections → Git checks (owner decision 48; B68; B76; UI_SPEC
 * §6.7): Docket runs no git, so the helper on this computer reads every
 * worktree (the worktrees source) and everything else the radar and checks
 * need (the git source).
 */
export function WorktreeHelperCard() {
  // The helper's status is bookkeeping, with no event to refresh on.
  const worktrees = useQuery({
    queryKey: queryKeys.syncSource('worktrees'),
    queryFn: () => apiClient['sync.source']({ params: { source: 'worktrees' } }),
    refetchInterval: 60_000,
  });
  const git = useQuery({
    queryKey: queryKeys.syncSource('git'),
    queryFn: () => apiClient['sync.source']({ params: { source: 'git' } }),
    refetchInterval: 60_000,
  });
  const states = [worktrees.data, git.data]
    .filter((d): d is SyncSourceResponse => !!d)
    .map((d) => worktreeHelperState(d.status));
  return (
    <Card padded data-card="worktree-helper">
      <h3 id="settings-worktree-helper">Git checks</h3>
      <p className="src" style={{ marginTop: 4 }}>
        Docket runs no git itself. The helper on this computer reads your repositories, only
        reading, so Docket can tell what each worktree holds and which branches are heading for a
        conflict. Docket still never removes a worktree.
      </p>
      <h4 className="github-h4">Worktrees</h4>
      <QueryState
        query={worktrees}
        skeleton={<Skeleton lines={2} label="Loading the worktree helper’s status" />}
      >
        {(d) => (
          <SourceStatus data={d} table={WORKTREE_HELPER_STATUS} attr="data-worktree-helper" />
        )}
      </QueryState>
      <h4 className="github-h4">Conflict radar, branches and commits</h4>
      <QueryState
        query={git}
        skeleton={<Skeleton lines={2} label="Loading the git helper’s status" />}
      >
        {(d) => <SourceStatus data={d} table={GIT_HELPER_STATUS} attr="data-git-helper" />}
      </QueryState>
      {states.length === 2 && states.some((s) => s !== 'ok') && (
        <div data-worktree-helper-steps>
          <h4 className="github-h4">Start or update the helper</h4>
          <ol className="github-steps">
            {HELPER_STEPS.map((step) => (
              <li key={step.code}>
                {step.text}
                <pre className="code" tabIndex={0} aria-label={step.text}>
                  {step.code}
                </pre>
              </li>
            ))}
          </ol>
        </div>
      )}
    </Card>
  );
}

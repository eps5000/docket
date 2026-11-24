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
    help: 'Until it reports, worktrees outside Docket’s folder show as Unknown. The steps below set it up or start it.',
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

/**
 * Settings → Connections → Worktree checks (owner decision 48; B68; UI_SPEC
 * §6.7): the helper reads worktrees that Docket's container can't reach.
 */
export function WorktreeHelperCard() {
  const query = useQuery({
    queryKey: queryKeys.syncSource('worktrees'),
    queryFn: () => apiClient['sync.source']({ params: { source: 'worktrees' } }),
    // The helper's status is bookkeeping, with no event to refresh on.
    refetchInterval: 60_000,
  });
  return (
    <Card padded data-card="worktree-helper">
      <h3 id="settings-worktree-helper">Worktree checks</h3>
      <p className="src" style={{ marginTop: 4 }}>
        The same helper reads your worktrees on this computer, so Docket can tell what each one
        holds. Docket still never removes a worktree.
      </p>
      <QueryState
        query={query}
        skeleton={<Skeleton lines={2} label="Loading the worktree helper’s status" />}
      >
        {(d) => {
          const state = worktreeHelperState(d.status);
          const status = WORKTREE_HELPER_STATUS[state];
          const error = d.status.last_error;
          return (
            <>
              <dl className="kv" data-worktree-helper={state}>
                <dt>Status</dt>
                <dd>
                  <Chip kind={status.kind}>{status.label}</Chip>
                  <div className="src">{status.help}</div>
                </dd>
                <dt>Last check</dt>
                <dd>
                  {d.status.last_success_at ? (
                    <span title={isoTitle(d.status.last_success_at)}>
                      {formatAgo(d.status.last_success_at)}
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
              {state !== 'ok' && (
                <div data-worktree-helper-steps>
                  <h4 className="github-h4">Start the helper</h4>
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
            </>
          );
        }}
      </QueryState>
    </Card>
  );
}

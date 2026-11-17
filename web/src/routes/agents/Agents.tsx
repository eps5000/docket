import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useLocation, useSearchParams } from 'react-router';
import { Skeleton } from '../../components/kit';
import { apiClient } from '../../app/queryClient';
import { QueryState } from '../../app/QueryState';
import { useShell } from '../../app/ShellState';
import { queryKeys } from '../../lib/api';
import '../screens.css';
import { ActiveRunsSection, RecentRunsSection, stateFilter } from './RunsCard';
import { WorkspacesCard } from './WorkspacesCard';

/**
 * Agents (`/agents`, UI_SPEC §6.6), three sections (B20):
 * - **Active now:** needs input, failed, stale, parked, live, reported.
 *   `?state=parked` shows one state (the Needs you strip's counts link here);
 * - **Workspaces:** every recorded worktree, "n at risk" in its header
 *   (`/agents#workspaces`);
 * - **Recent:** finished and interrupted runs from the last 24 h, collapsed
 *   by default.
 *
 * Subagent log entries aren't listed; they show on their item's Checklist.
 */
export function Agents() {
  const { scope } = useShell();
  const [params] = useSearchParams();
  const only = stateFilter(params.get('state'));
  const { hash } = useLocation();
  const query = useQuery({
    queryKey: queryKeys.agents({ scope }),
    queryFn: () => apiClient['agents.list']({ query: { scope } }),
  });

  // "n workspaces at risk" on Needs you links to `/agents#workspaces`.
  useEffect(() => {
    if (hash === '#workspaces') document.getElementById('workspaces')?.scrollIntoView();
  }, [hash]);

  return (
    <div className="agents stack">
      <h1>Agents</h1>
      <QueryState
        query={query}
        skeleton={
          <div className="card pad" data-card="runs">
            <Skeleton lines={5} label="Loading runs" />
          </div>
        }
      >
        {(d) => <ActiveRunsSection rows={d.rows} only={only} />}
      </QueryState>
      <WorkspacesCard />
      {query.data && <RecentRunsSection rows={query.data.rows} />}
    </div>
  );
}

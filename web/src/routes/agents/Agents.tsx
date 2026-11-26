import { useAgentsNow, useNoProjects } from '../../app/useBootstrap';
import { NoProjectsPointer } from '../needs-you/Welcome';
import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router';
import { Skeleton } from '../../components/kit';
import { apiClient } from '../../app/queryClient';
import { QueryState } from '../../app/QueryState';
import { useShell } from '../../app/ShellState';
import { queryKeys } from '../../lib/api';
import { plural } from '../../lib/format';
import { paths } from '../../lib/paths';
import '../screens.css';
import { ActiveRunsSection, RecentRunsSection, stateFilter } from './RunsCard';
import { WorkspacesCard } from './WorkspacesCard';

/**
 * Agents (`/agents`, UI_SPEC §6.6), three sections (B20):
 * - **Active now:** needs input, failed, stale, parked, live, reported.
 *   `?state=parked` shows one state;
 * - **Workspaces:** every recorded worktree, "n at risk" in its header
 *   (`/agents#workspaces`);
 * - **Recent:** finished and interrupted runs from the last 24 h, collapsed
 *   by default.
 *
 * Subagent log entries aren't listed; they show on their item's Checklist.
 *
 * These are **runs**: a ticket with a lead and two child runs is three rows. The
 * line under the h1 gives the ticket counts the sidebar and Overview show (decision 43).
 */
/** The number in the sidebar, and why the lists below can hold more rows than that. */
function StoriesLine() {
  const now = useAgentsNow();
  if (!now) return null;
  return (
    <p className="src agents-stories" data-agents-stories>
      <Link to={paths.overviewList('agents_working')}>
        {plural(now.working, 'ticket')} being worked
      </Link>
      {' · '}
      <Link to={paths.overviewList('agents_waiting')}>{now.waiting} parked/waiting</Link>. The lists
      below show individual runs, so one ticket can have several.
    </p>
  );
}

export function Agents() {
  const { scope } = useShell();
  const [params] = useSearchParams();
  const only = stateFilter(params.get('state'));
  const { hash } = useLocation();
  const query = useQuery({
    queryKey: queryKeys.agents({ scope }),
    queryFn: () => apiClient['agents.list']({ query: { scope } }),
    refetchInterval: 30_000,
    refetchOnMount: 'always',
  });

  // Overview's at-risk worktrees line links to `/agents#workspaces`.
  useEffect(() => {
    if (hash === '#workspaces') document.getElementById('workspaces')?.scrollIntoView();
  }, [hash]);
  const noProjects = useNoProjects();

  if (noProjects) {
    // First run (B32): a pointer to the Welcome page instead of empty run lists.
    return (
      <div className="agents stack">
        <h1>Agents</h1>
        <NoProjectsPointer />
      </div>
    );
  }

  return (
    <div className="agents stack">
      <h1>Agents</h1>
      <StoriesLine />
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

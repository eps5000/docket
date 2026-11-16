import { useQuery } from '@tanstack/react-query';
import { Skeleton } from '../../components/kit';
import { apiClient } from '../../app/queryClient';
import { QueryState } from '../../app/QueryState';
import { useShell } from '../../app/ShellState';
import { queryKeys } from '../../lib/api';
import { AgentsStrip } from './AgentsStrip';
import { DeferredCard } from './DeferredCard';
import { ForYouNow } from './ForYouNow';
import { PlanningQueueCard } from './PlanningQueueCard';
import { ProblemsCard } from './ProblemsCard';
import '../screens.css';

/**
 * Needs you (`/`, UI_SPEC §6.1): h1, Agents strip, the top band (For you
 * now · Problems) and the lower row (Deferred · Planning queue). One file per
 * card; US2 (T081) fills them. No subtitle and no scope pill.
 */
export function NeedsYou() {
  const { scope } = useShell();
  const query = useQuery({
    queryKey: queryKeys.needsYou({ scope }),
    queryFn: () => apiClient['needsYou.get']({ query: { scope } }),
  });
  return (
    <div className="needs-you">
      <h1>Needs you</h1>
      {/* The desktop-notification opt-in callout goes here (T085, UI_SPEC §6.7a). */}
      <QueryState query={query} skeleton={<NeedsYouSkeleton />}>
        {(data) => (
          <>
            <AgentsStrip counts={data.agent_counts} />
            <div className="dash-top">
              <ForYouNow rows={data.for_you_now} />
              <ProblemsCard problems={data.problems} />
            </div>
            <div className="dash-row two">
              <DeferredCard rows={data.deferred} />
              <PlanningQueueCard items={data.planning_queue} />
            </div>
          </>
        )}
      </QueryState>
    </div>
  );
}

function NeedsYouSkeleton() {
  return (
    <>
      <div className="pulse">
        <Skeleton lines={1} label="Loading agents" />
      </div>
      <div className="dash-top">
        <div className="card pad">
          <Skeleton lines={3} tall={1} label="Loading For you now" />
        </div>
        <div className="card pad">
          <Skeleton lines={4} label="Loading problems" />
        </div>
      </div>
    </>
  );
}

import { useNoProjects } from '../../app/useBootstrap';
import { Welcome } from './Welcome';
import { useQuery } from '@tanstack/react-query';
import type {
  DecisionRecord,
  OverlapRow,
  Problem,
  ProjectDecisionGroup,
  ResolutionRow,
  UndeclaredHoldRow,
  WorkspaceRow,
} from '@docket/shared';
import { Skeleton } from '../../components/kit';
import { apiClient } from '../../app/queryClient';
import { QueryState } from '../../app/QueryState';
import { useShell } from '../../app/ShellState';
import { queryKeys } from '../../lib/api';
import { useWorkspaces } from '../agents/WorkspacesCard';
import { AgentsStrip } from './AgentsStrip';
import { NotificationsCallout } from './NotificationsCallout';
import { DeferredCard } from './DeferredCard';
import { ForYouNow } from './ForYouNow';
import { OnboardingReviews } from './OnboardingReviews';
import { PlanningQueueCard } from './PlanningQueueCard';
import { ProblemsCard } from './ProblemsCard';
import { OverlapsHandled, SharedQuestions } from './SharedQuestions';
import { ResolutionCards } from './ResolutionCards';
import { ProjectDecisionCards } from './ProjectDecisionCards';
import '../screens.css';
import { HelpLink } from '../../help/HelpLink';

/**
 * Needs you (`/`, UI_SPEC §6.1): h1, Agents strip, the top band (For you
 * now · Problems) and the lower row (Deferred · Planning queue). One file per
 * card; US2 (T081) fills them. No subtitle and no scope pill. An onboarding
 * ready for review gets its own card above the top band (decision 31), and
 * so does each shared-changes question (decision 36) and each agent's new
 * project-wide decision (decision 38).
 * With no projects it is the Welcome page instead (UI_SPEC §6.0; B32).
 */
export function NeedsYou() {
  const { scope } = useShell();
  const query = useQuery({
    queryKey: queryKeys.needsYou({ scope }),
    queryFn: () => apiClient['needsYou.get']({ query: { scope } }),
  });
  // The strip's "n workspaces at risk" and the recovery rows' state chips (B20).
  const workspaces = useWorkspaces().data?.rows ?? NO_WORKSPACES;
  const atRisk = workspaces.filter((w) => w.state === 'at_risk').length;
  const noProjects = useNoProjects();
  if (noProjects) return <Welcome />;
  return (
    <div className="needs-you">
      <div className="withhelp wh-h1">
        <h1>Needs you</h1>
        <HelpLink anchor="needs-you.page" />
      </div>
      <NotificationsCallout />
      <QueryState query={query} skeleton={<NeedsYouSkeleton />}>
        {(data) => (
          <>
            <AgentsStrip
              counts={data.agent_counts}
              atRisk={atRisk}
              proposals={data.agent_file_proposals}
            />
            <OnboardingReviews sessions={data.onboarding_reviews ?? []} />
            <SharedQuestions
              overlaps={data.overlaps ?? NO_OVERLAPS}
              holds={data.undeclared_holds ?? NO_HOLDS}
            />
            <OverlapsHandled handled={data.overlaps_handled} />
            <ResolutionCards resolutions={data.resolutions ?? NO_RESOLUTIONS} />
            <ProjectDecisionCards
              cards={data.project_decisions ?? NO_DECISIONS}
              groups={data.project_decision_groups ?? NO_GROUPS}
            />
            <div className="dash-top">
              <ForYouNow rows={data.for_you_now} />
              <ProblemsCard
                problems={data.problems}
                workspaces={workspaces}
                agentProblems={data.agent_problems ?? NO_PROBLEMS}
                acknowledged={data.acknowledged ?? NO_PROBLEMS}
              />
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

const NO_WORKSPACES: readonly WorkspaceRow[] = [];
const NO_OVERLAPS: readonly OverlapRow[] = [];
const NO_HOLDS: readonly UndeclaredHoldRow[] = [];
const NO_RESOLUTIONS: readonly ResolutionRow[] = [];
const NO_PROBLEMS: readonly Problem[] = [];
const NO_DECISIONS: readonly DecisionRecord[] = [];
const NO_GROUPS: readonly ProjectDecisionGroup[] = [];

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

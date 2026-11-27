import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router';
import {
  needsYouCount,
  ownerNeedsYouCount,
  OVERVIEW_WINDOWS,
  type DecisionRecord,
  type DesignReviewRow,
  type NeedsYouResponse,
  type OverlapRow,
  type OverviewResponse,
  type ProjectDecisionGroup,
  type ResolutionRow,
  type UndeclaredHoldRow,
  type WorkspaceRow,
} from '@docket/shared';
import { Button, Card, Skeleton } from '../../components/kit';
import { QueryState } from '../../app/QueryState';
import { apiClient } from '../../app/queryClient';
import { useShell } from '../../app/ShellState';
import { NEEDS_YOU_REFRESH_MS, useNoProjects } from '../../app/useBootstrap';
import { HelpLink } from '../../help/HelpLink';
import { queryKeys } from '../../lib/api';
import { plural } from '../../lib/format';
import { paths } from '../../lib/paths';
import { useWorkspaces } from '../agents/WorkspacesCard';
import { DeferredCard } from '../needs-you/DeferredCard';
import { ForYouNow } from '../needs-you/ForYouNow';
import { NotificationsCallout } from '../needs-you/NotificationsCallout';
import { OnboardingReviews } from '../needs-you/OnboardingReviews';
import { PlanningQueueCard } from '../needs-you/PlanningQueueCard';
import { ProjectDecisionCards } from '../needs-you/ProjectDecisionCards';
import { ResolutionCards } from '../needs-you/ResolutionCards';
import { SharedQuestions } from '../needs-you/SharedQuestions';
import { Welcome } from '../needs-you/Welcome';
import { CompletedChart } from './CompletedChart';
import { FlowChart } from './FlowChart';
import { HealthCard } from './HealthCard';
import { NeedsYouGroups, needsYouProblemGroups } from './NeedsYouGroups';
import { OverviewStats } from './OverviewStats';
import { useOverviewWindow, WINDOW_LABELS, WINDOW_WORDS } from './overviewWindow';
import { UsageCard } from './UsageCard';
import { WorkloadCard } from './WorkloadCard';
import { PauseProjectAction, PausedBanners } from '../shared/ProjectPause';
import '../screens.css';
import './overview.css';

/** The numbers go stale as runs fall silent, with no event to say so. */
const METRICS_REFRESH_MS = 60_000;

/**
 * Overview (`/`; owner decision 43; UI_SPEC §6.1): are agents making progress,
 * is anything stuck, and do I need to do anything? The four numbers, then the
 * owner's actions and Health, then the charts, then the two long lists.
 *
 * Needs you keeps its own query, the one the sidebar badge reads, so the badge
 * and the section can't disagree, and a failed metric never hides an action.
 * With no projects this is the Welcome page (UI_SPEC §6.0; B32).
 *
 * Radar insights (a later batch) get their own section between the charts and
 * the long lists; nothing renders there until they exist.
 */
export function Overview() {
  const { scope } = useShell();
  const location = useLocation();
  const [window, setWindow] = useOverviewWindow();
  const needs = useQuery({
    queryKey: queryKeys.needsYou({ scope }),
    queryFn: () => apiClient['needsYou.get']({ query: { scope } }),
    refetchInterval: NEEDS_YOU_REFRESH_MS,
  });
  const metrics = useQuery({
    queryKey: queryKeys.overview({ scope, window }),
    queryFn: () => apiClient['overview.get']({ query: { scope, window } }),
    refetchInterval: METRICS_REFRESH_MS,
    // A new window keeps the old numbers until the new ones land; a new project never does.
    placeholderData: (previous, query) =>
      (query?.queryKey[3] as { scope?: string } | undefined)?.scope === scope
        ? previous
        : undefined,
  });
  const workspaces = useWorkspaces().data?.rows ?? NO_WORKSPACES;
  const noProjects = useNoProjects();

  // `#needs-you` and `#problems`: the target renders after its data, so scroll once it's there.
  const loaded = needs.data !== undefined;
  useEffect(() => {
    if (!loaded || !location.hash) return;
    const target = document.getElementById(location.hash.slice(1));
    if (!target) return;
    target.scrollIntoView?.({ block: 'start' });
    target.focus?.({ preventScroll: true });
  }, [loaded, location.hash, location.key]);

  if (noProjects) return <Welcome />;
  const count = needs.data ? ownerNeedsYouCount(needs.data) : 0;
  return (
    <div className="overview">
      <div className="ov-head">
        <div className="withhelp wh-h1">
          <h1>Overview</h1>
          <HelpLink anchor="needs-you.page" />
          {/* Only actions the owner owes drive the badge and tab title. */}
          {count > 0 && (
            <span className="src" data-needs-you-count={count}>
              {plural(count, 'thing')} to act on
            </span>
          )}
        </div>
        <div className="ov-head-actions">
          <PauseProjectAction />
          <Link to={paths.brief()} data-brief-link>
            Daily brief
          </Link>
          <div className="seg" role="group" aria-label="Time window" data-overview-window={window}>
            {OVERVIEW_WINDOWS.map((w) => (
              <button
                key={w}
                type="button"
                aria-pressed={w === window}
                title={`The last ${WINDOW_WORDS[w]}`}
                onClick={() => setWindow(w)}
              >
                {WINDOW_LABELS[w]}
              </button>
            ))}
          </div>
        </div>
      </div>
      <PausedBanners />
      <NotificationsCallout />
      {/* The numbers name the window they were counted over, even while a new one loads. */}
      <OverviewStats
        metrics={metrics.data}
        needs={needs.data}
        window={metrics.data?.window ?? window}
      />
      {metrics.isError && !metrics.data && (
        <p className="src ov-metrics-error" role="status">
          Couldn’t load the numbers.{' '}
          <Button size="sm" onClick={() => void metrics.refetch()}>
            Retry
          </Button>
        </p>
      )}
      {needs.isError && needs.data && (
        <p className="src ov-metrics-error" role="alert">
          Couldn’t refresh Needs you. Showing the last loaded counts.{' '}
          <Button
            size="sm"
            onClick={() => {
              void needs.refetch().then((result) => {
                // Only a successful, user-triggered retry moves focus. The
                // heading survives when this alert and its button unmount.
                if (result.isSuccess)
                  document.getElementById('needs-you-title')?.focus({ preventScroll: true });
              });
            }}
          >
            Try again
          </Button>
        </p>
      )}
      {needs.data ? (
        <div className="ov-main">
          <NeedsYouSection data={needs.data} workspaces={workspaces} />
          <HealthCard
            data={needs.data}
            lastBackupAt={metrics.data?.last_backup_at}
            metricsLoaded={metrics.data !== undefined}
            workspaces={workspaces}
          />
        </div>
      ) : (
        <QueryState query={needs} skeleton={<OwnerSkeleton />}>
          {(data) => <NeedsYouSection data={data} workspaces={workspaces} />}
        </QueryState>
      )}
      {metrics.data && <OverviewCharts metrics={metrics.data} />}
      <UsageCard scope={scope} window={metrics.data?.window ?? window} />
      {/* Radar insights go here (design: "Later: Radar insights"). */}
      {needs.data && (
        <div className="dash-row two">
          <PlanningQueueCard items={needs.data.planning_queue} />
          <DeferredCard rows={needs.data.deferred} />
        </div>
      )}
    </div>
  );
}

function OverviewCharts({ metrics }: { metrics: OverviewResponse }) {
  return (
    <div className="ov-charts">
      <CompletedChart completed={metrics.completed} />
      <FlowChart flow={metrics.flow} />
      <WorkloadCard workload={metrics.workload} />
    </div>
  );
}

/**
 * Every row stays reachable; the heading is the full count, while the badge
 * counts only actions the owner owes.
 */
function NeedsYouSection({
  data,
  workspaces,
}: {
  data: NeedsYouResponse;
  workspaces: readonly WorkspaceRow[];
}) {
  const count = needsYouCount(data);
  const owner = ownerNeedsYouCount(data);
  const groups = needsYouProblemGroups(data);
  const reached = groups.reached.length;
  const held = groups.heldCount;
  const summary = `${count} total, ${owner} yours, ${reached > 0 ? `${plural(reached, 'agent-owned problem')} reached you, ` : ''}${plural(held, 'coordinator hold')}.`;
  const prior = useRef<{ total: number; owner: number; reached: number; held: number } | null>(
    null,
  );
  const [announcement, setAnnouncement] = useState('');
  const [change, setChange] = useState('');
  useEffect(() => {
    const before = prior.current;
    if (!before) setAnnouncement(`Needs you: ${summary}`);
    else if (
      before.total !== count ||
      before.owner !== owner ||
      before.reached !== reached ||
      before.held !== held
    ) {
      const difference = count - before.total;
      const ownerDifference = owner - before.owner;
      const reachedDifference = reached - before.reached;
      const heldDifference = held - before.held;
      const signed = (n: number) => (n > 0 ? `+${n}` : String(n));
      const reachedChange =
        before.reached > 0 || reached > 0
          ? `agent-owned problems reaching you ${signed(reachedDifference)}, `
          : '';
      setChange(
        `Since last update: ${signed(ownerDifference)} yours, ${reachedChange}${signed(heldDifference)} ${Math.abs(heldDifference) === 1 ? 'coordinator hold' : 'coordinator holds'}; ${signed(difference)} total.`,
      );
      setAnnouncement(
        `Needs you changed: ${summary} ${difference === 0 ? 'The breakdown changed.' : difference > 0 ? `${difference} more overall.` : `${-difference} fewer overall.`}`,
      );
    }
    prior.current = { total: count, owner, reached, held };
  }, [count, owner, reached, held, summary]);
  return (
    <section id="needs-you" className="needs-you" tabIndex={-1} aria-labelledby="needs-you-title">
      <h2 id="needs-you-title" className="ov-h2" tabIndex={-1}>
        Needs you{count > 0 ? ` · ${count}` : ''}
      </h2>
      <p className="sr" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>
      {change && <p className="src ny-change">{change}</p>}
      {count === 0 ? (
        <Card padded data-card="nothing-needs-you">
          <p className="ov-nothing">
            <span aria-hidden="true">✓ </span>Nothing needs you
          </p>
        </Card>
      ) : (
        <>
          {owner === 0 && (
            <p className="ov-nothing">
              {reached > 0
                ? `Nothing for you to decide; agent-owned problems that reached you${held > 0 ? ' and coordinator holds' : ''} are listed below.`
                : 'Nothing for you to decide; coordinator holds are listed below.'}
            </p>
          )}
          {data.for_you_now.length > 0 && <ForYouNow rows={data.for_you_now} />}
          <OnboardingReviews sessions={data.onboarding_reviews ?? []} />
          <SharedQuestions
            overlaps={data.overlaps ?? NO_OVERLAPS}
            holds={data.undeclared_holds ?? NO_HOLDS}
            designReviews={data.design_reviews ?? NO_DESIGN_REVIEWS}
          />
          <ResolutionCards resolutions={data.resolutions ?? NO_RESOLUTIONS} />
          <ProjectDecisionCards
            cards={data.project_decisions ?? NO_DECISIONS}
            groups={data.project_decision_groups ?? NO_GROUPS}
          />
          <NeedsYouGroups data={data} workspaces={workspaces} />
        </>
      )}
    </section>
  );
}

const NO_WORKSPACES: readonly WorkspaceRow[] = [];
const NO_OVERLAPS: readonly OverlapRow[] = [];
const NO_HOLDS: readonly UndeclaredHoldRow[] = [];
const NO_DESIGN_REVIEWS: readonly DesignReviewRow[] = [];
const NO_RESOLUTIONS: readonly ResolutionRow[] = [];
const NO_DECISIONS: readonly DecisionRecord[] = [];
const NO_GROUPS: readonly ProjectDecisionGroup[] = [];

function OwnerSkeleton() {
  return (
    <div className="ov-main">
      <div className="card pad">
        <Skeleton lines={3} tall={1} label="Loading what needs you" />
      </div>
      <div className="card pad">
        <Skeleton lines={4} label="Loading health" />
      </div>
    </div>
  );
}

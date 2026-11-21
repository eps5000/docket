import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import type { DecisionRecord } from '@docket/shared';
import { Card, ErrorState, SegmentedControl, Skeleton } from '../../components/kit';
import { apiClient } from '../../app/queryClient';
import { useBreadcrumb } from '../../app/ShellState';
import { useBootstrap } from '../../app/useBootstrap';
import { HelpLink } from '../../help/HelpLink';
import { queryKeys } from '../../lib/api';
import { paths } from '../../lib/paths';
import { DecisionsPanel } from '../shared/DecisionsPanel';
import '../screens.css';

/** Agent-recorded and unconfirmed: what *Needs your review* shows (decision 38). */
export const needsReview = (d: DecisionRecord) => d.status === 'active' && d.authority === 'agent';

/** Every project-scope record, active and inactive, following `next_cursor` to the end. */
async function allProjectDecisions(project: string): Promise<DecisionRecord[]> {
  const out: DecisionRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await apiClient['decisions.list']({
      query: { project, scope_kind: 'project', include_inactive: true, cursor },
    });
    out.push(...page.items);
    cursor = page.next_cursor ?? undefined;
  } while (cursor);
  return out;
}

/**
 * A project's Decisions page (`/projects/:key/decisions`; owner decision 38;
 * UI_SPEC §6.3.7): every project-scope record, managed in one place, with
 * *Confirm*, *Supersede*, *Withdraw…* and *+ Record a decision* (scope
 * Project), each undoable from its toast. *All* or *Needs your review*
 * (agents' unconfirmed records; `?filter=review`). `?decision=` scrolls to
 * one record and focuses it (the Needs you card's *Open*).
 */
export function ProjectDecisionsPage() {
  const { key = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const review = params.get('filter') === 'review';
  const focus = params.get('decision');
  const boot = useBootstrap();
  const project = boot.data?.projects.find((p) => p.key === key);
  const name = project?.name ?? key;
  useBreadcrumb({
    crumbs: [
      { kind: 'text', text: name },
      { kind: 'current', text: 'Decisions' },
    ],
  });
  const query = useQuery({
    queryKey: queryKeys.decisions({ project: key, scope_kind: 'project', include_inactive: true }),
    queryFn: () => allProjectDecisions(key),
    enabled: project !== undefined,
  });
  const records = query.data;
  const toReview = records?.filter(needsReview).length ?? 0;

  // The Needs you card's *Open*: once the record is on the page, scroll to it and focus it.
  // On the next frame: with cached data this runs in the navigation's commit, and the shell's
  // own effect (a parent's, so it runs after this one) then moves focus to the view.
  const ready = records !== undefined;
  useEffect(() => {
    if (!ready || !focus) return;
    let el: HTMLElement | undefined;
    const frame = requestAnimationFrame(() => {
      el = Array.from(document.querySelectorAll<HTMLElement>('[data-decision]')).find(
        (e) => e.dataset.decision === focus,
      );
      if (!el) return;
      el.tabIndex = -1;
      el.classList.add('focused');
      el.scrollIntoView?.({ block: 'center' });
      el.focus({ preventScroll: true });
    });
    return () => {
      cancelAnimationFrame(frame);
      el?.classList.remove('focused');
    };
  }, [ready, focus, review]);

  const setFilter = (next: 'all' | 'review') => {
    const p = new URLSearchParams(params);
    if (next === 'review') p.set('filter', 'review');
    else p.delete('filter');
    p.delete('decision');
    setParams(p, { replace: true });
  };

  if (boot.data && !project) {
    return (
      <div className="projdec">
        <h1>Decisions</h1>
        <Card padded>
          <p style={{ margin: 0 }}>
            <span className="muted">There’s no project {key}. </span>
            <Link to={paths.settings()}>See your projects in Settings</Link>
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div className="projdec" data-project={key}>
      <div className="withhelp wh-h1">
        <h1>Project decisions · {name}</h1>
        <HelpLink anchor="decisions.project-page" />
      </div>
      <p className="src projdec-lede">
        Decisions that apply to every item in {key}. Agents get them with every item’s context;
        tickets show only their own, their epic’s and their labels’, with one line pointing here.
      </p>
      <div className="projdec-filter">
        <SegmentedControl
          label="Show decisions"
          value={review ? 'review' : 'all'}
          onChange={setFilter}
          options={[
            { key: 'all', label: 'All' },
            { key: 'review', label: `Needs your review${records ? ` (${toReview})` : ''}` },
          ]}
        />
      </div>
      {query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : !records ? (
        <div className="card pad">
          <Skeleton lines={3} label="Loading decisions" />
        </div>
      ) : (
        <DecisionsPanel
          place={{ kind: 'project', project: key, name }}
          records={review ? records.filter(needsReview) : records}
          alwaysOpen
          revealInactive={records.some((d) => d.id === focus && d.status !== 'active')}
          emptyText={
            review
              ? 'Nothing to review. Agents’ project-wide decisions wait here until you confirm, supersede or withdraw them.'
              : undefined
          }
        />
      )}
    </div>
  );
}

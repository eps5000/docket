import { useQuery } from '@tanstack/react-query';
import { useEffect, useId, useRef } from 'react';
import { useSearchParams } from 'react-router';
import type { ItemDetailResponse, Problem, ResolutionRow } from '@docket/shared';
import { apiClient } from '../../app/queryClient';
import { HelpLink } from '../../help/HelpLink';
import { queryKeys } from '../../lib/api';
import { plural } from '../../lib/format';
import { KindActions } from '../needs-you/ProblemsCard';
import { DesignReviewCard, HoldCard, OverlapCard } from '../needs-you/SharedQuestions';
import {
  PROBLEM_TITLES,
  ProblemActions,
  ProblemLines,
  ResolutionView,
  WarningMark,
  WhoChip,
} from '../shared/problems';

/**
 * The problem banner (owner decision 37; UI_SPEC §6.3): at the top of every
 * tab while the item has an open problem, acknowledged or not, until it is
 * resolved. Each says what's wrong, what fixes it and who acts, with a
 * warning icon, any proposed resolution, "Acknowledged by you <when>", and
 * the same actions as the Problems card. Several stack, with a count.
 * `?problem=<id>` (the Problems card's *Open*) focuses that one.
 *
 * Open overlap and undeclared-changes questions on the item are problems
 * too: their cards, with their decisions, stack here as well.
 */
export function ProblemBanners({ data }: { data: ItemDetailResponse }) {
  const id = data.item.id;
  const [params] = useSearchParams();
  const focus = params.get('problem');
  const problems = data.problems ?? NO_PROBLEMS;
  const resolutions = data.resolutions ?? NO_RESOLUTIONS;
  const shared = useQuery({
    queryKey: queryKeys.itemShared(id),
    queryFn: () => apiClient['itemShared.get']({ params: { id } }),
  });
  const overlaps = (shared.data?.overlaps ?? []).filter((o) => o.state === 'open');
  const holds = (shared.data?.holds ?? []).filter((h) => h.state === 'open');
  // Decision 39: an open review of a change to an approved design pauses this item.
  const designs = (shared.data?.design_reviews ?? []).filter((d) => d.state === 'open');
  const total =
    problems.length + resolutions.length + overlaps.length + holds.length + designs.length;
  const root = useRef<HTMLElement>(null);
  const focused = useRef<string | null>(null);

  // Focus the problem `?problem=` names, once per id, when it has rendered.
  useEffect(() => {
    if (!focus || focused.current === focus || !root.current) return;
    const el = [...root.current.querySelectorAll<HTMLElement>('[data-problem-id]')].find(
      (x) => x.dataset.problemId === focus,
    );
    if (!el) return;
    focused.current = focus;
    el.focus();
    el.scrollIntoView?.({ block: 'nearest' });
  }, [focus, total]);

  if (total === 0) return null;
  return (
    <section
      ref={root}
      className="prob-banners"
      aria-label={`Problems with ${id}`}
      data-banner="problems"
    >
      {total > 1 && <p className="prob-count">{plural(total, 'open problem')}</p>}
      {problems.map((p) => (
        <ProblemBanner key={p.id ?? p.kind} problem={p} focused={p.id === focus} />
      ))}
      {resolutions.map((r) => (
        <ResolutionBanner key={r.id} resolution={r} />
      ))}
      {designs.map((d) => (
        <DesignReviewCard key={d.id} review={d} banner />
      ))}
      {overlaps.map((o) => (
        <OverlapCard key={o.id} overlap={o} banner />
      ))}
      {holds.map((h) => (
        <HoldCard key={h.id} hold={h} banner />
      ))}
    </section>
  );
}

const NO_PROBLEMS: readonly Problem[] = [];
const NO_RESOLUTIONS: readonly ResolutionRow[] = [];

function ProblemBanner({ problem: p, focused }: { problem: Problem; focused: boolean }) {
  const titleId = useId();
  const e = p.explanation;
  const title =
    p.kind === 'radar_conflict' && p.related.length === 0
      ? 'Out of date with main'
      : PROBLEM_TITLES[p.kind];
  return (
    <div
      className={`banner prob${focused ? ' focused' : ''}${p.acknowledged ? ' acked' : ''}`}
      data-problem={p.kind}
      data-problem-id={p.id}
      tabIndex={-1}
      role="group"
      aria-labelledby={titleId}
    >
      <WarningMark label={p.acknowledged ? 'Problem (acknowledged)' : 'Problem'} />
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="row wrap" style={{ gap: 6 }}>
          <b id={titleId}>{title}</b>
          {e && <WhoChip e={e} />}
        </div>
        {e ? (
          <ProblemLines e={e} reachedYou={p.reached_you} acknowledged={p.acknowledged} />
        ) : (
          <p>{p.reason}</p>
        )}
        {p.resolution && <ResolutionView resolution={p.resolution} />}
        <div className="row wrap prob-acts">
          <KindActions problem={p} place="banner" />
          <ProblemActions problem={p} place="banner" />
          <HelpLink anchor="item.problem-banner" />
        </div>
      </div>
    </div>
  );
}

function ResolutionBanner({ resolution: r }: { resolution: ResolutionRow }) {
  const titleId = useId();
  return (
    <div
      className="banner prob"
      data-problem-id={r.id}
      tabIndex={-1}
      role="group"
      aria-labelledby={titleId}
    >
      <WarningMark label="Proposed resolution" />
      <div className="grow" style={{ minWidth: 0 }}>
        <b id={titleId}>An agent proposes a change to this item</b>
        <ResolutionView resolution={r} />
        <div className="row wrap prob-acts">
          <HelpLink anchor="item.problem-banner" />
        </div>
      </div>
    </div>
  );
}

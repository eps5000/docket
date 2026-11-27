import { needsYouProblemActor, type BriefDecision, type NeedsYouResponse } from '@docket/shared';
import { plural } from '../../lib/format';
import { paths } from '../../lib/paths';

export interface BriefLine {
  key: string;
  to: string;
  /** The ticket key, when the line is about one ticket. */
  id: string | null;
  title: string;
  meta: string;
}

/**
 * One line per owner action, from the response the badge reads.
 */
export function needsYouLines(v: NeedsYouResponse): BriefLine[] {
  const lines: BriefLine[] = [];
  for (const r of v.for_you_now) {
    lines.push({
      key: r.kind === 'packet' ? r.packet_id : r.question_id,
      to: paths.item(r.item_id),
      id: r.item_id,
      title: r.title,
      meta: r.kind === 'packet' ? 'Review packet ready' : `Question from ${r.asked_by}`,
    });
  }
  for (const s of v.onboarding_reviews ?? []) {
    lines.push({
      key: s.id,
      to: paths.work({ onboarding: s.id }),
      id: null,
      title: `Onboarding of ${s.project_name}`,
      meta: 'Ready for your review',
    });
  }
  for (const o of v.overlaps ?? []) {
    const [a, b] = o.items;
    lines.push({
      key: o.id,
      to: paths.item(a?.id ?? ''),
      id: a?.id ?? null,
      title: b ? `${a?.title} and ${b.id}` : (a?.title ?? 'Overlap'),
      meta: 'Overlap to decide',
    });
  }
  for (const h of v.undeclared_holds ?? []) {
    lines.push({
      key: h.id,
      to: paths.item(h.item.id),
      id: h.item.id,
      title: h.item.title,
      meta: 'Held hand-off to decide',
    });
  }
  for (const d of v.design_reviews ?? []) {
    lines.push({
      key: d.id,
      to: paths.item(d.item.id),
      id: d.item.id,
      title: d.item.title,
      meta: 'Design change to review',
    });
  }
  for (const r of v.resolutions ?? []) {
    lines.push({
      key: r.id,
      to: paths.item(r.item_id),
      id: r.item_id,
      title: r.reason,
      meta: `Proposed fix from ${r.proposed_by}`,
    });
  }
  for (const d of v.project_decisions ?? []) {
    lines.push({
      key: d.id,
      to: paths.projectDecisions(d.project, { filter: 'review', decision: d.id }),
      id: null,
      title: d.title,
      meta: `Project-wide decision by ${d.author}`,
    });
  }
  for (const g of v.project_decision_groups ?? []) {
    lines.push({
      key: `group:${g.project}`,
      to: paths.projectDecisions(g.project, { filter: 'review' }),
      id: null,
      title: `${plural(g.decisions.length, 'project-wide decision')} in ${g.project}`,
      meta: 'By agents, to review',
    });
  }
  v.problems
    .filter((p) => needsYouProblemActor(p) === 'owner')
    .forEach((p, index) => {
      lines.push({
        key: p.id ?? `problem:${index}`,
        to: p.item_id
          ? paths.item(p.item_id, undefined, undefined, p.id)
          : `${paths.overview()}#problems`,
        id: p.item_id,
        title: p.title ?? p.reason,
        meta: p.explanation?.what ?? p.reason,
      });
    });
  return lines;
}

const CHANGE_WORDS: Record<BriefDecision['change'], [string, string]> = {
  recorded: ['You recorded this', 'An agent recorded this'],
  replaced: ['You replaced an earlier decision', 'An agent replaced an earlier decision'],
  confirmed: ['You confirmed this', 'Confirmed'],
  withdrawn: ['You withdrew this', 'An agent withdrew this'],
  acknowledged: ['You acknowledged this', 'Acknowledged'],
};

export const decisionChangeText = (d: Pick<BriefDecision, 'change' | 'by'>) =>
  CHANGE_WORDS[d.change][d.by === 'owner' ? 0 : 1];

/** A decision about one ticket links to it; a wider one to its project's Decisions page. */
export const decisionLink = (d: BriefDecision) =>
  d.item_id
    ? paths.item(d.item_id)
    : paths.projectDecisions(d.project, { decision: d.decision_id });

/** "Nov 23" from `2026-11-23`, without moving it through a timezone. */
export function briefDayText(day: string): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

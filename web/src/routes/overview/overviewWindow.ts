import { useCallback, useState } from 'react';
import {
  DEFAULT_OVERVIEW_WINDOW,
  OVERVIEW_WINDOWS,
  type NeedsYouResponse,
  type OverviewWindow,
  needsYouProblemActor,
} from '@docket/shared';
import { readString, STORAGE_KEYS, writeString } from '../../lib/persistence';

export const WINDOW_LABELS: Record<OverviewWindow, string> = {
  '24h': '24h',
  '7d': '7d',
  '30d': '30d',
};

/** "the previous 7 days": what a comparison is against. */
export const WINDOW_WORDS: Record<OverviewWindow, string> = {
  '24h': '24 hours',
  '7d': '7 days',
  '30d': '30 days',
};

export const isOverviewWindow = (v: string | null | undefined): v is OverviewWindow =>
  (OVERVIEW_WINDOWS as readonly string[]).includes(v ?? '');

/** The last choice in this browser, or 7 days. Storage may be missing or hold anything. */
export function readOverviewWindow(): OverviewWindow {
  const stored = readString(STORAGE_KEYS.overviewWindow);
  return isOverviewWindow(stored) ? stored : DEFAULT_OVERVIEW_WINDOW;
}

export function useOverviewWindow(): [OverviewWindow, (w: OverviewWindow) => void] {
  const [window, setWindow] = useState(readOverviewWindow);
  const choose = useCallback((w: OverviewWindow) => {
    setWindow(w);
    writeString(STORAGE_KEYS.overviewWindow, w);
  }, []);
  return [window, choose];
}

/**
 * The owner's actions by kind, for the Needs you card. The parts always add up
 * to `ownerNeedsYouCount`, the badge's number (`overview.test.tsx` holds them to it).
 */
export function ownerActionParts(v: NeedsYouResponse) {
  const packets = v.for_you_now.filter((r) => r.kind === 'packet').length;
  return {
    reviews: packets + (v.onboarding_reviews?.length ?? 0),
    questions: v.for_you_now.length - packets,
    decisions:
      (v.overlaps?.length ?? 0) +
      (v.undeclared_holds?.length ?? 0) +
      (v.design_reviews?.length ?? 0) +
      (v.resolutions?.length ?? 0) +
      (v.project_decisions?.length ?? 0) +
      (v.project_decision_groups?.length ?? 0),
    problems: v.problems.filter((p) => needsYouProblemActor(p) === 'owner').length,
  };
}

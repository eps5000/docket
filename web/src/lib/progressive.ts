import { startTransition, useEffect, useState } from 'react';

/** Cards or rows rendered in the first commit: more than a 1440×900 screen shows. */
export const FIRST_RENDER = 60;
/** Added per follow-up commit. */
export const RENDER_STEP = 400;

/**
 * Render a long list progressively (B18, SC-013): the first `first` entries
 * in the first commit, then `step` more per follow-up commit, as low-priority
 * transitions, until all `total` are there. A board of 5,000 items appears in
 * well under a second, and the rest fills in below the fold right after.
 * Nothing is dropped: every entry is rendered within a few frames.
 */
export function useRenderLimit(total: number, first = FIRST_RENDER, step = RENDER_STEP): number {
  const [limit, setLimit] = useState(first);
  useEffect(() => {
    if (limit >= total) return;
    const id = setTimeout(() => startTransition(() => setLimit((l) => l + step)), 0);
    return () => clearTimeout(id);
  }, [limit, total, step]);
  return Math.min(limit, total);
}

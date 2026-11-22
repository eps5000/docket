import type { Page } from '@playwright/test';
import type { NeedsYouResponse } from '@docket/shared';

/**
 * The tab title the owner should see now (owner decision 41): every card on
 * Needs you plus the Problems that reached them, read from the same API the
 * page uses, in the page's session. The sum mirrors `needsYouCount`, which the
 * unit tests cover; e2e imports only types from the shared package.
 */
export async function needsYouTitle(page: Page, scope = 'all'): Promise<string> {
  const view = await page.evaluate(async (s) => {
    const res = await fetch(`/api/needs-you?scope=${encodeURIComponent(s)}`);
    return (await res.json()) as NeedsYouResponse;
  }, scope);
  const n =
    view.for_you_now.length +
    view.problems.length +
    (view.onboarding_reviews?.length ?? 0) +
    (view.overlaps?.length ?? 0) +
    (view.undeclared_holds?.length ?? 0) +
    (view.design_reviews?.length ?? 0) +
    (view.resolutions?.length ?? 0) +
    (view.project_decisions?.length ?? 0) +
    (view.project_decision_groups?.length ?? 0);
  return n > 0 ? `(${n}) Docket` : 'Docket';
}

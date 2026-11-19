/** Types for the parts of ui-sweep.mjs the e2e specs import (web/e2e/layout.spec.ts). */
export interface LayoutReport {
  /** How far the page scrolls sideways, in px (0 is fine). */
  sideways: number;
  /** Elements outside their parent with nothing between that scrolls or clips. */
  overflowCount: number;
  /** The first few of them, described. */
  overflow: string[];
  /** `.pbar i` fills less than 2 px tall. */
  flatCount: number;
  flat: string[];
}

/** The sweep's layout checks on a Playwright page as it is now. */
export function layoutReport(page: unknown): Promise<LayoutReport>;

export const WCAG_TAGS: string[];
export const SCREENS: [string, string][];

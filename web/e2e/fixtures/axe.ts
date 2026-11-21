/**
 * The axe helper (tasks.md T062; UI_SPEC §11): scan the page with the WCAG
 * 2.1 A and AA rules in both themes, and fail on serious or critical
 * violations. The theme is applied the way the app applies it
 * (`data-theme` on the `.tl` body), and the media query is emulated to match.
 */
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';

/** WCAG 2.1 AA rule set (constitution Principle V). */
export const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

export type ThemeName = 'light' | 'dark';
export const THEMES: readonly ThemeName[] = ['light', 'dark'];

export type AxeResults = Awaited<ReturnType<AxeBuilder['analyze']>>;

/** Violations that fail a test: serious or critical impact. */
export function seriousViolations(results: AxeResults) {
  return results.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => ({
      id: v.id,
      impact: v.impact,
      help: v.help,
      nodes: v.nodes.length,
      targets: v.nodes.slice(0, 3).map((n) => n.target.join(' ')),
    }));
}

/** Switch the page to a theme without reloading (the app's own mechanism). */
export async function setTheme(page: Page, theme: ThemeName): Promise<void> {
  await page.emulateMedia({ colorScheme: theme });
  await page.evaluate((t) => {
    document.body.dataset.theme = t;
  }, theme);
}

export interface AxeSummary {
  theme: ThemeName;
  passes: number;
  violations: number;
  serious: ReturnType<typeof seriousViolations>;
}

/**
 * Scan in each theme; returns one summary per theme. Callers assert
 * `serious` is empty (see `expectAxeClean` in fixtures/index.ts).
 */
export async function axeInThemes(
  page: Page,
  opts: { include?: string; exclude?: string[]; themes?: readonly ThemeName[] } = {},
): Promise<AxeSummary[]> {
  const out: AxeSummary[] = [];
  for (const theme of opts.themes ?? THEMES) {
    await setTheme(page, theme);
    // A toast mid-fade has partial opacity, so axe measures a false contrast
    // failure. Wait for animations that end; the live-run pulse never does.
    await page.evaluate(() =>
      Promise.all(
        document
          .getAnimations()
          .filter((a) => a.effect?.getComputedTiming().endTime !== Infinity)
          .map((a) => a.finished.catch(() => undefined)),
      ),
    );
    let builder = new AxeBuilder({ page }).withTags(WCAG_TAGS);
    if (opts.include) builder = builder.include(opts.include);
    for (const ex of opts.exclude ?? []) builder = builder.exclude(ex);
    const results = await builder.analyze();
    out.push({
      theme,
      passes: results.passes.length,
      violations: results.violations.length,
      serious: seriousViolations(results),
    });
  }
  return out;
}

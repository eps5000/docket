import AxeBuilder from '@axe-core/playwright';
import { test as base, expect } from '@playwright/test';

/** WCAG 2.1 AA rule set (constitution Principle V). */
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

type Fixtures = {
  /** An axe scan of the current page, limited to WCAG 2.1 A and AA rules. */
  makeAxeBuilder: () => AxeBuilder;
};

export const test = base.extend<Fixtures>({
  makeAxeBuilder: async ({ page }, use) => {
    await use(() => new AxeBuilder({ page }).withTags(WCAG_TAGS));
  },
});

/** Violations that fail a test: serious or critical impact. */
export function seriousViolations(results: Awaited<ReturnType<AxeBuilder['analyze']>>) {
  return results.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length }));
}

export { expect };

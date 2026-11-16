/**
 * The end-to-end harness (tasks.md T062). Import `test` and `expect` from
 * here:
 * - `makeAxeBuilder()` / `expectAxeClean(page)`: WCAG 2.1 AA scans, both
 *   themes by default (fixtures/axe.ts);
 * - `ownerPage`: a page whose context is already unlocked (fixtures/unlock.ts);
 * - `agent`: an MCP client connected to `/mcp` with the official SDK
 *   (fixtures/mcp.ts), closed after the test;
 * - `useSeededContainer()`: reset the sample seed once per test file
 *   (fixtures/container.ts);
 * - notification helpers (fixtures/notifications.ts).
 */
import AxeBuilder from '@axe-core/playwright';
import { test as base, expect, type Page } from '@playwright/test';
import { axeInThemes, seriousViolations, WCAG_TAGS, type AxeSummary, type ThemeName } from './axe';
import { connectAgent, type McpAgent } from './mcp';
import { unlock } from './unlock';

type Fixtures = {
  /** An axe scan of the current page, limited to WCAG 2.1 A and AA rules. */
  makeAxeBuilder: () => AxeBuilder;
  /** A page in an unlocked browser context. */
  ownerPage: Page;
  /** An MCP agent session (name `e2e-agent`). */
  agent: McpAgent;
};

export const test = base.extend<Fixtures>({
  makeAxeBuilder: async ({ page }, use) => {
    await use(() => new AxeBuilder({ page }).withTags(WCAG_TAGS));
  },
  ownerPage: async ({ page }, use) => {
    await unlock(page.context());
    await use(page);
  },
  // Playwright needs the destructuring pattern even with no dependencies.
  // eslint-disable-next-line no-empty-pattern
  agent: async ({}, use) => {
    const agent = await connectAgent();
    await use(agent);
    await agent.close();
  },
});

/** Scan in both themes and fail on any serious or critical violation. Logs the summary. */
export async function expectAxeClean(
  page: Page,
  label: string,
  opts: { include?: string; exclude?: string[]; themes?: readonly ThemeName[] } = {},
): Promise<AxeSummary[]> {
  const results = await axeInThemes(page, opts);
  for (const r of results) {
    console.log(
      `axe ${label} [${r.theme}]: ${r.passes} rules passed, ${r.violations} violations, ${r.serious.length} serious or critical`,
    );
  }
  expect(
    results
      .filter((r) => r.serious.length > 0)
      .map((r) => ({ theme: r.theme, serious: r.serious })),
    `axe on ${label}`,
  ).toEqual([]);
  return results;
}

export { expect, seriousViolations };
export { useSeededContainer, resetSeededContainer, ownerKey, agentToken } from './container';
export { unlock, unlockViaUi, lock } from './unlock';
export { connectAgent } from './mcp';
export { setTheme, THEMES } from './axe';
export {
  grantNotifications,
  denyNotifications,
  recordNotifications,
  recordedNotifications,
} from './notifications';

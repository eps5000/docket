/**
 * Owner views at scale, in the browser (tasks.md T143; SC-013: "owner views
 * appear in under 1 second"). On demand only: it needs a container loaded
 * with the scale data set, which no other spec may reset.
 *
 *   # 1. Generate and keep the data set (server/tests/perf/scale.test.ts)
 *   DOCKET_PERF_KEEP=/tmp/tl-scale pnpm --filter @docket/server perf
 *   # 2. Copy it into a throwaway volume, owned by uid 10001, and start the image on it
 *   # 3. Run only this spec against it
 *   DOCKET_E2E_PERF=1 DOCKET_E2E_NO_START=1 DOCKET_E2E_CONTAINER=<name> \
 *     pnpm --filter @docket/web exec playwright test e2e/perf-scale.spec.ts
 *
 * Each view is timed twice: a cold load (a fresh page: HTML, the bundle, the
 * API calls and the first render) and a switch inside the app (the router
 * and TanStack Query, as the owner moves between views). Both must be
 * under 1 s, until the view's own content is on screen.
 */
import { expect, test, type Page } from '@playwright/test';
import { unlock } from './fixtures/unlock';

const BUDGET_MS = 1_000;

test.describe('owner views at scale (T143)', () => {
  test.skip(!process.env.DOCKET_E2E_PERF, 'Set DOCKET_E2E_PERF=1 against the scale data set.');

  const views: { name: string; path: string; ready: (page: Page) => Promise<void> }[] = [
    {
      name: 'Overview',
      path: '/',
      ready: (p) => expect(p.getByRole('heading', { name: /^For you now/ })).toBeVisible(),
    },
    {
      name: 'Work board (all, 5,000 items)',
      path: '/work',
      ready: (p) => expect(p.locator('.board .tcard').first()).toBeVisible(),
    },
    {
      name: 'Work list (all)',
      path: '/work?layout=list',
      ready: (p) => expect(p.getByRole('table').first()).toBeVisible(),
    },
    {
      name: 'Work map (all)',
      path: '/work?layout=map',
      ready: (p) => expect(p.locator('.pm-node').first()).toBeVisible(),
    },
    {
      name: 'Work timeline (all)',
      path: '/work?layout=timeline',
      ready: (p) => expect(p.locator('[data-card="timeline-grid"]')).toBeVisible(),
    },
    {
      name: 'Ticket page',
      path: '/items/PXF-21',
      ready: (p) => expect(p.getByRole('heading', { level: 1 })).toBeVisible(),
    },
    {
      name: 'Epic page',
      path: '/items/PXF-1',
      ready: (p) => expect(p.getByRole('heading', { level: 1 })).toBeVisible(),
    },
    {
      name: 'Label page',
      path: '/labels/PXF/area-1',
      ready: (p) => expect(p.getByRole('heading', { level: 1 })).toBeVisible(),
    },
    {
      name: 'Agents',
      path: '/agents',
      ready: (p) => expect(p.getByRole('heading', { level: 1 })).toBeVisible(),
    },
    {
      name: 'Settings',
      path: '/settings',
      ready: (p) => expect(p.getByRole('heading', { level: 1 })).toBeVisible(),
    },
  ];

  test('every owner view is on screen in under 1 s', async ({ browser }) => {
    test.setTimeout(300_000);
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addInitScript(() => localStorage.setItem('docket.notifications', 'off'));
    await unlock(context);
    const rows: string[] = ['| View | Cold load ms | In-app switch ms |', '|---|---|---|'];
    const slow: string[] = [];
    // Warm the browser's cache of the bundle once, as a returning owner has it.
    const warm = await context.newPage();
    await warm.goto('/');
    await views[0]!.ready(warm);
    for (const v of views) {
      const page = await context.newPage();
      const t0 = Date.now();
      await page.goto(v.path);
      await v.ready(page);
      const cold = Date.now() - t0;
      // In-app: start from Overview, then navigate with the router.
      await page.evaluate(() => window.history.pushState({}, '', '/'));
      await page.evaluate(() => window.dispatchEvent(new PopStateEvent('popstate')));
      await views[0]!.ready(page);
      const t1 = Date.now();
      await page.evaluate((path) => {
        window.history.pushState({}, '', path);
        window.dispatchEvent(new PopStateEvent('popstate'));
      }, v.path);
      await v.ready(page);
      const inApp = Date.now() - t1;
      rows.push(`| ${v.name} | ${cold} | ${inApp} |`);
      if (cold >= BUDGET_MS || inApp >= BUDGET_MS) slow.push(`${v.name}: ${cold} / ${inApp} ms`);
      await page.close();
    }
    console.log(rows.join('\n'));
    await context.close();
    expect(slow).toEqual([]);
  });
});

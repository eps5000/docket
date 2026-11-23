/**
 * B59 (owner decision 48): flow trends on Overview and the daily brief, by mouse
 * and keyboard, with axe in both themes at 1440 and 1024 px on the stress data,
 * plus the PR's screenshots (DOCKET_E2E_SCREENSHOTS). All fixture text is made up.
 */
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import type { BriefResponse, OverviewResponse } from '@docket/shared';
import { mockGet } from './fixtures/api-mocks';
import { expect, expectAxeClean, setTheme, test, unlock, useSeededContainer } from './fixtures';

useSeededContainer();

const out = process.env.DOCKET_E2E_SCREENSHOTS;
const SIZES = [
  { name: '1440', width: 1440, height: 900 },
  { name: '1024', width: 1024, height: 768 },
] as const;

test.beforeEach(async ({ page }) => {
  await unlock(page.context());
  await page.context().addInitScript(() => localStorage.setItem('docket.notifications', 'off'));
});

const api = <T>(page: Page, path: string) =>
  page.evaluate(async (p) => (await (await fetch(p)).json()) as unknown, path) as Promise<T>;
const flowCard = (page: Page) => page.locator('[data-card="flow-chart"]');
const tip = (page: Page) => page.locator('[data-flow-tip]');
const section = (page: Page, id: string) => page.locator(`[data-brief-section="${id}"]`);

const NOTE = 'Parking is up while finished tickets are down (parked 15 to 116, finished 8 to 2).';

/** The slide the pilot saw, as synthetic numbers on the real response. */
async function withTrend(page: Page) {
  await page.goto('/');
  const real = await api<OverviewResponse>(page, '/api/overview?scope=all&window=7d');
  const shape = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
    [8, 7, 15],
    [5, 8, 45],
    [2, 7, 91],
    [2, 1, 116],
  ];
  const buckets = real.flow.buckets.map((b, k, all) => {
    const [finished, merged, parked] = shape[shape.length - all.length + k] ?? [0, 0, 0];
    return { ...b, finished: finished!, merged: merged!, parked: parked! };
  });
  const sum = (key: 'finished' | 'merged' | 'parked') => buckets.reduce((n, b) => n + b[key], 0);
  await mockGet(page, '/api/overview', {
    ...real,
    // The Completed chart shows the same finished tickets as Flow.
    completed: {
      ...real.completed,
      count: sum('finished'),
      buckets: real.completed.buckets.map((b, k) => ({
        ...b,
        count: buckets[k]?.finished ?? 0,
        tickets: [],
      })),
    },
    flow: {
      ...real.flow,
      buckets,
      finished: sum('finished'),
      merged: sum('merged'),
      parked: sum('parked'),
      finished_without_merge: 4,
      note: NOTE,
    },
  });
  return buckets;
}

const line = (k: number) => ({
  id: `STR-${40 + k}`,
  title: `A long made-up ticket title that has to be cut short on a narrow screen, number ${k + 1}`,
  project: 'STR',
});

/** Every section full, including a run held by an owner decision. */
const fullBrief = (real: BriefResponse): BriefResponse => ({
  ...real,
  finished: {
    count: 14,
    rows: Array.from({ length: 8 }, (_, k) => ({ ...line(k), closed_at: real.to })),
  },
  stuck: {
    parked: {
      count: 11,
      rows: Array.from({ length: 8 }, (_, k) => ({
        ...line(k + 10),
        since: new Date(Date.parse(real.to) - (k + 2) * 86_400_000).toISOString(),
        next: `Next step on STR-${70 + k}: shape it or assign it`,
      })),
    },
    unowned_blockers: {
      count: 3,
      rows: [0, 1, 2].map((k) => ({
        ...line(k + 20),
        status: 'planning' as const,
        blocks: 5 - k,
      })),
    },
    held: {
      count: 1,
      rows: [
        {
          ...line(30),
          since: real.to,
          decision_id: 'dec_sample',
          decision_title: 'Hold the export work until the new format is agreed',
        },
      ],
    },
  },
  decisions: {
    count: 2,
    rows: [
      {
        decision_id: 'dec_a',
        title: 'Use the short date format everywhere',
        change: 'recorded',
        by: 'owner',
        at: real.to,
        project: 'STR',
        item_id: 'STR-41',
      },
      {
        decision_id: 'dec_b',
        title: 'Keep drafts for thirty days',
        change: 'replaced',
        by: 'agent',
        at: real.to,
        project: 'STR',
        item_id: null,
      },
    ],
  },
});

async function noSideScroll(page: Page) {
  const over = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(over).toBeLessThanOrEqual(0);
}

test('Overview shows the three trends, the note and what merged really counts', async ({
  page,
}) => {
  await withTrend(page);
  await page.goto('/');
  const card = flowCard(page);
  await expect(card.getByRole('heading', { name: 'Flow per day' })).toBeVisible();
  await expect(card.locator('[data-flow-note]')).toHaveText(NOTE);
  await expect(card.locator('[data-flow-merged]')).toContainText(
    'Merged counts only PRs an agent recorded in Docket.',
  );
  await expect(card.locator('[data-flow-merged]')).toContainText('may be higher');
  // The text alternative has the same numbers.
  const table = card.getByRole('table', { includeHidden: true });
  await expect(table.locator('tbody tr').last().locator('td')).toHaveText(['2', '1', '116']);
});

test('the flow tooltip works by mouse and keyboard', async ({ page }) => {
  const buckets = await withTrend(page);
  await page.goto('/');
  const last = buckets.at(-1)!;
  const bar = page.locator(`[data-flow-bar="${last.key}"]`);
  await bar.hover();
  await expect(tip(page)).toHaveAttribute('data-flow-tip', last.key);
  await expect(tip(page)).toContainText('116');
  await page.mouse.move(0, 0);
  await expect(tip(page)).toHaveCount(0);

  await bar.focus();
  await expect(tip(page)).toHaveAttribute('data-flow-tip', last.key);
  await page.keyboard.press('ArrowLeft');
  await expect(tip(page)).toHaveAttribute('data-flow-tip', buckets.at(-2)!.key);
  await page.keyboard.press('Escape');
  await expect(tip(page)).toHaveCount(0);
});

test('Overview links to the brief, which shows every section', async ({ page }) => {
  await page.goto('/');
  await page.locator('[data-brief-link]').click();
  await expect(page).toHaveURL(/\/brief$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Daily brief' })).toBeVisible();
  for (const name of [/^What finished/, /^What’s stuck/, /^What needs you/, /^What changed/]) {
    await expect(page.getByRole('heading', { level: 2, name })).toBeVisible();
  }
  await expect(page.getByRole('heading', { name: /cost/i })).toHaveCount(0);
});

test('each line opens its ticket, and the held group is separate', async ({ page }) => {
  await page.goto('/brief');
  const real = await api<BriefResponse>(page, '/api/brief?scope=all');
  await mockGet(page, '/api/brief', fullBrief(real));
  await page.goto('/brief');
  const held = section(page, 'stuck').locator('[data-brief-group="held"]');
  await expect(held).toContainText('Held by your decision · 1');
  await expect(held).toContainText('Nothing is wrong.');
  await section(page, 'finished')
    .getByRole('link', { name: /STR-40/ })
    .click();
  await expect(page).toHaveURL(/\/items\/STR-40/);
});

test('the day can be chosen, and Today returns', async ({ page }) => {
  await page.goto('/brief');
  const real = await api<BriefResponse>(page, '/api/brief?scope=all');
  const [y, m, d] = real.today.split('-').map(Number) as [number, number, number];
  const previous = new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
  await page.getByLabel('Day', { exact: true }).fill(previous);
  await expect(page).toHaveURL(new RegExp(`day=${previous}`));
  await expect(page.locator('.brief')).toHaveAttribute('data-brief-day', previous);
  await expect(section(page, 'stuck')).toContainText('Shown as it is now.');
  await page.getByRole('button', { name: 'Today' }).click();
  await expect(page).toHaveURL(/\/brief$/);
  await expect(page.locator('.brief')).toHaveAttribute('data-brief-day', real.today);
});

for (const size of SIZES) {
  test(`axe and layout at ${size.name} on the stress data`, async ({ page }) => {
    await page.setViewportSize({ width: size.width, height: size.height });
    await withTrend(page);
    await page.goto('/');
    await expect(flowCard(page).locator('[data-flow-note]')).toBeVisible();
    await noSideScroll(page);
    await expectAxeClean(page, `Overview flow: ${size.name}`);

    await page.goto('/brief');
    const real = await api<BriefResponse>(page, '/api/brief?scope=all');
    await mockGet(page, '/api/brief', fullBrief(real));
    await page.goto('/brief');
    await expect(section(page, 'stuck').locator('[data-brief-group="held"]')).toBeVisible();
    await noSideScroll(page);
    await expectAxeClean(page, `Daily brief: ${size.name}`);
  });
}

test.describe('screenshots', () => {
  test.skip(!out, 'Set DOCKET_E2E_SCREENSHOTS to a folder to capture screenshots.');

  async function shoot(page: Page, name: string, size: (typeof SIZES)[number], full = false) {
    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme);
      await page.screenshot({
        path: join(out!, `b59-${name}-${size.name}-${theme}.png`),
        fullPage: full,
      });
    }
  }

  for (const size of SIZES) {
    test(`flow trends and the brief at ${size.name}`, async ({ page }) => {
      await page.setViewportSize({ width: size.width, height: size.height });
      const buckets = await withTrend(page);
      await page.goto('/');
      const card = flowCard(page);
      await expect(card.locator('[data-flow-note]')).toBeVisible();
      await card.scrollIntoViewIfNeeded();
      await shoot(page, 'overview-flow', size);
      await page.locator(`[data-flow-bar="${buckets.at(-1)!.key}"]`).focus();
      await expect(tip(page)).toBeVisible();
      await shoot(page, 'overview-flow-tooltip', size);
      await page.keyboard.press('Escape');

      await page.goto('/brief');
      const real = await api<BriefResponse>(page, '/api/brief?scope=all');
      await mockGet(page, '/api/brief', fullBrief(real));
      await page.goto('/brief');
      await expect(section(page, 'stuck').locator('[data-brief-group="held"]')).toBeVisible();
      await shoot(page, 'brief', size);
      await shoot(page, 'brief-full', size, true);
    });
  }
});

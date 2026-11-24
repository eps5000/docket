/**
 * B70 (owner decision 54): Pick next epic on the real stress project, and on
 * made-up rows for the states the seed doesn't have, by mouse and keyboard,
 * with axe in both themes at 1440 x 900 and 1024 px, plus the PR's screenshots
 * (DOCKET_E2E_SCREENSHOTS).
 */
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import type { EpicPick, PickEpicResponse, WorkResponse } from '@docket/shared';
import { mockGet } from './fixtures/api-mocks';
import { expect, expectAxeClean, setTheme, test, unlock, useSeededContainer } from './fixtures';

useSeededContainer();

const out = process.env.DOCKET_E2E_SCREENSHOTS;
const SIZES = [
  { name: '1440', width: 1440, height: 900 },
  { name: '1024', width: 1024, height: 768 },
] as const;
const PAGE = '/projects/STR/next-epic';

test.beforeEach(async ({ page }) => {
  await unlock(page.context());
  await page.context().addInitScript(() => {
    localStorage.setItem('docket.notifications', 'off');
    sessionStorage.setItem('docket.scope', 'STR');
  });
});

const pick = (id: string, title: string, over: Partial<EpicPick>): EpicPick => ({
  id,
  title,
  status: 'progress',
  priority: 2,
  open: 18,
  self_contained: 18,
  can_start: {
    count: 4,
    first: [
      { id: 'STR-40', title: 'A ready ticket' },
      { id: 'STR-41', title: 'Another ready ticket' },
      { id: 'STR-42', title: 'A third ready ticket' },
    ],
  },
  waits_on: [],
  waiting: { queued: 0, blocked: 0 },
  unblocks_elsewhere: 0,
  not_shaped: 0,
  worked_by: [],
  fit: 'available',
  park_reason: null,
  ...over,
});

/** All three groups, with made-up epics. */
const GROUPS: PickEpicResponse = {
  project: 'STR',
  paused: false,
  best: {
    id: 'STR-3',
    reason: 'Nothing outside this epic blocks it, and finishing it unblocks 27 tickets.',
  },
  epics: [
    pick('STR-3', 'Checkout flow', { unblocks_elsewhere: 27 }),
    pick('STR-5', 'Search filters', {
      open: 12,
      self_contained: 10,
      unblocks_elsewhere: 4,
      not_shaped: 2,
      waits_on: [{ epic: 'STR-3', title: 'Checkout flow', tickets: 2 }],
    }),
    pick('STR-2', 'Account settings', {
      open: 6,
      self_contained: 6,
      worked_by: [{ who: 'agent-a · worker', role: 'lead', items: ['STR-44'] }],
      fit: 'being_worked',
    }),
    pick('STR-4', 'Reporting dashboards with a long title that has to wrap inside its table cell', {
      open: 9,
      self_contained: 1,
      can_start: { count: 0, first: [] },
      waits_on: [
        { epic: 'STR-3', title: 'Checkout flow', tickets: 5 },
        { epic: 'STR-5', title: 'Search filters', tickets: 2 },
        { epic: null, title: null, tickets: 1 },
      ],
      fit: 'likely_parks',
      park_reason: 'Nothing can start: 8 of 9 tickets wait on work outside this epic.',
    }),
  ],
};

const root = (page: Page) => page.locator('[data-pick-epic="STR"]');
const rowOf = (page: Page, id: string) => page.locator(`[data-pick-row="${id}"]`);

async function openGroups(page: Page) {
  await mockGet(page, '/api/projects/STR/pick-epic', GROUPS);
  await page.goto(PAGE);
  await expect(root(page).locator('[data-best-next]')).toBeVisible();
}

test('one click from Work, and the table agrees with the real stress data', async ({ page }) => {
  await page.goto('/work');
  await page.locator('[data-pick-epic-link]').click();
  await expect(page).toHaveURL(new RegExp(`${PAGE}$`));
  await expect(root(page).getByRole('table')).toBeVisible();

  const data = (await page.evaluate(
    async () => (await (await fetch('/api/projects/STR/pick-epic')).json()) as unknown,
  )) as PickEpicResponse;
  expect(data.epics.length).toBeGreaterThan(0);
  await expect(root(page).locator('[data-pick-row]')).toHaveCount(data.epics.length);
  await expect(root(page).getByText('Based on dependencies recorded in Docket.')).toHaveCount(1);
  for (const e of data.epics) {
    const row = rowOf(page, e.id);
    await expect(row.locator('[data-col="own"]')).toHaveText(`${e.self_contained} of ${e.open}`);
    await expect(row.locator('[data-col="unblocks"]')).toHaveText(String(e.unblocks_elsewhere));
  }
  if (data.best) {
    const best = root(page).locator('[data-best-next]');
    await expect(best).toHaveAttribute('data-pick-row', data.best.id);
    await expect(best.locator('[data-best-reason]')).toHaveText(data.best.reason);
  }
});

test('the groups say why, and each row links out', async ({ page }) => {
  await openGroups(page);
  await expect(root(page).locator('tbody[data-pick-group]')).toHaveCount(3);
  const parks = rowOf(page, 'STR-4');
  await expect(parks.locator('[data-park-reason]')).toContainText('Nothing can start');
  await expect(rowOf(page, 'STR-2')).toContainText('agent-a · worker');

  await parks.getByRole('link', { name: 'Search filters' }).click();
  await expect(page).toHaveURL(/\/items\/STR-5$/);
  await page.goBack();
  await rowOf(page, 'STR-3')
    .getByRole('link', { name: /^Critical path/ })
    .click();
  await expect(page).toHaveURL(/\/items\/STR-3\?tab=map&goal=STR-3$/);
});

test('columns sort by keyboard, inside each group', async ({ page }) => {
  await openGroups(page);
  const head = page.getByRole('columnheader', { name: /Can finish on its own/ });
  await head.getByRole('button').focus();
  await page.keyboard.press('Enter');
  await expect(head).toHaveAttribute('aria-sort', 'descending');
  await page.keyboard.press('Enter');
  await expect(head).toHaveAttribute('aria-sort', 'ascending');
  const first = root(page).locator('[data-pick-group="available"] [data-pick-row]').first();
  await expect(first).toHaveAttribute('data-pick-row', 'STR-5');
  await expect(root(page).locator('[data-pick-group="likely_parks"] [data-pick-row]')).toHaveCount(
    1,
  );
  await page.keyboard.press('Enter');
  await expect(head).not.toHaveAttribute('aria-sort', /.+/);
  await expect(first).toHaveAttribute('data-pick-row', 'STR-3');
});

test('a paused project says "once resumed" and keeps its counts', async ({ page }) => {
  await mockGet(page, '/api/projects/STR/pick-epic', { ...GROUPS, paused: true });
  await page.goto(PAGE);
  await expect(page.getByRole('button', { name: 'Can start once resumed' })).toBeVisible();
  await expect(rowOf(page, 'STR-3').locator('[data-col="start"]')).toContainText('4');
  await expect(root(page).locator('.pick-paused')).toContainText('once you resume it');
});

test('no epic qualifies, and no epics at all', async ({ page }) => {
  await mockGet(page, '/api/projects/STR/pick-epic', {
    ...GROUPS,
    best: null,
    epics: GROUPS.epics.slice(2),
  });
  await page.goto(PAGE);
  await expect(root(page).locator('.pick-none')).toContainText('No epic is free');
  await expect(root(page).locator('[data-best-next]')).toHaveCount(0);

  await page.unroute(/pick-epic/);
  await mockGet(page, '/api/projects/STR/pick-epic', { ...GROUPS, best: null, epics: [] });
  await page.reload();
  await expect(root(page).getByText(/No open epic has open tickets yet/)).toBeVisible();
});

test('epic cards and the epic page show the indicator in words', async ({ page }) => {
  await page.goto('/work');
  await expect(page.locator('a.epiccard').first()).toBeVisible();
  const work = (await page.evaluate(
    async () =>
      (await (await fetch('/api/work?scope=STR&layout=board&quick=active')).json()) as unknown,
  )) as WorkResponse;
  const epic = work.epics.find((e) => e.waits_on !== undefined);
  expect(epic, 'the stress project has an open epic with open tickets').toBeTruthy();
  const words = epic!.waits_on!.length === 0 ? 'No outside dependencies' : /Waits on/;
  const card = page.locator(`a.epiccard[href="/items/${epic!.id}"]`);
  await expect(card.locator('[data-epic-deps]')).toContainText(words);

  await page.goto(`/items/${epic!.id}`);
  await expect(page.locator('.epicdeps-line')).toContainText(words);
  for (const w of epic!.waits_on!) {
    if (w.epic) {
      await expect(
        page.locator('.epicdeps-line').getByRole('link', { name: w.title ?? w.epic }),
      ).toHaveAttribute('href', `/items/${w.epic}`);
    }
  }
});

for (const size of SIZES) {
  test(`stress data: axe and no page overflow at ${size.name}`, async ({ page }) => {
    await page.setViewportSize({ width: size.width, height: size.height });
    await page.goto(PAGE);
    await expect(root(page).getByRole('table')).toBeVisible();
    await expectAxeClean(page, `Pick next epic on stress data at ${size.name}`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      size.width,
    );
    if (out) {
      for (const theme of ['light', 'dark'] as const) {
        await setTheme(page, theme);
        await page.screenshot({ path: join(out, `b70-stress-${size.name}-${theme}.png`) });
      }
    }
  });

  test(`all groups: axe and no page overflow at ${size.name}`, async ({ page }) => {
    await page.setViewportSize({ width: size.width, height: size.height });
    await openGroups(page);
    await expectAxeClean(page, `Pick next epic groups at ${size.name}`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      size.width,
    );
    if (out) {
      for (const theme of ['light', 'dark'] as const) {
        await setTheme(page, theme);
        await page.screenshot({ path: join(out, `b70-groups-${size.name}-${theme}.png`) });
      }
    }
  });

  test(`the indicator: axe at ${size.name}`, async ({ page }) => {
    await page.setViewportSize({ width: size.width, height: size.height });
    await page.goto('/work');
    await expect(page.locator('a.epiccard [data-epic-deps]').first()).toBeVisible();
    await expectAxeClean(page, `Work with the epic indicator at ${size.name}`, {
      include: '[data-card="epics"]',
    });
    if (out) {
      for (const theme of ['light', 'dark'] as const) {
        await setTheme(page, theme);
        await page.screenshot({ path: join(out, `b70-indicator-${size.name}-${theme}.png`) });
      }
    }
  });
}

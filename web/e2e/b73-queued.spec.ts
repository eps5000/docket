/**
 * B73 (owner decision 57): Queued instead of Blocked, on the seeded projects
 * and the 300-item stress project. A ticket waiting its turn behind moving work
 * is calm and says "Queued · Starts after …"; red Blocked is kept for a wait
 * that needs attention, and says why. The counts agree across Work, Overview
 * and the API, status is never colour alone, and axe passes in both themes at
 * 1440 x 900 and 1024 px, plus the PR's screenshots (DOCKET_E2E_SCREENSHOTS).
 */
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import type { OverviewResponse, WorkResponse } from '@docket/shared';
import { expect, expectAxeClean, setTheme, test, unlock, useSeededContainer } from './fixtures';

useSeededContainer();

const out = process.env.DOCKET_E2E_SCREENSHOTS;
const SIZES = [
  { name: '1440', width: 1440, height: 900 },
  { name: '1024', width: 1024, height: 768 },
] as const;

const inScope = async (page: Page, scope: string) => {
  await unlock(page.context());
  await page.context().addInitScript((s) => {
    localStorage.setItem('docket.notifications', 'off');
    sessionStorage.setItem('docket.scope', s);
  }, scope);
};

const api = async <T>(page: Page, path: string): Promise<T> =>
  page.evaluate(async (p) => (await fetch(p)).json(), path) as Promise<T>;

const chip = (page: Page, name: string) =>
  page.getByRole('button', { name: new RegExp(`^${name}\\b`) });
const chipCount = async (page: Page, name: string) =>
  Number(await chip(page, name).first().locator('b').textContent());

const shots = async (page: Page, name: string) => {
  if (!out) return;
  for (const theme of ['light', 'dark'] as const) {
    await setTheme(page, theme);
    await page.screenshot({ path: join(out, `b73-${name}-${theme}.png`) });
  }
};

test('a ticket behind moving work is Queued and calm; a loop is Blocked and says so', async ({
  page,
}) => {
  await inScope(page, 'RCP');
  await page.goto('/work?layout=list');
  const row = (id: string) => page.locator('tr', { has: page.locator(`a[href="/items/${id}"]`) });
  // RCP-16 waits on DOC-4 (a live lead) and RCP-19 (a packet in review): both are moving.
  const queued = row('RCP-16').locator('[data-wait]');
  await expect(queued).toHaveAttribute('data-wait', 'queued');
  await expect(queued).toHaveText('◷ Queued · Starts after RCP-19’s design and 1 more');
  await expect(row('RCP-16').locator('.st-blocked')).toHaveCount(0);

  // DOC-7 and DOC-8 block each other: that needs attention.
  await inScope(page, 'DOC');
  await page.goto('/work?layout=list');
  const loop = row('DOC-7').locator('[data-wait]');
  await expect(loop).toHaveAttribute('data-wait', 'blocked');
  await expect(loop).toHaveAttribute('data-wait-reason', 'cycle');
  await expect(loop).toContainText('⊘ Blocked · Blocker loop');
  await expect(loop).toHaveAttribute('title', /loop back through/);

  // The item page spells the reason out, and the blockers in neutral words.
  await page.goto('/items/RCP-16');
  await expect(page.locator('[data-wait="queued"]').first()).toHaveText(
    '◷ Queued · Starts after RCP-19’s design and 1 more',
  );
  await expect(page.locator('[data-open-blockers]')).toContainText('Open blockers:');
  await page.goto('/items/DOC-7');
  await expect(page.locator('[data-wait="blocked"]').first()).toContainText(
    'Its blockers loop back through',
  );
});

test('Queued and Blocked are separate filters, and their counts agree everywhere', async ({
  page,
}) => {
  await inScope(page, 'STR');
  await page.goto('/work?layout=list');
  await expect(chip(page, 'Queued').first()).toBeVisible();
  const o = await api<OverviewResponse>(page, '/api/overview?scope=STR&window=7d');
  const byQuick = async (q: string) =>
    (await api<WorkResponse>(page, `/api/work?scope=STR&layout=list&quick=${q}`)).items;
  const queued = await byQuick('queued');
  const blocked = await byQuick('blocked');
  expect(queued.length + blocked.length).toBeGreaterThan(0);
  expect(queued.every((i) => i.wait?.kind === 'queued')).toBe(true);
  expect(blocked.every((i) => i.wait?.kind === 'blocked' && i.wait.reason !== null)).toBe(true);
  expect(queued.length).toBe(o.queued);
  expect(blocked.length).toBe(o.blocked);
  await expect.poll(() => chipCount(page, 'Queued')).toBe(o.queued);
  await expect.poll(() => chipCount(page, 'Blocked')).toBe(o.blocked);

  // Overview's In flight card says both, each linking to its filter.
  await page.goto('/');
  const counts = page.locator('[data-wait-counts]');
  await expect(counts).toHaveText(`Queued ${o.queued} · Blocked ${o.blocked}`);
  await counts.getByRole('link', { name: `Queued ${o.queued}` }).click();
  await expect(page).toHaveURL(/\/work\?quick=queued$/);
  await expect(chip(page, 'Queued').first()).toHaveAttribute('aria-pressed', 'true');

  // The brief lists what is Blocked, with why, and counts what is Queued.
  await page.goto('/brief');
  if (o.blocked > 0) {
    await expect(page.locator('[data-brief-group="blocked"] h3')).toHaveText(
      `Blocked · ${o.blocked}`,
    );
  }
  if (o.queued > 0) {
    await expect(page.locator('[data-brief-queued]')).toContainText('queued');
  }
});

test('status is never colour alone, and the Map legend says queued and blocked', async ({
  page,
}) => {
  await inScope(page, 'STR');
  await page.goto('/work?layout=list');
  const chips = page.locator('[data-layout="list"] [data-wait]');
  await expect(chips.first()).toBeVisible();
  const texts = await chips.allTextContents();
  for (const t of texts) expect(t).toMatch(/Queued|Blocked|Held/);

  await page.goto('/work?layout=map');
  const legend = page.locator('.pm-legend');
  await expect(legend).toBeVisible();
  await expect(legend).not.toContainText('ready but blocked');
  const bar = page.locator('.pm-head .pbar');
  await expect(bar).not.toHaveAttribute('aria-label', /ready but blocked/);
  await expect(bar).toHaveAttribute('aria-label', /\d+ queued, \d+ blocked/);
});

for (const size of SIZES) {
  test(`stress data: Work, Overview and the brief pass axe at ${size.name}`, async ({ page }) => {
    await page.setViewportSize({ width: size.width, height: size.height });
    await inScope(page, 'STR');
    const noOverflow = async () =>
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        size.width,
      );

    await page.goto('/work?layout=list');
    await expect(page.locator('[data-layout="list"] [data-wait]').first()).toBeVisible();
    await expectAxeClean(page, `Work list on stress data at ${size.name}`);
    await noOverflow();
    await shots(page, `stress-list-${size.name}`);

    await page.goto('/work?layout=board');
    await expect(page.locator('[data-layout="board"]')).toBeVisible();
    await expectAxeClean(page, `Work board on stress data at ${size.name}`);
    await noOverflow();
    await shots(page, `stress-board-${size.name}`);

    await page.goto('/work?layout=map');
    await expect(page.locator('.pm-legend')).toBeVisible();
    await expectAxeClean(page, `Work map on stress data at ${size.name}`, { include: '.pm-head' });
    await shots(page, `stress-map-${size.name}`);

    await page.goto('/');
    await expect(page.locator('[data-wait-counts]')).toBeVisible();
    await expectAxeClean(page, `Overview on stress data at ${size.name}`);
    await noOverflow();
    await shots(page, `stress-overview-${size.name}`);

    await page.goto('/brief');
    await expect(page.getByRole('heading', { name: /^What’s stuck/ })).toBeVisible();
    await expectAxeClean(page, `Brief on stress data at ${size.name}`);
    await noOverflow();
    await shots(page, `stress-brief-${size.name}`);
  });

  test(`Queued and Blocked side by side: axe at ${size.name}`, async ({ page }) => {
    await page.setViewportSize({ width: size.width, height: size.height });
    await inScope(page, 'RCP');
    const noOverflow = async () =>
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        size.width,
      );

    await page.goto('/work?layout=list&quick=queued');
    await expect(page.locator('[data-layout="list"] [data-wait="queued"]').first()).toBeVisible();
    await expectAxeClean(page, `Work list, Queued, at ${size.name}`);
    await noOverflow();
    await shots(page, `queued-list-${size.name}`);

    await page.goto('/work?layout=board');
    const ready = page.locator('[data-layout="board"] section.col[aria-label="Ready"]');
    await ready.getByRole('button', { name: /^Waiting/ }).click();
    await expect(ready.locator('[data-wait="queued"]').first()).toBeVisible();
    await expectAxeClean(page, `Work board, Waiting open, at ${size.name}`);
    await noOverflow();
    await shots(page, `queued-board-${size.name}`);

    await page.goto('/items/RCP-16');
    await expect(page.locator('[data-wait="queued"]').first()).toBeVisible();
    await expectAxeClean(page, `Item page, Queued, at ${size.name}`);
    await noOverflow();
    await shots(page, `queued-item-${size.name}`);

    await page.goto('/items/RCP-1');
    await expect(page.locator('[data-ticket="RCP-16"] [data-wait]')).toBeVisible();
    await expectAxeClean(page, `Epic tickets at ${size.name}`);
    await shots(page, `queued-epic-${size.name}`);

    await inScope(page, 'DOC');
    await page.goto('/work?layout=list&quick=blocked');
    await expect(page.locator('[data-layout="list"] [data-wait="blocked"]').first()).toBeVisible();
    await expectAxeClean(page, `Work list, Blocked, at ${size.name}`);
    await noOverflow();
    await shots(page, `blocked-list-${size.name}`);

    await page.goto('/items/DOC-7');
    await expect(page.locator('[data-wait="blocked"]').first()).toBeVisible();
    await expectAxeClean(page, `Item page, Blocked, at ${size.name}`);
    await shots(page, `blocked-item-${size.name}`);
  });
}

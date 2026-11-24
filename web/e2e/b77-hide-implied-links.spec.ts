/**
 * B77 (owner decision 60): the dependency map hides implied links. The seed has
 * RCP-11 → RCP-12 → RCP-22; this spec adds the shortcut RCP-11 → RCP-22, which
 * that chain already shows.
 *
 * - The epic Map tab and Work → Map leave the shortcut out while *Hide implied
 *   links* is on (the default), with "1 hidden" beside it; off draws it, and a
 *   reload remembers that.
 * - The link itself is unchanged: RCP-22's Dependencies tab lists both
 *   blockers, with "Also implied through RCP-12" on RCP-11.
 * - axe in both themes, no horizontal overflow, and screenshots at 1440 x 900
 *   and 1024 px (DOCKET_E2E_SCREENSHOTS).
 */
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import {
  connectAgent,
  expect,
  expectAxeClean,
  setTheme,
  test,
  unlock,
  useSeededContainer,
} from './fixtures';

useSeededContainer();

const out = process.env.DOCKET_E2E_SCREENSHOTS;
const SIZES = [
  { name: '1440', width: 1440, height: 900 },
  { name: '1024', width: 1024, height: 768 },
] as const;
const HELP = 'Hides an arrow when a chain of other arrows already connects the same two tickets.';

const map = (page: Page) => page.locator('[data-progress-map]');
const shortcut = (page: Page) =>
  map(page).locator('path.pm-edge[data-from="RCP-11"][data-to="RCP-22"]');
const toggle = (page: Page) => map(page).getByRole('switch', { name: 'Hide implied links' });

const shots = async (page: Page, name: string) => {
  if (!out) return;
  for (const theme of ['light', 'dark'] as const) {
    await setTheme(page, theme);
    await page.screenshot({ path: join(out, `b77-${name}-${theme}.png`) });
  }
  await setTheme(page, 'light');
};

const noOverflow = async (page: Page, width: number) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    width,
  );

test.beforeAll(async () => {
  const agent = await connectAgent('codex');
  const res = await agent.call('link_items', { from: 'RCP-11', to: 'RCP-22', type: 'blocks' });
  await agent.close();
  expect(res.isError, res.text).toBe(false);
});

test.beforeEach(async ({ page }) => {
  await unlock(page.context());
  await page.context().addInitScript(() => {
    localStorage.setItem('docket.notifications', 'off');
    sessionStorage.setItem('docket.scope', 'RCP');
  });
});

test('the epic map hides the implied arrow by default, shows it when off, and remembers', async ({
  page,
}) => {
  await page.goto('/items/RCP-1?tab=map');
  await expect(
    map(page).locator('path.pm-edge[data-from="RCP-12"][data-to="RCP-22"]'),
  ).toBeAttached();
  await expect(toggle(page)).toBeChecked();
  await expect(shortcut(page)).toHaveCount(0);
  await expect(map(page).locator('[data-implied-hidden]')).toHaveText('1 hidden');
  await expect(map(page).locator('.pm-implied')).toHaveAttribute('title', HELP);
  await expect(toggle(page)).toHaveAccessibleDescription(HELP);

  // The chain is still traced; the hidden arrow isn't.
  await map(page).locator('.pm-node[data-pid="RCP-11"]').hover();
  await expect(map(page).locator('.pm-node[data-pid="RCP-12"]')).toHaveClass(/\bhl\b/);
  await expect(map(page).locator('.pm-node[data-pid="RCP-22"]')).toHaveClass(/\bdim\b/);
  await page.mouse.move(0, 0);

  const before = await map(page).locator('path.pm-edge').count();
  await toggle(page).click();
  await expect(toggle(page)).not.toBeChecked();
  await expect(shortcut(page)).toHaveCount(1);
  await expect(map(page).locator('path.pm-edge')).toHaveCount(before + 1);
  await expect(map(page).locator('[data-implied-hidden]')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('docket.mapHideImplied'))).toBe('off');

  await page.reload();
  await expect(toggle(page)).not.toBeChecked();
  await expect(shortcut(page)).toHaveCount(1);

  // Back on, and the default is stored as nothing.
  await toggle(page).click();
  await expect(shortcut(page)).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('docket.mapHideImplied'))).toBeNull();
});

test('Work → Map, the project map, hides it too', async ({ page }) => {
  await page.goto('/work?layout=map&epic=RCP-1');
  await expect(
    map(page).locator('path.pm-edge[data-from="RCP-12"][data-to="RCP-22"]'),
  ).toBeAttached();
  await expect(shortcut(page)).toHaveCount(0);
  await expect(map(page).locator('[data-implied-hidden]')).toHaveText(/\d+ hidden/);
});

test('the Dependencies tab lists both blockers and notes the implied one', async ({ page }) => {
  await page.goto('/items/RCP-22?tab=deps');
  const deps = page.locator('[data-section="deps"]');
  await expect(deps.getByRole('heading', { name: /^Waits on 2 · unblocks/ })).toBeVisible();
  await expect(deps.locator('.pm-node[data-pid="RCP-12"]')).toBeVisible();
  await expect(deps.locator('.pm-node[data-pid="RCP-11"]')).toBeVisible();
  await expect(deps.locator('[data-implied="RCP-11"]')).toContainText(
    'Also implied through RCP-12',
  );
  await expect(deps.locator('[data-implied]')).toHaveCount(1);
});

for (const size of SIZES) {
  test(`axe in both themes, no overflow and screenshots at ${size.name}`, async ({ page }) => {
    await page.setViewportSize({ width: size.width, height: size.height });

    await page.goto('/items/RCP-1?tab=map');
    await expect(map(page).locator('[data-implied-hidden]')).toHaveText('1 hidden');
    await expectAxeClean(page, `epic Map with implied links hidden at ${size.name}`);
    await noOverflow(page, size.width);
    await shots(page, `epic-map-hidden-${size.name}`);

    await toggle(page).click();
    await expect(shortcut(page)).toHaveCount(1);
    await expectAxeClean(page, `epic Map with every arrow at ${size.name}`);
    await shots(page, `epic-map-all-${size.name}`);
    await toggle(page).click();

    await page.goto('/items/RCP-22?tab=deps');
    await expect(page.locator('[data-implied="RCP-11"]')).toBeVisible();
    await expectAxeClean(page, `Dependencies tab with the note at ${size.name}`);
    await noOverflow(page, size.width);
    await shots(page, `deps-note-${size.name}`);
  });
}

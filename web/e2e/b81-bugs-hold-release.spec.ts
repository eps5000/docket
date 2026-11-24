/**
 * B84: open bugs hold the epic's mandatory Release. The seeded RCP-1 has one
 * unlinked bug; this spec adds a bug in the chain. Synthetic data only.
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
} from './fixtures/index';
import type { McpAgent } from './fixtures/mcp';

useSeededContainer();

const out = process.env.DOCKET_E2E_SCREENSHOTS;
const SIZES = [
  { name: '1440', width: 1440, height: 900 },
  { name: '1024', width: 1024, height: 768 },
] as const;

async function shots(page: Page, name: string) {
  if (!out) return;
  for (const theme of ['light', 'dark'] as const) {
    await setTheme(page, theme);
    await page.screenshot({ path: join(out, `b84-${name}-${theme}.png`) });
  }
  await setTheme(page, 'light');
}

let agent: McpAgent;
let chainBug = '';
let release = '';

const ok = async (tool: string, args: Record<string, unknown>) => {
  const res = await agent.call(tool, args);
  expect(res.isError, res.text).toBe(false);
  return res;
};

test.beforeAll(async () => {
  agent = await connectAgent('codex');
  const found = await ok('search_items', { project: 'RCP', epic: 'RCP-1', type: ['Release'] });
  release = (found.structured.items as { id: string }[])[0]!.id;
  const created = await ok('create_item', {
    project: 'RCP',
    type: 'Bug',
    title: 'Synthetic: the share link drops the last day',
    epic: 'RCP-1',
    status: 'planning',
  });
  chainBug = (created.structured.item as { id: string }).id;
  await ok('link_items', { from: chainBug, to: 'RCP-22', type: 'blocks' });
});
test.afterAll(async () => agent.close());

test.beforeEach(async ({ page }) => {
  await unlock(page.context());
  await page.context().addInitScript(() => {
    localStorage.setItem('docket.notifications', 'off');
    sessionStorage.setItem('docket.scope', 'RCP');
  });
});

const map = (page: Page) => page.locator('[data-progress-map]');

test('the map keeps unlinked bugs left and the Release alone in the last column', async ({
  page,
}) => {
  await page.goto('/items/RCP-1?tab=map');
  const bugs = map(page).locator('[data-col="bugs"]');
  await expect(bugs.locator('[data-pid="RCP-17"]')).toBeVisible();
  await expect(map(page).locator('.pm-col').first()).toHaveAttribute('data-col', 'bugs');
  await expect(map(page).locator(`[data-pid="${chainBug}"] [data-bug-mark]`)).toHaveText('bug');
  await expect(map(page).locator('path.pm-edge[data-to="RCP-17"]')).toHaveCount(0);

  const columns = map(page).locator('.pm-col');
  await expect(columns.last()).toHaveAttribute('data-col', 'release');
  await expect(columns.last().locator('[data-pid]')).toHaveCount(1);
  const card = columns.last().locator(`[data-pid="${release}"]`);
  await expect(card.locator('[data-release-badge]')).toContainText('Waiting on 2 bugs');
  await expect(map(page).locator(`path.pm-edge[data-to="${release}"]`)).toHaveCount(0);
});

test('the epic and Release name the bugs, and canceling one requires a reason', async ({
  page,
}) => {
  await page.goto('/items/RCP-1');
  const line = page.locator(`[data-release="${release}"]`);
  await expect(line).toContainText('Waiting on 2 bugs');
  await expect(line.getByRole('link', { name: 'RCP-17' })).toBeVisible();
  await expect(line.getByRole('link', { name: chainBug })).toBeVisible();

  await page.goto(`/items/${release}`);
  const hold = page.locator('[data-release-hold="RCP-1"]');
  await expect(hold).toContainText('2 bugs open');
  await expect(hold).toContainText('Review and Done wait');

  await page.goto('/items/RCP-17');
  await expect(page.locator('[data-bug-holds="RCP-1"]')).toContainText('holds RCP-1’s Release');
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Cancel item…' }).click();
  const box = page.locator('[data-cancel-confirm]');
  await expect(box).toContainText('Reason (required)');
  const go = box.getByRole('button', { name: 'Cancel item' });
  await expect(go).toBeDisabled();
  await box.getByRole('textbox').fill('Synthetic reason');
  await expect(go).toBeEnabled();
  await box.getByRole('button', { name: 'Keep item' }).click();
});

test('Work, Pick next epic and the digest count both open bugs', async ({ page }) => {
  await page.goto('/work');
  await expect(page.locator(`[data-epic-release="${release}"]`)).toContainText(
    'Release waiting on 2 bugs',
  );
  await page.goto('/projects/RCP/next-epic');
  await expect(page.locator('[data-pick-row="RCP-1"] [data-pick-release]')).toContainText(
    `Release ${release}`,
  );
  const digest = await ok('get_digest', { project: 'RCP' });
  expect(digest.text).toContain(`RCP-1 Release ${release} waits on 2 bugs`);
  expect(digest.text).toContain(chainBug);
});

for (const size of SIZES) {
  test(`axe and screenshots at ${size.name} in both themes`, async ({ page }) => {
    await page.setViewportSize({ width: size.width, height: size.height });
    for (const [name, path] of [
      ['map', '/items/RCP-1?tab=map'],
      ['epic', '/items/RCP-1?tab=details'],
      ['release', `/items/${release}`],
      ['pick', '/projects/RCP/next-epic'],
    ] as const) {
      await page.goto(path);
      await expectAxeClean(page, `${name} ${size.name}`);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        size.width,
      );
      await shots(page, `${name}-${size.name}`);
      if (name === 'map') {
        await map(page).locator('.pm-col').last().scrollIntoViewIfNeeded();
        await expect(map(page).locator('.pm-col').last()).toBeInViewport();
        await shots(page, `map-release-column-${size.name}`);
      }
    }
  });
}

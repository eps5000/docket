/**
 * B81 (owner decision 64): open bugs hold back an epic's release, on the seeded
 * RCP-1 with synthetic tickets an agent adds over MCP. RCP-17 is the seed's bug
 * with no links; this spec adds a bug RCP-22 waits on (part of the chain),
 * marks RCP-22 as the finish line, and adds the shortcut RCP-11 → RCP-22 that
 * the chain RCP-11 → RCP-12 → RCP-22 already shows.
 *
 * - The epic Map tab: a Bugs column left of the waves with RCP-17 and "1 bug
 *   open", the chain bug in its wave with a bug marker, no arrow from the Bugs
 *   column, "Finish line · Waiting on 2 bugs" on RCP-22, and Hide implied links
 *   still hiding the shortcut.
 * - The epic page names the finish line and links each open bug; you can clear
 *   the mark ("No finish line") and mark it again. The finish line and the bug
 *   say what holds what, and canceling a bug in an epic needs a reason.
 * - The Work epics row, Pick next epic and get_digest count the open bugs.
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
    await page.screenshot({ path: join(out, `b81-${name}-${theme}.png`) });
  }
  await setTheme(page, 'light');
}

const noOverflow = async (page: Page, width: number) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    width,
  );

let agent: McpAgent;
let chainBug = '';

const ok = async (tool: string, args: Record<string, unknown>) => {
  const res = await agent.call(tool, args);
  expect(res.isError, res.text).toBe(false);
  return res;
};
const versionOf = async (id: string) =>
  ((await ok('get_item', { id, view: 'summary' })).structured.item as { version: number }).version;

test.beforeAll(async () => {
  agent = await connectAgent('codex');
  const created = await ok('create_item', {
    project: 'RCP',
    type: 'Bug',
    title: 'Synthetic: the share link drops the last day',
    epic: 'RCP-1',
    status: 'planning',
  });
  chainBug = (created.structured.item as { id: string }).id;
  await ok('link_items', { from: chainBug, to: 'RCP-22', type: 'blocks' });
  await ok('link_items', { from: 'RCP-11', to: 'RCP-22', type: 'blocks' });
  await ok('update_item', {
    id: 'RCP-1',
    expected_version: await versionOf('RCP-1'),
    finish_line: 'RCP-22',
  });
});
test.afterAll(async () => {
  await agent.close();
});

test.beforeEach(async ({ page }) => {
  await unlock(page.context());
  await page.context().addInitScript(() => {
    localStorage.setItem('docket.notifications', 'off');
    sessionStorage.setItem('docket.scope', 'RCP');
  });
});

const map = (page: Page) => page.locator('[data-progress-map]');

test('the epic map stacks unlinked bugs, marks the chain bug and badges the finish line', async ({
  page,
}) => {
  await page.goto('/items/RCP-1?tab=map');
  const bugs = map(page).locator('[data-col="bugs"]');
  await expect(bugs.locator('.pm-colh')).toHaveText('Bugs1 bug open');
  await expect(bugs.locator('[data-pid="RCP-17"]')).toBeVisible();
  await expect(bugs.locator('[data-pid]')).toHaveCount(1);
  // It's the leftmost column, before the outside column and Wave 1.
  await expect(map(page).locator('.pm-col').first()).toHaveAttribute('data-col', 'bugs');

  // The chain bug stays in its wave, with the marker; no arrow touches the Bugs column.
  const chain = map(page).locator(`.pm-node[data-pid="${chainBug}"]`);
  await expect(chain.locator('[data-bug-mark]')).toHaveText('bug');
  await expect(map(page).locator('path.pm-edge[data-from="RCP-17"]')).toHaveCount(0);
  await expect(map(page).locator('path.pm-edge[data-to="RCP-17"]')).toHaveCount(0);
  await expect(
    map(page).locator(`path.pm-edge[data-from="${chainBug}"][data-to="RCP-22"]`),
  ).toBeAttached();

  const finish = map(page).locator('.pm-node[data-pid="RCP-22"]');
  await expect(finish.locator('[data-finish-badge]')).toHaveText('Finish line · Waiting on 2 bugs');

  // Hide implied links still hides the shortcut the chain shows.
  await expect(map(page).locator('[data-implied-hidden]')).toHaveText('1 hidden');
  await expect(map(page).locator('path.pm-edge[data-from="RCP-11"][data-to="RCP-22"]')).toHaveCount(
    0,
  );
  await map(page).getByRole('switch', { name: 'Hide implied links' }).click();
  await expect(
    map(page).locator('path.pm-edge[data-from="RCP-11"][data-to="RCP-22"]'),
  ).toBeAttached();
  await expect(bugs.locator('[data-pid="RCP-17"]')).toBeVisible();
  await map(page).getByRole('switch', { name: 'Hide implied links' }).click();
});

test('the epic page names the finish line and its bugs; clearing and marking it again', async ({
  page,
}) => {
  await page.goto('/items/RCP-1');
  const line = page.locator('[data-finish-line]').first();
  await expect(line).toContainText('Finish line RCP-22 (marked) · Waiting on 2 bugs');
  await expect(line.getByRole('link', { name: 'RCP-17' })).toBeVisible();
  await expect(line.getByRole('link', { name: chainBug })).toBeVisible();

  await page.getByRole('button', { name: 'Clear finish line mark' }).click();
  await expect(page.locator('[data-finish-line="none"]')).toContainText('No finish line');
  const select = page.getByLabel(/tickets could be the release\. Mark one:/);
  await select.selectOption('RCP-22');
  await page.getByRole('button', { name: 'Mark as finish line' }).click();
  await expect(page.locator('[data-finish-line="RCP-22"]')).toContainText('(marked)');
  await expect(page.getByRole('button', { name: 'Clear finish line mark' })).toBeVisible();
});

test('the finish line and the bug say what holds what; canceling the bug needs a reason', async ({
  page,
}) => {
  await page.goto('/items/RCP-22');
  const hold = page.locator('[data-release-hold]');
  await expect(hold).toContainText('Waiting on 2 bugs');
  await expect(hold).toContainText('can’t move to Review or Done');
  await expect(hold.getByRole('link', { name: 'RCP-17' })).toBeVisible();

  await page.goto('/items/RCP-17');
  await expect(page.locator('[data-bug-holds="RCP-1"]')).toContainText(
    'this bug holds RCP-1’s release',
  );
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Cancel item…' }).click();
  const box = page.locator('[data-cancel-confirm]');
  await expect(box).toContainText('Reason (required)');
  const go = box.getByRole('button', { name: 'Cancel item' });
  await expect(go).toBeDisabled();
  await box.getByRole('textbox').fill('Synthetic reason');
  await expect(go).toBeEnabled();
  await box.getByRole('button', { name: 'Keep item' }).click();
  await expect(box).toHaveCount(0);
});

test('the Work epics row, Pick next epic and the digest count the open bugs', async ({ page }) => {
  await page.goto('/work');
  await expect(page.locator('[data-epic-release="RCP-22"]')).toContainText(
    'Finish line waiting on 2 bugs',
  );

  await page.goto('/projects/RCP/next-epic');
  await expect(page.locator('[data-pick-row="RCP-1"] [data-pick-release]')).toContainText(
    'Finish line RCP-22 · Waiting on 2 bugs',
  );

  const digest = await ok('get_digest', { project: 'RCP' });
  expect(digest.text).toContain(`- RCP-1 finish line RCP-22 waits on 2 bugs: RCP-17, ${chainBug}`);
});

for (const size of SIZES) {
  test(`axe in both themes, no overflow and screenshots at ${size.name}`, async ({ page }) => {
    await page.setViewportSize({ width: size.width, height: size.height });

    await page.goto('/items/RCP-1?tab=map');
    await expect(map(page).locator('[data-col="bugs"] [data-pid="RCP-17"]')).toBeVisible();
    await expectAxeClean(page, `epic Map with the Bugs column at ${size.name}`);
    await noOverflow(page, size.width);
    await shots(page, `epic-map-${size.name}`);

    await page.goto('/items/RCP-1');
    await expect(page.locator('[data-finish-line="RCP-22"]')).toBeVisible();
    await expectAxeClean(page, `epic page with the finish line at ${size.name}`);
    await noOverflow(page, size.width);
    await shots(page, `epic-page-${size.name}`);

    await page.goto('/items/RCP-22');
    await expect(page.locator('[data-release-hold]')).toBeVisible();
    await expectAxeClean(page, `finish line ticket at ${size.name}`);
    await noOverflow(page, size.width);
    await shots(page, `finish-line-${size.name}`);

    await page.goto('/projects/RCP/next-epic');
    await expect(page.locator('[data-pick-release]').first()).toBeVisible();
    await expectAxeClean(page, `Pick next epic with open bugs at ${size.name}`);
    await noOverflow(page, size.width);
    await shots(page, `pick-epic-${size.name}`);
  });
}

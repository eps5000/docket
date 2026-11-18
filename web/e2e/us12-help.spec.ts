/**
 * US12, Help is one click away (T152; FR-120; SC-015; UI_SPEC §6.7c):
 * - the independent test: open Help, search for "parked", open the article,
 *   and follow a "?" from Agents to an article;
 * - scenario 1: the "?" by Agents → Workspaces opens "Workspace states and
 *   safe pruning" in a side panel; Esc closes it and focus returns to the "?";
 * - scenario 2: the palette lists the backup and restore article under Help
 *   for "restore";
 * - axe in both themes on /help, an article and the side panel.
 */
import { expect, expectAxeClean, test, unlock, useSeededContainer } from './fixtures';

useSeededContainer();

test.beforeEach(async ({ page }) => {
  await unlock(page.context());
  await page.context().addInitScript(() => localStorage.setItem('tl.notifications', 'off'));
});

test('the sidebar opens Help; search for "parked" and open the article', async ({ page }) => {
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: 'Primary' });
  await nav.getByRole('link', { name: 'Help' }).click();
  await expect(page).toHaveURL(/\/help$/);
  await expect(page.getByRole('heading', { name: 'Help', level: 1 })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Help' })).toHaveAttribute('aria-current', 'page');
  for (const g of ['Getting started', 'Working with agents', 'Recovery', 'Planning', 'Operations'])
    await expect(page.getByRole('heading', { name: g, level: 2 })).toBeVisible();

  await page.getByRole('searchbox', { name: 'Search help' }).fill('parked');
  await expect(page).toHaveURL(/\/help\?q=parked$/);
  await expect(page.getByRole('link', { name: 'Jira import' })).toHaveCount(0);
  await page.getByRole('link', { name: 'Run states: live, parked, stale and more' }).click();
  await expect(page).toHaveURL(/\/help\/run-states$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'Run states: live, parked, stale and more',
  );
  await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText('Help');

  // A link in the text stays in the app, in this tab.
  await page
    .getByRole('region', { name: 'Run states: live, parked, stale and more' })
    .getByRole('link', { name: 'Recovering after a crash' })
    .click();
  await expect(page).toHaveURL(/\/help\/crash-recovery$/);
  // Related links.
  await page
    .getByRole('region', { name: 'Related' })
    .getByRole('link', { name: 'Workspace states and safe pruning' })
    .click();
  await expect(page).toHaveURL(/\/help\/workspaces-and-pruning$/);
});

test('the "?" by Agents → Workspaces opens the article in a side panel (scenario 1)', async ({
  page,
}) => {
  await page.goto('/agents');
  const section = page.getByRole('region', { name: 'Workspaces' });
  await expect(section).toBeVisible();
  const q = section.getByRole('button', { name: 'Help: Workspace states and safe pruning' });
  await q.click();
  const panel = page.getByRole('dialog', { name: 'Workspace states and safe pruning' });
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('Idle is not finished');
  // The page stays underneath.
  await expect(page).toHaveURL(/\/agents$/);
  await expect(page.getByRole('heading', { name: 'Agents', level: 1 })).toBeAttached();

  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect(q).toBeFocused();

  // Open in Help.
  await q.click();
  await page.getByRole('dialog').getByRole('link', { name: 'Open in Help' }).click();
  await expect(page).toHaveURL(/\/help\/workspaces-and-pruning$/);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'Workspace states and safe pruning',
  );
});

test('every "?" on the main screens opens a panel with its article', async ({ page }) => {
  for (const [path, ready] of [
    ['/', 'For you now'],
    ['/agents', 'Agents'],
    ['/items/RCP-15?tab=activity', null],
    ['/items/RCP-14?tab=deps', null],
    ['/review/RCP-12', 'Human review'],
    ['/settings', 'Settings'],
    ['/agent-files?project=RCP', 'Agent files'],
    ['/agent-files?project=all', 'Agent files'],
  ] as const) {
    await page.goto(path);
    if (ready)
      await expect(
        page.getByRole('heading', { name: new RegExp(`^${ready}`) }).first(),
      ).toBeVisible();
    await page.waitForLoadState('networkidle');
    const links = page.locator('[data-help-anchor]');
    const n = await links.count();
    expect(n, `${path} has a "?"`).toBeGreaterThan(0);
    for (let i = 0; i < n; i++) {
      const link = links.nth(i);
      const name = (await link.getAttribute('aria-label'))!;
      expect(name).toMatch(/^Help: /);
      await link.click();
      const panel = page.getByRole('dialog', { name: name.replace(/^Help: /, '') });
      await expect(panel, `${path}: ${name}`).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(panel).toHaveCount(0);
      await expect(link).toBeFocused();
    }
  }
});

test('the palette lists matching articles under Help (scenario 2)', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /^For you now/ })).toBeVisible();
  await page.keyboard.press('Control+k');
  const dialog = page.getByRole('dialog', { name: 'Search or jump to' });
  await page.getByRole('combobox', { name: 'Search' }).fill('restore');
  const help = dialog.getByRole('group', { name: 'Help' });
  await expect(help.getByRole('option', { name: /Backups, restore and export/ })).toBeVisible();
  await help.getByRole('option', { name: /Backups, restore and export/ }).click();
  await expect(page).toHaveURL(/\/help\/backups-restore-export$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Backups, restore and export');
});

test.describe('axe, both themes', () => {
  test('/help, with a search', async ({ page }) => {
    await page.goto('/help');
    await expect(page.getByRole('heading', { name: 'Getting started' })).toBeVisible();
    await expectAxeClean(page, 'Help');
    await page.getByRole('searchbox', { name: 'Search help' }).fill('parked');
    await expect(page.locator('[data-help-count]')).toContainText('parked');
    await expectAxeClean(page, 'Help, searched');
  });

  test('an article with tables and commands', async ({ page }) => {
    for (const slug of ['run-states', 'backups-restore-export']) {
      await page.goto(`/help/${slug}`);
      await expect(page.getByRole('region', { name: 'Related' })).toBeVisible();
      await expectAxeClean(page, `Help article ${slug}`);
    }
  });

  test('the side panel', async ({ page }) => {
    await page.goto('/agents');
    await page.getByRole('button', { name: 'Help: Workspace states and safe pruning' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expectAxeClean(page, 'Help side panel', { include: '[role="dialog"]' });
  });
});

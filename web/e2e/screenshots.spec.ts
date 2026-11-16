/**
 * PR evidence: light and dark screenshots of every shell. Skipped unless
 * TASKLITE_E2E_SCREENSHOTS names an output folder.
 */
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { bootstrap, emptyNeedsYou, mockGet } from './fixtures/api-mocks';
import { expect, setTheme, test, unlock } from './fixtures/index';

const out = process.env.TASKLITE_E2E_SCREENSHOTS;

test.describe('screenshots', () => {
  test.skip(!out, 'Set TASKLITE_E2E_SCREENSHOTS to a folder to capture screenshots.');

  async function shoot(page: Page, name: string) {
    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme);
      await page.screenshot({ path: join(out!, `${name}-${theme}.png`), fullPage: true });
    }
  }

  test.beforeEach(async ({ page }) => {
    await unlock(page.context());
  });

  for (const [name, path] of [
    ['needs-you', '/'],
    ['work-board', '/work'],
    ['work-list', '/work?layout=list'],
    ['work-map', '/work?layout=map'],
    ['work-timeline', '/work?layout=timeline'],
    ['item-details', '/items/RCP-14?tab=details'],
    ['item-checklist', '/items/RCP-14?tab=checklist'],
    ['item-deps', '/items/RCP-14?tab=deps'],
    ['item-activity', '/items/RCP-14?tab=activity'],
    ['packet', '/review/RCP-12'],
    ['label', '/labels/RCP/ui-refresh'],
    ['agents', '/agents'],
    ['settings', '/settings'],
  ] as const) {
    test(name, async ({ page }) => {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await page.waitForLoadState('networkidle');
      await shoot(page, name);
    });
  }

  test('unlock', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await page.goto('/unlock');
    await expect(page.getByRole('heading', { name: 'Unlock Task Lite' })).toBeVisible();
    await shoot(page, 'unlock');
    await context.close();
  });

  test('dialog', async ({ page }) => {
    await page.goto('/settings');
    await page.getByRole('button', { name: 'Rotate owner key…' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await shoot(page, 'dialog-rotate-key');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '+ New' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await shoot(page, 'dialog-quick-capture');
  });

  test('rail at 1100px with open tabs', async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 800 });
    await page.goto('/items/RCP-12');
    await page.goto('/items/RCP-14?tab=checklist');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await shoot(page, 'rail-1100');
  });

  test('empty states', async ({ page }) => {
    await mockGet(page, '/api/bootstrap', bootstrap);
    await mockGet(page, '/api/needs-you', emptyNeedsYou);
    await page.goto('/');
    await expect(page.getByText('Nothing deferred.')).toBeVisible();
    await shoot(page, 'needs-you-empty');
  });
});

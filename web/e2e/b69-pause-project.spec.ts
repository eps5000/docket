/**
 * B69, Pause project (owner decision 53), with synthetic text: the dialog from
 * the keyboard, the banner on Overview, Work and the item page, the Paused
 * marker, Undo, Resume, nothing added to Needs you, axe in both themes, and
 * the layout at 1024 px and 1440 x 900.
 */
import type { Page } from '@playwright/test';
import { expect, expectAxeClean, test, unlock, useSeededContainer } from './fixtures';

useSeededContainer();

const REASON = 'Waiting on a synthetic answer';
/** A seeded project no other assertion in this file depends on. */
const KEY = 'DOC';

test.beforeEach(async ({ page }) => {
  await unlock(page.context());
  await page.context().addInitScript(() => localStorage.setItem('docket.notifications', 'off'));
});

async function inScope(page: Page, path: string) {
  await page.addInitScript((s) => sessionStorage.setItem('docket.scope', s), KEY);
  await page.goto(path);
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
}

const banner = (page: Page) => page.locator(`[data-banner="paused"][data-paused-project="${KEY}"]`);
const pauseButton = (page: Page) => page.locator(`[data-pause-project="${KEY}"]`);
const resumeButton = (page: Page) => banner(page).locator(`[data-resume-project="${KEY}"]`);

async function pauseFromOverview(page: Page) {
  await inScope(page, '/');
  await pauseButton(page).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Why are you pausing it?')).toBeFocused();
  await page.keyboard.type(REASON);
  await page.keyboard.press('Enter');
  await expect(banner(page)).toContainText(REASON);
}

/** Always leave the shared container's project running. */
test.afterEach(async ({ page }) => {
  const resume = page.locator(`[data-resume-project="${KEY}"]`).first();
  if (await resume.isVisible().catch(() => false)) {
    await resume.click();
    await expect(page.locator(`[data-pause-project="${KEY}"]`).first()).toBeVisible();
  }
});

test('pausing from the keyboard shows the banner everywhere, and Resume lifts it', async ({
  page,
}) => {
  await pauseFromOverview(page);
  await expect(resumeButton(page)).toBeFocused();
  await expect(banner(page)).toContainText('You paused it on');
  await expectAxeClean(page, 'Overview with a paused project', {
    include: '[data-banner="paused"]',
  });

  await page.goto('/work');
  await expect(banner(page)).toContainText(REASON);

  await page.goto(`/items/${KEY}-2`);
  await expect(banner(page)).toContainText(REASON);
  await expectAxeClean(page, 'Item page with a paused project', {
    include: '[data-banner="paused"]',
  });

  await page.locator('.scopebtn').click();
  await expect(
    page.getByRole('menuitemradio', { name: /Paused/ }).filter({ hasText: 'Paused' }),
  ).toHaveCount(1);
  await page.keyboard.press('Escape');

  await page.goto('/');
  await resumeButton(page).click();
  await expect(banner(page)).toHaveCount(0);
  await expect(pauseButton(page)).toBeFocused();
});

test('Undo takes a pause back', async ({ page }) => {
  await pauseFromOverview(page);
  await page.getByRole('button', { name: 'Undo' }).first().click();
  await expect(banner(page)).toHaveCount(0);
  await expect(pauseButton(page)).toBeVisible();
});

test('a pause adds nothing to Needs you', async ({ page }) => {
  await inScope(page, '/');
  const section = page.locator('#needs-you-title');
  await expect(section).toBeVisible();
  const before = await section.textContent();
  await pauseButton(page).click();
  await page.getByLabel('Why are you pausing it?').fill(REASON);
  await page.locator(`[data-confirm-pause="${KEY}"]`).click();
  await expect(banner(page)).toBeVisible();
  await expect(section).toHaveText(before ?? '');
});

test('Settings shows the Paused chip and both actions', async ({ page }) => {
  await pauseFromOverview(page);
  await page.goto('/settings');
  const row = page.locator(`[data-project="${KEY}"]`);
  await expect(row.locator(`[data-paused-chip="${KEY}"]`)).toHaveText('Paused');
  await expectAxeClean(page, 'Settings with a paused project', {
    include: `[data-project="${KEY}"]`,
  });
  await row.locator(`[data-resume-project="${KEY}"]`).click();
  await expect(row.locator(`[data-pause-project="${KEY}"]`)).toBeFocused();
  await expect(row.locator(`[data-paused-chip="${KEY}"]`)).toHaveCount(0);
});

for (const viewport of [
  { width: 1024, height: 768 },
  { width: 1440, height: 900 },
]) {
  test(`the banner fits at ${viewport.width} px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await pauseFromOverview(page);
    const box = (await banner(page).boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    const button = (await resumeButton(page).boundingBox())!;
    expect(button.x + button.width).toBeLessThanOrEqual(viewport.width);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(overflow).toBe(false);
  });
}

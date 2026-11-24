/**
 * The stress project and the Gameflow pilot follow-ups (B35). The seed's
 * `STR` project (DOCKET_SEED_STRESS=1; BUILD_SPEC §8) is shaped like a real
 * Jira import: long titles, many labels, big and empty epics.
 *
 * - An epic with no work tickets still has its mandatory Release on its card
 *   and page, counted as the one ticket left to finish.
 * - A Jira sub-task key held in a step's `source` finds the parent item in the
 *   palette, with the step named; choosing it opens the item's checklist with
 *   that step's dialog. An exact item Jira key still ranks first.
 */
import type { Page } from '@playwright/test';
import { expect, expectAxeClean, test, unlock, useSeededContainer } from './fixtures';

useSeededContainer();

const STEP = 'Prove SVG admission rejects a 48 MB decompression bomb within the memory budget';

test.beforeEach(async ({ page }) => {
  await unlock(page.context());
  await page.context().addInitScript(() => localStorage.setItem('docket.notifications', 'off'));
});

/** Open a page in the STR project's scope (the project switcher keeps it in sessionStorage). */
async function inStress(page: Page, path: string) {
  await page.addInitScript(() => sessionStorage.setItem('docket.scope', 'STR'));
  await page.goto(path);
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
}

test('the stress project is seeded', async ({ request }) => {
  const res = await request.get('/api/bootstrap');
  const boot = (await res.json()) as { projects: { key: string }[] };
  expect(
    boot.projects.map((p) => p.key),
    'start the e2e instance with DOCKET_SEED_STRESS=1 (docker/compose.e2e.yaml and CI set it)',
  ).toContain('STR');
});

test('an epic with no work tickets shows its one Release on the card and page', async ({
  page,
}) => {
  await inStress(page, '/work');
  const epics = page.locator('[data-card="epics"]');
  const empty = epics.locator('a.epiccard[href="/items/STR-1"]');
  await expect(empty).toContainText('0/1 done · In progress');
  await expect(empty.locator('.pbar')).toHaveCount(1);
  await expect(epics.locator('a.epiccard[href="/items/STR-6"]')).toContainText('0/1 done · Inbox');
  // An epic with tickets keeps its bar and count.
  const big = epics.locator('a.epiccard[href="/items/STR-3"]');
  await expect(big.locator('.pbar')).toHaveCount(1);
  await expect(big).toContainText(/\d+\/3\d done · In progress/);
  await expectAxeClean(page, 'Epics row with empty epics', { include: '[data-card="epics"]' });

  await page.goto('/items/STR-1');
  const tickets = page.locator('section[data-section="tickets"]');
  await expect(tickets).toContainText('0/1 done');
  await expect(tickets.locator('[data-ticket]')).toHaveCount(1);
  await expect(tickets).toContainText('Release Empty epic');
});

test('palette: a sub-task key in a step source finds the parent, and opens the step dialog', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'Search or jump to' });
  await expect(palette).toBeVisible();
  const box = page.getByRole('combobox', { name: 'Search' });
  await expect(box).toBeFocused();
  await page.keyboard.type('stress-227');
  await expect(box).toHaveValue('stress-227');
  const first = palette.getByRole('option').first();
  await expect(first).toContainText('STR-203');
  await expect(first).toContainText(`step: ${STEP}`);
  await expect(first).toContainText('STRESS-227');
  await expectAxeClean(page, 'Palette with a step hit', { include: '[role="dialog"]' });

  await first.click();
  // The link carried ?step=<id>; the page opens that step, then drops it from the URL.
  await expect(page).toHaveURL(/\/items\/STR-203\?tab=checklist$/);
  const dialog = page.getByRole('dialog', { name: STEP });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('[data-step-source]')).toContainText('STRESS-227');
  await expect(page.getByRole('tab', { name: /^Checklist/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page).not.toHaveURL(/step=/);
  // Focus returns to the step's row.
  await expect(page.getByRole('button', { name: new RegExp(`^${STEP} \\(`) })).toBeFocused();
});

test('palette: an exact item Jira key still ranks first', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'Search or jump to' });
  await expect(page.getByRole('combobox', { name: 'Search' })).toBeFocused();
  await page.keyboard.type('STRESS-103');
  const first = palette.getByRole('option').first();
  await expect(first).toContainText('STR-203');
  await expect(first).not.toContainText('step:');
});

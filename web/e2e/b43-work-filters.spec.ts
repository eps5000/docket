/**
 * Work filters and the Epics strip (B43, owner feedback from the Gameflow
 * pilot; UI_SPEC §6.2), against the seeded instance with the stress project
 * (`STR`: 300 items, done epic STR-10, canceled items, blocked chains):
 *
 * - the Epics strip hides done epics with tickets behind *Show N done*
 *   (*Hide done*), keeps empty ones, and always keeps the filtered epic;
 * - the quick filters: *Active* (the default: no done items, and the Done
 *   column says how many it hides), *Blocked*, *In progress* and *Queued*
 *   (decision 57), each count
 *   matching the board; Back returns to the previous filter;
 * - the *Filters* menu from the keyboard: checks narrow, *Shows done* adds,
 *   pills remove one, *Clear* goes back to Active; axe in both themes;
 * - the choice is remembered per project, and old `filter=` links map;
 * - at 1024 px the row wraps inside the page and the menu stays on screen.
 */
import type { Page } from '@playwright/test';
import { expect, expectAxeClean, test, unlock, useSeededContainer } from './fixtures';

useSeededContainer();

test.beforeEach(async ({ page }) => {
  await unlock(page.context());
  await page.context().addInitScript(() => localStorage.setItem('docket.notifications', 'off'));
});

/** Open a page in a project's scope (the project switcher keeps it in sessionStorage). */
async function inScope(page: Page, scope: string, path: string) {
  await page.addInitScript((s) => sessionStorage.setItem('docket.scope', s), scope);
  await page.goto(path);
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
}

const quick = (page: Page) => page.getByRole('group', { name: 'Quick filters' });
const chip = (page: Page, name: string) =>
  quick(page).getByRole('button', { name: new RegExp(`^${name}`) });
const chipCount = async (page: Page, name: string) =>
  Number(await chip(page, name).locator('b').textContent());
const filtersButton = (page: Page) => page.getByRole('button', { name: /^Filters/ });
const entry = (page: Page, name: string) =>
  page.getByRole('menu', { name: 'Filters' }).getByRole('menuitemcheckbox', {
    name: new RegExp(`^${name}`),
  });
const entryCount = async (page: Page, name: string) =>
  Number(await entry(page, name).locator('.fcount').textContent());

/** The board's column counts, summed: every item the filter shows. */
async function boardTotal(page: Page): Promise<number> {
  const counts = await page.locator('[data-layout="board"] .colh > span').allTextContents();
  return counts.reduce((n, c) => n + Number(c), 0);
}
const column = (page: Page, name: string) =>
  page.locator(`[data-layout="board"] section.col[aria-label="${name}"]`);

test('the Epics strip hides done epics until Show N done, and keeps the filtered epic', async ({
  page,
}) => {
  await inScope(page, 'STR', '/work');
  const epics = page.locator('[data-card="epics"]');
  const done = epics.locator('a.epiccard[href="/items/STR-10"]');
  // 10 epics; STR-10 is done with 10 tickets, so it waits behind the toggle.
  await expect(epics.getByRole('heading', { name: 'Epics · 9' })).toBeVisible();
  await expect(done).toHaveCount(0);
  // Empty epics stay (STR-1 In progress, STR-6 Inbox).
  await expect(epics.locator('a.epiccard[href="/items/STR-1"]')).toBeVisible();
  await expect(epics.locator('a.epiccard[href="/items/STR-6"]')).toBeVisible();
  const toggle = epics.getByRole('button', { name: 'Show 1 done' });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await expect(epics.getByRole('heading', { name: 'Epics · 10' })).toBeVisible();
  await expect(done).toContainText('10/10 done · Done');
  const hide = epics.getByRole('button', { name: 'Hide done' });
  await expect(hide).toHaveAttribute('aria-expanded', 'true');
  // expectAxeClean scans in both themes.
  await expectAxeClean(page, 'Epics strip with done shown', { include: '[data-card="epics"]' });
  await hide.click();
  await expect(epics.getByRole('heading', { name: 'Epics · 9' })).toBeVisible();

  // Filtered to the done epic: its card shows, and its done tickets wait behind Show 10 done.
  await page.goto('/work?epic=STR-10');
  await expect(done).toBeVisible();
  await expect(epics.getByRole('heading', { name: 'Epics · 10' })).toBeVisible();
  await expect(epics.locator('[data-epics-done]')).toHaveCount(0);
  const note = column(page, 'Done').locator('[data-hidden-done]');
  await expect(note).toContainText('Hidden by the filter.');
  await note.getByRole('button', { name: 'Show 10 done' }).click();
  await expect(page).toHaveURL(/show=done/);
  await expect(column(page, 'Done').locator('.tcard')).toHaveCount(10);
  await expect(page.locator('[data-pill="done"]')).toBeVisible();
});

test('the quick filters: Active by default, Blocked, In progress; Back returns', async ({
  page,
}) => {
  await inScope(page, 'STR', '/work');
  await expect(page).toHaveURL(/\/work$/);
  await expect(chip(page, 'Active')).toHaveAttribute('aria-pressed', 'true');
  // Active: nothing done or canceled; the Done column says what it hides.
  await expect(column(page, 'Done').locator('.tcard')).toHaveCount(0);
  await expect(column(page, 'Done').locator('[data-hidden-done]')).toContainText(/Show \d+ done/);
  await expect(
    page.locator('[data-layout="board"] section.col[aria-label="Canceled"]'),
  ).toHaveCount(0);
  await expect.poll(() => boardTotal(page)).toBe(await chipCount(page, 'Active'));
  await expect(chip(page, 'Active')).toHaveAttribute('title', /^Agent query: /);

  await chip(page, 'Blocked').click();
  await expect(page).toHaveURL(/quick=blocked/);
  await expect(chip(page, 'Blocked')).toHaveAttribute('aria-pressed', 'true');
  await expect(chip(page, 'Blocked')).toHaveAttribute(
    'title',
    'Agent query: is:blocked -is:queued -is:held',
  );
  const blocked = await chipCount(page, 'Blocked');
  await expect.poll(() => boardTotal(page)).toBe(blocked);
  // Decision 57: under Blocked, nothing shows as Queued.
  await expect(page.locator('[data-layout="board"] [data-wait="queued"]')).toHaveCount(0);

  await chip(page, 'In progress').click();
  await expect(page).toHaveURL(/quick=progress/);
  const progress = await chipCount(page, 'In progress');
  await expect.poll(() => boardTotal(page)).toBe(progress);
  await expect(column(page, 'In progress').locator('.colh > span')).toHaveText(String(progress));

  // Back and Forward walk the filter history.
  await page.goBack();
  await expect(page).toHaveURL(/quick=blocked/);
  await expect(chip(page, 'Blocked')).toHaveAttribute('aria-pressed', 'true');
  await page.goBack();
  await expect(chip(page, 'Active')).toHaveAttribute('aria-pressed', 'true');
  await page.goForward();
  await expect(chip(page, 'Blocked')).toHaveAttribute('aria-pressed', 'true');

  // Decision 57: Queued is its own chip, its count matches the board, and none of it is red.
  await chip(page, 'Queued').click();
  await expect(page).toHaveURL(/quick=queued/);
  await expect(chip(page, 'Queued')).toHaveAttribute('aria-pressed', 'true');
  await expect(chip(page, 'Queued')).toHaveAttribute('title', 'Agent query: is:queued');
  const queued = await chipCount(page, 'Queued');
  expect(queued + blocked).toBeGreaterThan(0);
  await expect.poll(() => boardTotal(page)).toBe(queued);
  await expect(page.locator('[data-layout="board"] a.tcard.isblocked')).toHaveCount(0);

  // Shows canceled adds a Canceled column.
  await chip(page, 'Active').click();
  await filtersButton(page).click();
  const canceled = await entryCount(page, 'Shows canceled');
  expect(canceled).toBeGreaterThan(0);
  await entry(page, 'Shows canceled').click();
  await expect(page).toHaveURL(/show=canceled/);
  await expect(column(page, 'Canceled').locator('.colh > span')).toHaveText(String(canceled));
});

test('the Filters menu from the keyboard: a combination, pills, Clear; axe in both themes', async ({
  page,
}) => {
  await page.goto('/work');
  await expect(page.locator('[data-layout="board"]')).toBeVisible();
  const button = filtersButton(page);
  await expect(button).toHaveAttribute('aria-haspopup', 'menu');
  await button.focus();
  await page.keyboard.press('Enter');
  const menu = page.getByRole('menu', { name: 'Filters' });
  await expect(menu).toBeVisible();
  await expect(button).toHaveAttribute('aria-expanded', 'true');
  await expect(menu.getByRole('menuitemcheckbox')).toHaveText([
    /^For you\d+$/,
    /^Human review later\d+$/,
    /^Deferred review\d+$/,
    /^Live run\d+$/,
    /^Has a problem\d+$/,
    /^Shows done\d+$/,
    /^Shows canceled\d+$/,
  ]);
  await expect(entry(page, 'For you')).toBeFocused();
  await expectAxeClean(page, 'Work filter row with the menu open', {
    include: '[data-work-filters]',
  });
  await entry(page, 'For you').focus();

  // For you (Space ticks and keeps the menu open).
  const forYou = await entryCount(page, 'For you');
  await page.keyboard.press(' ');
  await expect(page).toHaveURL(/has=for_you/);
  await expect(entry(page, 'For you')).toHaveAttribute('aria-checked', 'true');
  await expect.poll(() => boardTotal(page)).toBe(forYou);
  await expect(button).toHaveText(/^Filters\s*1/);

  // AND Has a problem: the menu's count is what the board then shows.
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(entry(page, 'Has a problem')).toBeFocused();
  await expect.poll(() => entryCount(page, 'Has a problem')).toBeLessThanOrEqual(forYou);
  const both = await entryCount(page, 'Has a problem');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/has=for_you%2Chas_problem|has=for_you,has_problem/);
  await expect.poll(() => boardTotal(page)).toBe(both);

  // Shows done adds the done items those checks match.
  await page.keyboard.press('End');
  await page.keyboard.press('ArrowUp');
  await expect(entry(page, 'Shows done')).toBeFocused();
  const doneAdds = await entryCount(page, 'Shows done');
  await page.keyboard.press(' ');
  await expect(page).toHaveURL(/show=done/);
  await expect.poll(() => boardTotal(page)).toBe(both + doneAdds);

  // Escape closes the menu and returns to the button.
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(button).toBeFocused();
  await expect(button).toHaveText(/^Filters\s*3/);

  // A pill each; removing one unticks it.
  const pills = page.getByRole('group', { name: 'Active filters' });
  await expect(pills.getByRole('button')).toHaveText([/For you/, /Has a problem/, /Shows done/]);
  await pills.getByRole('button', { name: 'Remove the filter: Has a problem' }).click();
  await expect(page).not.toHaveURL(/has_problem/);
  await expect(pills.getByRole('button')).toHaveCount(2);

  // Clear: back to Active, nothing ticked.
  await page.getByRole('button', { name: 'Clear' }).click();
  await expect(page).toHaveURL(/\/work$/);
  await expect(chip(page, 'Active')).toHaveAttribute('aria-pressed', 'true');
  await expect(pills).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Clear' })).toHaveCount(0);
  await expect(button).toHaveText(/^Filters\s*$/);
});

test('remembered per project; old filter= links map to the new model', async ({ page }) => {
  // An old link: For you becomes Active + the For you check, rewritten in place.
  await inScope(page, 'RCP', '/work?filter=for_you');
  await expect(page).toHaveURL(/\/work\?has=for_you$/);
  await expect(page.locator('[data-pill="for_you"]')).toBeVisible();
  await page.goto('/work?layout=list&filter=archived');
  await expect(page).toHaveURL(/\/work\?layout=list&has=archived&show=done$/);

  // A choice is remembered for this project and applied when the URL has none.
  await page.goto('/work');
  await chip(page, 'Blocked').click();
  await expect(page).toHaveURL(/quick=blocked/);
  await page.goto('/');
  await page.locator('a[data-nav="work"]').click();
  await expect(page).toHaveURL(/\/work\?quick=blocked$/);
  await expect(chip(page, 'Blocked')).toHaveAttribute('aria-pressed', 'true');
  // Another project keeps its own (the default here).
  await inScope(page, 'DOC', '/work');
  await expect(page).toHaveURL(/\/work$/);
  await expect(chip(page, 'Active')).toHaveAttribute('aria-pressed', 'true');
});

test('1024 px: the filter row wraps inside the page and the menu stays on screen', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 900 });
  await page.goto('/work?quick=progress&has=for_you,live_run,has_problem&show=done,canceled');
  await expect(page.locator('[data-layout="board"]')).toBeVisible();
  await expect(page.getByRole('group', { name: 'Active filters' }).getByRole('button')).toHaveCount(
    5,
  );
  await filtersButton(page).click();
  const menu = page.getByRole('menu', { name: 'Filters' });
  await expect(menu).toBeVisible();
  const box = (await menu.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(1024);
  const row = (await page.locator('[data-work-filters]').boundingBox())!;
  expect(row.x + row.width).toBeLessThanOrEqual(1024);
  const spill = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(spill, 'sideways page scroll').toBeLessThanOrEqual(0);
});

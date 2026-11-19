/**
 * Shell navigation (tasks.md T063): every route reachable from the sidebar,
 * the palette and the tabs; the 8-tab cap and tab memory; scope resetting to
 * All projects in a new context; the 501 "not built yet" state; the rail at
 * ≤ 1180px; and axe-clean shells and empty states in both themes.
 */
import type { Locator, Page } from '@playwright/test';
import {
  bootstrap,
  emptyAgents,
  emptyNeedsYou,
  emptySettings,
  emptyWork,
  emptyWorkspaces,
  mockGet,
  needsYouWithPacket,
  searchResults,
} from './fixtures/api-mocks';
import {
  expect,
  expectAxeClean,
  test,
  unlock,
  unlockViaUi,
  useSeededContainer,
} from './fixtures/index';

useSeededContainer();

const nav = (page: Page) => page.getByRole('navigation', { name: 'Primary' });
const h1 = (page: Page) => page.getByRole('heading', { level: 1 });
const openTabs = (page: Page) => page.getByRole('navigation', { name: 'Open items' });
/** A sidebar link by its label; badges ("3 for you", "5 active runs") follow it in the name. */
const navLink = (page: Page, name: string) =>
  nav(page).getByRole('link', { name: new RegExp(`^${name}(\\s|$)`) });
/** A view tab by its label; counts and dots follow it in the name. */
const viewTab = (views: Locator, name: string) =>
  views.getByRole('tab', { name: new RegExp(`^${name}(\\s|\\d|$)`) });

async function openPalette(page: Page) {
  await page.keyboard.press('Control+k');
  await expect(page.getByRole('dialog', { name: 'Search or jump to' })).toBeVisible();
  // Typing goes to the search box only once it has focus.
  await expect(page.getByRole('combobox', { name: 'Search' })).toBeFocused();
}

/** Type a search and wait until the box holds it (the query is debounced 150 ms). */
async function search(page: Page, text: string) {
  await page.keyboard.type(text);
  await expect(page.getByRole('combobox', { name: 'Search' })).toHaveValue(text);
}

test.describe('shell navigation', () => {
  test.beforeEach(async ({ page }) => {
    await unlock(page.context());
  });

  test('the Unlock screen unlocks with the owner key and returns to the requested page @protected', async ({
    browser,
  }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto('/agents');
    await expect(page).toHaveURL(/\/unlock\?next=%2Fagents$/);
    await page.getByLabel('Owner key').fill('NOT-THE-KEY');
    await page.getByRole('button', { name: 'Unlock' }).click();
    await expect(page.getByText('That key didn’t match.')).toBeVisible();
    await unlockViaUi(page);
    await expect(page).toHaveURL(/\/agents$/);
    await expect(h1(page)).toHaveText('Agents');
    await context.close();
  });

  test('every sidebar item is reachable and marks itself current', async ({ page }) => {
    await page.goto('/');
    for (const [name, path, title] of [
      ['Work', '/work', 'Work'],
      ['Agents', '/agents', 'Agents'],
      ['Settings', '/settings', 'Settings'],
      ['Needs you', '/', 'Needs you'],
    ] as const) {
      await navLink(page, name).click();
      await expect(page).toHaveURL(new RegExp(`${path === '/' ? '/' : path}$`));
      await expect(h1(page)).toHaveText(title);
      await expect(navLink(page, name)).toHaveAttribute('aria-current', 'page');
    }
    // Agents stays the current item when filtered or opened at Workspaces (B20).
    for (const path of ['/agents?state=live', '/agents#workspaces']) {
      await page.goto(path);
      await expect(h1(page)).toHaveText('Agents');
      await expect(navLink(page, 'Agents')).toHaveAttribute('aria-current', 'page');
    }
    // Settings carries the Service-wide pill in the breadcrumb.
    await nav(page).getByRole('link', { name: 'Settings', exact: true }).click();
    await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText(
      'Service-wide',
    );
  });

  test('every Go to view is reachable from the palette (Ctrl K and /)', async ({ page }) => {
    await page.goto('/');
    for (const [label, url, title] of [
      ['Work', /\/work$/, 'Work'],
      ['Timeline (Work)', /\/work\?layout=timeline$/, 'Work'],
      ['Agents', /\/agents$/, 'Agents'],
      ['Settings: projects and connections', /\/settings$/, 'Settings'],
      ['Needs you', /\/$/, 'Needs you'],
    ] as const) {
      await openPalette(page);
      await page.getByRole('option', { name: label, exact: true }).click();
      await expect(page).toHaveURL(url);
      await expect(h1(page)).toHaveText(title);
    }
    await page.locator('main').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('/');
    await expect(page.getByRole('dialog', { name: 'Search or jump to' })).toBeVisible();
    await page.keyboard.press('Escape');
  });

  test('items and labels are reachable from palette search, and packets from Needs you', async ({
    page,
  }) => {
    await mockGet(page, '/api/search', searchResults);
    await mockGet(page, '/api/needs-you', needsYouWithPacket);
    await page.goto('/');
    await page.getByRole('link', { name: 'Open packet' }).click();
    await expect(page).toHaveURL(/\/review\/RCP-12$/);
    await expect(h1(page)).toHaveText('Human review');
    // The packet keeps Needs you as the active nav item.
    await expect(navLink(page, 'Needs you')).toHaveAttribute('aria-current', 'page');

    await openPalette(page);
    await search(page, 'rcp');
    await page.getByRole('option', { name: /RCP-14/ }).click();
    await expect(page).toHaveURL(/\/items\/RCP-14$/);

    // The item page renders after the URL changes (a transition); it must not take focus
    // from the palette opened meanwhile (the cause of B7's flake).
    await openPalette(page);
    await search(page, 'ui');
    await page.getByRole('option', { name: '# ui-refresh' }).click();
    await expect(page).toHaveURL(/\/labels\/RCP\/ui-refresh$/);
    await expect(h1(page)).toContainText('ui-refresh');
  });

  test('the item page: each view tab, tab memory through the tab strip, and closing tabs', async ({
    page,
  }) => {
    await page.goto('/items/RCP-14');
    const views = page.getByRole('tablist', { name: 'Ticket views' });
    for (const [name, content] of [
      ['Checklist', 'Agent review'],
      ['Dependencies', 'Waits on 1'],
      ['Activity', 'Lead and runs'],
      ['Details', 'Outcome'],
    ] as const) {
      await viewTab(views, name).click();
      await expect(viewTab(views, name)).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByRole('tabpanel')).toContainText(content);
      // The agent bar sits above the tabs on every one of them (B20).
      await expect(page.getByRole('region', { name: 'Lead agent' })).toContainText(
        'claude · orca-w3',
      );
    }
    // Arrow keys move between view tabs.
    await viewTab(views, 'Details').focus();
    await page.keyboard.press('ArrowRight');
    await expect(viewTab(views, 'Checklist')).toBeFocused();
    await expect(page).toHaveURL(/\/items\/RCP-14\?tab=checklist$/);
    await viewTab(views, 'Activity').click();
    await expect(page).toHaveURL(/\/items\/RCP-14\?tab=activity$/);
    // The open-item tab remembers the view in sessionStorage before we reload.
    await expect
      .poll(() => page.evaluate(() => sessionStorage.getItem('docket.tabs')))
      .toContain('"view":"activity"');

    await page.goto('/items/RCP-12');
    await expect(openTabs(page).getByRole('link')).toHaveCount(2);
    await openTabs(page).getByRole('link', { name: 'RCP-14' }).click();
    await expect(page).toHaveURL(/\/items\/RCP-14\?tab=activity$/);
    await expect(viewTab(views, 'Activity')).toHaveAttribute('aria-selected', 'true');

    // Closing the active tab moves to its neighbour; closing the last returns to where you came from.
    await page.getByRole('button', { name: 'Close RCP-14' }).click();
    await expect(page).toHaveURL(/\/items\/RCP-12/);
    await page.getByRole('button', { name: 'Close RCP-12' }).click();
    await expect(openTabs(page)).toHaveCount(0);
    await expect(page).not.toHaveURL(/\/items\//);
  });

  test('at most 8 open-item tabs: the oldest inactive one closes', async ({ page }) => {
    const ids = [
      'RCP-11',
      'RCP-12',
      'RCP-14',
      'RCP-15',
      'RCP-16',
      'RCP-17',
      'RCP-18',
      'RCP-19',
      'RCP-20',
    ];
    for (const id of ids) {
      await page.goto(`/items/${id}`);
      await expect(openTabs(page).getByRole('link', { name: id })).toBeVisible();
    }
    await expect(openTabs(page).getByRole('link')).toHaveCount(8);
    await expect(openTabs(page).getByRole('link', { name: 'RCP-11' })).toHaveCount(0);
    await expect(openTabs(page).getByRole('link', { name: 'RCP-20' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  test('scope lives in sessionStorage and resets to All projects in a new context', async ({
    page,
    browser,
  }) => {
    await mockGet(page, '/api/bootstrap', bootstrap);
    await page.goto('/work');
    await page.getByRole('button', { name: /^Project:?\s*All projects$/ }).click();
    const menu = page.getByRole('menu', { name: 'Choose project' });
    await expect(menu.getByRole('menuitemradio', { name: 'All projects' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await menu.getByRole('menuitemradio', { name: 'Recipe App' }).click();
    await expect(page.getByRole('button', { name: /^Project:?\s*Recipe App$/ })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toHaveText(
      'Recipe App / Work',
    );
    await page.reload();
    await expect(page.getByRole('button', { name: /^Project:?\s*Recipe App$/ })).toBeVisible();

    const fresh = await browser.newContext();
    await unlock(fresh);
    const other = await fresh.newPage();
    await other.goto('/work');
    await expect(other.getByRole('button', { name: /^Project:?\s*All projects$/ })).toBeVisible();
    await fresh.close();
  });

  test('every routed screen now answers: no "Not built yet" state, never a blank page', async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    // US2's routes (Needs you, Work board/list/map, items, Agents) answer; see
    // us2-visibility. So does the packet screen (US3); see us3-review. Settings
    // answers since US4 (its project rows; us4-deps), the label page since US7
    // (us7-planning), Work → Timeline since US8 (us8-timeline), and the Jira
    // import dialog since US9 (us9-jira; it has no route of its own).
    for (const path of ['/work?layout=timeline']) {
      await page.goto(path);
      await expect(h1(page)).toBeVisible();
      await expect(page.locator('[data-card="timeline-grid"]')).toBeVisible();
      await expect(page.locator('[data-error-state="not-built"]')).toHaveCount(0);
    }
    expect(errors).toEqual([]);
  });

  test('at ≤ 1180px the sidebar becomes a 64px icon rail with accessible names', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1100, height: 800 });
    await page.goto('/');
    const box = await nav(page).boundingBox();
    expect(Math.round(box!.width)).toBe(64);
    // Labels leave the rail visually (1px, clipped) but still name the links.
    const label = await nav(page).getByText('Needs you', { exact: true }).boundingBox();
    expect(label!.width).toBeLessThanOrEqual(1);
    await expect(nav(page).getByRole('link', { name: 'Work', exact: true })).toBeVisible();
    await expectAxeClean(page, 'rail (1100px)');
  });
});

test.describe('axe: every shell in both themes', () => {
  test.beforeEach(async ({ page }) => {
    await unlock(page.context());
  });

  for (const [label, path] of [
    ['Needs you', '/'],
    ['Work board', '/work'],
    ['Work list', '/work?layout=list'],
    ['Work map', '/work?layout=map'],
    ['Work timeline', '/work?layout=timeline'],
    ['Item details', '/items/RCP-14'],
    ['Item checklist', '/items/RCP-14?tab=checklist'],
    ['Item dependencies', '/items/RCP-14?tab=deps'],
    ['Item activity', '/items/RCP-14?tab=activity'],
    ['Packet', '/review/RCP-12'],
    ['Label page', '/labels/RCP/ui-refresh'],
    ['Agents', '/agents'],
    ['Settings', '/settings'],
    ['Not found', '/nope'],
  ] as const) {
    test(label, async ({ page }) => {
      await page.goto(path);
      await expect(h1(page)).toBeVisible();
      await page.waitForLoadState('networkidle');
      await expectAxeClean(page, label);
    });
  }

  test('Quick capture dialog and the palette', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: '+ New' }).click();
    const dialog = page.getByRole('dialog', { name: 'New item in Inbox' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel(/^Title/)).toBeFocused();
    await expectAxeClean(page, 'Quick capture');
    await dialog.getByRole('button', { name: 'Create' }).click();
    const toast = page.locator('.toasts[role="status"]');
    await expect(toast).toContainText('Give it a title');
    await page.keyboard.press('Escape');
    // Let the 3.2 s toast leave, so axe doesn't sample it mid-fade.
    await expect(toast.locator('.toast')).toHaveCount(0, { timeout: 5000 });
    await openPalette(page);
    await expectAxeClean(page, 'Command palette');
  });

  test('the destructive Rotate owner key dialog focuses Cancel @protected', async ({ page }) => {
    await page.goto('/settings');
    await page.getByRole('button', { name: 'Rotate owner key…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Rotate the owner key?' });
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await expectAxeClean(page, 'Rotate owner key dialog');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  });

  test('empty states are axe-clean', async ({ page }) => {
    await mockGet(page, '/api/bootstrap', bootstrap);
    await mockGet(page, '/api/needs-you', emptyNeedsYou);
    await mockGet(page, '/api/work', emptyWork);
    await mockGet(page, '/api/agents', emptyAgents);
    await mockGet(page, '/api/workspaces', emptyWorkspaces);
    await mockGet(page, '/api/settings', emptySettings);

    await page.goto('/');
    await expect(page.getByText('No active runs')).toBeVisible();
    await expect(
      page.getByText('Nothing to verify. Agents will hand off when work is built.'),
    ).toBeVisible();
    await expect(
      page.getByText('No stale or failed runs, cycles or date conflicts.'),
    ).toBeVisible();
    await expect(page.getByText('Nothing deferred.')).toBeVisible();
    await expect(page.getByText('Nothing in Planning.')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'For you now · 0' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Problems · 0' })).toBeVisible();
    await expectAxeClean(page, 'Needs you (empty)');

    await page.goto('/work?layout=list');
    await expect(page.getByText('No items match.')).toBeVisible();
    await expectAxeClean(page, 'Work list (empty)');

    await page.goto('/agents');
    await expect(page.getByText('No runs yet. Connect an agent from Settings.')).toBeVisible();
    await expect(
      page.getByText('No workspaces recorded yet. Agents report theirs when they claim work.'),
    ).toBeVisible();
    await expectAxeClean(page, 'Agents (empty)');

    await page.goto('/settings');
    await expect(page.getByText('No projects yet.')).toBeVisible();
    await expectAxeClean(page, 'Settings (empty)');
  });
});

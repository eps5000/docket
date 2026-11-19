/**
 * Accessibility pass (tasks.md T142; SC-010; constitution Principle V;
 * UI_SPEC §11).
 *
 * - axe (WCAG 2.1 A and AA) on every route, in light and dark, with no
 *   serious or critical violation: every shell screen, each ticket view,
 *   the epic, the packet, a label page, the Timeline with an active filter
 *   chip, archived cards, Unlock, Not found, and each dialog while open;
 * - the keyboard paths: the skip link, the tabs pattern (arrows, Home,
 *   End), the map canvas (focus, then arrows pan), and dialogs (focus moves
 *   in, Tab stays inside, Esc closes and focus returns; destructive dialogs
 *   start on Cancel).
 *
 * The NVDA spot check of the packet flow needs a person with a screen
 * reader: it is an owner step in docker/smoke/OWNER-CHECKLIST.md.
 */
import type { Locator, Page } from '@playwright/test';
import { expect, expectAxeClean, test, unlock, useSeededContainer } from './fixtures';

useSeededContainer();

test.beforeEach(async ({ page }) => {
  await unlock(page.context());
  await page.context().addInitScript(() => localStorage.setItem('docket.notifications', 'off'));
});

/** Every route, and what says it has rendered. */
const ROUTES: { name: string; path: string; ready: (p: Page) => Locator }[] = [
  { name: 'Needs you', path: '/', ready: (p) => p.getByRole('heading', { name: /^For you now/ }) },
  { name: 'Work board', path: '/work', ready: (p) => p.locator('[data-layout="board"]') },
  { name: 'Work list', path: '/work?layout=list', ready: (p) => p.locator('[data-layout="list"]') },
  { name: 'Work map', path: '/work?layout=map', ready: (p) => p.locator('.pm-node').first() },
  {
    name: 'Work timeline',
    path: '/work?layout=timeline',
    ready: (p) => p.locator('[data-card="timeline-grid"]'),
  },
  {
    name: 'Work timeline, filtered by an epic',
    path: '/work?layout=timeline&epic=RCP-1',
    ready: (p) => p.locator('[data-active-filters]'),
  },
  {
    name: 'Ticket: Details',
    path: '/items/RCP-14?tab=details',
    ready: (p) => p.getByRole('tabpanel'),
  },
  {
    name: 'Ticket: Checklist',
    path: '/items/RCP-14?tab=checklist',
    ready: (p) => p.getByRole('tabpanel'),
  },
  {
    name: 'Ticket: Dependencies',
    path: '/items/RCP-14?tab=deps',
    ready: (p) => p.getByRole('tabpanel'),
  },
  {
    name: 'Ticket: Activity',
    path: '/items/RCP-15?tab=activity',
    ready: (p) => p.getByRole('tabpanel'),
  },
  { name: 'Epic: Details', path: '/items/RCP-1', ready: (p) => p.getByRole('tabpanel') },
  { name: 'Epic: Map', path: '/items/RCP-1?tab=deps', ready: (p) => p.locator('.pm-node').first() },
  {
    name: 'Packet',
    path: '/review/RCP-12',
    ready: (p) => p.getByRole('heading', { level: 1 }),
  },
  {
    name: 'Label page',
    path: '/labels/RCP/ui-refresh',
    ready: (p) => p.getByRole('heading', { level: 1 }),
  },
  { name: 'Agents', path: '/agents', ready: (p) => p.getByRole('heading', { level: 1 }) },
  // B20: Agents filtered from the Needs you strip; the agent bar with a stale lead and with none.
  {
    name: 'Agents, filtered to stale',
    path: '/agents?state=stale',
    ready: (p) => p.getByRole('table', { name: 'Active runs: stale' }),
  },
  {
    name: 'Ticket: the agent bar, no lead (In progress)',
    path: '/items/RCP-18',
    ready: (p) => p.getByRole('region', { name: 'Lead agent' }),
  },
  {
    name: 'Epic: Details with the Tickets list',
    path: '/items/RCP-1?tab=details',
    ready: (p) => p.locator('[data-ticket="RCP-14"]'),
  },
  { name: 'Settings', path: '/settings', ready: (p) => p.getByRole('heading', { level: 1 }) },
  {
    name: 'Agent files: one project, a file and its Workflow notes',
    path: '/agent-files?project=RCP&file=skill:docket-worker',
    ready: (p) => p.locator('[data-workflow="RCP"] .sectionhead'),
  },
  {
    name: 'Agent files: All projects (the defaults)',
    path: '/agent-files?project=all',
    ready: (p) => p.getByRole('table', { name: 'Default agent files' }),
  },
  // B22: Help (US12). The side panel is scanned in us12-help.spec.ts.
  {
    name: 'Help',
    path: '/help',
    ready: (p) => p.getByRole('heading', { name: 'Getting started' }),
  },
  {
    name: 'Help article',
    path: '/help/run-states',
    ready: (p) => p.getByRole('region', { name: 'Related' }),
  },
  { name: 'Not found', path: '/no-such-page', ready: (p) => p.getByRole('heading', { level: 1 }) },
];

test.describe('axe on every route, both themes (T142)', () => {
  for (const r of ROUTES) {
    test(r.name, async ({ page }) => {
      await page.goto(r.path);
      await expect(r.ready(page)).toBeVisible();
      await page.waitForLoadState('networkidle');
      await expectAxeClean(page, r.name);
    });
  }

  test('Unlock (a locked browser) @protected', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Unlock Docket' })).toBeVisible();
    await expectAxeClean(page, 'Unlock');
    await context.close();
  });

  test('archived cards keep full contrast (the kit fix)', async ({ page }) => {
    const csrf =
      (await page.context().cookies()).find((c) => c.name === 'docket_csrf')?.value ?? '';
    const res = await page.request.post('/api/items/RCP-11/archive', {
      headers: { 'X-Docket-CSRF': csrf },
      data: {},
    });
    expect(res.status(), await res.text()).toBe(200);
    await page.goto('/work?filter=archived');
    const card = page.locator('a.tcard.archived').first();
    await expect(card).toBeVisible();
    expect(await card.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
    expect(await card.evaluate((el) => getComputedStyle(el).borderTopStyle)).toBe('dashed');
    await expectAxeClean(page, 'archived cards', { include: '[data-layout="board"]' });
  });
});

test.describe('dialogs: axe while open, and the keyboard (T142)', () => {
  test('the palette: Ctrl+K focuses the search box, Esc closes and gives focus back', async ({
    page,
  }) => {
    await page.goto('/work');
    await expect(page.locator('[data-layout="board"]')).toBeVisible();
    const trigger = page.getByRole('button', { name: /Search/ }).first();
    await trigger.focus();
    await page.keyboard.press('Control+k');
    const dialog = page.getByRole('dialog', { name: 'Search or jump to' });
    await expect(dialog).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Search' })).toBeFocused();
    await page.keyboard.type('pantry');
    await expect(dialog.getByRole('option').first()).toBeVisible();
    await expectAxeClean(page, 'palette', { include: '[role="dialog"]' });
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  test('quick capture: + New focuses the title, Tab stays in the dialog, Esc closes', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: /^For you now/ })).toBeVisible();
    await page.getByRole('button', { name: '+ New' }).click();
    const dialog = page.getByRole('dialog', { name: 'New item in Inbox' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('textbox').first()).toBeFocused();
    await expectAxeClean(page, 'quick capture', { include: '[role="dialog"]' });
    await expectFocusTrapped(page, dialog);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  });

  test('a destructive dialog starts on Cancel and traps focus', async ({ page }) => {
    // From the agent bar (B20), on any tab.
    await page.goto('/items/RCP-15?tab=details');
    const release = page
      .getByRole('region', { name: 'Lead agent' })
      .getByRole('button', { name: 'Release lead claim…' });
    await release.click();
    const dialog = page.getByRole('dialog', { name: 'Release lead claim on RCP-15?' });
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await expectAxeClean(page, 'destructive dialog', { include: '[role="dialog"]' });
    await expectFocusTrapped(page, dialog);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(release).toBeFocused();
  });

  test('the document viewer', async ({ page, agent }) => {
    const put = await agent.call('put_document', {
      item_id: 'RCP-21',
      name: 'a11y-notes.md',
      kind: 'planning',
      content_text: '# Notes\n\nA short **planning** note.\n',
    });
    expect(put.isError).toBeFalsy();
    await page.goto('/items/RCP-21?tab=details');
    const open = page.locator('[data-document="a11y-notes.md"]').getByRole('button', {
      name: 'a11y-notes.md',
    });
    await open.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('link', { name: 'Download' })).toBeVisible();
    await expectAxeClean(page, 'document viewer', { include: '[role="dialog"]' });
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(open).toBeFocused();
  });
});

test.describe('keyboard paths (T142)', () => {
  test('the skip link is the first stop and moves focus to the main content', async ({ page }) => {
    await page.goto('/work');
    await expect(page.locator('[data-layout="board"]')).toBeVisible();
    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: 'Skip to content' });
    await expect(skip).toBeFocused();
    await expect(skip).toBeInViewport();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/#main$/);
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.closest('#main') !== null))
      .toBe(true);
  });

  test('the tabs pattern: arrows move and select, Home and End jump', async ({ page }) => {
    await page.goto('/items/RCP-14?tab=details');
    const views = page.getByRole('tablist', { name: 'Ticket views' });
    const tab = (name: string) => views.getByRole('tab', { name: new RegExp(`^${name}`) });
    await tab('Details').focus();
    await page.keyboard.press('ArrowRight');
    await expect(tab('Checklist')).toBeFocused();
    await expect(tab('Checklist')).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('End');
    await expect(tab('Activity')).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(tab('Details')).toBeFocused(); // wraps
    await page.keyboard.press('ArrowLeft');
    await expect(tab('Activity')).toBeFocused();
    await page.keyboard.press('Home');
    await expect(tab('Details')).toBeFocused();
    // Only the selected tab is in the Tab order.
    await expect(views.locator('[role="tab"][tabindex="0"]')).toHaveCount(1);
  });

  test('the map canvas: Tab reaches it, and the arrow keys pan it', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 900 });
    await page.goto('/work?layout=map');
    const canvas = page.getByRole('region', { name: /^Progress map/ });
    await expect(page.locator('.pm-node').first()).toBeVisible();
    await canvas.focus();
    await expect(canvas).toBeFocused();
    const scroll = () => canvas.evaluate((el) => ({ x: el.scrollLeft, y: el.scrollTop }));
    const pannable = await canvas.evaluate(
      (el) => el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight,
    );
    expect(pannable, 'the seed map overflows a 1024 px window').toBe(true);
    const before = await scroll();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowDown');
    await expect.poll(scroll).not.toEqual(before);
    // A card inside is a button: Tab moves into the cards, Enter opens one.
    await page.keyboard.press('Tab');
    const focused = page.locator('.pm-node:focus');
    await expect(focused).toHaveCount(1);
    const id = await focused.getAttribute('data-pid');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`/(items|review)/${id}`));
  });
});

/** Tab and Shift+Tab many times: focus never leaves the dialog. */
async function expectFocusTrapped(page: Page, dialog: Locator): Promise<void> {
  for (const key of ['Tab', 'Tab', 'Tab', 'Tab', 'Tab', 'Tab', 'Shift+Tab', 'Shift+Tab']) {
    await page.keyboard.press(key);
    expect(
      await dialog.evaluate((d) => d.contains(document.activeElement)),
      `focus left the dialog after ${key}`,
    ).toBe(true);
  }
}

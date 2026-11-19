/**
 * Reduced motion and the 1024×900 layout (tasks.md T144; UI_SPEC §8, §11;
 * BUILD_SPEC §10 "Cross-cutting").
 *
 * - With `prefers-reduced-motion: reduce`, nothing on any screen animates or
 *   transitions: no running CSS animation (the live-run pulse, toasts, fresh
 *   attachments) and no transition, including while hovering a map card and
 *   when a toast appears. The same screens without it do animate, so the
 *   check can fail.
 * - At 1024×900, no screen scrolls sideways (the board and the map scroll
 *   inside their own boxes), and the packet's decision panel sits under the
 *   queue.
 * - B35: at 1024×900, no element is wider than its container unless something
 *   between them scrolls or clips (the UI sweep's check, docker/smoke/ui-sweep.mjs),
 *   on the sample screens and on the stress project's (STR: long titles, many
 *   labels, big and empty epics). Board cards keep their text inside, and
 *   progress fills have height, in both.
 */
import type { Page } from '@playwright/test';
import { layoutReport } from '../../docker/smoke/ui-sweep.mjs';
import { expect, test, unlock, useSeededContainer } from './fixtures';

useSeededContainer();

test.beforeEach(async ({ page }) => {
  await unlock(page.context());
  await page.context().addInitScript(() => localStorage.setItem('docket.notifications', 'off'));
});

const SCREENS: [string, string][] = [
  ['Needs you', '/'],
  ['Work board', '/work'],
  ['Work list', '/work?layout=list'],
  ['Work map', '/work?layout=map'],
  ['Work timeline', '/work?layout=timeline'],
  ['Ticket', '/items/RCP-14?tab=checklist'],
  ['Ticket activity', '/items/RCP-15?tab=activity'],
  ['Epic map', '/items/RCP-1?tab=deps'],
  ['Packet', '/review/RCP-12'],
  ['Label page', '/labels/RCP/ui-refresh'],
  ['Agents', '/agents'],
  ['Settings', '/settings'],
];

/** The stress project's screens (B35), opened in its scope. */
const STRESS_SCREENS: [string, string][] = [
  ['Needs you', '/'],
  ['Work board', '/work'],
  ['Work list', '/work?layout=list'],
  ['Work map', '/work?layout=map'],
  ['Work timeline', '/work?layout=timeline'],
  ['Big epic (STR-3, 30+ tickets)', '/items/STR-3'],
  ['Big epic checklist', '/items/STR-3?tab=checklist'],
  ['Empty epic', '/items/STR-1'],
  ['Many labels', '/items/STR-14'],
  ['Imported ticket checklist', '/items/STR-203?tab=checklist'],
  ['Blocked chain', '/items/STR-164?tab=deps'],
  ['Label page', '/labels/STR/accessibility-and-keyboard-navigation'],
  ['Agents', '/agents'],
  ['Settings', '/settings'],
];

/** Switch to the STR project before the app reads its scope (sessionStorage). */
async function stressScope(page: Page): Promise<void> {
  await page.addInitScript(() => sessionStorage.setItem('docket.scope', 'STR'));
}

async function expectNoSpill(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, 'the page scrolls sideways').toBeLessThanOrEqual(0);
  const report = await layoutReport(page);
  expect(
    report.overflow,
    `${report.overflowCount} elements outside their container, with nothing that scrolls or clips`,
  ).toEqual([]);
  expect(report.flat, 'progress fills with no height').toEqual([]);
}

async function open(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  await page.waitForLoadState('networkidle');
}

/** Running CSS animations and transitions, and elements with a non-zero transition. */
async function motion(page: Page): Promise<{ running: string[]; transitions: number }> {
  return page.evaluate(() => {
    const running = document
      .getAnimations()
      .filter((a) => a.playState === 'running')
      .map((a) => {
        const el = (a.effect as KeyframeEffect | null)?.target as Element | null;
        return `${a.constructor.name} on ${el?.className || el?.tagName || '?'}`;
      });
    let transitions = 0;
    for (const el of document.querySelectorAll('.tl *')) {
      const s = getComputedStyle(el);
      if (s.transitionDuration.split(',').some((d) => parseFloat(d) > 0)) transitions++;
    }
    return { running, transitions };
  });
}

test.describe('reduced motion (T144)', () => {
  test('without it, the app does animate (so the check below can fail)', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await open(page, '/work?layout=map');
    expect((await motion(page)).transitions).toBeGreaterThan(0);
  });

  for (const [name, path] of SCREENS) {
    test(`${name}: nothing animates or transitions`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await open(page, path);
      const m = await motion(page);
      expect(m.running, 'running animations').toEqual([]);
      expect(m.transitions, 'elements with a transition').toBe(0);
    });
  }

  test('hovering a map card and showing a toast stay still', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await open(page, '/work?layout=map');
    await page.locator('.pm-node').first().hover();
    expect((await motion(page)).running).toEqual([]);
    // A toast: archive a done card, then the Undo toast appears without its slide-in.
    await open(page, '/work');
    const done = page.getByRole('region', { name: 'Done' });
    await done.getByRole('button', { name: 'Archive' }).first().click();
    await expect(page.getByRole('status').filter({ hasText: /Archived/ })).toBeVisible();
    expect((await motion(page)).running).toEqual([]);
    await page.getByRole('button', { name: 'Undo' }).click();
  });
});

test.describe('1024×900 (T144)', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 900 });
  });

  for (const [name, path] of SCREENS) {
    test(`${name}: no sideways page scroll`, async ({ page }) => {
      await open(page, path);
      await expectNoSpill(page);
      await expect(page.locator('#main')).toBeInViewport();
    });
  }

  for (const [name, path] of STRESS_SCREENS) {
    test(`stress project, ${name}: no sideways scroll, nothing spills`, async ({ page }) => {
      await stressScope(page);
      await open(page, path);
      await expectNoSpill(page);
    });
  }

  test('six open items with long titles: the tab strip scrolls, the page does not', async ({
    page,
  }) => {
    // B35 (found by the UI sweep): the tabs' screen-reader-only text escaped the strip's
    // scroll box and widened the page by about 90 px.
    for (const id of ['STR-40', 'STR-35', 'STR-3', 'STR-1', 'STR-206', 'RCP-12']) {
      await open(page, `/items/${id}`);
    }
    await expect(page.locator('[data-open-tab]')).toHaveCount(6);
    await expectNoSpill(page);
  });

  test('the packet: the decision panel sits under the queue', async ({ page }) => {
    await open(page, '/review/RCP-12');
    const box = async (col: string) =>
      (await page.locator(`[data-column="${col}"]`).boundingBox())!;
    const queue = await box('queue');
    const packet = await box('packet');
    const decision = await box('decision');
    expect(decision.x).toBeCloseTo(queue.x, 0);
    expect(decision.y).toBeGreaterThanOrEqual(queue.y + queue.height - 1);
    expect(packet.x).toBeGreaterThan(queue.x + queue.width - 1);
    expect(decision.x + decision.width).toBeLessThanOrEqual(1024);
  });
  for (const project of ['all', 'STR']) {
    test(`the board (${project}): cards keep their text inside, and progress bars fill`, async ({
      page,
    }) => {
      if (project === 'STR') await stressScope(page);
      await open(page, '/work');
      await expect(page.locator('a.tcard').first()).toBeVisible();
      // Gameflow pilot: long titles and chips spilled past the card, because the
      // card's auto grid track grew to its widest child.
      const spills = await page.$$eval('a.tcard, a.epiccard', (cards) =>
        cards.flatMap((card) => {
          const c = card.getBoundingClientRect();
          return [...card.querySelectorAll('*')]
            .map((el) => ({ el, r: el.getBoundingClientRect() }))
            .filter(({ r }) => r.width > 0 && r.right > c.right + 1)
            .map(({ el }) => `${card.getAttribute('href')}: ${el.className || el.tagName}`);
        }),
      );
      expect(spills, 'children wider than their card').toEqual([]);
      // Gameflow pilot: a board class named "mini" padded the epic bars, so the
      // fills had no height and every bar looked empty.
      const bars = page.locator('.epiccard .pbar');
      expect(await bars.count()).toBeGreaterThan(0);
      const flat = await page.$$eval(
        '.pbar i',
        (fills) => fills.filter((i) => i.getBoundingClientRect().height < 2).length,
      );
      expect(flat, 'progress fills with no height').toBe(0);
    });
  }
});

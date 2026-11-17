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
 */
import type { Page } from '@playwright/test';
import { expect, test, unlock, useSeededContainer } from './fixtures';

useSeededContainer();

test.beforeEach(async ({ page }) => {
  await unlock(page.context());
  await page.context().addInitScript(() => localStorage.setItem('tl.notifications', 'off'));
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
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, 'the page scrolls sideways').toBeLessThanOrEqual(0);
      await expect(page.locator('#main')).toBeInViewport();
    });
  }

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
});

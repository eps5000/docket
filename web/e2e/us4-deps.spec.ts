/**
 * Dependencies end to end (tasks.md T105; spec US4; UI_SPEC §6.3.3, §6.3.4,
 * §6.7, §11; BUILD_SPEC §10 "Map" and "Stricter dependencies").
 *
 * - The map: waves plus an "Outside this epic" column, done items and the
 *   done count, arrows drawn and kept on resize and zoom, hover tracing,
 *   More pills with the drag hint, drag to pan, Fit, reset and zoom steps;
 *   the seed's largest epic renders in under 1 s.
 * - Work → Map with "Outside this view".
 * - The project rule select with its toast and Undo; the blocked chip
 *   "(needs merge)" and "done · waiting for merge"; an agent-reported merge
 *   clears it.
 * - The cycle fix from the Dependencies tab, with Undo.
 * - axe on the map, the Dependencies tab and Settings, both themes.
 *
 * Set TASKLITE_E2E_SCREENSHOTS to a folder to also capture the PR's light
 * and dark screenshots.
 */
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { expect, expectAxeClean, setTheme, test, useSeededContainer } from './fixtures/index';

useSeededContainer();

const out = process.env.TASKLITE_E2E_SCREENSHOTS;

async function shoot(page: Page, name: string, target?: Locator) {
  if (!out) return;
  for (const theme of ['light', 'dark'] as const) {
    await setTheme(page, theme);
    const path = join(out, `us4-${name}-${theme}.png`);
    if (target) await target.screenshot({ path });
    else await page.screenshot({ path, fullPage: true });
  }
  await setTheme(page, 'light');
}

const map = (page: Page) => page.locator('[data-progress-map]');
const card = (page: Page, id: string) => map(page).locator(`.pm-node[data-pid="${id}"]`);
const edges = (page: Page) => map(page).locator('path.pm-edge');

/** The arrow's end point (just left of the blocked card) must sit on that card's left edge. */
async function arrowsLineUp(page: Page, from: string, to: string): Promise<void> {
  const ok = await page.evaluate(
    ([f, t]) => {
      const path = document.querySelector<SVGPathElement>(
        `path.pm-edge[data-from="${f}"][data-to="${t}"]`,
      );
      const target = document.querySelector<HTMLElement>(`.pm-node[data-pid="${t}"]`);
      const source = document.querySelector<HTMLElement>(`.pm-node[data-pid="${f}"]`);
      if (!path || !target || !source) return 'missing';
      const len = path.getTotalLength();
      const end = path.getPointAtLength(len);
      const start = path.getPointAtLength(0);
      const svg = path.ownerSVGElement!.getBoundingClientRect();
      const scale = svg.width / Number(path.ownerSVGElement!.getAttribute('width'));
      const tr = target.getBoundingClientRect();
      const sr = source.getBoundingClientRect();
      const ex = svg.left + end.x * scale;
      const ey = svg.top + end.y * scale;
      const sx = svg.left + start.x * scale;
      const sy = svg.top + start.y * scale;
      const near = (a: number, b: number) => Math.abs(a - b) <= 6;
      return near(ex, tr.left) &&
        near(ey, tr.top + tr.height / 2) &&
        near(sx, sr.right) &&
        near(sy, sr.top + sr.height / 2)
        ? 'ok'
        : `off: end ${ex},${ey} vs ${tr.left},${tr.top + tr.height / 2}`;
    },
    [from, to],
  );
  expect(ok).toBe('ok');
}

test.describe('the progress map', () => {
  test('epic Map tab: waves, the outside column, done items, arrows, tracing, zoom and pan', async ({
    ownerPage: page,
  }) => {
    await page.goto('/items/RCP-1');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    // The seed's largest epic (RCP-1, 12 children) renders, arrows and all, in under 1 s.
    const started = Date.now();
    await page.getByRole('tab', { name: /^Map/ }).click();
    await expect(edges(page).first()).toBeAttached();
    const elapsed = Date.now() - started;
    console.log(`map render (RCP-1, 12 items): ${elapsed} ms`);
    expect(elapsed).toBeLessThan(1000);

    const heads = map(page).locator('.pm-colh');
    await expect(heads.first()).toContainText('Outside this epic');
    await expect(heads.nth(1)).toContainText('Wave 1');
    await expect(heads.nth(1)).toContainText('nothing blocks these');
    await expect(heads.nth(2)).toContainText('after wave 1');
    await expect(
      map(page).locator('[data-col="outside"] .pm-node[data-pid="DOC-4"]'),
    ).toContainText('DOC ↗');
    // Done items and the done count.
    await expect(card(page, 'RCP-11')).toHaveClass(/ps-done/);
    await expect(card(page, 'RCP-11')).toContainText('✓');
    await expect(map(page).locator('.pm-big')).toContainText(/\d+ \/ 12 done/);
    // A blocked Ready card: red border and "blocked".
    await expect(card(page, 'RCP-16')).toHaveClass(/blk/);
    await expect(card(page, 'RCP-16')).toContainText('blocked');
    // The person icon: filled for a packet ready (RCP-12), outlined for review later.
    await expect(card(page, 'RCP-12').locator('.pm-hr.now')).toBeVisible();

    // Arrows: drawn, a dashed green one for a cleared link, and lined up with the cards.
    const count = await edges(page).count();
    expect(count).toBeGreaterThan(5);
    await expect(map(page).locator('path.pm-edge.ok').first()).toBeAttached();
    await arrowsLineUp(page, 'RCP-11', 'RCP-12');
    await arrowsLineUp(page, 'DOC-4', 'RCP-16');

    // Kept on resize (redrawn after the 80 ms debounce).
    await page.setViewportSize({ width: 1024, height: 900 });
    await page.waitForTimeout(250);
    await expect(edges(page)).toHaveCount(count);
    await arrowsLineUp(page, 'RCP-11', 'RCP-12');

    // Overflowing at 1024 px: the drag hint and a More pill.
    await expect(map(page).getByText('Drag to pan')).toBeVisible();
    const more = map(page).getByRole('button', { name: /scroll the map right/ });
    await expect(more).toBeVisible();

    // Drag the background to pan (cards still open on click).
    const canvas = map(page).getByRole('region', { name: /Progress map/ });
    const box = (await canvas.boundingBox())!;
    const before = await canvas.evaluate((el) => el.scrollLeft);
    // The top padding is background on every platform (the bottom edge can be a scrollbar).
    await page.mouse.move(box.x + box.width - 30, box.y + 8);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 230, box.y + 8, { steps: 8 });
    await page.mouse.up();
    expect(await canvas.evaluate((el) => el.scrollLeft)).toBeGreaterThan(before);
    await expect(map(page).getByRole('button', { name: /scroll the map left/ })).toBeVisible();

    // Arrow keys pan while the canvas has focus (UI_SPEC §11).
    await canvas.evaluate((el) => el.scrollTo({ left: 0 }));
    await canvas.focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    expect(await canvas.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);

    // Zoom steps, reset and Fit; arrows survive each one.
    const zoomLabel = map(page).getByRole('button', { name: /^Zoom \d+%/ });
    await expect(zoomLabel).toHaveText('100%');
    await map(page).getByRole('button', { name: 'Zoom out' }).click();
    await expect(zoomLabel).toHaveText('80%');
    await map(page).getByRole('button', { name: 'Zoom out' }).click();
    await expect(zoomLabel).toHaveText('67%');
    await expect(edges(page)).toHaveCount(count);
    await arrowsLineUp(page, 'RCP-11', 'RCP-12');
    await map(page).getByRole('button', { name: 'Zoom in' }).click();
    await map(page).getByRole('button', { name: 'Zoom in' }).click();
    await map(page).getByRole('button', { name: 'Zoom in' }).click();
    await expect(zoomLabel).toHaveText('125%');
    await zoomLabel.click();
    await expect(zoomLabel).toHaveText('100%');
    const fit = map(page).getByRole('button', { name: 'Fit' });
    await fit.click();
    await expect(fit).toHaveAttribute('aria-pressed', 'true');
    const fitPct = Number((await zoomLabel.textContent())!.replace('%', ''));
    expect(fitPct).toBeGreaterThanOrEqual(40);
    expect(fitPct).toBeLessThanOrEqual(100);
    await expect(map(page).getByRole('button', { name: /scroll the map right/ })).toBeHidden();
    await arrowsLineUp(page, 'RCP-11', 'RCP-12');
    await fit.click();
    await expect(zoomLabel).toHaveText('100%');

    // Hover traces a card's links and dims the rest.
    await page.setViewportSize({ width: 1440, height: 900 });
    await card(page, 'RCP-12').hover();
    await expect(card(page, 'RCP-12')).toHaveClass(/hl/);
    await expect(card(page, 'RCP-22')).toHaveClass(/hl/);
    await expect(card(page, 'RCP-11')).toHaveClass(/hl/);
    await expect(card(page, 'RCP-27')).toHaveClass(/dim/);
    // RCP-11 → RCP-12, RCP-12 → RCP-22 and RCP-12 → RCP-23.
    await expect(map(page).locator('path.pm-edge.hl')).toHaveCount(3);
    await page.mouse.move(5, 5);
    await expect(map(page).locator('.pm-node.dim')).toHaveCount(0);

    await shoot(page, 'epic-map', page.locator('[data-section="map"]'));
    await expectAxeClean(page, 'epic Map tab');

    // A card opens its item.
    await card(page, 'RCP-22').click();
    await expect(page).toHaveURL(/\/items\/RCP-22/);
  });

  test('Work → Map shows the filtered set with "Outside this view"', async ({
    ownerPage: page,
  }) => {
    await page.goto('/work?layout=map&epic=RCP-2');
    await expect(map(page)).toBeVisible();
    await expect(map(page).locator('.pm-colh').first()).toContainText('Outside this view');
    await expect(map(page).locator('[data-col="outside"] .pm-node')).not.toHaveCount(0);
    await expect(edges(page).first()).toBeAttached();
    await shoot(page, 'work-map', page.locator('[data-layout="map"]'));
    await expectAxeClean(page, 'Work → Map');
  });
});

test.describe('stricter dependencies', () => {
  test('the project rule select blocks again with a toast and Undo; the merge clears it', async ({
    ownerPage: page,
    agent,
  }) => {
    // RCP-11 is done and blocks RCP-12 (review). Under "Done" it is cleared.
    await page.goto('/items/RCP-12');
    await expect(page.getByText(/Blocked by RCP-11/)).toHaveCount(0);

    await page.goto('/settings');
    const select = page.locator('[data-blocker-rule="RCP"] select');
    await expect(select).toHaveValue('done');
    await expect(select).toHaveAttribute('title', /Agents can override it per link/);
    await shoot(page, 'settings-rule', page.locator('[data-project="RCP"]'));
    await expectAxeClean(page, 'Settings');

    await select.selectOption('merged');
    const toast = page.locator('.toast').filter({ hasText: 'Blocker rule for' }).last();
    await expect(toast).toContainText(/set to PR merged\. \d+ items? (is|are) blocked again\./);
    await expect(select).toHaveValue('merged');

    // Undo restores Done.
    await toast.getByRole('button', { name: 'Undo' }).click();
    await expect(select).toHaveValue('done');

    await select.selectOption('merged');
    await expect(select).toHaveValue('merged');

    // The chip says what the done blocker still needs, and the Dependencies tab says it too.
    await page.goto('/items/RCP-12');
    await expect(page.getByText('Blocked by RCP-11 (needs merge)')).toBeVisible();
    await page.getByRole('tab', { name: /^Dependencies/ }).click();
    const blocker = page.locator('[data-hop] .pm-node[data-pid="RCP-11"]');
    await expect(blocker).toContainText('Done');
    await expect(blocker).toContainText('waiting for merge');
    await expect(blocker.locator('.pm-wait')).toHaveAttribute('title', /reported by the agent/);
    await shoot(page, 'deps-waiting-merge', page.locator('[data-section="deps"]'));
    await expectAxeClean(page, 'Dependencies tab (waiting for merge)');

    // The agent reports the merge: RCP-12 is no longer blocked by RCP-11.
    const merged = await agent.call('link_artifact', {
      id: 'RCP-11',
      kind: 'pr',
      label: 'PR #41',
      url: 'https://github.com/example/recipes/pull/41',
      state: 'merged',
    });
    expect(merged.isError, merged.text).toBe(false);
    await page.reload();
    await expect(page.getByText(/Blocked by RCP-11/)).toHaveCount(0);

    // Put the rule back for the other tests in this file.
    await page.goto('/settings');
    await page.locator('[data-blocker-rule="RCP"] select').selectOption('done');
    await expect(page.locator('[data-blocker-rule="RCP"] select')).toHaveValue('done');
  });

  test('a cycle is fixed from the Dependencies tab, and Undo brings it back', async ({
    ownerPage: page,
  }) => {
    await page.goto('/');
    const row = page.locator('[data-problem="cycle"]').first();
    await expect(row).toContainText('DOC-7 ⇄ DOC-8');
    await row.getByRole('link', { name: 'Fix' }).click();
    await expect(page).toHaveURL(/\/items\/DOC-\d+\?tab=deps/);
    const callout = page.locator('[data-section="deps"] [data-cycle]');
    await expect(callout).toContainText('is in a dependency cycle: DOC-7 → DOC-8 → DOC-7');
    await expect(page.getByRole('tab', { name: /Dependencies/ })).toContainText(
      'in a dependency cycle',
    );
    await shoot(page, 'deps-cycle', page.locator('[data-section="deps"]'));
    await expectAxeClean(page, 'Dependencies tab (cycle)');

    await page.getByRole('button', { name: 'Remove “DOC-8 blocks DOC-7”' }).click();
    const toast = page.locator('.toast').filter({ hasText: 'Cycle resolved' });
    await expect(toast).toContainText('Removed “DOC-8 blocks DOC-7”. Cycle resolved.');
    await expect(callout).toHaveCount(0);

    await toast.getByRole('button', { name: 'Undo' }).click();
    await expect(page.locator('[data-section="deps"] [data-cycle]')).toBeVisible();
  });
});

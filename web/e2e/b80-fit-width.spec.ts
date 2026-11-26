/**
 * B80 (owner decision 63): Fit width. Fit scales the map so every wave fits
 * the canvas's width, never above 100% or below 50%, and goes back to the
 * top; the map scrolls down for the rest.
 *
 * RCP-1's answer is rewritten into synthetic maps, keeping the real
 * response's shape:
 * - tall: 5 waves with 12 tickets in wave 3 (the owner's case);
 * - wide: 6 waves of 2;
 * - narrow: 2 waves, capped at 100%;
 * - very wide: 16 waves in a chain, held at 50% and scrolling both ways.
 *
 * Also: the scroll position after Fit width, wheel and keyboard scrolling, the
 * zoom buttons and *Hide implied links* alongside it, Work → Map on the seed,
 * axe in both themes, no page overflow, and screenshots at 1440 x 900 and
 * 1024 px (DOCKET_E2E_SCREENSHOTS).
 */
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import type { ItemDetailResponse, ItemSummary, LinkEdge, Status } from '@docket/shared';
import { expect, expectAxeClean, setTheme, test, useSeededContainer } from './fixtures/index';

useSeededContainer();

const out = process.env.DOCKET_E2E_SCREENSHOTS;
const SIZES = [
  { name: '1440', width: 1440, height: 900 },
  { name: '1024', width: 1024, height: 768 },
] as const;
const HELP = 'Fit every wave to the width. Scroll down for the rest.';

/** Tickets per wave. Each ticket waits on the first ticket of the wave before it. */
const SHAPES = {
  tall: [1, 1, 12, 1, 1],
  wide: [2, 2, 2, 2, 2, 2],
  narrow: [2, 1],
  veryWide: Array.from({ length: 16 }, () => 1),
} as const;
type Shape = keyof typeof SHAPES;

function graph(shape: Shape) {
  const waves: string[][] = [];
  const links: LinkEdge[] = [];
  let n = 0;
  for (const count of SHAPES[shape]) {
    const wave = Array.from({ length: count }, () => `RCP-${800 + ++n}`);
    const from = waves.at(-1)?.[0];
    for (const to of from ? wave : []) {
      links.push({
        link_id: `lnk_b80_${to}`,
        from: from!,
        to,
        type: 'blocks',
        satisfied_when: 'done',
        cleared: false,
      });
    }
    waves.push(wave);
  }
  return { waves, links };
}

/** Serve RCP-1's Map from a synthetic shape. */
async function useShape(page: Page, shape: Shape) {
  const { waves, links } = graph(shape);
  await page.route(/\/api\/items\/RCP-1(\?.*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const res = await route.fetch();
    const body = (await res.json()) as ItemDetailResponse;
    const base = body.children[0] as ItemSummary;
    const children = waves.flat().map((id, i) => {
      const blockers = links.filter((l) => l.to === id).map((l) => l.from);
      const status: Status = blockers.length > 0 ? 'ready' : 'progress';
      return {
        ...base,
        id,
        title: `Synthetic ticket ${i + 1} with a title long enough to wrap`,
        status,
        blocked: blockers.length > 0,
        blocked_by: blockers,
        lead: null,
      };
    });
    await route.fulfill({ response: res, json: { ...body, children, links, outside: [] } });
  });
  return { waves, links };
}

const map = (page: Page) => page.locator('[data-progress-map]');
const canvas = (page: Page) => map(page).locator('.pm-canvas');
const fitButton = (page: Page) => map(page).getByRole('button', { name: 'Fit width' });
const zoomLabel = (page: Page) => map(page).getByRole('button', { name: /^Zoom \d+%/ });

async function openShape(page: Page, shape: Shape) {
  const { waves, links } = await useShape(page, shape);
  await page.goto('/items/RCP-1');
  await page.getByRole('tab', { name: /^Map/ }).click();
  await expect(map(page).locator('.pm-colh')).toHaveCount(waves.length);
  await expect(map(page).locator('path.pm-edge')).toHaveCount(links.length);
  // The whole canvas on screen, so "in view" means in the canvas's own view.
  await canvas(page).evaluate((c) => c.scrollIntoView({ block: 'center' }));
}

/** What the canvas shows: its zoom, the map's unscaled width, and what overflows. */
function state(page: Page) {
  return map(page).evaluate((root) => {
    const c = root.querySelector<HTMLElement>('.pm-canvas')!;
    const m = root.querySelector<HTMLElement>('.pm-map')!;
    return {
      pct: Number(m.dataset.zoom),
      mapW: parseFloat(m.style.width),
      // The canvas's padding is 22 px on each side.
      avail: c.clientWidth - 44,
      overX: c.scrollWidth > c.clientWidth + 1,
      overY: c.scrollHeight > c.clientHeight + 1,
      top: c.scrollTop,
      left: c.scrollLeft,
    };
  });
}

/** The width fit the spec describes: the width only, rounded down, 50% to 100%. */
const widthFit = (s: { mapW: number; avail: number }) =>
  Math.round(Math.max(0.5, Math.min(1, Math.floor((s.avail / s.mapW) * 1000) / 1000)) * 100);

/** Fit width, then wait until the zoom is the width fit (it settles after one re-measure). */
async function fitWidth(page: Page) {
  // An open epic tab now remembers Fit width across view switches and reloads.
  // Turn it off first if it is already active so this helper still exercises the button.
  if ((await fitButton(page).getAttribute('aria-pressed')) === 'true') {
    await fitButton(page).click();
  }
  await fitButton(page).click();
  await expect(fitButton(page)).toHaveAttribute('aria-pressed', 'true');
  await expect
    .poll(async () => {
      const s = await state(page);
      return s.pct - widthFit(s);
    })
    .toBe(0);
  return state(page);
}

const shots = async (page: Page, name: string) => {
  if (!out) return;
  for (const theme of ['light', 'dark'] as const) {
    await setTheme(page, theme);
    await page.screenshot({ path: join(out, `b80-${name}-${theme}.png`) });
  }
  await setTheme(page, 'light');
};

const noOverflow = async (page: Page, width: number) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    width,
  );

test.beforeEach(async ({ ownerPage: page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
});

test('a tall map fits its waves to the width, then scrolls down', async ({ ownerPage: page }) => {
  await openShape(page, 'tall');
  await expect(map(page).locator('[data-col="wave-3"] .pm-node')).toHaveCount(12);
  await expect(fitButton(page)).toHaveAttribute('title', HELP);
  await expect(fitButton(page)).toHaveAttribute('aria-pressed', 'false');

  // Somewhere down and right first: Fit width goes back to the top left.
  await canvas(page).evaluate((c) => {
    c.scrollTop = 200;
    c.scrollLeft = 150;
  });
  const s = await fitWidth(page);
  expect(s.pct).toBeGreaterThan(50);
  expect(s.pct).toBeLessThanOrEqual(100);
  expect(s.overX, 'every wave fits the width').toBe(false);
  expect(s.overY, 'the 12-ticket wave runs below the fold').toBe(true);
  expect([s.top, s.left]).toEqual([0, 0]);
  await expect(map(page).getByRole('button', { name: /scroll the map right/ })).toBeHidden();
  await expect(map(page).getByRole('button', { name: /scroll the map down/ })).toBeVisible();
  await expect(map(page).locator('.pm-colh').last()).toBeInViewport();
  const lastInWave3 = map(page).locator('[data-col="wave-3"] .pm-node').last();
  await expect(lastInWave3).not.toBeInViewport();

  // The mouse wheel (and a trackpad, which sends wheel events) scrolls it down, not sideways.
  const box = (await canvas(page).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 400);
  await expect.poll(async () => (await state(page)).top).toBeGreaterThan(0);
  expect((await state(page)).left).toBe(0);

  // The keyboard: arrow keys while the canvas has focus.
  await canvas(page).evaluate((c) => {
    c.scrollTop = 0;
  });
  await canvas(page).focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect.poll(async () => (await state(page)).top).toBeGreaterThan(0);
  for (let i = 0; i < 30; i++) await page.keyboard.press('ArrowDown');
  await expect(lastInWave3).toBeInViewport();
  // Still fitted: scrolling doesn't change the zoom.
  await expect(fitButton(page)).toHaveAttribute('aria-pressed', 'true');
  expect((await state(page)).pct).toBe(s.pct);

  // The zoom buttons work as before: + leaves Fit width at the next step.
  await map(page).getByRole('button', { name: 'Zoom in' }).click();
  await expect(fitButton(page)).toHaveAttribute('aria-pressed', 'false');
  expect(Number((await zoomLabel(page).textContent())!.replace('%', ''))).toBeGreaterThan(s.pct);
  // Pressing Fit width again returns to the top; pressing it once more goes back to 100%.
  await fitWidth(page);
  expect((await state(page)).top).toBe(0);
  await fitButton(page).click();
  await expect(zoomLabel(page)).toHaveText('100%');
});

test('a wide map scales down to fit its six waves', async ({ ownerPage: page }) => {
  await openShape(page, 'wide');
  const s = await fitWidth(page);
  expect(s.pct).toBeGreaterThan(50);
  expect(s.pct).toBeLessThan(100);
  expect(s.overX).toBe(false);
  await expect(map(page).getByRole('button', { name: /scroll the map right/ })).toBeHidden();
  // Hide implied links stays where it was.
  await expect(map(page).getByRole('switch', { name: 'Hide implied links' })).toBeChecked();
});

test('an open epic tab keeps zoom and Fit width across view switches', async ({
  ownerPage: page,
}) => {
  await openShape(page, 'wide');
  await map(page).getByRole('button', { name: 'Zoom in' }).click();
  await expect(zoomLabel(page)).toHaveText('125%');

  await page.getByRole('tab', { name: /^Details/ }).click();
  await page.getByRole('tab', { name: /^Map/ }).click();
  await expect(zoomLabel(page)).toHaveText('125%');

  await fitWidth(page);
  await page.getByRole('tab', { name: /^Details/ }).click();
  await page.getByRole('tab', { name: /^Map/ }).click();
  await expect(fitButton(page)).toHaveAttribute('aria-pressed', 'true');
});

test('a narrow map is never blown up past 100%', async ({ ownerPage: page }) => {
  await openShape(page, 'narrow');
  const s = await fitWidth(page);
  expect(s.pct).toBe(100);
  await expect(zoomLabel(page)).toHaveText('100%');
  expect(s.overX).toBe(false);
});

test('a very wide map stops at 50% and scrolls both ways', async ({ ownerPage: page }) => {
  await openShape(page, 'veryWide');
  const s = await fitWidth(page);
  expect(s.pct).toBe(50);
  expect(s.overX).toBe(true);
  expect([s.top, s.left]).toEqual([0, 0]);
  await expect(map(page).getByRole('button', { name: /scroll the map right/ })).toBeVisible();
  const box = (await canvas(page).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(400, 0);
  await expect.poll(async () => (await state(page)).left).toBeGreaterThan(0);
});

test('Work → Map fits its width too', async ({ ownerPage: page }) => {
  await page.goto('/work?layout=map&epic=RCP-1');
  await expect(map(page).locator('.pm-node').first()).toBeVisible();
  const s = await fitWidth(page);
  expect(s.overX).toBe(false);
  expect([s.top, s.left]).toEqual([0, 0]);
});

for (const size of SIZES) {
  test(`axe, no overflow and screenshots at ${size.name}`, async ({ ownerPage: page }) => {
    await page.setViewportSize({ width: size.width, height: size.height });

    await openShape(page, 'tall');
    await shots(page, `tall-before-${size.name}`);
    await fitWidth(page);
    await expectAxeClean(page, `tall map at Fit width at ${size.name}`);
    await noOverflow(page, size.width);
    await shots(page, `tall-fit-${size.name}`);

    await page.unrouteAll({ behavior: 'wait' });
    await openShape(page, 'veryWide');
    await fitWidth(page);
    await expectAxeClean(page, `very wide map at Fit width at ${size.name}`);
    await noOverflow(page, size.width);
    await shots(page, `very-wide-fit-${size.name}`);
  });
}

/**
 * One status colour system, and map arrows that never cross a card (B47;
 * UI_SPEC §5, §6.3.4). The epic's answer is rewritten into a Gameflow-shaped
 * graph: 15 items, 8 waves, wave-skipping links. The checks sample each real
 * SVG path in the browser against every card's on-screen box, at several
 * zooms and at Fit width.
 *
 * Set DOCKET_E2E_SCREENSHOTS to a folder to also capture the PR's evidence.
 */
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import type { ItemDetailResponse, ItemSummary, LinkEdge, Status } from '@docket/shared';
import { expect, expectAxeClean, setTheme, test, useSeededContainer } from './fixtures/index';

useSeededContainer();

const out = process.env.DOCKET_E2E_SCREENSHOTS;

const STATUSES: Status[] = [
  'done',
  'done',
  'review',
  'progress',
  'progress',
  'ready',
  'ready',
  'ready',
  'ready',
  'planning',
  'planning',
  'inbox',
  'inbox',
  'ready',
  'review',
];
const id = (n: number) => `RCP-${900 + n}`;
/** Waves 1 to 8 down the spine (1→…→8); the rest hang off it and skip waves. */
const LINKS: [number, number][] = [
  [1, 2],
  [2, 3],
  [3, 4],
  [4, 5],
  [5, 6],
  [6, 7],
  [7, 8],
  [1, 9],
  [9, 10],
  [2, 11],
  [1, 11],
  [11, 8],
  [3, 12],
  [12, 7],
  [1, 13],
  [13, 6],
  [4, 14],
  [10, 14],
  [14, 8],
  [9, 15],
  [15, 5],
  [2, 8],
];

/** Serve RCP-1's Map from the Gameflow-shaped graph, keeping the real response's shape. */
async function useManyWaves(page: Page) {
  await page.route(/\/api\/items\/RCP-1(\?.*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const res = await route.fetch();
    const body = (await res.json()) as ItemDetailResponse;
    const base = body.children[0] as ItemSummary;
    const links: LinkEdge[] = LINKS.map(([a, b], i) => ({
      link_id: `lnk_b47_${i}`,
      from: id(a),
      to: id(b),
      type: 'blocks',
      satisfied_when: 'done',
      cleared: STATUSES[a - 1] === 'done',
    }));
    const children = STATUSES.map((status, i) => {
      const blockers = links.filter((l) => l.to === id(i + 1) && !l.cleared).map((l) => l.from);
      return {
        ...base,
        id: id(i + 1),
        title: `Gameflow-shaped ticket ${i + 1} with a title long enough to wrap`,
        status,
        blocked: blockers.length > 0,
        blocked_by: blockers,
        lead: null,
      };
    });
    await route.fulfill({
      response: res,
      json: { ...body, children, links, outside: [] },
    });
  });
}

/** Arrows with a point inside any card, in on-screen pixels. Empty means clear. */
function arrowsOverCards(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const cards = [...document.querySelectorAll<HTMLElement>('[data-progress-map] .pm-node')].map(
      (el) => ({ id: el.dataset.pid!, r: el.getBoundingClientRect() }),
    );
    const bad: string[] = [];
    for (const path of document.querySelectorAll<SVGPathElement>(
      '[data-progress-map] path.pm-edge',
    )) {
      // The map is CSS-scaled: from SVG units to the page, as the existing map spec does.
      const svg = path.ownerSVGElement!;
      const frame = svg.getBoundingClientRect();
      const scale = frame.width / Number(svg.getAttribute('width'));
      const len = path.getTotalLength();
      for (let at = 0; at <= len; at += 1.5) {
        const pt = path.getPointAtLength(at);
        const p = { x: frame.left + pt.x * scale, y: frame.top + pt.y * scale };
        const hit = cards.find(
          ({ r }) => p.x > r.left + 1 && p.x < r.right - 1 && p.y > r.top + 1 && p.y < r.bottom - 1,
        );
        if (hit) {
          bad.push(`${path.dataset.from}>${path.dataset.to} crosses ${hit.id}`);
          break;
        }
      }
    }
    return bad;
  });
}

const map = (page: Page) => page.locator('[data-progress-map]');
const edges = (page: Page) => map(page).locator('path.pm-edge');

async function openMap(page: Page) {
  await useManyWaves(page);
  // Decision 60 would hide 1 → 11 and 2 → 8 (chains already show them); route all 22 arrows here.
  await page.context().addInitScript(() => localStorage.setItem('docket.mapHideImplied', 'off'));
  await page.goto('/items/RCP-1');
  await page.getByRole('tab', { name: /^Map/ }).click();
  await expect(edges(page)).toHaveCount(LINKS.length);
  await expect(map(page).locator('.pm-colh')).toHaveCount(8);
}

async function shoot(page: Page, name: string, target = page.locator('[data-section="map"]')) {
  if (!out) return;
  for (const theme of ['light', 'dark'] as const) {
    await setTheme(page, theme);
    await target.screenshot({ path: join(out, `b47-${name}-${theme}.png`) });
  }
  await setTheme(page, 'light');
}

test('arrows stay clear of every card at each zoom and at Fit', async ({ ownerPage: page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openMap(page);
  expect(await arrowsOverCards(page)).toEqual([]);
  await shoot(page, 'many-wave-map');

  const zoomLabel = map(page).getByRole('button', { name: /^Zoom \d+%/ });
  for (const [button, pct] of [
    ['Zoom out', '80%'],
    ['Zoom out', '67%'],
    ['Zoom out', '50%'],
  ] as const) {
    await map(page).getByRole('button', { name: button }).click();
    await expect(zoomLabel).toHaveText(pct);
    expect(await arrowsOverCards(page), pct).toEqual([]);
  }
  await zoomLabel.click();
  await map(page).getByRole('button', { name: 'Zoom in' }).click();
  await expect(zoomLabel).toHaveText('125%');
  expect(await arrowsOverCards(page), '125%').toEqual([]);

  const fit = map(page).getByRole('button', { name: 'Fit width' });
  await fit.click();
  await expect(fit).toHaveAttribute('aria-pressed', 'true');
  expect(await arrowsOverCards(page), 'Fit width').toEqual([]);
  await expect(edges(page)).toHaveCount(LINKS.length);
  await shoot(page, 'many-wave-map-fit');
  await fit.click();

  // A resize re-routes without moving an arrow onto a card.
  await page.setViewportSize({ width: 1024, height: 800 });
  await page.waitForTimeout(250);
  expect(await arrowsOverCards(page), '1024 px').toEqual([]);
  await expectAxeClean(page, 'many-wave map');
});

test('hover traces a card’s arrows, painted on top of the shared channels', async ({
  ownerPage: page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openMap(page);
  const hub = id(8);
  const links = LINKS.filter(([a, b]) => id(a) === hub || id(b) === hub).length;
  const card = map(page).locator(`.pm-node[data-pid="${hub}"]`);
  // Fit width first: every wave is in view, with no More pill over the last wave.
  await map(page).getByRole('button', { name: 'Fit width' }).click();
  await card.hover();
  await expect(card).toHaveClass(/hl/);
  await expect(map(page).locator('path.pm-edge.hl')).toHaveCount(links);
  await expect(map(page).locator('path.pm-edge.dim')).toHaveCount(LINKS.length - links);
  // The traced arrows are the last ones painted.
  const lastAreTraced = await page.$$eval(
    '[data-progress-map] path.pm-edge',
    (paths, n) => {
      return paths.slice(-n).every((p) => p.classList.contains('hl'));
    },
    links,
  );
  expect(lastAreTraced).toBe(true);
  await shoot(page, 'hover-trace');
  await page.mouse.move(5, 5);
  await expect(map(page).locator('path.pm-edge.hl')).toHaveCount(0);

  // The keyboard traces too.
  await card.focus();
  await expect(map(page).locator('path.pm-edge.hl')).toHaveCount(links);
});

test('the real 30-plus-ticket stress epic keeps its arrows clear', async ({ ownerPage: page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/items/STR-3');
  await page.getByRole('tab', { name: /^Map/ }).click();
  await expect(map(page).locator('.pm-node').first()).toBeVisible();
  await expect(edges(page).first()).toBeAttached();
  expect(await arrowsOverCards(page)).toEqual([]);
});

test('bars, legend, card edges and chips use the same status tokens', async ({
  ownerPage: page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openMap(page);
  for (const theme of ['light', 'dark'] as const) {
    await setTheme(page, theme);
    const check = await page.evaluate(() => {
      const root = document.querySelector('[data-progress-map]')!;
      const probe = document.createElement('span');
      root.append(probe);
      const resolve = (token: string) => {
        probe.style.color = `var(${token})`;
        return getComputedStyle(probe).color;
      };
      const wrong: string[] = [];
      // Decision 59: In progress has no colour of its own; it is Done's, hatched (below).
      const statuses = ['done', 'review', 'ready', 'blocked', 'planning', 'inbox'];
      for (const s of statuses) {
        for (const el of root.querySelectorAll(`.sb-${s}`)) {
          if (getComputedStyle(el).backgroundColor !== resolve(`--st-${s}`)) wrong.push(`bar ${s}`);
        }
      }
      const done = resolve('--st-done');
      const hatchedDone = (image: string) =>
        image.includes('repeating-linear-gradient') && image.includes(done);
      for (const el of root.querySelectorAll('.sb-progress')) {
        if (!hatchedDone(getComputedStyle(el).backgroundImage)) wrong.push('bar progress');
      }
      for (const el of root.querySelectorAll('.pm-node.ps-progress')) {
        if (!hatchedDone(getComputedStyle(el, '::before').backgroundImage))
          wrong.push('edge progress');
      }
      for (const s of ['done', 'review', 'ready', 'planning', 'inbox']) {
        for (const el of root.querySelectorAll<HTMLElement>(`.pm-node.ps-${s}:not(.blk)`)) {
          if (
            getComputedStyle(el).borderLeftColor !== resolve(`--st-${s}`) &&
            !el.matches(':hover')
          )
            wrong.push(`edge ${s}`);
        }
      }
      const seen = new Set(statuses.map((s) => resolve(`--st-${s}`)));
      probe.remove();
      return { wrong, distinct: seen.size, total: statuses.length };
    });
    expect(check.wrong, theme).toEqual([]);
    expect(check.distinct, theme).toBe(check.total);
  }
  await setTheme(page, 'light');

  if (out) {
    // The evidence: each status's chip beside its bar swatch.
    await page.evaluate(() => {
      const labels: [string, string][] = [
        ['inbox', 'Inbox'],
        ['planning', 'Planning'],
        ['ready', 'Ready'],
        ['progress', 'In progress'],
        ['review', 'Review'],
        ['done', 'Done'],
        ['blocked', 'Blocked'],
        ['canceled', 'Canceled'],
      ];
      const panel = document.createElement('div');
      panel.id = 'b47-palette';
      panel.style.cssText =
        'display:grid;grid-template-columns:repeat(4,max-content);gap:10px 18px;padding:16px;background:var(--panel)';
      panel.innerHTML = labels
        .map(
          ([s, name]) =>
            `<span style="display:inline-flex;gap:8px;align-items:center"><span class="pbar" style="width:96px"><i class="sb-${s}" style="width:100%"></i></span><span class="chip st-${s}">${name}</span></span>`,
        )
        .join('');
      document.querySelector('[data-progress-map]')!.prepend(panel);
    });
    await shoot(page, 'status-palette', page.locator('#b47-palette'));
    await page.evaluate(() => document.getElementById('b47-palette')?.remove());
    await shoot(page, 'map-header', map(page).locator('.pm-head'));
  }
});

/**
 * B75 (owner decision 59): status colours that show progress. Planning wears
 * the violet In progress had, and In progress is Done's green, striped, in the
 * pattern Queued uses with Ready: hatched in bars, legend swatches, the Board's
 * column rules and the Map's card edges, and dashed on chips. Status is never
 * colour alone, nothing draws the retired orange, and axe passes in both themes
 * at 1440 x 900 and 1024 px, plus the PR's screenshots (DOCKET_E2E_SCREENSHOTS).
 */
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, expectAxeClean, setTheme, test, unlock, useSeededContainer } from './fixtures';

useSeededContainer();

const out = process.env.DOCKET_E2E_SCREENSHOTS;
const SIZES = [
  { name: '1440', width: 1440, height: 900 },
  { name: '1024', width: 1024, height: 768 },
] as const;
const THEMES = ['light', 'dark'] as const;

/** The tokens, as the browser computes them (tokens.css). */
const TOKENS = {
  light: {
    done: 'rgb(19, 108, 63)',
    doneSoft: 'rgb(227, 244, 234)',
    doneText: 'rgb(19, 100, 55)',
    planning: 'rgb(157, 104, 251)',
    planningSoft: 'rgb(240, 233, 255)',
    planningText: 'rgb(95, 55, 201)',
  },
  dark: {
    done: 'rgb(91, 239, 160)',
    doneSoft: 'rgb(15, 45, 32)',
    doneText: 'rgb(111, 240, 172)',
    planning: 'rgb(115, 97, 255)',
    planningSoft: 'rgb(34, 29, 69)',
    planningText: 'rgb(177, 166, 255)',
  },
} as const;

/** Planning's retired orange (solid, soft and text, both themes). */
const RETIRED = [
  'rgb(207, 106, 7)',
  'rgb(253, 238, 221)',
  'rgb(143, 71, 0)',
  'rgb(248, 166, 13)',
  'rgb(51, 36, 12)',
  'rgb(248, 177, 58)',
];

const inScope = async (page: Page, scope: string) => {
  await unlock(page.context());
  await page.context().addInitScript((s) => {
    localStorage.setItem('docket.notifications', 'off');
    sessionStorage.setItem('docket.scope', s);
  }, scope);
};

const shots = async (page: Page, name: string) => {
  if (!out) return;
  for (const theme of THEMES) {
    // expectAxeClean leaves the page dark, so set each theme right before its shot.
    await setTheme(page, theme);
    await page.screenshot({ path: join(out, `b75-${name}-${theme}.png`) });
  }
};

const noOverflow = async (page: Page, width: number) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    width,
  );

/** Every colour the page paints that is the retired orange, as "tag.class: property". */
const retiredOrange = (page: Page) =>
  page.evaluate((retired) => {
    const hits: string[] = [];
    const props = [
      'color',
      'backgroundColor',
      'borderLeftColor',
      'borderTopColor',
      'backgroundImage',
      'fill',
      'stroke',
    ] as const;
    for (const el of document.querySelectorAll('body *')) {
      for (const pseudo of [null, '::before', '::after']) {
        const cs = getComputedStyle(el, pseudo);
        for (const p of props) {
          if (retired.some((c) => cs[p].includes(c)))
            hits.push(`${el.tagName}.${el.className}: ${p}`);
        }
      }
    }
    return hits;
  }, RETIRED);

test('chips: In progress is Done green with a dashed edge, Planning is violet, and each says so', async ({
  page,
}) => {
  await inScope(page, 'RCP');
  await page.goto('/work?layout=list');
  const progressChip = page.locator('[data-layout="list"] .chip.st-progress').first();
  await expect(progressChip).toHaveText('In progress');
  const planningChip = page.locator('[data-layout="list"] .chip.st-planning').first();
  await expect(planningChip).toHaveText('Planning');

  for (const theme of THEMES) {
    await setTheme(page, theme);
    const t = TOKENS[theme];
    const style = (sel: string) =>
      page
        .locator(sel)
        .first()
        .evaluate((el) => {
          const cs = getComputedStyle(el);
          return {
            bg: cs.backgroundColor,
            fg: cs.color,
            edge: cs.borderTopStyle,
            edgeColour: cs.borderTopColor,
          };
        });
    const progress = await style('[data-layout="list"] .chip.st-progress');
    expect(progress.bg, theme).toBe(t.doneSoft);
    expect(progress.fg, theme).toBe(t.doneText);
    expect(progress.edge, theme).toBe('dashed');
    const planning = await style('[data-layout="list"] .chip.st-planning');
    expect(planning.bg, theme).toBe(t.planningSoft);
    expect(planning.fg, theme).toBe(t.planningText);
  }

  // Done's chip is solid-edged: the dashed edge and the words tell the two apart.
  await page.goto('/items/RCP-11');
  const done = page.locator('.chip.st-done').first();
  await expect(done).toHaveText('Done');
  expect(await done.evaluate((el) => getComputedStyle(el).borderTopStyle)).not.toBe('dashed');
});

test('the Board, the Map and the workload bars hatch In progress in Done green', async ({
  page,
}) => {
  await inScope(page, 'RCP');

  // The Board: a status rule over each column, hatched for In progress, solid for Done.
  await page.goto('/work?layout=board');
  const rule = (s: string) => page.locator(`[data-layout="board"] [data-colrule="${s}"]`);
  await expect(rule('progress')).toHaveAttribute('aria-hidden', 'true');
  for (const theme of THEMES) {
    await setTheme(page, theme);
    const t = TOKENS[theme];
    const progress = await rule('progress').evaluate((el) => getComputedStyle(el).backgroundImage);
    expect(progress, theme).toContain('repeating-linear-gradient');
    expect(progress, theme).toContain(t.done);
    const doneRule = await rule('done').evaluate((el) => getComputedStyle(el));
    expect(doneRule.backgroundImage, theme).toBe('none');
    expect(doneRule.backgroundColor, theme).toBe(t.done);
    const planning = await rule('planning').evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(planning, theme).toBe(t.planning);
  }
  const progressColumn = page.locator(
    '[data-layout="board"] section.col[aria-label="In progress"]',
  );
  await expect(progressColumn.locator('h2')).toHaveText('In progress');

  // The Map: In progress cards carry a hatched Done-green edge; Done cards a solid one with ✓.
  await page.goto('/work?layout=map');
  const card = page.locator('.pm-node.ps-progress').first();
  await expect(card).toBeVisible();
  await expect(card.locator('.pm-status')).toContainText('In progress');
  for (const theme of THEMES) {
    await setTheme(page, theme);
    const edge = await card.evaluate((el) => {
      const before = getComputedStyle(el, '::before');
      return { image: before.backgroundImage, width: before.width };
    });
    expect(edge.image, theme).toContain('repeating-linear-gradient');
    expect(edge.image, theme).toContain(TOKENS[theme].done);
    expect(edge.width, theme).toBe('4px');
  }
  // A Done card from outside the view stays solid-edged, so it never reads as In progress.
  const outsideDone = page.locator('.pm-node.ext.ps-done').first();
  await expect(outsideDone).toBeVisible();
  const outsideEdge = await outsideDone.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { left: cs.borderLeftStyle, top: cs.borderTopStyle };
  });
  expect(outsideEdge).toEqual({ left: 'solid', top: 'dashed' });
  // The legend swatch for In progress is hatched too.
  const swatch = page.locator('.pm-legend b.sb-progress');
  if ((await swatch.count()) > 0) {
    expect(await swatch.evaluate((el) => getComputedStyle(el).backgroundImage)).toContain(
      'repeating-linear-gradient',
    );
  }

  // Overview's workload bars: In progress segments are hatched and never thinner than 8px.
  await page.goto('/');
  const workload = page.locator('[data-card="workload"]');
  await expect(workload).toBeVisible();
  const segments = workload.locator('.ov-work .pbar .sb-progress');
  await expect(segments.first()).toBeVisible();
  for (const w of await segments.evaluateAll((els) =>
    els.map((el) => el.getBoundingClientRect().width),
  )) {
    expect(w).toBeGreaterThanOrEqual(8);
  }
  await expect(workload.locator('.ov-legend li', { has: page.locator('.sb-progress') })).toHaveText(
    'In progress',
  );
});

for (const size of SIZES) {
  test(`axe in both themes, no retired orange, and screenshots at ${size.name}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: size.width, height: size.height });
    await inScope(page, 'RCP');

    await page.goto('/work?layout=board');
    await expect(page.locator('[data-colrule="progress"]')).toBeVisible();
    await expectAxeClean(page, `Work board at ${size.name}`);
    await noOverflow(page, size.width);
    for (const theme of THEMES) {
      await setTheme(page, theme);
      expect(await retiredOrange(page), `board ${theme}`).toEqual([]);
    }
    await shots(page, `board-${size.name}`);

    await page.goto('/work?layout=list');
    await expect(page.locator('[data-layout="list"] .chip.st-progress').first()).toBeVisible();
    await expectAxeClean(page, `Work list chips at ${size.name}`);
    await noOverflow(page, size.width);
    for (const theme of THEMES) {
      await setTheme(page, theme);
      expect(await retiredOrange(page), `list ${theme}`).toEqual([]);
    }
    await shots(page, `chips-${size.name}`);

    await page.goto('/work?layout=map');
    await expect(page.locator('.pm-node.ps-progress').first()).toBeVisible();
    await expectAxeClean(page, `Work map at ${size.name}`, { include: '.pm-head' });
    for (const theme of THEMES) {
      await setTheme(page, theme);
      expect(await retiredOrange(page), `map ${theme}`).toEqual([]);
    }
    await shots(page, `map-${size.name}`);

    await page.goto('/');
    const workload = page.locator('[data-card="workload"]');
    await expect(workload).toBeVisible();
    await expectAxeClean(page, `Overview at ${size.name}`);
    await noOverflow(page, size.width);
    for (const theme of THEMES) {
      await setTheme(page, theme);
      expect(await retiredOrange(page), `overview ${theme}`).toEqual([]);
    }
    await workload.scrollIntoViewIfNeeded();
    await shots(page, `workload-${size.name}`);
  });
}

test('stress data: the Map bar and workload bars keep hatched segments wide enough', async ({
  page,
}) => {
  await inScope(page, 'STR');
  await page.goto('/work?layout=map');
  await expect(page.locator('.pm-head .pbar')).toBeVisible();
  const narrow = await page
    .locator('.pbar .sb-progress, .pbar .sb-queued, .pbar .sb-canceled')
    .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().width).filter((w) => w < 8));
  expect(narrow).toEqual([]);
  await expectAxeClean(page, 'Work map on stress data', { include: '.pm-head' });
});

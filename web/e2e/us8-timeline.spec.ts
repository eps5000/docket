/**
 * Dates, effort and a forecast end to end (tasks.md T135; spec US8;
 * UI_SPEC §6.2.4, §9.1, §11; BUILD_SPEC §5.9).
 *
 * - Timeline: planned and actual bars, who set the dates on hover only,
 *   blocker ticks, the seed's RCP-16 date risk (its blocker DOC-4 ends after
 *   it starts) with the same row in Problems, the undated list, the Now line
 *   and the "No forecast yet" lane; the seed renders in under 1 s.
 * - The burn-down card: the step chart with scope additions, the summary
 *   line, the forecast line, an sr-only summary and *Show as table*.
 * - With enough history (a fixture inserts ten estimated completions across
 *   two past weeks): the hatched forecast lane and the burn-down forecast
 *   band, and planned dates unchanged.
 * - axe on the Timeline and the burn-down card (and its table), both themes.
 *
 * Set TASKLITE_E2E_SCREENSHOTS to a folder to also capture the PR's light
 * and dark screenshots.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { CONTAINER } from './fixtures/container';
import {
  expect,
  expectAxeClean,
  resetSeededContainer,
  setTheme,
  test,
  useSeededContainer,
} from './fixtures/index';

useSeededContainer();

const out = process.env.TASKLITE_E2E_SCREENSHOTS;

async function shoot(page: Page, name: string, target?: Locator) {
  if (!out) return;
  for (const theme of ['light', 'dark'] as const) {
    await setTheme(page, theme);
    const path = join(out, `us8-${name}-${theme}.png`);
    if (target) await target.screenshot({ path });
    else await page.screenshot({ path, fullPage: true });
  }
  await setTheme(page, 'light');
}

/** Run SQL in the container's database (fixture: history the clock can't make). */
function sql(statements: [string, unknown[]][]): void {
  const script =
    "const D=require('better-sqlite3');const db=new D('/data/tasklite.db');db.pragma('busy_timeout = 5000');" +
    'db.transaction(()=>{for (const [q, a] of JSON.parse(process.argv[1])) db.prepare(q).run(...a);})();db.close();';
  execFileSync(
    'docker',
    ['exec', '-w', '/app/server', CONTAINER, 'node', '-e', script, JSON.stringify(statements)],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

const DAY = 86_400_000;
const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * Ten 3-pt items done in RCP, five on each of two days in the last four full
 * weeks, and one new 4-pt item added nine days ago (a scope addition).
 */
function seedHistory(): void {
  const now = Date.now();
  const today = Date.parse(`${utcDay(now)}T00:00:00Z`);
  const monday = today - ((new Date(today).getUTCDay() + 6) % 7) * DAY;
  const created = new Date(monday - 40 * DAY).toISOString();
  const days = [monday - 10 * DAY + 12 * 3_600_000, monday - 3 * DAY + 12 * 3_600_000];
  const statements: [string, unknown[]][] = [];
  for (let i = 0; i < 10; i++) {
    const id = `RCP-${901 + i}`;
    const doneAt = new Date(days[i % 2]!).toISOString();
    statements.push([
      `INSERT INTO items (id, project_key, type, title, description_md, outcome_md, status, priority, effort, closed_by, closed_at, imported, version, created_at, updated_at)
       VALUES (?, 'RCP', 'Task', ?, '', '', 'done', 2, 3, 'agent', ?, 0, 3, ?, ?)`,
      [id, `History item ${i + 1}`, doneAt, created, doneAt],
    ]);
    for (const [at, old, to] of [
      [new Date(days[i % 2]! - 3 * 3_600_000).toISOString(), 'ready', 'progress'],
      [doneAt, 'progress', 'done'],
    ] as const) {
      statements.push([
        `INSERT INTO events (at, actor_kind, client, project_key, item_id, type, summary, data, mutation_id)
         VALUES (?, 'agent', 'claude', 'RCP', ?, 'item.status_changed', ?, ?, ?)`,
        [
          at,
          id,
          `${id} moved to ${to}`,
          JSON.stringify({ status: { old, new: to } }),
          `mut_e2e_${id}_${to}`,
        ],
      ]);
    }
  }
  const added = new Date(today - 9 * DAY + 10 * 3_600_000).toISOString();
  statements.push([
    `INSERT INTO items (id, project_key, type, title, description_md, outcome_md, status, priority, effort, imported, version, created_at, updated_at)
     VALUES ('RCP-920', 'RCP', 'Task', 'Added mid-window', '', '', 'ready', 2, 4, 0, 1, ?, ?)`,
    [added, added],
  ]);
  sql(statements);
}

/** Open Work in RCP's scope. */
async function openWork(page: Page, layout?: 'timeline'): Promise<void> {
  await page.context().addInitScript(() => {
    sessionStorage.setItem('tl.scope', 'RCP');
    localStorage.setItem('tl.notifications', 'off');
  });
  await page.goto(layout ? `/work?layout=${layout}` : '/work');
}

const grid = (page: Page) => page.locator('[data-card="timeline-grid"]');
const timelineRow = (page: Page, id: string) => grid(page).locator(`[data-row="${id}"]`);
const burndownCard = (page: Page) => page.locator('[data-card="burndown"]');

/** Text a sighted user sees in the grid: everything but sr-only text and attributes. */
async function visibleGridText(page: Page): Promise<string> {
  return grid(page).evaluate((root) => {
    const parts: string[] = [];
    const walk = (node: Node) => {
      if (node.nodeType === Node.TEXT_NODE) parts.push(node.textContent ?? '');
      if (node instanceof Element && node.classList.contains('sr')) return;
      node.childNodes.forEach(walk);
    };
    walk(root);
    return parts.join(' ');
  });
}

test.describe('Work → Timeline', () => {
  test('planned and actual bars, set-by on hover only, blocker ticks, risk text, undated list and forecast lane', async ({
    ownerPage: page,
  }) => {
    await openWork(page);
    await expect(page.locator('[data-layout="board"]')).toBeVisible();

    // The seed's timeline and burn-down render in under 1 s from the layout switch.
    const t0 = Date.now();
    await page
      .getByRole('group', { name: 'Layout' })
      .getByRole('button', { name: 'Timeline' })
      .click();
    await expect(timelineRow(page, 'RCP-16')).toBeVisible();
    await expect(burndownCard(page).locator('[data-burndown-line]')).toBeVisible();
    const ms = Date.now() - t0;
    console.log(`Timeline and burn-down for the seed rendered in ${ms} ms`);
    expect(ms).toBeLessThan(1000);
    await expect(page).toHaveURL(/layout=timeline/);

    // RCP-16: planned to start before DOC-4 (another project) is planned to end.
    const rcp16 = timelineRow(page, 'RCP-16');
    const planned = rcp16.locator('[data-bar="planned"]');
    await expect(planned).toHaveText('⚠ blocker ends later');
    await expect(planned).toHaveClass(/risk/);
    await expect(planned).toHaveAttribute(
      'title',
      /^Planned \w{3} \d+ → \w{3} \d+ · set by owner$/,
    );
    await expect(rcp16.locator('[data-after]')).toContainText(/^after .*DOC-4 ends \w{3} \d+/);
    await expect(rcp16.locator('[data-after] b.risk')).toContainText('DOC-4 ends');
    await expect(rcp16.locator('[data-dep="DOC-4"]')).toHaveClass(/risk/);
    await expect(rcp16.locator('[data-dep="RCP-19"]')).not.toHaveClass(/risk/);
    await expect(rcp16.locator('.track > .sr')).toContainText('(date risk)');

    // Actual time: RCP-14 is in progress since its start; RCP-11 is done.
    await expect(timelineRow(page, 'RCP-14').locator('[data-bar="actual"]')).toBeVisible();
    await expect(timelineRow(page, 'RCP-11').locator('[data-bar="planned"]')).toHaveText('✓ done');
    // Planning items without dates stay off the grid.
    await expect(timelineRow(page, 'RCP-20')).toHaveCount(0);

    // Who set the dates: on hover (title) only, never as visible text.
    expect(await visibleGridText(page)).not.toMatch(/set by/);
    await planned.hover();
    await expect(planned).toHaveAttribute('title', /set by owner/);

    // The Now line, the legend and the undated list.
    await expect(rcp16.locator('.now')).toHaveCount(1);
    const legend = grid(page).getByRole('group', { name: 'Legend' });
    for (const name of ['Entered plan', 'Actual', 'Forecast', 'Blocker’s planned end', 'Now']) {
      await expect(legend).toContainText(name);
    }
    const undated = grid(page).locator('[data-undated]');
    await expect(undated).toContainText('Not on the timeline (no dates):');
    await expect(undated.getByRole('link', { name: 'RCP-20' })).toBeVisible();
    await expect(undated).not.toContainText('DOC-');

    // The forecast lane: not enough history in the seed.
    const lane = grid(page).locator('[data-forecast-lane="RCP"]');
    await expect(lane).toContainText('Forecast · Recipe App backlog');
    await expect(lane).toContainText(
      'No forecast yet: needs 8 completed items with effort (have 0).',
    );
    await expect(lane.locator('.bar.forecast')).toHaveCount(0);

    await expectAxeClean(page, 'Timeline');
    await shoot(page, 'timeline');
    await shoot(page, 'timeline-grid', grid(page));
  });

  test('an active epic or label filter shows as a removable chip (B18)', async ({
    ownerPage: page,
  }) => {
    await page.context().addInitScript(() => localStorage.setItem('tl.notifications', 'off'));
    await page.goto('/work?layout=timeline&epic=RCP-1&label=ui-refresh');
    await expect(grid(page)).toBeVisible();
    const chips = page.getByRole('group', { name: 'Active filters' });
    const epicChip = chips.getByRole('button', { name: /^Remove the epic filter: / });
    const labelChip = chips.getByRole('button', { name: 'Remove the label filter: #ui-refresh' });
    await expect(epicChip).toBeVisible();
    await expect(labelChip).toHaveText(/# ui-refresh/);
    await shoot(page, 'timeline-filter-chips', chips);
    await epicChip.click();
    await expect(page).toHaveURL(/layout=timeline&label=ui-refresh$/);
    await expect(epicChip).toHaveCount(0);
    await labelChip.click();
    await expect(page).toHaveURL(/\/work\?layout=timeline$/);
    await expect(chips).toHaveCount(0);
  });

  test('the date risk is also in Problems, and its Timeline action opens Work → Timeline', async ({
    ownerPage: page,
  }) => {
    await page.context().addInitScript(() => {
      sessionStorage.setItem('tl.scope', 'RCP');
      localStorage.setItem('tl.notifications', 'off');
    });
    await page.goto('/');
    const problem = page.locator('[data-problem="date_risk"]').filter({ hasText: 'RCP-16' });
    await expect(problem).toContainText(/before its blocker DOC-4 is planned to finish/);
    await problem.getByRole('link', { name: 'Timeline' }).click();
    await expect(page).toHaveURL(/\/work\?layout=timeline/);
    await expect(timelineRow(page, 'RCP-16').locator('[data-bar="planned"]')).toHaveText(
      '⚠ blocker ends later',
    );
  });
});

test.describe('the burn-down card', () => {
  test('chart, scope additions, the summary and forecast lines, and Show as table', async ({
    ownerPage: page,
  }) => {
    await openWork(page, 'timeline');
    const card = burndownCard(page);
    await expect(card.getByRole('heading', { name: 'Remaining effort' })).toBeVisible();
    await expect(card.locator('[data-burndown-summary]')).toHaveText(
      /^\d+ pts open · \d+ not estimated · last 4 weeks$/,
    );
    await expect(card.locator('[data-burndown-chart] svg')).toBeVisible();
    // The seed's estimated items were added inside the window: up-ticks with a title.
    const adds = card.locator('[data-addition]');
    expect(await adds.count()).toBeGreaterThan(0);
    await expect(adds.first().locator('title')).toHaveText(/^\+\d+ pts: RCP-\d+ added$/);
    await expect(card.locator('[data-forecast-line]')).toHaveText(
      'No forecast yet: needs 8 completed items with effort (have 0).',
    );
    await expect(card.locator('[data-forecast-band]')).toHaveCount(0);
    await expect(card.locator('[data-burndown-sr]')).toContainText(/^Remaining effort went from/);

    await expectAxeClean(page, 'burn-down card', { include: '[data-card="burndown"]' });
    await shoot(page, 'burndown', card);

    const toggle = card.getByRole('button', { name: 'Show as table' });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();
    const hide = card.getByRole('button', { name: 'Hide table' });
    await expect(hide).toHaveAttribute('aria-expanded', 'true');
    const table = card.getByRole('table', { name: 'Remaining effort per day' });
    await expect(table.getByRole('columnheader')).toHaveText(['Date', 'Remaining', 'Change']);
    await expect(table.locator('tbody tr')).toHaveCount(28);
    await expect(table).toContainText(/\+\d+ pts: RCP-\d+ added/);

    await expectAxeClean(page, 'burn-down table', { include: '[data-card="burndown"]' });
    await shoot(page, 'burndown-table', card);
    await hide.click();
    await expect(table).toHaveCount(0);
  });
});

test.describe('with enough history', () => {
  test.afterAll(async () => {
    test.setTimeout(120_000);
    // Leave a clean seed for anything that runs after this file.
    await resetSeededContainer();
  });

  test('a P50–P85 forecast lane and band; planned dates unchanged', async ({ ownerPage: page }) => {
    await openWork(page, 'timeline');
    const plannedBefore = await timelineRow(page, 'RCP-16')
      .locator('[data-bar="planned"]')
      .getAttribute('title');

    seedHistory();
    await page.reload();

    const lane = grid(page).locator('[data-forecast-lane="RCP"]');
    const bar = lane.locator('.bar.forecast');
    await expect(bar).toHaveText(/^P50 \w{3} \d+ – P85 \w{3} \d+$/);
    await expect(lane).toContainText(
      /\d+(\.\d)? pts\/wk over the last 4 weeks · n=10 · excludes \d+ unestimated items?/,
    );

    const card = burndownCard(page);
    await expect(card.locator('[data-forecast-line]')).toHaveText(
      /^Forecast: P50 \w{3} \d+ – P85 \w{3} \d+ · \d+(\.\d)? pts\/wk over the last 4 weeks · n=10 · excludes \d+ unestimated items?$/,
    );
    await expect(card.locator('[data-forecast-band]')).toBeVisible();
    await expect(card.locator('[data-forecast-band] text')).toHaveText([
      /^P50 \w{3} \d+$/,
      /^P85 \w{3} \d+$/,
    ]);
    // The added item shows as a scope addition.
    await expect(card.locator('[data-addition] title')).toContainText(['+4 pts: RCP-920 added']);

    // Forecasts never move planned dates.
    await expect(timelineRow(page, 'RCP-16').locator('[data-bar="planned"]')).toHaveAttribute(
      'title',
      plannedBefore!,
    );

    await expectAxeClean(page, 'Timeline with a forecast');
    await shoot(page, 'forecast-lane', lane);
    await shoot(page, 'burndown-forecast', card);
    await card.getByRole('button', { name: 'Show as table' }).click();
    await expectAxeClean(page, 'burn-down table with a forecast', {
      include: '[data-card="burndown"]',
    });
    await shoot(page, 'timeline-forecast');
  });
});

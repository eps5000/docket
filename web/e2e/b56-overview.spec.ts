/**
 * B56: the owner's feedback on Overview. No tab strip there (and the tabs
 * survive), the Tickets with agents card, the chart's axis and tooltip by mouse
 * and keyboard, and the at-risk line, with axe in both themes at 1440 and 1024
 * px on the stress data, plus the PR's screenshots (DOCKET_E2E_SCREENSHOTS).
 */
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import type {
  NeedsYouResponse,
  OverviewResponse,
  WorkspaceRow,
  WorkspacesResponse,
} from '@docket/shared';
import { mockGet } from './fixtures/api-mocks';
import {
  connectAgent,
  expect,
  expectAxeClean,
  setTheme,
  test,
  unlock,
  useSeededContainer,
} from './fixtures';

useSeededContainer();

const out = process.env.DOCKET_E2E_SCREENSHOTS;
const SIZES = [
  { name: '1440', width: 1440, height: 900 },
  { name: '1024', width: 1024, height: 768 },
] as const;

test.beforeEach(async ({ page }) => {
  await unlock(page.context());
  await page.context().addInitScript(() => localStorage.setItem('docket.notifications', 'off'));
});

const api = <T>(page: Page, path: string) =>
  page.evaluate(async (p) => (await (await fetch(p)).json()) as unknown, path) as Promise<T>;
const openTabs = (page: Page) => page.getByRole('navigation', { name: 'Open items' });
const tip = (page: Page) => page.locator('[data-chart-tip]');
const riskLine = (page: Page) =>
  page.locator('[data-card="health"] a[data-state="workspaces-at-risk"]');

async function open(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
  await expect(page.locator('[data-stat="completed"] a.ov-num')).toBeVisible();
  await expect(page.locator('[data-card="completed-chart"] [data-bar]').first()).toBeVisible();
}

/** An at-risk worktree with made-up paths, on a stress-project ticket. */
const worktree = (
  name: string,
  item_id: string,
  at_risk_owner: WorkspaceRow['at_risk_owner'],
): WorkspaceRow => ({
  path: `C:/work/${name}`,
  state: 'at_risk',
  at_risk_owner,
  branch: `work/${name}`,
  host: null,
  repo: null,
  item_id,
  item_title: `Stress ticket ${item_id}`,
  project: 'STR',
  run_id: `run_${name}`,
  run_state: 'finished',
  client: 'claude',
  label: 'worker',
  head_sha: null,
  pushed_sha: null,
  unpushed_commits: 0,
  dirty: true,
  unreleased_resources: 0,
  last_activity_at: new Date().toISOString(),
});

/** The shape the owner saw: two an agent owns, and one kept for later. */
const OWNERS_CASE = [
  worktree('story-a', 'STR-40', 'agents'),
  worktree('story-b', 'STR-41', 'agents'),
  worktree('kept', 'STR-42', 'kept'),
];

/** The chart with one known, overflowing bucket at each end, from the real response. */
async function withBusyEdges(page: Page) {
  await page.goto('/');
  const real = await api<OverviewResponse>(page, '/api/overview?scope=all&window=30d');
  const tickets = Array.from({ length: 6 }, (_, k) => ({
    id: `RCP-${11 + k}`,
    title: `A long ticket title that has to be cut short in the tooltip, number ${k + 1}`,
  }));
  const buckets = real.completed.buckets.map((b, k, all) =>
    k === 0 || k === all.length - 1
      ? { ...b, count: 23, tickets }
      : { ...b, count: 0, tickets: [] },
  );
  await mockGet(page, '/api/overview', {
    ...real,
    window: '7d',
    completed: { ...real.completed, count: 46, buckets },
  });
  return buckets;
}

async function expectInViewport(page: Page) {
  const box = (await tip(page).boundingBox())!;
  const view = page.viewportSize()!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(view.width);
  expect(box.y + box.height).toBeLessThanOrEqual(view.height);
}

test('the tab strip stays off Overview, and the open tabs survive it', async ({ page }) => {
  await page.goto('/items/RCP-14');
  await expect(openTabs(page).getByRole('link', { name: 'RCP-14' })).toBeVisible();
  await page.goto('/items/RCP-12');
  await expect(openTabs(page).getByRole('link')).toHaveCount(2);

  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: /^Overview/ })
    .click();
  await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
  await expect(openTabs(page)).toHaveCount(0);

  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: /^Work/ })
    .click();
  await expect(openTabs(page).getByRole('link')).toHaveCount(2);
  await openTabs(page).getByRole('link', { name: 'RCP-14' }).click();
  await expect(page).toHaveURL(/\/items\/RCP-14/);
  await expect(openTabs(page).getByRole('link')).toHaveCount(2);
});

test('the card and the sidebar badge say the same thing', async ({ page }) => {
  await open(page);
  const { working, waiting } = (await api<NeedsYouResponse>(page, '/api/needs-you?scope=all'))
    .agents_now!;
  const card = page.getByRole('group', { name: 'Tickets with agents' });
  await expect(card.locator('a.ov-num')).toHaveText(`${working} being worked`);
  await expect(card.locator('a.ov-sub')).toHaveText(`${waiting} parked/waiting`);
  await expect(page.locator('[data-agents-note]')).toContainText(
    'Counts tickets in Docket, not agent sessions.',
  );
  const link = page.getByRole('navigation', { name: 'Primary' }).getByRole('link', {
    name: /^Agents/,
  });
  await expect(link).toContainText(`${working === 1 ? 'ticket' : 'tickets'} being worked`);
  await expect(link.locator('.badge')).toContainText(String(working));
});

test('the chart: whole-number axis, and a tooltip by mouse and by keyboard', async ({ page }) => {
  const buckets = await withBusyEdges(page);
  await open(page);
  const labels = await page.locator('.ov-yaxis span').allTextContents();
  expect(labels).toEqual(['0', '10', '20', '30']);

  // Mouse, at the left edge.
  const first = buckets[0]!;
  await page.locator(`[data-bar="${first.key}"]`).hover();
  await expect(tip(page)).toContainText('23 tickets completed');
  await expect(tip(page)).toContainText('and 17 more');
  await expect(tip(page).getByRole('link')).toHaveCount(6);
  await expectInViewport(page);
  await expectAxeClean(page, 'Overview chart tooltip by mouse');

  // The pointer can reach the links.
  await tip(page).getByRole('link').first().hover();
  await expect(tip(page)).toBeVisible();
  await page.mouse.move(0, 0);
  await expect(tip(page)).toHaveCount(0);

  // Keyboard, at the right edge.
  const last = buckets.at(-1)!;
  await page.locator(`[data-bar="${last.key}"]`).focus();
  await expect(tip(page)).toHaveAttribute('data-chart-tip', last.key);
  await expectInViewport(page);
  await page.keyboard.press('ArrowLeft');
  await expect(tip(page)).toContainText('None completed');
  await page.keyboard.press('End');
  await page.keyboard.press('Tab');
  await expect(tip(page).getByRole('link').first()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(tip(page)).toHaveCount(0);
  await expect(page.locator(`[data-bar="${last.key}"]`)).toBeFocused();

  // The link goes to the ticket.
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('End');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/items\/RCP-11/);
});

const healthTone = (page: Page) => riskLine(page).locator('xpath=ancestor::li');
/** The Needs you number beside the h1, the badge's number. The spec can't import shared code. */
const badgeCount = async (page: Page) => {
  const count = page.locator('[data-needs-you-count]');
  return (await count.count()) ? await count.getAttribute('data-needs-you-count') : '0';
};

for (const [name, rows, tone, text] of [
  [
    'none need the owner',
    OWNERS_CASE,
    'ok',
    '3 worktrees hold unsaved work. None need you: agents own 2, and you kept 1 for later.',
  ],
  [
    'one needs the owner',
    [worktree('a', 'STR-40', 'you'), worktree('b', 'STR-41', 'agents')],
    'warn',
    '2 worktrees hold unsaved work. 1 needs your choice, and agents own 1.',
  ],
  [
    'the owner is unknown',
    [worktree('a', 'STR-40', 'unknown')],
    'info',
    '1 worktree holds unsaved work. Docket can’t tell who owns it.',
  ],
] as const) {
  test(`the at-risk line, ${name}: its words, tone and list`, async ({ page }) => {
    await mockGet(page, '/api/workspaces', { rows });
    await open(page);
    await expect(riskLine(page)).toHaveText(text);
    await expect(healthTone(page)).toHaveAttribute('data-health', tone);
    await expectAxeClean(page, `Overview, at-risk line: ${name}`);
    await riskLine(page).click();
    await expect(page).toHaveURL(/\/agents#workspaces$/);
    const note = page.locator('[data-at-risk-note]');
    await expect(note).toContainText('work could still be lost');
    await expect(note).not.toContainText(/delete/i);
    await expect(page.locator('[data-at-risk-owner]')).toHaveCount(rows.length);
    await expectAxeClean(page, `Agents, what to do: ${name}`);
  });
}

test('a real worktree an agent left: at risk, owned by its coordinator, badge unchanged', async ({
  page,
}) => {
  await open(page);
  await expect(page.locator('[data-card="health"]')).toBeVisible();
  const before = await badgeCount(page);
  const agent = await connectAgent('claude-agent-sdk');
  try {
    const claim = await agent.call('claim_lead', {
      id: 'RCP-17',
      agent_label: 'b56-w1',
      orchestrator: { name: 'orca', dispatch_id: 'ctx_b56' },
      workspace: { path: 'C:/work/b56-left', branch: 'b56-left' },
    });
    expect(claim.isError, claim.text).toBe(false);
    const run_id = claim.structured.run_id as string;
    const beat = await agent.call('heartbeat', { run_id, workspace: { dirty: true } });
    expect(beat.isError, beat.text).toBe(false);
    const done = await agent.call('finish_run', { run_id, result: 'finished', summary: 'Done.' });
    expect(done.isError, done.text).toBe(false);
  } finally {
    await agent.close();
  }
  await open(page);
  const { rows } = await api<WorkspacesResponse>(page, '/api/workspaces?scope=all');
  expect(rows.find((r) => r.path === 'C:/work/b56-left')).toMatchObject({
    state: 'at_risk',
    at_risk_owner: 'agents',
  });
  await expect(riskLine(page)).toContainText('an agent owns it');
  await expect(healthTone(page)).toHaveAttribute('data-health', 'ok');
  expect(await badgeCount(page)).toBe(before);
});

for (const size of SIZES) {
  test(`axe and layout at ${size.name} px with the tooltip open`, async ({ page }) => {
    await page.setViewportSize({ width: size.width, height: size.height });
    await open(page);
    await page.waitForLoadState('networkidle');
    await expect(openTabs(page)).toHaveCount(0);
    await expectAxeClean(page, `Overview at ${size.name}`);
    await page.locator('[data-bar][tabindex="0"]').focus();
    await expect(tip(page)).toBeVisible();
    await expectInViewport(page);
    const over = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(over).toBeLessThanOrEqual(0);
    await expectAxeClean(page, `Overview tooltip at ${size.name}`);
  });
}

test.describe('screenshots', () => {
  test.skip(!out, 'Set DOCKET_E2E_SCREENSHOTS to a folder to capture screenshots.');

  async function shoot(page: Page, name: string, size: (typeof SIZES)[number], full = false) {
    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme);
      await page.screenshot({
        path: join(out!, `b56-${name}-${size.name}-${theme}.png`),
        fullPage: full,
      });
    }
  }

  for (const size of SIZES) {
    test(`Overview, chart tooltip, card and at-risk line at ${size.name}`, async ({ page }) => {
      await page.setViewportSize({ width: size.width, height: size.height });
      await mockGet(page, '/api/workspaces', { rows: OWNERS_CASE });
      // A ticket left open first, to show the strip is gone from Overview.
      await page.goto('/items/STR-40');
      await expect(openTabs(page)).toBeVisible();
      await page
        .getByRole('navigation', { name: 'Primary' })
        .getByRole('link', { name: /^Overview/ })
        .click();
      await expect(page.locator('[data-card="completed-chart"] [data-bar]').first()).toBeVisible();
      await page
        .getByRole('group', { name: 'Time window' })
        .getByRole('button', { name: '30d' })
        .click();
      await page.waitForLoadState('networkidle');
      await expect(openTabs(page)).toHaveCount(0);
      await shoot(page, 'overview', size, true);

      const bar = page.locator('[data-bar][tabindex="0"]');
      await bar.scrollIntoViewIfNeeded();
      await bar.focus();
      await expect(tip(page)).toBeVisible();
      await shoot(page, 'chart-tooltip', size);
      await page.keyboard.press('Escape');

      await page.locator('[data-stat="agents"]').scrollIntoViewIfNeeded();
      for (const theme of ['light', 'dark'] as const) {
        await setTheme(page, theme);
        await page.locator('.ov-stats').screenshot({
          path: join(out!, `b56-agents-card-${size.name}-${theme}.png`),
        });
        await page.locator('[data-card="health"]').screenshot({
          path: join(out!, `b56-at-risk-line-${size.name}-${theme}.png`),
        });
      }

      await riskLine(page).click();
      await expect(page.locator('[data-at-risk-note]')).toBeVisible();
      await shoot(page, 'workspaces', size);
    });
  }
});

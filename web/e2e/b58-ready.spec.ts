/**
 * B58 (owner decision 48), on the seeded stress project (`STR`, 300 items):
 *
 * - Work splits Ready into Startable and Waiting, by keyboard, with counts
 *   that match the board, and each waiting ticket says what it waits on;
 * - Overview's In flight card links to Startable;
 * - a run parked on the owner's decision says "Held by your decision", links
 *   to it, and shows the next step;
 * - axe in both themes, and no sideways page scroll at 1024 px.
 *
 * Set DOCKET_E2E_SCREENSHOTS to a folder to also capture the PR's evidence.
 */
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import type { WorkResponse } from '@docket/shared';
import {
  connectAgent,
  expect,
  expectAxeClean,
  setTheme,
  test,
  unlock,
  useSeededContainer,
} from './fixtures/index';

useSeededContainer();
test.describe.configure({ mode: 'serial' });

const out = process.env.DOCKET_E2E_SCREENSHOTS;
const SIZES = [
  { name: '1440', width: 1440, height: 900 },
  { name: '1024', width: 1024, height: 768 },
] as const;

test.beforeEach(async ({ page }) => {
  await unlock(page.context());
  await page.context().addInitScript(() => {
    localStorage.setItem('docket.notifications', 'off');
    sessionStorage.setItem('docket.scope', 'STR');
  });
});

const quick = (page: Page) => page.getByRole('group', { name: 'Quick filters' });
const chip = (page: Page, name: string) =>
  quick(page).getByRole('button', { name: new RegExp(`^${name}`) });
const chipCount = async (page: Page, name: string) =>
  Number(await chip(page, name).locator('b').textContent());
const readyColumn = (page: Page) =>
  page.locator('[data-layout="board"]').getByRole('region', { name: 'Ready' });

async function capture(page: Page, name: string) {
  if (!out) return;
  for (const size of SIZES) {
    await page.setViewportSize({ width: size.width, height: size.height });
    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme);
      await page.screenshot({ path: join(out, `b58-${name}-${size.name}-${theme}.png`) });
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

async function noSidewaysScroll(page: Page) {
  const over = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(over).toBeLessThanOrEqual(0);
}

test('Work splits Ready into Startable and Waiting, from the keyboard', async ({ page }) => {
  await page.goto('/work');
  await expect(chip(page, 'Startable')).toBeVisible();
  const startable = await chipCount(page, 'Startable');
  const waiting = await chipCount(page, 'Waiting');
  await expect(readyColumn(page)).toContainText(`Startable · ${startable}`);
  await expect(readyColumn(page)).toContainText(`Waiting · ${waiting}`);
  await capture(page, 'work-board');

  await chip(page, 'Startable').focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/quick=startable/);
  await expect(chip(page, 'Startable')).toHaveAttribute('aria-pressed', 'true');
  await expect(readyColumn(page)).toContainText(`Startable · ${startable}`);
  await expectAxeClean(page, 'Work, Startable');

  await chip(page, 'Waiting').focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/quick=waiting/);
  const column = readyColumn(page);
  await expect(column).toContainText(`Waiting · ${waiting}`);
  await expect(column.locator('[data-waiting]').first()).toContainText('waits on');
  await expectAxeClean(page, 'Work, Waiting');
  await capture(page, 'work-waiting');

  await page.setViewportSize({ width: 1024, height: 768 });
  await noSidewaysScroll(page);
});

test('Overview’s In flight card links to Startable', async ({ page }) => {
  await page.goto('/');
  const link = page.locator('[data-stat="in-flight"] [data-ready-link]');
  await expect(link).toContainText(/\d+ of \d+ Ready can start/);
  await capture(page, 'overview');
  await link.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/work\?quick=startable/);
});

test('a run parked on the owner’s decision says so, with a link', async ({ page }) => {
  const work = await page.request.get('/api/work?scope=STR&layout=board&quick=startable');
  const id = ((await work.json()) as WorkResponse).items[0]!.id;
  const csrf = (await page.context().cookies()).find((c) => c.name === 'docket_csrf')?.value ?? '';
  const created = await page.request.post('/api/decisions', {
    headers: { 'X-Docket-CSRF': csrf },
    data: {
      project: 'STR',
      scope: { kind: 'project' },
      title: 'Pause this project for now',
      decision: 'Synthetic pause for this test.',
    },
  });
  expect(created.ok()).toBe(true);
  const decision = ((await created.json()) as { decision: { id: string } }).decision.id;

  const agent = await connectAgent('claude-agent-sdk');
  try {
    const claim = await agent.call('claim_lead', { id, agent_label: 'b58-worker' });
    expect(claim.isError, claim.text).toBe(false);
    const parked = await agent.call('park_run', {
      run_id: claim.structured.run_id,
      reason: `Paused by ${decision}.`,
      waiting_on: { person: true },
    });
    expect(parked.isError, parked.text).toBe(false);
  } finally {
    await agent.close();
  }

  await page.goto(`/items/${id}`);
  const held = page.locator('[data-ab="wait-held"]');
  await expect(held).toContainText('Held by your decision: Pause this project for now');
  await expect(held.getByRole('link')).toHaveAttribute('href', new RegExp(decision));
  await expect(page.locator('[data-ab="wait-next"]')).toHaveText(
    'Next: Resumes when the owner lifts it',
  );
  await expectAxeClean(page, 'Held by your decision', { include: '.agentbar' });
  await capture(page, 'held-by-decision');

  await page.setViewportSize({ width: 1024, height: 768 });
  await noSidewaysScroll(page);
});

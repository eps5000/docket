/**
 * B51: the Overview page (owner decision 43), on the seeded data and the
 * 300-item STR stress project: each number equals the list behind it, the
 * time window, "Nothing needs you", axe in both themes at 1440 and 1024 px,
 * the read API's timings, and the PR's screenshots (DOCKET_E2E_SCREENSHOTS).
 */
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import type {
  NeedsYouResponse,
  OverviewMetric,
  OverviewResponse,
  WorkResponse,
} from '@docket/shared';
import { emptyNeedsYou, mockGet } from './fixtures/api-mocks';
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
  { name: '1024', width: 1024, height: 900 },
] as const;

test.beforeEach(async ({ page }) => {
  await unlock(page.context());
  await page.context().addInitScript(() => localStorage.setItem('docket.notifications', 'off'));
});

const inScope = (page: Page, scope: string) =>
  page.addInitScript((s) => sessionStorage.setItem('docket.scope', s), scope);

const api = <T>(page: Page, path: string) =>
  page.evaluate(async (p) => (await (await fetch(p)).json()) as unknown, path) as Promise<T>;
const overview = (page: Page, scope: string, window = '7d') =>
  api<OverviewResponse>(page, `/api/overview?scope=${scope}&window=${window}`);

const needsYou = (page: Page, scope: string) =>
  api<NeedsYouResponse>(page, `/api/needs-you?scope=${scope}`);

const stat = (page: Page, name: string) => page.locator(`[data-stat="${name}"]`);

/** The sidebar's Agents badge and the Overview card show the API's one number. */
async function expectBadgeEqualsCard(page: Page, scope: string, working: number, waiting: number) {
  await page.evaluate((s) => sessionStorage.setItem('docket.scope', s), scope);
  await open(page);
  expect((await needsYou(page, scope)).agents_now).toEqual({ working, waiting });
  await expect(stat(page, 'agents').locator('a.ov-num')).toHaveText(`${working} being worked`);
  await expect(stat(page, 'agents').locator('a.ov-sub')).toHaveText(`${waiting} parked/waiting`);
  const badge = page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: /^Agents/ })
    .locator('.badge');
  if (working === 0) await expect(badge).toHaveCount(0);
  else await expect(badge).toContainText(String(working));
}

async function open(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
  await expect(stat(page, 'completed').locator('a.ov-num')).toBeVisible();
  await expect(page.locator('[data-card="health"]')).toBeVisible();
}

async function expectNoSidewaysScroll(page: Page) {
  const over = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(over).toBeLessThanOrEqual(0);
}

test('the seed: each number opens a list of exactly that many tickets', async ({ page }) => {
  await inScope(page, 'RCP');
  await open(page);
  const o = await overview(page, 'RCP');
  const agents = (await needsYou(page, 'RCP')).agents_now!;
  const lists: [string, string, OverviewMetric, number][] = [
    ['completed', `${o.completed.count} ticket`, 'completed', o.completed.count],
    ['agents', `${agents.working} being worked`, 'agents_working', agents.working],
    ['agents', `${agents.waiting} parked/waiting`, 'agents_waiting', agents.waiting],
    ['in-flight', `${o.in_flight.count} ticket`, 'in_flight', o.in_flight.count],
  ];
  for (const [card, name, metric, n] of lists) {
    await open(page);
    await stat(page, card)
      .getByRole('link', { name: new RegExp(`^${name}`) })
      .click();
    await expect(page).toHaveURL(new RegExp(`/overview/${metric}`));
    await expect(page.getByRole('heading', { level: 1 })).toContainText(`· ${n}`);
    await expect(page.locator('tbody tr')).toHaveCount(n);
  }
  expect(agents.working).toBeGreaterThan(0);
});

test('the badge is the owner actions on the page, and old links land on them', async ({ page }) => {
  await page.goto('/needs-you');
  await expect(page).toHaveURL(/\/#needs-you$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
  await expect(page.locator('#needs-you')).toBeInViewport();
  const n = await page.locator('[data-needs-you-count]').getAttribute('data-needs-you-count');
  await expect(page.getByRole('heading', { level: 2, name: `Needs you · ${n}` })).toBeVisible();
  await expect(
    page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: /^Overview/ }),
  ).toContainText(n!);
  await expect(page).toHaveTitle(`(${n}) Docket`);
});

test('STR: the numbers, the Blocked link, and the read API stays fast', async ({ page }) => {
  await inScope(page, 'STR');
  await open(page);
  const o = await overview(page, 'STR', '30d');
  // Workload holds every open ticket once; Blocked equals Work's Blocked filter.
  const work = await api<WorkResponse>(page, '/api/work?scope=STR&quick=blocked&layout=list');
  expect(o.blocked).toBeGreaterThan(0);
  expect(work.items.length).toBe(o.blocked);
  expect(o.workload.reduce((n, g) => n + g.counts.blocked, 0)).toBe(o.blocked);
  const active = await api<WorkResponse>(page, '/api/work?scope=STR&quick=active&layout=list');
  expect(o.workload.reduce((n, g) => n + g.total, 0)).toBe(active.items.length);
  expect(o.completed.buckets.reduce((n, b) => n + b.count, 0)).toBe(o.completed.count);

  await stat(page, 'in-flight')
    .getByRole('link', { name: `${o.blocked} blocked` })
    .click();
  await expect(page).toHaveURL(/\/work\?quick=blocked$/);

  // The read API on the stress project and on All projects (for the PR).
  const timings = await page.evaluate(async () => {
    const out: Record<string, { p50: number; p95: number }> = {};
    for (const path of [
      '/api/overview?scope=STR&window=7d',
      '/api/overview?scope=STR&window=30d',
      '/api/overview?scope=all&window=30d',
      '/api/overview/items?scope=STR&window=30d&metric=completed',
      '/api/overview/items?scope=STR&window=7d&metric=in_flight',
    ]) {
      const samples: number[] = [];
      for (let i = 0; i < 20; i++) {
        const t = performance.now();
        const res = await fetch(path, { cache: 'no-store' });
        if (!res.ok) throw new Error(`${path}: ${res.status}`);
        await res.text();
        samples.push(performance.now() - t);
      }
      samples.sort((a, b) => a - b);
      out[path] = {
        p50: Math.round(samples[9]!),
        p95: Math.round(samples[18]!),
      };
    }
    return out;
  });
  console.log(`B51 overview timings (ms): ${JSON.stringify(timings)}`);
  for (const t of Object.values(timings)) expect(t.p95).toBeLessThan(1000);
});

test('the time window: 7 days first, the choice changes the numbers and is remembered', async ({
  page,
}) => {
  await inScope(page, 'STR');
  await open(page);
  const group = page.getByRole('group', { name: 'Time window' });
  await expect(group.getByRole('button', { name: '7d' })).toHaveAttribute('aria-pressed', 'true');
  const month = await overview(page, 'STR', '30d');
  await group.getByRole('button', { name: '30d' }).click();
  await expect(stat(page, 'completed').locator('a.ov-num')).toContainText(
    String(month.completed.count),
  );
  await expect(page.locator('[data-card="completed-chart"] h3')).toHaveText('Completed per day');
  await page.reload();
  await expect(group.getByRole('button', { name: '30d' })).toHaveAttribute('aria-pressed', 'true');
  await group.getByRole('button', { name: '24h' }).click();
  await expect(page.locator('[data-card="completed-chart"] h3')).toHaveText('Completed per hour');
});

test('the Agents badge equals the card, in All projects and one project, through a handoff and a park', async ({
  page,
}) => {
  await open(page);
  const all = (await needsYou(page, 'all')).agents_now!;
  const rcp = (await needsYou(page, 'RCP')).agents_now!;
  await expectBadgeEqualsCard(page, 'all', all.working, all.waiting);
  await expectBadgeEqualsCard(page, 'RCP', rcp.working, rcp.waiting);
  await expectBadgeEqualsCard(page, 'STR', 0, 0);

  const agent = await connectAgent('claude-agent-sdk');
  let run: string | null = null;
  try {
    // A producer's worker starts a story: one more in its project and in All.
    const first = await agent.call('claim_lead', {
      id: 'RCP-17',
      agent_label: 'b51-w1',
      producer: 'b51-producer',
    });
    expect(first.isError, first.text).toBe(false);
    run = first.structured.run_id as string;
    await expectBadgeEqualsCard(page, 'RCP', rcp.working + 1, rcp.waiting);
    await expectBadgeEqualsCard(page, 'all', all.working + 1, all.waiting);

    // Handed on: held for the producer, so it still counts once.
    const handoff = await agent.call('release_lead', {
      id: 'RCP-17',
      run_id: run,
      reason: 'Slice done.',
    });
    expect(handoff.isError, handoff.text).toBe(false);
    run = null;
    await expectBadgeEqualsCard(page, 'RCP', rcp.working + 1, rcp.waiting);
    const next = await agent.call('claim_lead', {
      id: 'RCP-17',
      agent_label: 'b51-w2',
      producer: 'b51-producer',
    });
    expect(next.isError, next.text).toBe(false);
    run = next.structured.run_id as string;
    await expectBadgeEqualsCard(page, 'RCP', rcp.working + 1, rcp.waiting);

    // Parked on the coordinator: waiting, and out of the badge.
    const parked = await agent.call('park_run', {
      run_id: run,
      reason: 'Waiting on the coordinator.',
      waiting_on: { orchestrator: true },
    });
    expect(parked.isError, parked.text).toBe(false);
    await expectBadgeEqualsCard(page, 'RCP', rcp.working, rcp.waiting + 1);
    await expectBadgeEqualsCard(page, 'all', all.working, all.waiting + 1);

    // The Agents page keeps its runs, labelled as runs, beside the same story count.
    await page.goto('/agents');
    await expect(page.locator('[data-agents-stories]')).toContainText(
      `${rcp.working === 1 ? '1 ticket' : `${rcp.working} tickets`} being worked`,
    );
    await expect(page.locator('[data-agents-stories]')).toContainText('individual runs');
    await expect(
      page.locator('[data-section="agents-active"]').getByRole('button', { name: /^Active now/ }),
    ).toContainText(/\d+ runs?/);
  } finally {
    if (run) {
      await agent.call('release_lead', {
        id: 'RCP-17',
        run_id: run,
        reason: 'Test finished.',
        release_story: true,
      });
    }
    await agent.close();
  }
  await expectBadgeEqualsCard(page, 'RCP', rcp.working, rcp.waiting);
});

test('Nothing needs you: no badge, and problems agents handle stay on one line', async ({
  page,
}) => {
  const agentProblem = {
    kind: 'stale_run',
    id: 'stale_run:STR-20',
    item_id: 'STR-20',
    title: 'A stale run',
    reason: 'Silent',
    related: [],
    link_id: null,
    run_id: null,
    resource_ids: [],
    explanation: { what: 'Silent.', fix: 'Resume it.', who: 'agent', who_text: 'An agent' },
    reached_you: null,
  };
  const view = { ...emptyNeedsYou, agent_problems: [agentProblem] } as NeedsYouResponse;
  await mockGet(page, '/api/needs-you', view);
  await inScope(page, 'STR');
  await open(page);
  await expect(page.getByText('Nothing needs you')).toBeVisible();
  await expect(page.locator('[data-needs-you-count]')).toHaveCount(0);
  await expect(
    page
      .getByRole('navigation', { name: 'Primary' })
      .getByRole('link', { name: /^Overview/ })
      .locator('.badge'),
  ).toHaveCount(0);
  const line = page.getByRole('button', { name: 'Agents are handling 1 problem' });
  await expect(line).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('[data-more-problems="agents"] [data-problem]')).toHaveCount(0);
  await expectAxeClean(page, 'Overview, nothing needs you');
});

for (const size of SIZES) {
  test(`axe and layout at ${size.name} px, busy and on the stress project`, async ({ page }) => {
    await page.setViewportSize({ width: size.width, height: size.height });
    await open(page);
    await page.waitForLoadState('networkidle');
    await expectNoSidewaysScroll(page);
    await expectAxeClean(page, `Overview, All projects at ${size.name}`);

    await page.evaluate(() => sessionStorage.setItem('docket.scope', 'STR'));
    await open(page);
    await page.waitForLoadState('networkidle');
    await expect(page.locator('[data-workload]').first()).toBeVisible();
    await expectNoSidewaysScroll(page);
    await expectAxeClean(page, `Overview, STR at ${size.name}`);

    await page.goto('/overview/in_flight');
    await expect(page.locator('tbody tr').first()).toBeVisible();
    await expectNoSidewaysScroll(page);
    await expectAxeClean(page, `Overview list at ${size.name}`);
  });
}

test.describe('screenshots', () => {
  test.skip(!out, 'Set DOCKET_E2E_SCREENSHOTS to a folder to capture screenshots.');

  async function shoot(page: Page, name: string, size: (typeof SIZES)[number]) {
    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme);
      await page.screenshot({
        path: join(out!, `overview-${name}-${size.name}-${theme}.png`),
        fullPage: true,
      });
    }
  }

  for (const size of SIZES) {
    test(`busy, a window change, and nothing needs you at ${size.name}`, async ({ page }) => {
      await page.setViewportSize({ width: size.width, height: size.height });
      await open(page);
      await page.waitForLoadState('networkidle');
      await shoot(page, 'busy', size);

      await page
        .getByRole('group', { name: 'Time window' })
        .getByRole('button', { name: '30d' })
        .click();
      const month = await overview(page, 'all', '30d');
      await expect(stat(page, 'completed').locator('a.ov-num')).toContainText(
        String(month.completed.count),
      );
      await shoot(page, 'window-30d', size);

      await mockGet(page, '/api/needs-you', emptyNeedsYou);
      await page.evaluate(() => sessionStorage.setItem('docket.scope', 'STR'));
      await open(page);
      await expect(page.getByText('Nothing needs you')).toBeVisible();
      await page.waitForLoadState('networkidle');
      await shoot(page, 'nothing', size);
    });
  }
});

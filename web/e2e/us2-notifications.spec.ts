/**
 * Desktop notifications and the tab title (tasks.md T079; spec US2 acceptance
 * 7; FR-068; UI_SPEC §6.7a).
 *
 * - Items already for you when the page loads never notify (the real stream).
 * - One notification per new packet or question; the same seq or a burst on
 *   one item doesn't notify again; nothing else notifies; a click opens the
 *   packet or the item's question.
 * - The tab title reads `(N) Task Lite`.
 * - The opt-in callout, and with permission denied the status reads
 *   "Blocked by the browser".
 *
 * Packets are real (B9): an agent hands one off with `submit_packet` through
 * the MCP helper, and the page hears it on the real `/api/stream`. Agents
 * can't ask questions yet (`ask_owner` is US6's), so the question cases still
 * feed a routed `/api/stream` carrying exactly what the server sends
 * (`for_you: true`, as us2-api.test.ts checks against the real stream), and
 * `/api/needs-you` adds the matching row. The packet tests run last: they
 * add to the "For you now · 3" the earlier tests count.
 */
import type { Page, Route } from '@playwright/test';
import type { ForYouRow, NeedsYouResponse } from '@tasklite/shared';
import {
  clickNotification,
  connectAgent,
  denyNotifications,
  expect,
  grantNotifications,
  recordNotifications,
  recordedNotifications,
  test,
  unlock,
  useSeededContainer,
} from './fixtures/index';

useSeededContainer();

const NEW_QUESTION: ForYouRow = {
  kind: 'question',
  item_id: 'RCP-16',
  title: 'Nutrition summary card',
  project: 'RCP',
  question_id: 'q_e2e',
  asked_by: 'claude · e2e-w1',
  text: 'Should the card round to whole grams?',
  asked_at: new Date().toISOString(),
};

/** A stream we feed by hand; each reconnect (300 ms) delivers what was queued. */
async function routedStream(page: Page) {
  const queue: string[] = [];
  await page.route(/\/api\/stream(\?.*)?$/, async (route: Route) => {
    const body = `retry: 300\n\n${queue.splice(0).join('')}`;
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
      body,
    });
  });
  return {
    push(seq: number, type: string, id: string, forYou: boolean) {
      const data = { seq, type, objects: [{ kind: 'item', id }], for_you: forYou };
      queue.push(`event: change\nid: ${seq}\ndata: ${JSON.stringify(data)}\n\n`);
    },
  };
}

/** Needs you as the server answers it, plus `extra` rows. */
async function needsYouWith(page: Page, extra: () => ForYouRow[]) {
  await page.route(/\/api\/needs-you(\?.*)?$/, async (route: Route) => {
    const res = await route.fetch();
    const body = (await res.json()) as NeedsYouResponse;
    await route.fulfill({
      response: res,
      json: { ...body, for_you_now: [...body.for_you_now, ...extra()] },
    });
  });
}

async function notificationsOn(page: Page) {
  await page.context().addInitScript(() => localStorage.setItem('tl.notifications', 'on'));
}

test.describe('notifications', () => {
  test.beforeEach(async ({ page }) => {
    await unlock(page.context());
  });

  test('items already for you on load never notify; the tab title reads (3) Task Lite', async ({
    page,
  }) => {
    await grantNotifications(page.context());
    await recordNotifications(page.context());
    await notificationsOn(page);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'For you now · 3' })).toBeVisible();
    await expect(page).toHaveTitle('(3) Task Lite');
    // Give the real stream time to deliver anything it would.
    await page.waitForTimeout(2000);
    expect(await recordedNotifications(page)).toEqual([]);
  });

  test('the opt-in callout: Turn on asks the browser, Not now hides it for good', async ({
    page,
  }) => {
    await grantNotifications(page.context());
    await page.goto('/');
    const callout = page.locator('[data-card="notify-optin"]');
    await expect(callout).toContainText('Get a desktop notification when something needs you.');
    await callout.getByRole('button', { name: 'Turn on' }).click();
    await expect(callout).toHaveCount(0);
    await page.goto('/settings');
    await expect(page.locator('[data-notify-status]')).toHaveText('On');
    await expect(page.getByRole('switch', { name: 'Desktop notifications' })).toBeChecked();
    await page.getByRole('switch', { name: 'Desktop notifications' }).click();
    await expect(page.locator('[data-notify-status]')).toHaveText('Off');
    // The choice was made: the callout doesn't come back.
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'For you now · 3' })).toBeVisible();
    await expect(callout).toHaveCount(0);
  });

  test('Not now hides the callout and Settings keeps the switch', async ({ page }) => {
    await grantNotifications(page.context());
    await page.goto('/');
    const callout = page.locator('[data-card="notify-optin"]');
    await callout.getByRole('button', { name: 'Not now' }).click();
    await expect(callout).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'For you now · 3' })).toBeVisible();
    await expect(callout).toHaveCount(0);
    await page.goto('/settings');
    await expect(page.locator('[data-notify-status]')).toHaveText('Off');
  });

  test('with permission denied, the status reads "Blocked by the browser"', async ({ page }) => {
    await denyNotifications(page.context());
    await page.goto('/');
    await page
      .locator('[data-card="notify-optin"]')
      .getByRole('button', { name: 'Turn on' })
      .click();
    await page.goto('/settings');
    const host = new URL(page.url()).host;
    await expect(page.locator('[data-notify-status]')).toHaveText(
      `Blocked by the browser. Allow notifications for ${host} in your browser settings.`,
    );
    await expect(page.getByRole('switch', { name: 'Desktop notifications' })).toBeDisabled();
    // The UI keeps working without notifications.
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'For you now · 3' })).toBeVisible();
  });
  test('one notification per new question; the same seq or a burst does not notify again; a click opens the question', async ({
    page,
  }) => {
    await grantNotifications(page.context());
    await recordNotifications(page.context());
    await notificationsOn(page);
    const rows: ForYouRow[] = [];
    await needsYouWith(page, () => rows);
    const stream = await routedStream(page);
    await page.goto('/work');
    await expect(page).toHaveTitle('(3) Task Lite');

    // Not for you: never notifies.
    stream.push(9001, 'item.updated', 'RCP-17', false);
    stream.push(9002, 'run.ended', 'RCP-18', false);
    await page.waitForTimeout(1000);
    expect(await recordedNotifications(page)).toEqual([]);

    rows.push(NEW_QUESTION);
    stream.push(9004, 'question.asked', 'RCP-16', true);
    await expect.poll(async () => (await recordedNotifications(page)).length).toBe(1);

    // The same seq again, and a burst on the same item: nothing more.
    stream.push(9004, 'question.asked', 'RCP-16', true);
    stream.push(9005, 'question.asked', 'RCP-16', true);
    await page.waitForTimeout(1500);
    expect(await recordedNotifications(page)).toEqual([
      {
        title: 'claude asks on RCP-16',
        body: 'Should the card round to whole grams?',
        tag: 'tl-question-RCP-16',
      },
    ]);
    await clickNotification(page, 0);
    await expect(page).toHaveURL(/\/items\/RCP-16$/);
  });

  test('a packet an agent submits notifies once; a click opens the packet', async ({ page }) => {
    await grantNotifications(page.context());
    await recordNotifications(page.context());
    await notificationsOn(page);
    await page.goto('/work');
    await expect(page).toHaveTitle('(3) Task Lite');

    const agent = await connectAgent('codex');
    try {
      // Claiming is not for you; once the board shows it, the live stream is delivering.
      const claim = await agent.call('claim_lead', { id: 'RCP-17', agent_label: 'e2e-w1' });
      expect(claim.isError, claim.text).toBe(false);
      const run_id = claim.structured.run_id as string;
      await expect(page.locator('[data-item="RCP-17"]').first()).toContainText('codex');
      const declared = await agent.call('declare_human_review', {
        id: 'RCP-17',
        run_id,
        items: ['Reload the planner on week 3. Does it stay on week 3?'],
      });
      expect(declared.isError, declared.text).toBe(false);
      expect(await recordedNotifications(page)).toEqual([]);

      const packet = await agent.call('submit_packet', {
        id: 'RCP-17',
        run_id,
        built_from_commit: 'abc1234',
        estimate: '5 min',
        how: ['Open the planner, go to week 3 and reload.'],
        checked: [{ text: 'Regression test passes', provenance: 'ci', evidence: 'CI #90' }],
      });
      expect(packet.isError, packet.text).toBe(false);
      await expect.poll(async () => (await recordedNotifications(page)).length).toBe(1);
      await expect(page).toHaveTitle('(4) Task Lite');

      // More changes on the same item that aren't for you: nothing more.
      const commit = await agent.call('report_commit', { id: 'RCP-17', run_id, sha: 'def5678' });
      expect(commit.text).toContain('out of date: RCP-17 round 1');
      await page.waitForTimeout(1500);
      expect(await recordedNotifications(page)).toEqual([
        {
          title: 'Handoff ready: RCP-17 Planner jumps back to the current week after reload',
          body: '1 thing to verify · about 5 min',
          tag: 'tl-packet-RCP-17',
        },
      ]);
      await clickNotification(page, 0);
      await expect(page).toHaveURL(/\/review\/RCP-17$/);
    } finally {
      await agent.close();
    }
  });

  test('turned off, a submitted packet does not notify (the title still counts)', async ({
    page,
  }) => {
    await grantNotifications(page.context());
    await recordNotifications(page.context());
    await page.context().addInitScript(() => localStorage.setItem('tl.notifications', 'off'));
    await page.goto('/');
    await expect(page).toHaveTitle(/^\(\d+\) Task Lite$/);
    const before = Number(/^\((\d+)\)/.exec(await page.title())![1]);
    const agent = await connectAgent('codex');
    try {
      const claim = await agent.call('claim_lead', { id: 'RCP-25', agent_label: 'e2e-w2' });
      expect(claim.isError, claim.text).toBe(false);
      const packet = await agent.call('submit_packet', {
        id: 'RCP-25',
        run_id: claim.structured.run_id as string,
        built_from_commit: 'abc9999',
        estimate: '10 min',
        how: ['Open the pantry screens on your phone.'],
        checked: [],
      });
      expect(packet.isError, packet.text).toBe(false);
      await expect(page).toHaveTitle(`(${before + 1}) Task Lite`);
      await page.waitForTimeout(1000);
      expect(await recordedNotifications(page)).toEqual([]);
    } finally {
      await agent.close();
    }
  });
});

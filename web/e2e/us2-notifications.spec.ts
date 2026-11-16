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
 * Agents can't submit packets or ask questions yet (`submit_packet` is US3's,
 * `ask_owner` US6's), so new for-you events reach the page through a routed
 * `/api/stream` carrying exactly what the server sends (`for_you: true`, as
 * us2-api.test.ts checks against the real stream), and `/api/needs-you` adds
 * the matching rows. B9 can switch these to real agent calls.
 */
import type { Page, Route } from '@playwright/test';
import type { ForYouRow, NeedsYouResponse } from '@tasklite/shared';
import {
  clickNotification,
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

const NEW_PACKET: ForYouRow = {
  kind: 'packet',
  item_id: 'RCP-17',
  title: 'Planner jumps back to the current week after reload',
  project: 'RCP',
  packet_id: 'pkt_e2e',
  round: 1,
  to_verify: 1,
  estimate: '5 min',
  stale: false,
  built_from_commit: 'abc1234',
  submitted_at: new Date().toISOString(),
};
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

  test('one notification per new packet or question; a click opens the packet or the question', async ({
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

    // A packet, then a question: one each.
    rows.push(NEW_PACKET);
    stream.push(9003, 'packet.submitted', 'RCP-17', true);
    await expect.poll(async () => (await recordedNotifications(page)).length).toBe(1);
    rows.push(NEW_QUESTION);
    stream.push(9004, 'question.asked', 'RCP-16', true);
    await expect.poll(async () => (await recordedNotifications(page)).length).toBe(2);

    // The same seq again, and a burst on the same item: nothing more.
    stream.push(9003, 'packet.submitted', 'RCP-17', true);
    stream.push(9005, 'packet.submitted', 'RCP-17', true);
    await page.waitForTimeout(1500);
    expect(await recordedNotifications(page)).toEqual([
      {
        title: 'Handoff ready: RCP-17 Planner jumps back to the current week after reload',
        body: '1 thing to verify · about 5 min',
        tag: 'tl-packet-RCP-17',
      },
      {
        title: 'claude asks on RCP-16',
        body: 'Should the card round to whole grams?',
        tag: 'tl-question-RCP-16',
      },
    ]);

    // Clicking goes to the packet, or to the item's question.
    await clickNotification(page, 0);
    await expect(page).toHaveURL(/\/review\/RCP-17$/);
    await clickNotification(page, 1);
    await expect(page).toHaveURL(/\/items\/RCP-16$/);
  });

  test('turned off, nothing notifies (the title still counts)', async ({ page }) => {
    await grantNotifications(page.context());
    await recordNotifications(page.context());
    await page.context().addInitScript(() => localStorage.setItem('tl.notifications', 'off'));
    const rows: ForYouRow[] = [NEW_PACKET];
    await needsYouWith(page, () => rows);
    const stream = await routedStream(page);
    await page.goto('/');
    stream.push(9101, 'packet.submitted', 'RCP-17', true);
    await page.waitForTimeout(1500);
    expect(await recordedNotifications(page)).toEqual([]);
    await expect(page).toHaveTitle(/^\(\d+\) Task Lite$/);
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
});

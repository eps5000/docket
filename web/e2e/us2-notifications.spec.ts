/**
 * Desktop notifications and the tab title (tasks.md T079; spec US2 acceptance
 * 7; FR-068; UI_SPEC §6.7a).
 *
 * - Items already for you when the page loads never notify (the real stream).
 * - One notification per new packet or question; nothing else on the item
 *   notifies, and a refused second question doesn't either; a click opens
 *   the packet or the item's question. (The same seq or a burst notifying
 *   once is unit-tested in src/lib/notifications.test.ts: a real server never
 *   repeats a seq.)
 * - The tab title reads `(N) Docket`, N being what the owner can act on on
 *   Needs you: the cards plus the Problems (decision 41).
 * - The opt-in callout, and with permission denied the status reads
 *   "Blocked by the browser".
 *
 * Everything is real: an agent hands off a packet with `submit_packet` (B9)
 * and asks with `ask_owner` (US6, B13) through the MCP helper, and the page
 * hears it on the real `/api/stream`. The question test answers its
 * question in the ticket's banner, so the count is back to 3 afterwards;
 * the packet tests run last: they add to the "For you now · 3" the earlier
 * tests count.
 */
import type { Page } from '@playwright/test';
import {
  clickNotification,
  connectAgent,
  denyNotifications,
  expect,
  grantNotifications,
  needsYouTitle,
  recordNotifications,
  recordedNotifications,
  test,
  unlock,
  useSeededContainer,
} from './fixtures/index';

useSeededContainer();

async function notificationsOn(page: Page) {
  await page.context().addInitScript(() => localStorage.setItem('docket.notifications', 'on'));
}

test.describe('notifications', () => {
  test.beforeEach(async ({ page }) => {
    await unlock(page.context());
  });

  test('items already for you on load never notify; the tab title counts what you can act on', async ({
    page,
  }) => {
    await grantNotifications(page.context());
    await recordNotifications(page.context());
    await notificationsOn(page);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'For you now · 3' })).toBeVisible();
    await expect(page).toHaveTitle(await needsYouTitle(page));
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
  test('one notification per new question; nothing else on the item notifies, nor a refused second question; a click opens the question', async ({
    page,
  }) => {
    await grantNotifications(page.context());
    await recordNotifications(page.context());
    await notificationsOn(page);
    await page.goto('/work');
    const before = await needsYouTitle(page);
    await expect(page).toHaveTitle(before);

    const agent = await connectAgent('claude');
    try {
      // Not for you: never notifies.
      const note = await agent.call('add_note', { id: 'RCP-16', text: 'Looking at rounding.' });
      expect(note.isError, note.text).toBe(false);
      await page.waitForTimeout(1000);
      expect(await recordedNotifications(page)).toEqual([]);

      const asked = await agent.call('ask_owner', {
        id: 'RCP-16',
        question: 'Should the card round to whole grams?',
      });
      expect(asked.isError, asked.text).toBe(false);
      await expect.poll(async () => (await recordedNotifications(page)).length).toBe(1);
      await expect(page).toHaveTitle(await needsYouTitle(page));
      expect(await needsYouTitle(page)).not.toBe(before);

      // A second question while one is open is refused; another note isn't for you.
      const second = await agent.call('ask_owner', { id: 'RCP-16', question: 'And for drinks?' });
      expect(second.structured).toMatchObject({ code: 'validation' });
      await agent.call('add_note', { id: 'RCP-16', text: 'Still waiting on rounding.' });
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

      // Answered in the banner, it's no longer for you.
      const banner = page.locator('[data-banner="question"]');
      await banner.getByLabel('Your answer').fill('Yes, whole grams.');
      await banner.getByRole('button', { name: 'Send answer' }).click();
      await expect(page.locator('.callout.answered')).toBeVisible();
      await expect(page).toHaveTitle(before);
    } finally {
      await agent.close();
    }
  });

  test('a packet an agent submits notifies once; a click opens the packet', async ({ page }) => {
    await grantNotifications(page.context());
    await recordNotifications(page.context());
    await notificationsOn(page);
    await page.goto('/work');
    const before = await needsYouTitle(page);
    await expect(page).toHaveTitle(before);

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
      await expect(page).toHaveTitle(await needsYouTitle(page));
      expect(await needsYouTitle(page)).not.toBe(before);

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
    await page.context().addInitScript(() => localStorage.setItem('docket.notifications', 'off'));
    await page.goto('/');
    await expect(page).toHaveTitle(/^\(\d+\) Docket$/);
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
      await expect(page).toHaveTitle(`(${before + 1}) Docket`);
      await page.waitForTimeout(1000);
      expect(await recordedNotifications(page)).toEqual([]);
    } finally {
      await agent.close();
    }
  });
});

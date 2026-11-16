/**
 * US2: the owner sees what agents did and are doing (tasks.md T078; spec US2
 * acceptance 1–3, 6; UI_SPEC §6.1, §6.2.1–2, §6.3, §6.6, §7).
 *
 * Against the seeded container: Needs you ("3 for you", only action cards,
 * Problems actions, one screen at 1440×900), Work Board and List, the four
 * item tabs with counts and dots, Agents, palette search, the tab title,
 * a live update from a real MCP agent that leaves the owner's focus where
 * it was, and owner views rendering in under 1 s (SC-013).
 */
import type { Page } from '@playwright/test';
import { expect, test, unlock, useSeededContainer, connectAgent } from './fixtures/index';

useSeededContainer();

const h1 = (page: Page) => page.getByRole('heading', { level: 1 });
const card = (page: Page, name: string) => page.locator(`[data-card="${name}"]`);

test.beforeEach(async ({ page }) => {
  await unlock(page.context());
});

test.describe('Needs you', () => {
  test('"3 for you": two packets and a question, then only action cards, on one screen', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'For you now · 3' })).toBeVisible();
    const forYou = card(page, 'for-you');
    await expect(forYou.locator('[data-row="packet"]')).toHaveCount(2);
    await expect(forYou.locator('[data-row="question"]')).toHaveCount(1);
    await expect(forYou).toContainText('codex asks: “Should nutrition values be documented');
    await expect(forYou).toContainText('out of date: code changed after it was written');
    await expect(forYou.getByRole('link', { name: 'Open packet' })).toHaveCount(2);

    // Only the action cards: For you now, Problems, Deferred, Planning queue (no Coming up,
    // no Since you looked).
    const cards = await page
      .locator('.needs-you [data-card]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-card')));
    expect(cards.filter((c) => c !== 'notify-optin')).toEqual([
      'agents-strip',
      'for-you',
      'problems',
      'deferred',
      'planning-queue',
    ]);
    await expect(page.getByText('Coming up')).toHaveCount(0);
    await expect(page.getByText('Since you looked')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: /^Deferred, not verified · 2$/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: /^Your Planning queue · 5$/ })).toBeVisible();

    // The Agents strip counts runs by state, in words.
    const strip = card(page, 'agents-strip');
    for (const s of ['live', 'reported', 'needs input', 'stale', 'failed']) {
      await expect(strip).toContainText(s);
    }

    // One screen at 1440×900: nothing scrolls.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollHeight - window.innerHeight,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test('Problems: each row has its reason and one action that opens the right place', async ({
    page,
  }) => {
    await page.goto('/');
    const problems = card(page, 'problems');
    await expect(problems.getByRole('heading', { name: /^Problems · \d+$/ })).toBeVisible();
    const stale = problems.locator('[data-problem="stale_run"]');
    await expect(stale).toContainText('RCP-15');
    await expect(stale).toContainText('Treated as unknown, not finished.');
    await stale.getByRole('link', { name: 'Inspect' }).click();
    await expect(page).toHaveURL(/\/items\/RCP-15\?tab=activity$/);
    await expect(page.getByRole('tabpanel')).toContainText('Lead and runs');

    await page.goto('/');
    await problems.locator('[data-problem="cycle"]').getByRole('link', { name: 'Fix' }).click();
    await expect(page).toHaveURL(/\/items\/DOC-7\?tab=deps$/);

    await page.goto('/');
    await problems
      .locator('[data-problem="date_risk"]')
      .getByRole('link', { name: 'Timeline' })
      .click();
    await expect(page).toHaveURL(/\/work\?layout=timeline$/);

    await page.goto('/');
    await problems
      .locator('[data-problem="failed_run"]')
      .getByRole('link', { name: 'Inspect' })
      .click();
    await expect(page).toHaveURL(/\/items\/RCP-18\?tab=activity$/);
  });

  test('the tab title and the sidebar badge show the for-you count', async ({ page }) => {
    await page.goto('/work');
    await expect(page).toHaveTitle('(3) Task Lite');
    const needsYou = page
      .getByRole('navigation', { name: 'Primary' })
      .getByRole('link', { name: /^Needs you/ });
    await expect(needsYou).toContainText('3');
    await expect(needsYou).toContainText('for you');
  });

  test('scoped to one project, Needs you counts that project only', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /^Project:?\s*All projects$/ }).click();
    await page.getByRole('menuitemradio', { name: 'Docs Site' }).click();
    await expect(page.getByRole('heading', { name: 'For you now · 1' })).toBeVisible();
  });
});

test.describe('Work', () => {
  test('Board: six columns, Ready split, Review cards open their packet, filters say their agent query', async ({
    page,
  }) => {
    await page.goto('/work');
    const board = page.locator('[data-layout="board"]');
    for (const col of ['Inbox', 'Planning', 'Ready', 'In progress', 'Review', 'Done']) {
      await expect(board.getByRole('region', { name: col })).toBeVisible();
    }
    const ready = board.getByRole('region', { name: 'Ready' });
    await expect(ready).toContainText(/Startable · \d+/);
    await expect(ready).toContainText(/Waiting on blockers · \d+/);
    await expect(page.getByRole('button', { name: /^For you/ })).toHaveAttribute(
      'title',
      'Agent query: needs:human',
    );
    await expect(page.getByRole('button', { name: /^Blocked/ })).toHaveAttribute(
      'title',
      'Agent query: is:blocked',
    );
    // A Review card with a ready packet opens the packet screen.
    const review = board.getByRole('region', { name: 'Review' });
    const rcp12 = review.locator('[data-item="RCP-12"]');
    await expect(rcp12).toHaveAttribute('title', 'Open the handoff packet');
    await rcp12.click();
    await expect(page).toHaveURL(/\/review\/RCP-12$/);
  });

  test('the Epics row opens an epic; a filter chip narrows the board', async ({ page }) => {
    await page.goto('/work');
    const epics = page.locator('[data-card="epics"]');
    await expect(epics.getByRole('heading', { name: 'Epics · 3' })).toBeVisible();
    await page.getByRole('button', { name: /^For you/ }).click();
    await expect(page).toHaveURL(/filter=for_you/);
    await expect(page.locator('.tcard')).toHaveCount(3);
    await epics.getByRole('link', { name: /Meal planning MVP/ }).click();
    await expect(page).toHaveURL(/\/items\/RCP-1$/);
    await expect(h1(page)).toHaveText('Meal planning MVP');
  });

  test('List: one row per item with status, lead · run, human review and last activity', async ({
    page,
  }) => {
    await page.goto('/work?layout=list');
    const list = page.locator('[data-layout="list"]');
    const row = list
      .getByRole('row')
      .filter({ has: page.getByRole('link', { name: 'RCP-14', exact: true }) });
    await expect(row).toContainText('In progress');
    await expect(row).toContainText('claude · orca-w3');
    await expect(row).toContainText('live');
    await row.getByRole('cell').nth(1).click();
    await expect(page).toHaveURL(/\/items\/RCP-14$/);
  });
});

test.describe('the item page', () => {
  test('four tabs with counts and dots, and the read views', async ({ page }) => {
    await page.goto('/items/RCP-14');
    const views = page.getByRole('tablist', { name: 'Ticket views' });
    await expect(views.getByRole('tab')).toHaveCount(4);
    await expect(views.getByRole('tab', { name: /^Details/ })).toHaveText('Details');
    await expect(views.getByRole('tab', { name: /^Checklist/ })).toHaveText(/^Checklist\d+\/\d+/);
    await expect(views.getByRole('tab', { name: /^Dependencies/ })).toHaveText(/^Dependencies4/);
    await expect(views.getByRole('tab', { name: /^Activity/ })).toBeVisible();
    await expect(page.getByRole('tabpanel')).toContainText('Outcome');
    await expect(page.getByRole('tabpanel')).toContainText('Units are metric internally');

    await views.getByRole('tab', { name: /^Checklist/ }).click();
    const panel = page.getByRole('tabpanel');
    await expect(panel).toContainText('Work');
    await expect(panel).toContainText('Changed: Reminders API not reachable from the container');
    await expect(panel.locator('[data-provenance]').first()).toBeVisible();
    await panel.getByRole('button', { name: 'Checklist history' }).click();
    await expect(page.getByRole('dialog', { name: 'Checklist history · RCP-14' })).toContainText(
      'v3',
    );
    await page.keyboard.press('Escape');

    await views.getByRole('tab', { name: /^Activity/ }).click();
    await expect(panel).toContainText('claude · orca-w3');
    await expect(panel).toContainText(/\d+ updates?/);

    // Attention dots carry text: a stale run, a packet ready, a dependency cycle.
    await page.goto('/items/RCP-15');
    await expect(views.getByRole('tab', { name: /^Activity/ })).toContainText('(stale run)');
    await page.goto('/items/RCP-12');
    await expect(views.getByRole('tab', { name: /^Checklist/ })).toContainText('(packet ready)');
    await expect(page.locator('[data-banner="packet"]')).toContainText('round 2');
    await page.goto('/items/DOC-7');
    await expect(views.getByRole('tab', { name: /^Dependencies/ })).toContainText(
      '(in a dependency cycle)',
    );
    await page.goto('/items/DOC-4');
    await expect(page.locator('[data-banner="question"]')).toContainText('per serving');
  });

  test('an epic shows its tickets and its Map count', async ({ page }) => {
    await page.goto('/items/RCP-1');
    const views = page.getByRole('tablist', { name: 'Epic views' });
    await expect(views.getByRole('tab', { name: /^Map/ })).toContainText(/\d+\/12/);
    await expect(page.getByRole('tabpanel')).toContainText('Tickets in this epic');
  });
});

test.describe('Agents and the palette', () => {
  test('Agents: needs input, stale, failed, live, reported first, with lease and how we know', async ({
    page,
  }) => {
    await page.goto('/agents');
    const rows = page.locator('[data-card="runs"] tbody tr');
    await expect(rows.nth(0)).toContainText('needs input');
    await expect(rows.nth(0)).toContainText('Paused');
    await expect(rows.nth(1)).toContainText('stale');
    await expect(rows.nth(1)).toContainText('Unknown: no heartbeat');
    await expect(rows.nth(1)).toContainText(/Expires \d\d:\d\d/);
    await expect(rows.nth(2)).toContainText('failed');
    await expect(rows.nth(3)).toContainText('live');
    await expect(rows.nth(3)).toContainText('Client heartbeat');
    await expect(rows.nth(3)).toContainText(/Until \d\d:\d\d/);
    await expect(rows.nth(4)).toContainText('reported');
    await expect(rows.nth(4)).toContainText('Agent-reported');
    await expect(page.locator('[data-card="runs"]')).toContainText('log entry');
    await rows.nth(3).getByRole('cell').nth(3).click();
    await expect(page).toHaveURL(/\/items\/RCP-14$/);
  });

  test('palette search finds items by ID and title, labels and views', async ({ page }) => {
    await page.goto('/');
    await page.keyboard.press('Control+k');
    const box = page.getByRole('combobox', { name: 'Search' });
    await expect(box).toBeFocused();
    await page.keyboard.type('pantry');
    await expect(box).toHaveValue('pantry');
    const results = page.getByRole('listbox', { name: 'Results' });
    await expect(results.getByRole('group', { name: 'Work items' })).toContainText('RCP-15');
    await box.fill('mobile');
    await expect(results.getByRole('option', { name: '# mobile' })).toBeVisible();
    await box.fill('DOC-7');
    await results.getByRole('option', { name: /DOC-7/ }).first().click();
    await expect(page).toHaveURL(/\/items\/DOC-7$/);
  });
});

test.describe('live updates', () => {
  test('an agent claims, plans and works while the item page and Agents update in place, and focus stays put', async ({
    page,
    browser,
  }) => {
    await page.goto('/items/RCP-17?tab=activity');
    await expect(page.getByRole('tabpanel')).toContainText('unclaimed');
    const note = page.getByLabel('Note for the agent');
    await note.click();
    await page.keyboard.type('Check the week boundary');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    const caret = await note.evaluate((el: HTMLTextAreaElement) => el.selectionStart);
    const scrollBefore = await page.evaluate(() => window.scrollY);

    // A second tab on Agents.
    const other = await page.context().newPage();
    await other.goto('/agents');
    await expect(other.locator('[data-card="runs"] tbody tr').first()).toBeVisible();

    const agent = await connectAgent('claude');
    try {
      const claim = await agent.call('claim_lead', { id: 'RCP-17', agent_label: 'e2e-w1' });
      expect(claim.isError, claim.text).toBe(false);
      const plan = await agent.call('set_plan', {
        id: 'RCP-17',
        steps: [{ text: 'Reproduce the jump on reload' }, { text: 'Persist the viewed week' }],
      });
      expect(plan.isError, plan.text).toBe(false);
      const steps = (plan.structured.work as { id: string }[]).map((s) => s.id);
      const step = await agent.call('update_step', {
        id: 'RCP-17',
        step_id: steps[0],
        state: 'current',
      });
      expect(step.isError, step.text).toBe(false);

      // The page updates without a reload…
      const panel = page.getByRole('tabpanel');
      await expect(panel).toContainText('claude · e2e-w1');
      await expect(panel).toContainText('live');
      await expect(page.getByRole('tablist', { name: 'Ticket views' })).toContainText('0/2');
      // …and the owner's focus, text and caret are where they were.
      await expect(note).toBeFocused();
      await expect(note).toHaveValue('Check the week boundary');
      expect(await note.evaluate((el: HTMLTextAreaElement) => el.selectionStart)).toBe(caret);
      expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore);

      // Agents shows the new run, live, doing the current step.
      const row = other.locator('[data-card="runs"] tbody tr').filter({ hasText: 'RCP-17' });
      await expect(row).toContainText('claude · e2e-w1');
      await expect(row).toContainText('live');
      await expect(row).toContainText('Reproduce the jump on reload');
    } finally {
      await agent.close();
      await other.close();
    }
    void browser;
  });
});

test.describe('performance (SC-013)', () => {
  for (const [label, path, ready] of [
    ['Needs you', '/', 'For you now · '],
    ['Work board', '/work', 'Epics · '],
    ['Work list', '/work?layout=list', 'Epics · '],
    ['Item page', '/items/RCP-14', 'Outcome'],
    ['Agents', '/agents', 'How we know'],
  ] as const) {
    test(`${label} renders in under 1 s on the seed`, async ({ page }) => {
      await page.goto('/agents'); // warm the app shell and the session
      const started = Date.now();
      await page.goto(path);
      await expect(page.locator('main')).toContainText(ready);
      const took = Date.now() - started;
      console.log(`render ${label}: ${took} ms`);
      expect(took).toBeLessThan(1000);
    });
  }
});

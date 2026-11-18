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
import type { SearchResponse } from '@docket/shared';
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

    // The Agents strip counts runs by state, in words; each count links to Agents → that state.
    const strip = card(page, 'agents-strip');
    for (const s of ['live', 'reported', 'needs input', 'stale', 'failed']) {
      await expect(strip).toContainText(s);
    }
    for (const s of ['live', 'reported', 'needs_input', 'stale', 'failed']) {
      await expect(strip.locator(`a[data-state="${s}"]`)).toHaveAttribute(
        'href',
        `/agents?state=${s}`,
      );
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
    // Key fact first, whole facts on up to two lines (B20).
    await expect(stale).toContainText('Lead silent for');
    await expect(stale).toContainText('treated as unknown, not finished');
    await expect(stale.locator('.reason')).toHaveAttribute('title', /^Lead silent for \d+m · /);
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
    await expect(page).toHaveTitle('(3) Docket');
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
    // Each ticket carries the coordination state its Board card shows (B20).
    const ticket = (id: string) => page.locator(`[data-ticket="${id}"]`);
    await expect(ticket('RCP-14').locator('.runline')).toContainText('live');
    await expect(ticket('RCP-14').locator('.runline')).toContainText('claude · orca-w3');
    await expect(ticket('RCP-16')).toContainText('Blocked by');
    await expect(ticket('RCP-12')).toContainText('For you');
    await expect(ticket('RCP-29').locator('.runline')).toHaveCount(0);
  });

  test('the agent bar on every tab: a live lead, a stale lead, no lead (B20)', async ({ page }) => {
    const bar = page.getByRole('region', { name: 'Lead agent' });
    // A live lead: its run line, last signal and worktree, on Details and on Checklist.
    await page.goto('/items/RCP-14?tab=details');
    await expect(bar).toHaveAttribute('data-agent-bar', 'live');
    await expect(bar.locator('.runline')).toContainText('live');
    await expect(bar.locator('.runline')).toContainText('claude · orca-w3');
    await expect(bar).toContainText(/last signal \d+[smh] ago/);
    // No recovery actions: the only button is the Help "?" (B22).
    await expect(bar.getByRole('button')).toHaveCount(1);
    await expect(bar.getByRole('button')).toHaveAccessibleName(
      'Help: Run states: live, parked, stale and more',
    );
    await page
      .getByRole('tablist', { name: 'Ticket views' })
      .getByRole('tab', { name: /^Checklist/ })
      .click();
    await expect(bar).toHaveAttribute('data-agent-bar', 'live');

    // A stale lead: the same Release and resume-note actions as Lead and runs.
    await page.goto('/items/RCP-15?tab=deps');
    await expect(bar).toHaveAttribute('data-agent-bar', 'stale');
    await expect(bar.getByRole('button', { name: 'Release lead claim…' })).toBeVisible();
    await expect(bar.getByRole('button', { name: 'Copy resume note' })).toBeVisible();

    // No lead: a quiet line while In progress (RCP-18's run failed), nothing in Ready.
    await page.goto('/items/RCP-18');
    await expect(bar).toHaveText('No agent on this');
    await page.goto('/items/RCP-16');
    await expect(page.getByRole('tabpanel')).toBeVisible();
    await expect(bar).toHaveCount(0);
  });
});

test.describe('Agents and the palette', () => {
  test('Agents: Active now (needs input, failed, stale, live, reported), Workspaces, then Recent collapsed', async ({
    page,
  }) => {
    await page.goto('/agents');
    const active = page.locator('[data-section="agents-active"]');
    const rows = active.locator('tbody tr');
    await expect(rows.first()).toBeVisible();
    const sections = await page
      .locator('.agents section[data-section]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-section')));
    expect(sections).toEqual(['agents-active', 'agents-workspaces', 'agents-recent']);
    expect(await rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-state')))).toEqual([
      'needs_input',
      'failed',
      'stale',
      'live',
      'reported',
    ]);
    await expect(rows.nth(0)).toContainText('Paused');
    await expect(rows.nth(2)).toContainText('Unknown: no heartbeat');
    await expect(rows.nth(2)).toContainText(/Expires \d\d:\d\d/);
    const rcp14 = rows.filter({ hasText: 'RCP-14' });
    await expect(rcp14).toContainText('Client heartbeat');
    await expect(rcp14).toContainText(/Until \d\d:\d\d/);
    await expect(rows.nth(4)).toContainText('Agent-reported');
    // Subagent log entries live on their item's Checklist, not here.
    await expect(page.locator('main')).not.toContainText('log entry');
    await expect(page.locator('main')).not.toContainText('Subagent log');
    // Recent starts collapsed, and remembers that it was opened.
    const recent = page.getByRole('button', { name: /^Recent/ });
    await expect(recent).toHaveAttribute('aria-expanded', 'false');
    await recent.click();
    await expect(page.getByRole('table', { name: 'Recent runs' })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('button', { name: /^Recent/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await rcp14.getByRole('cell').nth(3).click();
    await expect(page).toHaveURL(/\/items\/RCP-14$/);
  });

  test('a Needs you strip count opens Agents filtered to that state; Show all clears it', async ({
    page,
  }) => {
    await page.goto('/');
    await card(page, 'agents-strip').locator('a[data-state="stale"]').click();
    await expect(page).toHaveURL(/\/agents\?state=stale$/);
    const active = page.locator('[data-section="agents-active"]');
    await expect(active.getByRole('button', { name: /^Active now/ })).toContainText('1 stale');
    await expect(active.locator('tbody tr')).toHaveCount(1);
    await expect(active.locator('tbody tr')).toContainText('RCP-15');
    await active.getByRole('link', { name: 'Show all' }).click();
    await expect(page).toHaveURL(/\/agents$/);
    await expect(active.locator('tbody tr')).toHaveCount(5);
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

  test('archived items show an "Archived" tag in the palette', async ({ page }) => {
    // Archiving is US7's, and the seed has no archived item, so mark DOC-2 archived in the
    // real search answer; us2-api.test.ts checks the server sets the flag from archived_at.
    await page.route(/\/api\/search\?/, async (route) => {
      const res = await route.fetch();
      const body = (await res.json()) as SearchResponse;
      await route.fulfill({
        response: res,
        json: {
          ...body,
          items: body.items.map((i) => (i.id === 'DOC-2' ? { ...i, archived: true } : i)),
        },
      });
    });
    await page.goto('/');
    await page.keyboard.press('Control+k');
    const box = page.getByRole('combobox', { name: 'Search' });
    await expect(box).toBeFocused();
    await page.keyboard.type('docs site skeleton');
    const option = page.getByRole('option', { name: /DOC-2/ });
    await expect(option).toContainText('Archived');
    await box.fill('pantry');
    await expect(page.getByRole('option', { name: /RCP-15/ })).not.toContainText('Archived');
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
    await expect(other.locator('[data-section="agents-active"] tbody tr').first()).toBeVisible();

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
      // The agent bar appears above the tabs, live, without taking focus (B20).
      const bar = page.getByRole('region', { name: 'Lead agent' });
      await expect(bar).toHaveAttribute('data-agent-bar', 'live');
      await expect(bar).toContainText('claude · e2e-w1');
      await expect(bar.locator('[data-ab="step"]')).toHaveText('step 1/2');
      // …and the owner's focus, text and caret are where they were.
      await expect(note).toBeFocused();
      await expect(note).toHaveValue('Check the week boundary');
      expect(await note.evaluate((el: HTMLTextAreaElement) => el.selectionStart)).toBe(caret);
      expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore);

      // Agents shows the new run, live, doing the current step.
      const row = other
        .locator('[data-section="agents-active"] tbody tr')
        .filter({ hasText: 'RCP-17' });
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

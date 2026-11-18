/**
 * The packet screen end to end (tasks.md T090; spec US3; SC-006; UI_SPEC
 * §6.4, §6.3.1, §11).
 *
 * Agents hand off real packets through MCP (the official SDK client); the
 * owner decides in the browser against the seeded container:
 * - SC-006: deciding a two-item packet takes at most 4 clicks beyond the
 *   verification itself (the test counts them);
 * - the disabled submit, the note required for changes, the outcome-named
 *   button, Undo, the queue advancing;
 * - the round selector and past-round styling, attachments, out of date
 *   with *Ask for a fresh packet*, the 1024 px layout;
 * - the Checklist tab's human review section;
 * - axe on the packet screen and the Checklist tab, both themes.
 *
 * Set DOCKET_E2E_SCREENSHOTS to a folder to also capture the PR's light
 * and dark screenshots.
 */
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import {
  connectAgent,
  expect,
  expectAxeClean,
  setTheme,
  test,
  unlock,
  useSeededContainer,
} from './fixtures/index';
import type { McpAgent } from './fixtures/mcp';

useSeededContainer();

const out = process.env.DOCKET_E2E_SCREENSHOTS;

async function shoot(page: Page, name: string) {
  if (!out) return;
  for (const theme of ['light', 'dark'] as const) {
    await setTheme(page, theme);
    await page.screenshot({ path: join(out, `us3-${name}-${theme}.png`), fullPage: true });
  }
  await setTheme(page, 'light');
}

const TWO = [
  'On your phone, drag recipes between days and meal slots. Does it feel right?',
  'Move a recipe using only the keyboard (Space, arrows, Enter).',
];

/** An agent claims `id`, declares `items` and hands off round 1 (MCP_SPEC §7.3). */
async function handOff(agent: McpAgent, id: string, items: string[], sha = '7d21aa3') {
  const claim = await agent.call('claim_lead', { id, agent_label: 'e2e-w1' });
  expect(claim.isError, claim.text).toBe(false);
  const run_id = claim.structured.run_id as string;
  const declared = await agent.call('declare_human_review', { id, run_id, items });
  expect(declared.isError, declared.text).toBe(false);
  const packet = await agent.call('submit_packet', {
    id,
    run_id,
    built_from_commit: sha,
    estimate: '5 min',
    how: ['Open the preview build at http://127.0.0.1:5173.', 'Drag three recipes on your phone.'],
    checked: [
      { text: '214 unit and integration tests pass', provenance: 'ci', evidence: 'CI #88' },
    ],
    gaps: ['Not tested on Android.'],
  });
  expect(packet.isError, packet.text).toBe(false);
  return { run_id, round: packet.structured.round as number };
}

const radio = (page: Page, n: number, name: string) =>
  page.getByRole('radiogroup', { name: `Decision for item ${n}` }).getByRole('radio', { name });
const submitButton = (page: Page) => page.locator('[data-action="submit-decision"]');

async function itemStatus(page: Page, id: string): Promise<string> {
  const res = await page.request.get(`/api/items/${id}`);
  expect(res.ok()).toBe(true);
  return ((await res.json()) as { item: { status: string } }).item.status;
}

test.describe('the packet screen', () => {
  let codex: McpAgent;
  test.beforeAll(async () => {
    codex = await connectAgent('codex');
  });
  test.afterAll(async () => {
    await codex.close();
  });
  test.beforeEach(async ({ page }) => {
    await unlock(page.context());
    await page.context().addInitScript(() => localStorage.setItem('docket.notifications', 'off'));
  });

  test('SC-006: approving a two-item packet takes 3 clicks; the button names the outcome; the queue advances', async ({
    page,
  }) => {
    await handOff(codex, 'RCP-17', TWO);
    await page.goto('/review/RCP-17');
    await expect(page.getByRole('heading', { name: 'Your decision · round 1' })).toBeVisible();
    await expect(page.locator('.vers')).toContainText('codex · e2e-w1');
    await expect(page.locator('.vers')).toContainText('built from 7d21aa3');
    // Disabled until every item is decided, with a label that says why.
    await expect(submitButton(page)).toBeDisabled();
    await expect(submitButton(page)).toHaveText('Decide every item first');
    await expect(page.getByText('0 of 2 items decided')).toBeVisible();
    await shoot(page, 'packet-open');

    let clicks = 0;
    const click = async (l: Locator) => {
      clicks += 1;
      await l.click();
    };
    // The verification itself happens off screen; then the decision.
    await click(radio(page, 1, 'Looks good'));
    await expect(submitButton(page)).toBeDisabled();
    await expect(page.getByText('1 of 2 items decided')).toBeVisible();
    await click(radio(page, 2, 'Looks good'));
    await expect(submitButton(page)).toHaveText('Approve and close ticket');
    await expect(page.locator('.decide-callout').first()).toContainText(
      'Approving records your decision on pkt-',
    );
    await click(submitButton(page));
    expect(clicks).toBeLessThanOrEqual(4);
    console.log(`SC-006: ${clicks} clicks to decide a two-item packet (limit 4)`);

    await expect(page.getByRole('status')).toContainText('RCP-17 closed.');
    expect(await itemStatus(page, 'RCP-17')).toBe('done');
    // The queue advances to the next packet waiting on you.
    await expect(page).toHaveURL(/\/review\/RCP-(19|12)$/);
  });

  test('Needs changes requires a note; the button says who it goes back to; Undo restores everything', async ({
    page,
  }) => {
    // RCP-25 already has one declared item (the seed); the agent adds a second.
    await handOff(codex, 'RCP-25', [TWO[1]!]);
    await page.goto('/review/RCP-25');
    await radio(page, 1, 'Needs changes').click();
    await expect(page.getByLabel(/What needs to change/)).toBeVisible();
    await radio(page, 2, 'Defer').click();
    await expect(page.getByText('Deferring clears the gate so work can continue.')).toBeVisible();
    await expect(submitButton(page)).toHaveText('Send back to codex');
    await expect(page.locator('.decide-callout').first()).toContainText(
      'goes back to In progress and you’ll get a round 2 packet. Deferred items stay deferred.',
    );
    await shoot(page, 'packet-deciding');

    // Without a note it is refused: the field says so and takes focus; nothing is sent.
    await submitButton(page).click();
    const note = page.getByLabel(/What needs to change/);
    await expect(note).toBeFocused();
    await expect(page.getByText('Say what needs to change so the agent can fix it.')).toBeVisible();
    expect(await itemStatus(page, 'RCP-25')).toBe('review');

    await note.fill('The pantry list scrolls behind the header on my phone.');
    await page
      .getByRole('group', { name: 'Turn finding 1 into' })
      .getByRole('button', { name: 'New bug ticket' })
      .click();
    await submitButton(page).click();
    const toast = page.getByRole('status');
    await expect(toast).toContainText('Sent RCP-25 back to codex; created RCP-');
    expect(await itemStatus(page, 'RCP-25')).toBe('progress');

    await toast.getByRole('button', { name: 'Undo' }).click();
    await expect(toast).toContainText('Undone.');
    expect(await itemStatus(page, 'RCP-25')).toBe('review');
    await page.goto('/review/RCP-25');
    await expect(page.getByRole('heading', { name: 'Your decision · round 1' })).toBeVisible();
    await expect(page.getByText('0 of 2 items decided')).toBeVisible();
  });

  test('Defer with a follow-up closes the ticket as not verified; the decided round reads as past', async ({
    page,
  }) => {
    await handOff(codex, 'DOC-5', ['Search for “install” and check the first hit.', TWO[0]!]);
    await page.goto('/review/DOC-5');
    await radio(page, 1, 'Looks good').click();
    await radio(page, 2, 'Defer').click();
    await expect(submitButton(page)).toHaveText('Close ticket (1 deferred)');
    await submitButton(page).click();
    await expect(page.getByRole('status')).toContainText('DOC-5 closed with 1 deferred.');
    await page.goto('/review/DOC-5');
    // Decided: shown as past, each decision in its own owner-decision style.
    await expect(page.getByRole('heading', { name: 'Viewing' })).toBeVisible();
    await expect(
      page.locator('[data-decision="approve"] [data-provenance="owner_approve"]'),
    ).toHaveText(/Looked good/);
    await expect(
      page.locator('[data-decision="defer"] [data-provenance="owner_defer"]'),
    ).toHaveText(/Deferred · not verified/);
    await expect(page.locator('[data-decision="defer"]')).toContainText('→ test ticket DOC-');
    await expect(page.getByRole('heading', { name: 'Round 1' })).toBeVisible();
    await shoot(page, 'packet-decided');
  });

  test('round selector: an earlier round is read-only, says so, and keeps its decisions', async ({
    page,
  }) => {
    await page.goto('/review/RCP-12');
    const rounds = page.getByRole('group', { name: 'Rounds' });
    await expect(rounds.getByRole('link', { name: /Round 1/ })).toContainText('sent back');
    await expect(rounds.getByRole('link', { name: /Round 2/ })).toHaveAttribute(
      'aria-current',
      'true',
    );
    await rounds.getByRole('link', { name: /Round 1/ }).click();
    await expect(page).toHaveURL(/\/review\/RCP-12\?round=1$/);
    await expect(
      page.getByText('Earlier round. Its decisions are shown below and don’t carry over.'),
    ).toBeVisible();
    await expect(page.getByRole('radiogroup')).toHaveCount(0);
    const changes = page.locator('[data-decision="changes"]');
    await expect(changes).toHaveCount(2);
    await expect(changes.first().locator('[data-provenance="owner_changes"]')).toHaveText(
      /Needed changes/,
    );
    await expect(changes.first()).toContainText('→ checklist item');
    await expect(changes.nth(1)).toContainText('→ bug RCP-17');
    await shoot(page, 'packet-past-round');
    await expectAxeClean(page, 'packet screen, past round');
  });

  test('attachments open in the document viewer', async ({ page }) => {
    await page.goto('/review/RCP-12');
    const attachments = page.locator('.attachments');
    await expect(attachments.getByRole('button')).toHaveCount(3);
    await attachments.getByRole('button', { name: /drag-phone\.mp4/ }).click();
    const dialog = page.getByRole('dialog', { name: 'drag-phone.mp4' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Screen recording · 24 s');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  });

  test('out of date: Ask for a fresh packet returns the ticket to In progress', async ({
    page,
  }) => {
    await page.goto('/review/RCP-19');
    const callout = page.locator('.pkt-callout').filter({ hasText: 'Out of date.' });
    await expect(callout).toContainText('built from b41d2e0');
    await callout.getByRole('button', { name: 'Ask for a fresh packet' }).click();
    await expect(page.getByRole('status')).toContainText(
      'Asked claude for a fresh packet. RCP-19 is back in progress until it arrives.',
    );
    expect(await itemStatus(page, 'RCP-19')).toBe('progress');
    await expect(page.getByText('Withdrawn: you asked for a fresh packet.')).toBeVisible();
  });

  test('the verdicts are a keyboard radio group', async ({ page }) => {
    await page.goto('/review/RCP-12');
    const first = radio(page, 1, 'Looks good');
    await first.focus();
    await page.keyboard.press('ArrowRight');
    await expect(radio(page, 1, 'Needs changes')).toBeFocused();
    await expect(radio(page, 1, 'Needs changes')).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByText('1 of 2 items decided')).toBeVisible();
    await expectAxeClean(page, 'packet screen, deciding');
  });

  test('at 1024 px the decision panel moves under the queue, with no horizontal scroll', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1024, height: 800 });
    await page.goto('/review/RCP-12');
    await expect(page.getByRole('heading', { name: 'Your decision · round 2' })).toBeVisible();
    const box = async (col: string) =>
      (await page.locator(`[data-column="${col}"]`).boundingBox())!;
    const [queue, packet, decision] = [
      await box('queue'),
      await box('packet'),
      await box('decision'),
    ];
    expect(decision.x).toBeCloseTo(queue.x, 0);
    expect(decision.y).toBeGreaterThan(queue.y + queue.height - 1);
    expect(packet.x).toBeGreaterThan(queue.x + queue.width);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await shoot(page, 'packet-1024');
  });

  test('axe: the live packet screen is clean in both themes', async ({ page }) => {
    await page.goto('/review/RCP-12');
    await expect(page.getByRole('heading', { name: 'Your decision · round 2' })).toBeVisible();
    await expectAxeClean(page, 'packet screen');
  });
});

test.describe('the Checklist tab: human review', () => {
  test.beforeEach(async ({ page }) => {
    await unlock(page.context());
    await page.context().addInitScript(() => localStorage.setItem('docket.notifications', 'off'));
  });

  test('items in a packet are locked; Open packet goes to the packet', async ({ page }) => {
    await page.goto('/items/RCP-12?tab=checklist');
    const section = page.locator('[data-hr]');
    await expect(section).toHaveCount(2);
    await expect(section.first()).toContainText('In the current packet');
    await expect(section.first().getByRole('button', { name: /^Edit/ })).toHaveCount(0);
    await shoot(page, 'checklist-human-review');
    await expectAxeClean(page, 'checklist tab (packet open)');
    await page.getByRole('link', { name: 'Open packet' }).first().click();
    await expect(page).toHaveURL(/\/review\/RCP-12/);
  });

  test('the owner adds, edits and removes an item; agents see it', async ({ page }) => {
    await page.goto('/items/RCP-14?tab=checklist');
    await expect(page.locator('[data-hr]')).toHaveCount(1);
    await expectAxeClean(page, 'checklist tab (declared items)');
    await page.getByLabel('New human review item').fill('Try the export on your phone');
    await page.keyboard.press('Enter');
    const row = page.locator('[data-hr]').filter({ hasText: 'Try the export on your phone' });
    await expect(row).toContainText('added by you');
    await expect(row).toContainText('Coming up');
    await row.getByRole('button', { name: /^Edit/ }).click();
    const field = page.getByLabel('Edit human review item');
    await expect(field).toBeFocused();
    await field.fill('Try the export on your phone and in your notes app');
    await page.getByRole('button', { name: 'Save' }).click();
    const edited = page.locator('[data-hr]').filter({ hasText: 'and in your notes app' });
    await expect(edited).toBeVisible();

    const agent = await connectAgent('claude');
    const item = await agent.call('get_item', { id: 'RCP-14', fields: ['checklist'] });
    expect(item.text).toContain('Try the export on your phone and in your notes app · by owner');
    await agent.close();

    await edited.getByRole('button', { name: /^Remove/ }).click();
    await expect(page.getByRole('status')).toContainText('Removed from human review.');
    await expect(edited).toHaveCount(0);
  });
});

test.describe('Needs you', () => {
  test('a packet is for you, and Create test ticket follows up a deferred check', async ({
    page,
  }) => {
    await unlock(page.context());
    await page.context().addInitScript(() => localStorage.setItem('docket.notifications', 'off'));
    await page.goto('/');
    await expect(page.getByRole('heading', { name: /^For you now/ })).toBeVisible();
    await shoot(page, 'needs-you');
    const deferred = page.locator('[data-card="deferred"]');
    const create = deferred.getByRole('button', { name: 'Create test ticket' }).first();
    await expect(create).toBeVisible();
    await create.click();
    await expect(page.getByRole('status')).toContainText(
      /Created test ticket [A-Z]+-\d+ in Inbox\./,
    );
  });
});

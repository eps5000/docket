/**
 * Approve with notes end to end (owner decision 35; tasks.md T181; spec US3
 * scenario 8; UI_SPEC §6.4).
 *
 * - *Looks good* reveals "Notes for later (optional)"; a note reveals
 *   "Keep it for", all by keyboard, and axe is clean in both themes;
 * - kept for the epic: the past round shows the note, the item's Activity
 *   links the decision, the epic lists it with its "From your review"
 *   rationale, and `get_context` on another ticket in the epic carries it;
 * - without an epic, *The epic's future tickets* is disabled and says why.
 *
 * Set DOCKET_E2E_SCREENSHOTS to a folder to also capture the PR's light and
 * dark screenshots.
 */
import { join } from 'node:path';
import type { Page } from '@playwright/test';
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
    await page.screenshot({ path: join(out, `b37-${name}-${theme}.png`), fullPage: true });
  }
  await setTheme(page, 'light');
}

const FINDING = 'Reload the planner on week 3. Does it stay on week 3?';
const NOTE = 'Fine here, but next time put the fixture in tests/fixtures/';

/** An agent claims `id`, declares one item and hands off round 1. */
async function handOff(agent: McpAgent, id: string) {
  const claim = await agent.call('claim_lead', { id, agent_label: 'e2e-b37' });
  expect(claim.isError, claim.text).toBe(false);
  const run_id = claim.structured.run_id as string;
  const declared = await agent.call('declare_human_review', { id, run_id, items: [FINDING] });
  expect(declared.isError, declared.text).toBe(false);
  const packet = await agent.call('submit_packet', {
    id,
    run_id,
    built_from_commit: '7d21aa3',
    estimate: '2 min',
    how: ['Open the planner, go to week 3 and reload.'],
    checked: [{ text: 'Unit tests pass', provenance: 'ci', evidence: 'CI #91' }],
  });
  expect(packet.isError, packet.text).toBe(false);
}

const looksGood = (page: Page) =>
  page.getByRole('radiogroup', { name: 'Decision for item 1' }).getByRole('radio', {
    name: 'Looks good',
  });
const keepFor = (page: Page) => page.getByRole('group', { name: 'Keep the note on item 1 for' });

test.describe('approve with notes', () => {
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

  test('a note kept for the epic: by keyboard, axe clean, shown in the round, and in get_context on the epic’s other tickets', async ({
    page,
  }) => {
    await handOff(codex, 'RCP-17');
    await page.goto('/review/RCP-17');
    await expect(page.getByRole('heading', { name: 'Your decision · round 1' })).toBeVisible();
    // No note box until Looks good.
    await expect(page.getByLabel('Notes for later (optional)')).toHaveCount(0);

    // Keyboard only: Space picks Looks good, Tab reaches the note, then Keep it for.
    await looksGood(page).focus();
    await page.keyboard.press('Space');
    await expect(looksGood(page)).toHaveAttribute('aria-checked', 'true');
    const note = page.getByLabel('Notes for later (optional)');
    await expect(note).toHaveAttribute(
      'placeholder',
      'e.g. Fine here, but next time put the fixture in tests/fixtures/',
    );
    await expect(keepFor(page)).toHaveCount(0);
    await page.keyboard.press('Tab');
    await expect(note).toBeFocused();
    await page.keyboard.type(NOTE);
    const options = keepFor(page).getByRole('button');
    await expect(options).toHaveText([
      'This ticket',
      'The epic’s future tickets',
      'All Recipe App work',
    ]);
    await expect(keepFor(page).getByRole('button', { name: 'This ticket' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    const epic = keepFor(page).getByRole('button', { name: 'The epic’s future tickets' });
    await expect(epic).toBeFocused();
    await page.keyboard.press('Space');
    await expect(epic).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-keep-hint="epic"]')).toContainText(
      'Also saved as an owner decision on RCP-1',
    );
    await expectAxeClean(page, 'packet screen, approve with a note');
    await shoot(page, 'keep-it-for');

    const submit = page.locator('[data-action="submit-decision"]');
    await expect(submit).toHaveText('Approve and close ticket');
    await submit.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('status')).toContainText('RCP-17 closed.');

    // The past round shows the note and where it went.
    await page.goto('/review/RCP-17');
    const past = page.locator('[data-hr][data-decision="approve"]');
    await expect(past.locator('[data-note]')).toHaveText(`Note for later: “${NOTE}”`);
    await expect(past.locator('[data-decision-link]')).toHaveText(
      '→ decision for the epic’s future tickets',
    );
    await expectAxeClean(page, 'packet screen, past round with a note', { themes: ['light'] });
    await shoot(page, 'past-round-note');

    // The item's Activity: the note, and a link to the decision.
    await page.goto('/items/RCP-17?tab=activity');
    await expect(page.getByText(`You approved with a note: ${NOTE}`)).toBeVisible();
    await expect(page.getByRole('link', { name: 'See the decision' })).toBeVisible();

    // The epic lists the decision, with the review as its rationale.
    await page.goto('/items/RCP-1?tab=details');
    const row = page.locator('.decrow', { hasText: NOTE }).first();
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: /^(Why|Show reasoning)$/ }).click();
    await expect(row).toContainText(`From your review of RCP-17, round 1: ${FINDING}`);
    await shoot(page, 'epic-decision');

    // Agents on the epic's other tickets get it; one outside the epic doesn't.
    const ctx = await codex.call('get_context', { id: 'RCP-22' });
    expect(ctx.isError, ctx.text).toBe(false);
    console.log(`> get_context {"id":"RCP-22"}\n${ctx.text}`);
    const decisions = (ctx.structured.context as { decisions: { title: string }[] }).decisions;
    expect(decisions.map((x) => x.title)).toContain(NOTE);
    const outside = await codex.call('get_context', { id: 'DOC-9' });
    expect(
      (outside.structured.context as { decisions: { title: string }[] }).decisions.map(
        (x) => x.title,
      ),
    ).not.toContain(NOTE);
  });

  test('without an epic, the epic choice is disabled and says why', async ({ page }) => {
    await handOff(codex, 'DOC-5');
    await page.goto('/review/DOC-5');
    await looksGood(page).click();
    await page.getByLabel('Notes for later (optional)').fill('Index titles first next time.');
    const epic = keepFor(page).getByRole('button', { name: 'The epic’s future tickets' });
    await expect(epic).toBeDisabled();
    await expect(
      page.getByText('DOC-5 has no epic, so the note can’t go to an epic’s tickets.'),
    ).toBeVisible();
    await expect(keepFor(page).getByRole('button', { name: 'All Docs Site work' })).toBeVisible();
    await expectAxeClean(page, 'packet screen, approve with a note, no epic', {
      themes: ['light'],
    });
  });
});

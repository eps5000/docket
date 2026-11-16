/**
 * Decisions end to end (tasks.md T113; spec US5; UI_SPEC §6.3.5, §6.5, §6.7;
 * BUILD_SPEC §10 "Decisions").
 *
 * - A ticket's Details lists every record in scope with its scope chip
 *   (Project, ◆ epic, #label, This item); an agent record can be confirmed
 *   and becomes "Owner"; Withdraw… takes an optional reason inline, hides
 *   the record (it stays in Activity and under *Show withdrawn and
 *   superseded*) and Undo brings it back; the Record form validates and
 *   records an owner decision.
 * - An epic's Details lists its own records; recording one on the epic shows
 *   it on its child tickets; Supersede opens the form prefilled and marks the
 *   old record superseded.
 * - The label page lists the label's records; Settings → "n decisions" opens
 *   the project-wide section in a dialog.
 * - Agent decisions never appear in Needs you.
 * - axe on every Decisions section, both themes.
 *
 * Set TASKLITE_E2E_SCREENSHOTS to a folder to also capture the PR's light
 * and dark screenshots.
 */
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { expect, expectAxeClean, setTheme, test, useSeededContainer } from './fixtures/index';
import type { McpAgent } from './fixtures/mcp';

useSeededContainer();

const out = process.env.TASKLITE_E2E_SCREENSHOTS;

async function shoot(page: Page, name: string, target: Locator) {
  if (!out) return;
  for (const theme of ['light', 'dark'] as const) {
    await setTheme(page, theme);
    await target.screenshot({ path: join(out, `us5-${name}-${theme}.png`) });
  }
  await setTheme(page, 'light');
}

const section = (page: Page) => page.locator('section[data-section="decisions"]');
const row = (page: Page, title: string) =>
  section(page)
    .locator('.decrow')
    .filter({ has: page.locator('.dt', { hasText: title }) });

async function publish(
  agent: McpAgent,
  scope: { kind: string; id?: string },
  title: string,
  decision = `${title}.`,
) {
  const res = await agent.call('publish_decision', {
    project: 'RCP',
    scope,
    title,
    decision,
    rationale: 'Agreed while building it.',
  });
  expect(res.isError, res.text).toBe(false);
  return (res.structured.decision as { id: string }).id;
}

async function openDetails(page: Page, id: string) {
  await page.goto(`/items/${id}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(section(page)).toBeVisible();
}

test.describe('Decisions on a ticket', () => {
  test('inherited scope chips, Confirm → Owner, Withdraw with Undo, and the Record form', async ({
    ownerPage: page,
    agent,
  }) => {
    // RCP-12: epic RCP-1 (dec_1, owner) and label ui-refresh (dec_3, claude). Add a project
    // record and one on the item, as an agent.
    await publish(agent, { kind: 'project' }, 'Dates are ISO 8601');
    await publish(agent, { kind: 'item', id: 'RCP-12' }, 'Drop targets are at least 44 px');

    await openDetails(page, 'RCP-12');
    const sec = section(page);
    await expect(sec.locator('.sechead')).toContainText('4 in scope · 3 by agents');
    // Owner first.
    await expect(sec.locator('.decrow').first()).toContainText(
      'Units are metric internally; convert on display',
    );
    await expect(row(page, 'Units are metric internally')).toContainText('◆ Meal planning MVP');
    await expect(row(page, 'Units are metric internally').locator('.auth')).toHaveText('Owner');
    await expect(row(page, 'Use design tokens v2 spacing')).toContainText('#ui-refresh');
    await expect(row(page, 'Use design tokens v2 spacing').locator('.auth')).toHaveText(
      'Agent · claude',
    );
    await expect(row(page, 'Dates are ISO 8601')).toContainText('Project');
    await expect(row(page, 'Drop targets are at least 44 px')).toContainText('This item');
    // An owner record has no Confirm.
    await expect(
      row(page, 'Units are metric internally').getByRole('button', { name: 'Confirm' }),
    ).toHaveCount(0);
    // Why is collapsed until asked for.
    const drop = row(page, 'Drop targets are at least 44 px');
    await expect(drop.getByText('Agreed while building it.')).toHaveCount(0);
    await drop.getByRole('button', { name: 'Why' }).click();
    await expect(drop.getByText('Agreed while building it.')).toBeVisible();

    await expectAxeClean(page, 'ticket Decisions', {
      include: 'section[data-section="decisions"]',
    });
    await shoot(page, 'ticket', sec);

    // Confirm → "Owner".
    const tokens = row(page, 'Use design tokens v2 spacing');
    await tokens.getByRole('button', { name: 'Confirm' }).click();
    await expect(page.getByRole('status')).toContainText('It is now an owner decision.');
    await expect(tokens.locator('.auth')).toHaveText('Owner');
    await expect(tokens.getByRole('button', { name: 'Confirm' })).toHaveCount(0);
    await expect(sec.locator('.sechead')).toContainText('4 in scope · 2 by agents');

    // Withdraw… asks for an optional reason inline, then Undo brings it back.
    await drop.getByRole('button', { name: 'Withdraw…' }).click();
    const reason = drop.getByLabel('Reason for withdrawing (optional)');
    await expect(reason).toBeFocused();
    await reason.fill('Covered by the design tokens');
    await drop.getByRole('button', { name: 'Withdraw', exact: true }).click();
    const toast = page.locator('.toast').filter({ hasText: 'Withdrew “Drop targets' });
    await expect(toast).toBeVisible();
    await expect(row(page, 'Drop targets are at least 44 px')).toHaveCount(0);
    await toast.getByRole('button', { name: 'Undo' }).click();
    await expect(page.getByRole('status')).toContainText('Undone.');
    await expect(row(page, 'Drop targets are at least 44 px')).toBeVisible();

    // Withdraw it for good (no reason): hidden from Details, kept in Activity and under the toggle.
    await row(page, 'Drop targets are at least 44 px')
      .getByRole('button', { name: 'Withdraw…' })
      .click();
    await row(page, 'Drop targets are at least 44 px')
      .getByRole('button', { name: 'Withdraw', exact: true })
      .click();
    await expect(row(page, 'Drop targets are at least 44 px')).toHaveCount(0);
    const toggle = sec.getByRole('button', { name: /Show withdrawn and superseded \(1\)/ });
    await toggle.click();
    const withdrawn = row(page, 'Drop targets are at least 44 px');
    await expect(withdrawn).toHaveClass(/inactive/);
    await expect(withdrawn).toContainText('Withdrawn');
    await expect(withdrawn.getByRole('button', { name: 'Withdraw…' })).toHaveCount(0);
    await page.getByRole('tab', { name: /^Activity/ }).click();
    // History keeps both withdrawals and the undo.
    const history = page.getByText(/withdrew a decision: Drop targets are at least 44 px/);
    await expect(history).toHaveCount(3);
    await expect(history.first()).toBeVisible();
    await expect(page.getByText(/^Undid: Owner withdrew a decision/)).toHaveCount(1);
    await page.getByRole('tab', { name: /^Details/ }).click();

    // The Record form: Title and Decision are required; scope preset to This item.
    await sec.getByRole('button', { name: '+ Record a decision' }).click();
    const form = sec.locator('form[data-decision-form]');
    await expect(form.getByLabel(/^Title/)).toBeFocused();
    await expect(form.getByLabel('Scope')).toHaveValue('item:RCP-12');
    await expect(form.locator('option')).toHaveText([
      'This item',
      '◆ Meal planning MVP',
      'Project',
    ]);
    await form.getByRole('button', { name: 'Save' }).click();
    await expect(form.getByRole('alert')).toHaveText('Title is required.');
    await form.getByLabel(/^Title/).fill('Planner keeps the selected week on reload');
    await form.getByLabel(/^Decision/).fill('Store the week in the URL, not in memory.');
    await form.getByLabel(/^Why/).fill('RCP-17 came from losing it.');
    await expectAxeClean(page, 'ticket Record form', { include: 'form[data-decision-form]' });
    await form.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('status')).toContainText(
      'Recorded “Planner keeps the selected week on reload”.',
    );
    await expect(form).toHaveCount(0);
    const mine = row(page, 'Planner keeps the selected week on reload');
    await expect(mine.locator('.auth')).toHaveText('Owner');
    await expect(mine).toContainText('This item');
    await expect(mine).toContainText('owner');

    // Agent decisions never reach Needs you.
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByText('Dates are ISO 8601')).toHaveCount(0);
  });
});

test.describe('Decisions on an epic', () => {
  test('its own records; recording one shows it on its child tickets; Supersede', async ({
    ownerPage: page,
  }) => {
    await openDetails(page, 'RCP-1');
    const sec = section(page);
    // Epic: its own records, no scope chips.
    await expect(row(page, 'Units are metric internally')).toBeVisible();
    await expect(row(page, 'Units are metric internally')).not.toContainText('◆');
    await expect(row(page, 'Use design tokens v2 spacing')).toHaveCount(0);

    await sec.getByRole('button', { name: '+ Record a decision' }).click();
    const form = sec.locator('form[data-decision-form]');
    await expect(form.locator('[data-scope]')).toHaveText('◆ Meal planning MVP');
    await form.getByLabel(/^Title/).fill('Shopping lists group by aisle');
    await form.getByLabel(/^Decision/).fill('Group by aisle, then sort by name.');
    await form.getByRole('button', { name: 'Save' }).click();
    await expect(row(page, 'Shopping lists group by aisle')).toBeVisible();
    await expectAxeClean(page, 'epic Decisions', { include: 'section[data-section="decisions"]' });
    await shoot(page, 'epic', sec);

    // A child ticket inherits it, with the epic chip.
    await openDetails(page, 'RCP-14');
    await expect(row(page, 'Shopping lists group by aisle')).toContainText('◆ Meal planning MVP');

    // Supersede: the form opens prefilled, and saving marks the old one superseded.
    await openDetails(page, 'RCP-1');
    await row(page, 'Shopping lists group by aisle')
      .getByRole('button', { name: 'Supersede' })
      .click();
    const sup = section(page).locator('form[data-decision-form]');
    await expect(sup.getByLabel(/^Title/)).toHaveValue('Shopping lists group by aisle');
    await expect(sup.getByLabel(/^Decision/)).toHaveValue('Group by aisle, then sort by name.');
    await expect(sup).toContainText('Saving supersedes “Shopping lists group by aisle”.');
    await sup.getByLabel(/^Title/).fill('Shopping lists group by store section');
    await sup.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('status')).toContainText('is superseded');
    await expect(row(page, 'Shopping lists group by store section')).toBeVisible();
    await expect(row(page, 'Shopping lists group by aisle')).toHaveCount(0);
    await section(page)
      .getByRole('button', { name: /Show withdrawn and superseded/ })
      .click();
    await expect(row(page, 'Shopping lists group by aisle')).toContainText('Superseded');
  });
});

test.describe('Decisions on a label and in Settings', () => {
  test('the label page lists the label’s records and records new ones', async ({
    ownerPage: page,
  }) => {
    await page.goto('/labels/RCP/ui-refresh');
    const sec = section(page);
    await expect(sec).toBeVisible();
    await expect(row(page, 'Use design tokens v2 spacing (8 px grid)')).toBeVisible();
    await expect(row(page, 'Units are metric internally')).toHaveCount(0);
    await sec.getByRole('button', { name: '+ Record a decision' }).click();
    const form = sec.locator('form[data-decision-form]');
    await expect(form.locator('[data-scope]')).toHaveText('#ui-refresh');
    await form.getByLabel(/^Title/).fill('Every screen keeps 4.5:1 contrast');
    await form.getByLabel(/^Decision/).fill('Check each refreshed screen with axe in both themes.');
    await form.getByRole('button', { name: 'Save' }).click();
    await expect(row(page, 'Every screen keeps 4.5:1 contrast')).toContainText('Owner');
    await expectAxeClean(page, 'label Decisions', { include: 'section[data-section="decisions"]' });
    await shoot(page, 'label', sec);
  });

  test('Settings → "n decisions" opens the project-wide section in a dialog', async ({
    ownerPage: page,
  }) => {
    await page.goto('/settings');
    const link = page.locator('[data-project-decisions="RCP"]');
    await expect(link).toHaveText(/^\d+ decisions?$/);
    const before = Number((await link.textContent())!.split(' ')[0]);
    await link.click();
    const dialog = page.getByRole('dialog', { name: 'Sample · Recipe App · Decisions' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: '+ Record a decision' }).click();
    const form = dialog.locator('form[data-decision-form]');
    await form.getByLabel(/^Title/).fill('Write in plain English');
    await form.getByLabel(/^Decision/).fill('Short sentences. No jargon in the UI.');
    await form.getByRole('button', { name: 'Save' }).click();
    await expect(
      dialog.locator('.decrow').filter({ hasText: 'Write in plain English' }),
    ).toContainText('Owner');
    await expectAxeClean(page, 'Settings project Decisions', { include: '[role="dialog"]' });
    await shoot(page, 'settings', dialog);
    // Focus returns to + Record a decision, so Esc closes the dialog.
    await expect(dialog.getByRole('button', { name: '+ Record a decision' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(link).toHaveText(`${before + 1} ${before + 1 === 1 ? 'decision' : 'decisions'}`);
  });
});

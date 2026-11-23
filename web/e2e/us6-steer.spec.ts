/**
 * The owner steers without a review round (tasks.md T119; spec US6;
 * UI_SPEC §6.1, §6.3, §6.3.1–2, §7).
 *
 * - An agent asks through `ask_owner` (the MCP helper); the owner answers
 *   inline in Needs you, or in the ticket's question banner. The ticket
 *   says "Waiting for codex to read it" until the agent's `get_item`
 *   delivers the answer, once, and its run is back to open.
 * - A note for the agent is logged in History, shows as not read yet, and
 *   the agent's `get_item` delivers it once.
 * - *Release lead claim…* opens a destructive dialog whose focus starts on
 *   Cancel; releasing interrupts the run, moves the item to Ready, and the
 *   old run gets `conflict`; Undo restores the status, not the run.
 * - After a failed run (its error output in monospace), *Return to Ready*.
 * - The owner adds and removes a work step and a check.
 * - axe on each, both themes.
 *
 * Set DOCKET_E2E_SCREENSHOTS to a folder to also capture the PR's light
 * and dark screenshots.
 */
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import {
  askForm,
  connectAgent,
  expect,
  expectAxeClean,
  setTheme,
  test,
  useSeededContainer,
} from './fixtures/index';
import type { McpAgent } from './fixtures/mcp';

useSeededContainer();

const out = process.env.DOCKET_E2E_SCREENSHOTS;

async function shoot(page: Page, name: string, target: Locator) {
  if (!out) return;
  for (const theme of ['light', 'dark'] as const) {
    await setTheme(page, theme);
    await target.screenshot({ path: join(out, `us6-${name}-${theme}.png`) });
  }
  await setTheme(page, 'light');
}

const toast = (page: Page, text: string | RegExp) =>
  page.locator('.toast').filter({ hasText: text });
const section = (page: Page, key: string) => page.locator(`section[data-section="${key}"]`);

async function openTab(page: Page, id: string, tab: 'Activity' | 'Checklist' | 'Details') {
  await page.goto(`/items/${id}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.getByRole('tab', { name: new RegExp(`^${tab}`) }).click();
}

async function ok(agent: McpAgent, tool: string, args: Record<string, unknown>) {
  const res = await agent.call(tool, args);
  expect(res.isError, `${tool}: ${res.text}`).toBe(false);
  return res;
}

let codex: McpAgent;
test.beforeEach(async () => {
  codex = await connectAgent('codex');
});
test.afterEach(async () => {
  await codex.close();
});

test.describe('questions', () => {
  test('Needs you: the inline answer; the agent reads it once and its run is open again', async ({
    ownerPage: page,
  }) => {
    const claim = await ok(codex, 'claim_lead', { id: 'RCP-17', agent_label: 'e2e-w1' });
    const run_id = claim.structured.run_id as string;
    await ok(codex, 'ask_owner', {
      id: 'RCP-17',
      run_id,
      ...askForm('Keep the selected week in the URL or in local storage?'),
    });

    await page.goto('/');
    const row = page.locator('[data-row="question"][data-item="RCP-17"]');
    await expect(row).toContainText(
      'codex · e2e-w1 asks: “Keep the selected week in the URL or in local storage?”',
    );
    await row.getByRole('button', { name: 'Answer codex · e2e-w1 on RCP-17' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('radio', { name: /In the URL/ })).toBeFocused();
    await expect(dialog).toContainText('codex · e2e-w1 reads it on its next query.');
    await expectAxeClean(page, 'answer dialog', { include: '.dlg' });

    // Cancel closes it and puts focus back on Answer; Ctrl+Enter sends from the note.
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(row.getByRole('button', { name: /^Answer/ })).toBeFocused();
    await row.getByRole('button', { name: /^Answer/ }).click();
    const note = dialog.getByLabel('Add a note (optional)');
    await note.fill('So a reload keeps it.');
    await note.press('Control+Enter');
    await expect(
      toast(page, 'Answer posted to RCP-17. codex · e2e-w1 reads it on its next query.'),
    ).toBeVisible();
    await expect(row).toHaveCount(0);

    // The ticket says it's waiting for the agent to read it.
    await page.goto('/items/RCP-17');
    await expect(page.locator('.callout.answered')).toHaveText(
      'You answered: “Chose: In the URL (the recommended option). Note: So a reload keeps it.”. Waiting for codex · e2e-w1 to read it.',
    );

    // The agent's next get_item delivers it, once; its run goes back to open.
    const got = await ok(codex, 'get_item', { id: 'RCP-17', run_id });
    expect(got.structured.item).toMatchObject({
      open_question: {
        answer: 'Chose: In the URL (the recommended option). Note: So a reload keeps it.',
        choice: { option: 'In the URL', recommended: true, note: 'So a reload keeps it.' },
      },
    });
    const again = await ok(codex, 'get_item', { id: 'RCP-17', run_id, view: 'summary' });
    expect((again.structured.item as { lead: { run_state: string } }).lead.run_state).not.toBe(
      'needs_input',
    );
    expect((await ok(codex, 'get_item', { id: 'RCP-17' })).structured.item).toMatchObject({
      open_question: null,
    });
    await page.reload();
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.locator('.callout.answered')).toHaveCount(0);
  });

  test('the question banner on the ticket: answer, then "Waiting for codex to read it"', async ({
    ownerPage: page,
  }) => {
    // DOC-4 has codex's seeded open question.
    await page.goto('/items/DOC-4');
    const banner = page.locator('[data-banner="question"]');
    await expect(banner).toContainText('codex asked at');
    await expect(banner).toContainText('Should nutrition values be documented per serving');
    await expect(banner).toContainText('The run stays paused until codex reads it.');
    await banner.getByRole('button', { name: 'Send answer' }).click();
    await expect(toast(page, 'Write an answer first.')).toBeVisible();
    await banner.getByLabel('Your answer').fill('Per serving; put 100 g in a footnote.');
    await shoot(page, 'question-banner', banner);
    await expectAxeClean(page, 'question banner', { include: '[data-banner="question"]' });
    await banner.getByRole('button', { name: 'Send answer' }).click();
    const answered = page.locator('.callout.answered');
    await expect(answered).toHaveText(
      'You answered: “Per serving; put 100 g in a footnote.”. Waiting for codex to read it.',
    );
    await shoot(page, 'question-answered', answered);
    await expectAxeClean(page, 'answered callout', { include: '.callout.answered' });
    // Undo puts the question back.
    await toast(page, 'Answer posted to DOC-4').getByRole('button', { name: 'Undo' }).click();
    await expect(page.locator('[data-banner="question"]')).toBeVisible();
  });
});

test.describe('notes', () => {
  test('a note is logged in History and delivered to the agent once', async ({
    ownerPage: page,
  }) => {
    await openTab(page, 'RCP-14', 'Activity');
    const history = section(page, 'history');
    const box = history.getByLabel('Note for the agent');
    await box.fill('Use the metric units table for the export.');
    await shoot(page, 'history-note', history.locator('.notebox'));
    await history.getByRole('button', { name: 'Add note' }).click();
    await expect(
      toast(page, 'Note left on RCP-14. The agent sees it on its next query.'),
    ).toBeVisible();
    await expect(box).toHaveValue('');
    await expect(history.locator('.act').first()).toContainText(
      'You left a note: Use the metric units table for the export.',
    );
    await expect(history.locator('.notes-unread')).toHaveText('1 note not read yet');
    await expectAxeClean(page, 'History note box', { include: 'section[data-section="history"]' });

    const got = await ok(codex, 'get_item', { id: 'RCP-14' });
    expect(
      (got.structured.item as { unread_owner_notes: { text: string }[] }).unread_owner_notes.map(
        (n) => n.text,
      ),
    ).toEqual(['Use the metric units table for the export.']);
    const again = await ok(codex, 'get_item', { id: 'RCP-14' });
    expect((again.structured.item as { unread_owner_notes: unknown[] }).unread_owner_notes).toEqual(
      [],
    );
    await page.reload();
    await expect(section(page, 'history').locator('.act').first()).toBeVisible();
    await expect(section(page, 'history').locator('.notes-unread')).toHaveCount(0);
  });
});

test.describe('Lead and runs', () => {
  test('Release lead claim: the dialog focuses Cancel; releasing interrupts the run; Undo restores the status', async ({
    ownerPage: page,
  }) => {
    const before = await ok(codex, 'get_item', { id: 'RCP-15', view: 'summary' });
    const oldRun = (before.structured.item as { lead: { run_id: string } }).lead.run_id;

    await openTab(page, 'RCP-15', 'Activity');
    const runs = section(page, 'runs');
    await expect(runs).toContainText('claude · orca-w2 tried to claim lead at');
    await expect(runs).toContainText('Rejected: codex · orca-w1 still holds the lease.');
    await expect(runs).toContainText('Or wait: the lease expires on its own at');
    const releaseBtn = runs.getByRole('button', { name: 'Release lead claim…' });
    await shoot(page, 'lead-and-runs', runs);
    await releaseBtn.click();
    const dialog = page.getByRole('dialog', { name: 'Release lead claim on RCP-15?' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await expect(dialog).toContainText('codex · orca-w1 has been silent for');
    await expect(dialog).toContainText(`mark run ${oldRun} as interrupted, not finished`);
    await expect(dialog).toContainText('keep its checklist, log and partial work on the ticket');
    await expect(dialog).toContainText('move RCP-15 back to Ready so another agent can claim it');
    await expect(dialog).toContainText(
      'If codex comes back, it gets a conflict response with the current state.',
    );
    await shoot(page, 'release-dialog', dialog);
    await expectAxeClean(page, 'release dialog', { include: '[role="dialog"]' });

    // Cancel changes nothing and returns focus to the button.
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(releaseBtn).toBeFocused();

    await releaseBtn.click();
    await dialog.getByRole('button', { name: 'Release claim' }).click();
    const released = toast(page, 'Released codex · orca-w1’s claim. RCP-15 is back in Ready.');
    await expect(released).toBeVisible();
    await expect(page.locator('.tk-head .st-ready')).toBeVisible();
    await expect(runs.locator(`[data-run="${oldRun}"]`)).toContainText('interrupted');

    // codex comes back: its old run gets conflict with the current state.
    const late = await codex.call('heartbeat', { run_id: oldRun });
    expect(late.isError).toBe(true);
    expect(late.structured).toMatchObject({
      code: 'conflict',
      current: { run_id: oldRun, state: 'interrupted', end_reason: 'owner_released' },
    });

    // Undo restores the status, not the run.
    await released.getByRole('button', { name: 'Undo' }).click();
    await expect(page.getByRole('status')).toContainText('Undone.');
    await expect(page.locator('.tk-head .st-progress')).toBeVisible();
    await expect(runs.locator(`[data-run="${oldRun}"]`)).toContainText('interrupted');
    expect((await codex.call('heartbeat', { run_id: oldRun })).isError).toBe(true);
  });

  test('after a failed run: its error output, then Return to Ready', async ({
    ownerPage: page,
  }) => {
    const claim = await ok(codex, 'claim_lead', { id: 'RCP-25', agent_label: 'e2e-w2' });
    await ok(codex, 'finish_run', {
      run_id: claim.structured.run_id,
      result: 'failed',
      summary: 'The pantry screen test fails.',
      error: 'AssertionError: expected 3 rows, got 2\n    at pantry.test.ts:41',
    });
    await openTab(page, 'RCP-25', 'Activity');
    const runs = section(page, 'runs');
    await expect(runs.locator('pre.err')).toContainText('AssertionError: expected 3 rows, got 2');
    await expect(runs).toContainText(
      'This service never launches agents. A connected agent picks it up next.',
    );
    await expectAxeClean(page, 'failed run', { include: 'section[data-section="runs"]' });
    await runs.getByRole('button', { name: 'Return to Ready' }).click();
    await expect(
      toast(page, 'RCP-25 is back in Ready. A connected agent picks it up next.'),
    ).toBeVisible();
    await expect(page.locator('.tk-head .st-ready')).toBeVisible();
    await expect(runs.getByRole('button', { name: 'Return to Ready' })).toHaveCount(0);
    // Startable again.
    const ready = await ok(codex, 'search_items', { project: 'RCP', filter: 'ready_to_start' });
    expect((ready.structured.items as { id: string }[]).map((i) => i.id)).toContain('RCP-25');
  });
});

test.describe('the owner’s checklist entries', () => {
  test('the owner adds and removes a work step and a check; agents keep them', async ({
    ownerPage: page,
  }) => {
    await openTab(page, 'RCP-14', 'Checklist');
    const work = section(page, 'work');
    const checks = section(page, 'agentrev');

    // A work step: Enter adds.
    const stepInput = work.getByLabel('New work step');
    await stepInput.fill('Handle an empty week plan');
    await stepInput.press('Enter');
    await expect(toast(page, 'Step added. The agent sees it on its next read.')).toBeVisible();
    const step = work.locator('.ck').filter({ hasText: 'Handle an empty week plan' });
    await expect(step).toContainText('added by you');
    await expect(stepInput).toHaveValue('');

    // A check: the Add button.
    await checks
      .getByLabel('New agent review item')
      .fill('Run the full test suite on a clean checkout');
    await checks.getByRole('button', { name: 'Add' }).click();
    const check = checks.locator('.ck').filter({ hasText: 'Run the full test suite' });
    await expect(check).toContainText('added by you');
    await expect(check).toContainText('not run yet');
    await shoot(page, 'checklist-add-rows', page.locator('[role="tabpanel"]'));
    await expectAxeClean(page, 'Checklist with owner entries', { include: '[role="tabpanel"]' });

    // An agent restating its plan keeps the owner's step.
    const lead = await ok(codex, 'get_item', { id: 'RCP-14', view: 'summary' });
    const runId = (lead.structured.item as { lead: { run_id: string } }).lead.run_id;
    const claude = await connectAgent('claude');
    try {
      const plan = await claude.call('set_plan', {
        id: 'RCP-14',
        run_id: runId,
        reason: 'Restate',
        mode: 'replace',
        steps: [{ text: 'Export as Markdown' }],
      });
      expect(plan.isError, plan.text).toBe(false);
    } finally {
      await claude.close();
    }
    await page.reload();
    await page.getByRole('tab', { name: /^Checklist/ }).click();
    await expect(step).toBeVisible();

    // The owner removes them again.
    await step.getByRole('button', { name: 'Remove step “Handle an empty week plan”' }).click();
    await expect(toast(page, 'Step removed.')).toBeVisible();
    await expect(step).toHaveCount(0);
    await check
      .getByRole('button', { name: 'Remove check “Run the full test suite on a clean checkout”' })
      .click();
    await expect(toast(page, 'Check removed.')).toBeVisible();
    await expect(check).toHaveCount(0);
  });
});

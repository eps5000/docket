/**
 * Split a ticket and withdraw a question (owner decision 48; UI_SPEC §6.3).
 *
 * On the stress project, with a live lead and real-length criteria: the dialog
 * by keyboard, its preview and warnings, the split, Undo, and a withdrawn
 * question leaving Needs you and staying in History. Axe in both themes at
 * 1440 x 900 and 1024 px. All content is synthetic.
 *
 * Set DOCKET_E2E_SCREENSHOTS to a folder to capture the PR's evidence.
 */
import { join } from 'node:path';
import type { Page } from '@playwright/test';
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

const VIEWPORTS = [
  { name: '1440', width: 1440, height: 900 },
  { name: '1024', width: 1024, height: 768 },
] as const;

const CRITERIA = [
  'Opening a saved meal plan on a phone shows the week the person last looked at, even after the app was closed for several days.',
  'Changing the number of portions updates every recipe in the plan and the shopping list without a full page reload.',
  'A plan shared with a family member keeps its original portions until that person chooses to change them.',
  'The shopping list groups ingredients by aisle and merges the same ingredient across recipes into one line.',
  'Someone using only a keyboard can move a recipe between days and hear where it landed.',
  'A recipe removed from the plan can be brought back from the undo message for a short time.',
];

async function shoot(page: Page, name: string) {
  if (!out) return;
  for (const theme of ['light', 'dark'] as const) {
    await setTheme(page, theme);
    await page.screenshot({ path: join(out, `b61-${name}-${theme}.png`) });
  }
  await setTheme(page, 'light');
}

/** The dialog fits, its footer stays visible, and nothing overflows sideways. */
async function expectDialogFits(page: Page) {
  const box = await page.locator('.dlg').boundingBox();
  const vp = page.viewportSize()!;
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(vp.width);
  expect(box!.y + box!.height).toBeLessThanOrEqual(vp.height);
  await expect(
    page.locator('.dlg footer').getByRole('button', { name: 'Split ticket' }),
  ).toBeInViewport();
  const overflow = await page.evaluate(() => {
    const body = document.querySelector<HTMLElement>('.dlg .body')!;
    return {
      page: document.documentElement.scrollWidth > window.innerWidth,
      body: body.scrollWidth > body.clientWidth,
    };
  });
  expect(overflow).toEqual({ page: false, body: false });
}

let codex: McpAgent;
test.beforeEach(async () => {
  codex = await connectAgent('codex');
});
test.afterEach(async () => {
  await codex.close();
});

/** A ticket on the stress project with a live lead, a plan and a blocker. */
async function ledTicket() {
  const ok = async (tool: string, args: Record<string, unknown>) => {
    const res = await codex.call(tool, args);
    expect(res.isError, `${tool}: ${res.text}`).toBe(false);
    return res.structured;
  };
  const made = await ok('create_item', {
    project: 'STR',
    type: 'Story',
    title: 'Keep the weekly meal plan where the person left it',
    acceptance: CRITERIA,
    status: 'planning',
  });
  const id = (made.item as { id: string }).id;
  await ok('declare_shared_changes', { id, none: true });
  const version = (await codex.call('get_item', { id, view: 'summary' })).structured.item as {
    version: number;
  };
  await ok('set_status', { id, status: 'ready', expected_version: version.version });
  const claim = await ok('claim_lead', { id, agent_label: 'e2e-w9' });
  const run_id = claim.run_id as string;
  await ok('set_plan', {
    id,
    run_id,
    steps: [{ text: 'Read how the plan is stored' }, { text: 'Remember the last week viewed' }],
  });
  return { id, run_id };
}

const openSplit = async (page: Page) => {
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Split ticket…' }).click();
  return page.getByRole('dialog', { name: /^Split / });
};

test('split with a live lead: keyboard, preview, warning, axe at both sizes, and Undo', async ({
  ownerPage: page,
}) => {
  const { id } = await ledTicket();
  await page.goto(`/items/${id}`);
  await expect(page.locator('[data-section="header"]')).toContainText('Keep the weekly meal plan');

  for (const vp of VIEWPORTS) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    const dialog = await openSplit(page);
    await expect(dialog.getByLabel('New ticket title')).toBeFocused();
    await expect(dialog.locator('.callout').first()).toContainText('is working on this ticket');
    await dialog.getByLabel(CRITERIA[1]!).selectOption('move');
    await dialog.getByLabel(CRITERIA[3]!).selectOption('copy');
    await expect(dialog.locator('.split-preview')).toContainText('On the new ticket');
    await expectDialogFits(page);
    await shoot(page, `dialog-${vp.name}`);
    await expectAxeClean(page, `split dialog ${vp.name}`, { include: '.dlg' });
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'More actions' })).toBeFocused();
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  // By keyboard: type the title, Tab to the first criterion, choose Move with an arrow key.
  await page.getByRole('button', { name: 'More actions' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menuitem', { name: 'Cancel item…' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: 'Split ticket…' })).toBeFocused();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: /^Split / });
  await expect(dialog.getByLabel('New ticket title')).toBeFocused();
  await page.keyboard.type('Remember portions when sharing');
  await page.keyboard.press('Tab'); // Type
  await page.keyboard.press('Tab'); // The first criterion
  const first = dialog.getByLabel(CRITERIA[0]!);
  await expect(first).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(first).toHaveValue('move');

  // Moving every criterion is refused in the dialog, and nothing is sent.
  for (const text of CRITERIA) await dialog.getByLabel(text).selectOption('move');
  await dialog.getByRole('button', { name: 'Split ticket' }).click();
  await expect(dialog.getByRole('alert')).toContainText('must keep at least one');
  for (const text of CRITERIA.slice(2)) await dialog.getByLabel(text).selectOption('keep');

  await dialog.getByLabel(/The new ticket waits for/).check();
  await dialog.getByRole('button', { name: 'Split ticket' }).click();
  const toast = page.locator('.toast').filter({ hasText: /Split STR-[0-9]+ from/ });
  await expect(toast).toBeVisible();

  const into = page.locator('[data-split-into]');
  await expect(into).toBeVisible();
  const newId = (await into.getAttribute('data-split-into'))!;
  const original = (await codex.call('get_item', { id })).structured.item as {
    acceptance: string[];
    lead: { client: string } | null;
  };
  expect(original.acceptance).toEqual(CRITERIA.slice(2));
  expect(original.lead?.client).toBe('codex');
  const created = (await codex.call('get_item', { id: newId })).structured.item as {
    acceptance: string[];
    split_from: string;
  };
  expect(created.acceptance).toEqual(CRITERIA.slice(0, 2));
  expect(created.split_from).toBe(id);

  // Undo puts both tickets back.
  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect(into).toHaveCount(0);
  const back = (await codex.call('get_item', { id })).structured.item as { acceptance: string[] };
  expect(back.acceptance).toEqual(CRITERIA);
  expect((await codex.call('get_item', { id: newId })).isError).toBe(true);
});

test('the split shows on both tickets, in both themes at both sizes', async ({
  ownerPage: page,
}) => {
  const { id, run_id } = await ledTicket();
  const version = (await codex.call('get_item', { id, view: 'summary', run_id })).structured
    .item as { version: number };
  const split = await codex.call('create_item', {
    project: 'STR',
    type: 'Task',
    title: 'Share the plan with its original portions',
    run_id,
    split_from: { id, expected_version: version.version, move: [3], relation: 'after_original' },
  });
  expect(split.isError, split.text).toBe(false);
  const newId = (split.structured.item as { id: string }).id;

  for (const vp of VIEWPORTS) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.goto(`/items/${newId}`);
    await expect(page.locator(`[data-split-from="${id}"]`)).toBeVisible();
    await shoot(page, `from-${vp.name}`);
    await expectAxeClean(page, `split from ${vp.name}`, { include: '[data-section="header"]' });
    await page.goto(`/items/${id}`);
    await expect(page.locator('[data-split-into]')).toContainText(newId);
    await expectAxeClean(page, `split into ${vp.name}`, { include: '[data-section="header"]' });
  }
});

test('a withdrawn question leaves Needs you, stays in History, and the agent can ask again', async ({
  ownerPage: page,
}) => {
  const claim = await codex.call('claim_lead', { id: 'RCP-17', agent_label: 'e2e-w9' });
  expect(claim.isError, claim.text).toBe(false);
  const run_id = claim.structured.run_id as string;
  const asked = await codex.call('ask_owner', {
    id: 'RCP-17',
    run_id,
    ...askForm('Should the planner remember the last week viewed?'),
  });
  expect(asked.isError, asked.text).toBe(false);
  const question_id = asked.structured.question_id as string;

  await page.goto('/');
  const row = page.locator('[data-row="question"][data-item="RCP-17"]');
  await expect(row).toBeVisible();

  const reason = 'The design changed, so this no longer needs your decision.';
  const gone = await codex.call('withdraw_decision', { question_id, reason, run_id });
  expect(gone.isError, gone.text).toBe(false);
  await expect(row).toHaveCount(0);

  for (const vp of VIEWPORTS) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.goto('/items/RCP-17?tab=activity');
    const entry = page.locator('.act').filter({ hasText: reason });
    await expect(entry.getByText('Withdrawn', { exact: true })).toBeVisible();
    await entry.scrollIntoViewIfNeeded();
    await shoot(page, `withdrawn-${vp.name}`);
    await expectAxeClean(page, `withdrawn question ${vp.name}`, { include: '.act' });
  }
  await expect(page.locator('[data-banner="question"]')).toHaveCount(0);

  const next = await codex.call('ask_owner', {
    id: 'RCP-17',
    run_id,
    ...askForm('Should the planner open on today instead?'),
  });
  expect(next.isError, next.text).toBe(false);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(row).toContainText('open on today');
});

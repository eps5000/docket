/**
 * The step dialog (owner decision 33; tasks.md T172; spec US16; UI_SPEC
 * §6.3.1a; FR-146).
 *
 * An agent plans RCP-17 with detailed steps (one long, with a source),
 * rewords one with a reason, moves states, logs a subagent and edits
 * details, so the dialog has a real history. Then the owner:
 *
 * - sees the details icon only on rows whose step has details ("Details for
 *   <step>"), and no inline expansion;
 * - opens the dialog from a title and from the icon: title, status chip,
 *   source, the rendered details, the history (wording change with its
 *   reason, state changes by whom, details edits) and subagent notes;
 * - moves with *Previous* and *Next* and the arrow keys; Esc closes and
 *   focus returns to the row of the step last shown;
 * - edits details: Ctrl+Enter saves a new version the agent reads with
 *   get_step; Esc cancels (asking first when something changed);
 * - meets the conflict callout when the agent changed the details since the
 *   dialog opened, and saves theirs or keeps theirs;
 * - does all of it by keyboard alone, at 1024 px, the body scrolling;
 * - axe in both themes on the rows, the dialog, edit mode and the callout.
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
  useSeededContainer,
} from './fixtures/index';
import type { McpAgent } from './fixtures/mcp';

useSeededContainer();
test.describe.configure({ mode: 'serial' });

const out = process.env.DOCKET_E2E_SCREENSHOTS;

async function shoot(page: Page, name: string, target: Locator) {
  if (!out) return;
  for (const theme of ['light', 'dark'] as const) {
    await setTheme(page, theme);
    await target.screenshot({ path: join(out, `us16-${name}-${theme}.png`) });
  }
  await setTheme(page, 'light');
}

const LONG = [
  '## How to reproduce',
  '',
  '1. Open the planner on a week other than this one.',
  '2. Reload the page.',
  '3. The planner jumps back to the current week.',
  '',
  '## What we know',
  '',
  'The week lives only in component state, so a reload loses it. The router already',
  'parses `?week=`; nothing writes it. See [the planner notes](https://docs.example.test/planner).',
  '',
  '```ts',
  "const week = params.get('week') ?? isoWeek(new Date());",
  '```',
  '',
  ...Array.from(
    { length: 24 },
    (_, i) =>
      `- Case ${i + 1}: a week ${i + 1} ${i === 0 ? 'week' : 'weeks'} ahead keeps its place after a reload, and Back returns to the week before.`,
  ),
].join('\n');

const A = 'Reproduce the week jump';
const A2 = 'Reproduce the week jump after reload';
const B = 'Keep the week in the URL';
const C = 'Add a regression test';

let codex: McpAgent;
let runId = '';
let ids: string[] = [];

async function ok(tool: string, args: Record<string, unknown>) {
  const res = await codex.call(tool, args);
  expect(res.isError, `${tool}: ${res.text}`).toBe(false);
  return res;
}

test.beforeAll(async () => {
  codex = await connectAgent('codex');
  const claim = await ok('claim_lead', { id: 'RCP-17', agent_label: 'e2e-w1' });
  runId = claim.structured.run_id as string;
  const planned = await ok('set_plan', {
    id: 'RCP-17',
    run_id: runId,
    steps: [
      { text: A, details: LONG, source: 'GF-123' },
      { text: B, details: 'Write `?week=` on every change; read it on load.' },
      { text: C },
    ],
  });
  ids = (planned.structured.work as { id: string }[]).map((s) => s.id);
  await ok('set_plan', {
    id: 'RCP-17',
    run_id: runId,
    reason: 'Narrow the repro to reloads',
    steps: [{ id: ids[0], text: A2 }],
  });
  await ok('update_step', { id: 'RCP-17', run_id: runId, step_id: ids[0], state: 'current' });
  await ok('log_subagent', {
    id: 'RCP-17',
    run_id: runId,
    step_id: ids[0],
    name: 'explorer',
    outcome: 'Found the reset in usePlannerWeek: it ignores the URL.',
    evidence: 'src/planner/usePlannerWeek.ts:42',
    provenance: 'relayed',
  });
  await ok('update_step', { id: 'RCP-17', run_id: runId, step_id: ids[0], state: 'done' });
  await ok('update_step', {
    id: 'RCP-17',
    run_id: runId,
    step_id: ids[1],
    state: 'current',
    details: 'Write `?week=` on every change; read it on load.\n\nKeep Back working.',
  });
});
test.afterAll(async () => {
  await codex.close();
});

const dialog = (page: Page) => page.getByRole('dialog');
const work = (page: Page) => page.locator('section[data-section="work"]');
const titleButton = (page: Page, text: string) =>
  work(page).getByRole('button', { name: new RegExp(`^${text} \\(`) });

async function openChecklist(page: Page) {
  await page.goto('/items/RCP-17');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.getByRole('tab', { name: /^Checklist/ }).click();
  await expect(titleButton(page, A2)).toBeVisible();
}

test('rows: a details icon on detailed steps; title and icon open the dialog; axe', async ({
  ownerPage: page,
}) => {
  await openChecklist(page);
  const w = work(page);
  await expect(w.getByRole('button', { name: `Details for ${A2}` })).toBeVisible();
  await expect(w.getByRole('button', { name: `Details for ${B}` })).toBeVisible();
  await expect(w.getByRole('button', { name: `Details for ${C}` })).toHaveCount(0);
  // No inline expansion: the details text isn't on the page until the dialog opens.
  await expect(page.getByText('How to reproduce')).toHaveCount(0);
  await expect(w.locator('[data-step]').first()).toContainText('GF-123');
  await expectAxeClean(page, 'Checklist rows with details icons', {
    include: '[data-section="work"]',
  });
  await shoot(page, 'rows', w);

  // From the title.
  await titleButton(page, A2).click();
  const d = dialog(page);
  await expect(d).toHaveAccessibleName(A2);
  await expect(d.locator('.step-meta')).toContainText('Done');
  await expect(d.locator('[data-step-source]')).toHaveText('Source: GF-123');
  // No Jira site on this project: the source is plain text.
  await expect(d.locator('[data-step-source] a')).toHaveCount(0);
  await expect(d.getByRole('heading', { name: 'How to reproduce' })).toBeVisible();
  await expect(d.locator('.step-details code').first()).toHaveText('?week=');
  await expect(d.getByRole('link', { name: 'the planner notes' })).toHaveAttribute(
    'href',
    'https://docs.example.test/planner',
  );
  const history = d.locator('.step-history');
  await expect(history).toContainText(
    `Reworded by codex · e2e-w1: “${A}” → “${A2}” · Changed: Narrow the repro to reloads`,
  );
  await expect(history).toContainText('codex · e2e-w1 set it to done (was current)');
  await expect(history).toContainText('Added by codex · e2e-w1');
  await expect(d.locator('.contrib')).toContainText('explorer');
  await expect(d.locator('.contrib [data-provenance="relayed"]')).toBeVisible();
  await expect(d.getByRole('button', { name: 'Edit details' })).toBeFocused();
  await expectAxeClean(page, 'Step dialog', { include: '.dlg' });

  // Esc closes; focus is back on the row.
  await page.keyboard.press('Escape');
  await expect(d).toHaveCount(0);
  await expect(titleButton(page, A2)).toBeFocused();

  // From the details icon.
  await w.getByRole('button', { name: `Details for ${B}` }).click();
  await expect(dialog(page)).toHaveAccessibleName(B);
  await expect(dialog(page).locator('.step-history')).toContainText(
    'codex · e2e-w1 edited the details (v1 → v2)',
  );
  await dialog(page).getByRole('button', { name: 'Close' }).last().click();
  await expect(w.getByRole('button', { name: `${B} (current)` })).toBeFocused();
});

test('Previous and Next, and the arrow keys; Esc returns focus to the last step shown', async ({
  ownerPage: page,
}) => {
  await openChecklist(page);
  await titleButton(page, A2).click();
  const d = dialog(page);
  await expect(d.getByText('Step 1 of 3')).toBeVisible();
  await expect(d.getByRole('button', { name: 'Previous step' })).toBeDisabled();
  await page.keyboard.press('ArrowRight');
  await expect(d).toHaveAccessibleName(B);
  await expect(d.getByText('Step 2 of 3')).toBeVisible();
  await d.getByRole('button', { name: `Next step: ${C}` }).click();
  await expect(d).toHaveAccessibleName(C);
  await expect(d.getByText('No details yet.', { exact: false })).toBeVisible();
  await expect(d.getByRole('button', { name: 'Next step' })).toBeDisabled();
  await page.keyboard.press('ArrowLeft');
  await expect(d).toHaveAccessibleName(B);
  await d.getByRole('button', { name: `Previous step: ${A2}` }).click();
  await expect(d).toHaveAccessibleName(A2);
  // Previous is now disabled; focus stays in the dialog, on Next.
  await expect(d.getByRole('button', { name: `Next step: ${B}` })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Escape');
  await expect(d).toHaveCount(0);
  await expect(titleButton(page, B)).toBeFocused();
});

test('edit details: Ctrl+Enter saves a new version the agent reads; Esc cancels', async ({
  ownerPage: page,
}) => {
  await openChecklist(page);
  await work(page)
    .getByRole('button', { name: `Details for ${B}` })
    .click();
  const d = dialog(page);
  await d.getByRole('button', { name: 'Edit details' }).click();
  const field = d.getByLabel('Edit details');
  await expect(field).toBeFocused();
  await expect(field).toHaveValue(/Keep Back working\.$/);
  await expectAxeClean(page, 'Step dialog · edit details', { include: '.dlg' });
  await shoot(page, 'edit', d);
  // Arrow keys move the caret here, not the dialog.
  await page.keyboard.press('ArrowLeft');
  await expect(d).toHaveAccessibleName(B);
  await field.fill('## Plan\n\n- Write `?week=` on every change.\n- Read it on load.');
  await page.keyboard.press('Control+Enter');
  await expect(page.locator('.toast').filter({ hasText: 'Saved. Agents see it' })).toBeVisible();
  await expect(d.getByRole('heading', { name: 'Plan' })).toBeVisible();
  await expect(d.getByRole('heading', { name: /^Details/ })).toContainText('v3');
  await expect(d.getByRole('button', { name: 'Edit details' })).toBeFocused();
  await expect(d.locator('.step-history')).toContainText('you edited the details (v2 → v3)');
  const step = await ok('get_step', { id: 'RCP-17', step_id: ids[1] });
  expect(step.text).toContain('- Write `?week=` on every change.');
  expect(step.text).toContain('details v3');

  // Esc in the editor cancels (asking first, since the text changed), and doesn't close.
  await d.getByRole('button', { name: 'Edit details' }).click();
  await d.getByLabel('Edit details').fill('Something I won’t keep');
  await page.keyboard.press('Escape');
  await expect(d.getByText('Discard your changes to the details?')).toBeVisible();
  await d.getByRole('button', { name: 'Discard' }).click();
  await expect(d).toBeVisible();
  await expect(d.getByRole('heading', { name: 'Plan' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(d).toHaveCount(0);
});

test('conflict: the agent changed the details since the dialog opened', async ({
  ownerPage: page,
}) => {
  await openChecklist(page);
  await work(page)
    .getByRole('button', { name: `Details for ${B}` })
    .click();
  const d = dialog(page);
  await d.getByRole('button', { name: 'Edit details' }).click();
  await d.getByLabel('Edit details').fill('Mine: keep the week in the URL and in history state.');
  await ok('update_step', {
    id: 'RCP-17',
    run_id: runId,
    step_id: ids[1],
    state: 'current',
    details: 'Theirs: the URL only.',
  });
  await page.keyboard.press('Control+Enter');
  const callout = d.locator('.conflict');
  await expect(callout).toContainText(/codex · e2e-w1 changed this at \d\d:\d\d/);
  await expect(callout.getByLabel('Their version')).toContainText('Theirs: the URL only.');
  await expect(d.getByLabel('Edit details')).toHaveValue(
    'Mine: keep the week in the URL and in history state.',
  );
  await expectAxeClean(page, 'Step dialog · conflict', { include: '.dlg' });
  await shoot(page, 'conflict', d);
  await callout.getByRole('button', { name: 'Use mine anyway' }).click();
  await expect(d.locator('.step-details')).toContainText('Mine: keep the week in the URL');
  const step = await ok('get_step', { id: 'RCP-17', step_id: ids[1] });
  expect(step.text).toContain('Mine: keep the week in the URL and in history state.');
  expect(step.text).toContain('details v5');
  await page.keyboard.press('Escape');
});

test('keyboard only at 1024 px: open, read, edit, move and close; the body scrolls', async ({
  ownerPage: page,
}) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await openChecklist(page);
  await titleButton(page, A2).focus();
  await page.keyboard.press('Enter');
  const d = dialog(page);
  await expect(d).toHaveAccessibleName(A2);
  const box = (await d.boundingBox())!;
  expect(box.width).toBeLessThanOrEqual(960);
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(1024);
  expect(box.height).toBeLessThanOrEqual(768 * 0.85 + 1);
  const body = d.locator('.body');
  const scrolls = await body.evaluate((el) => el.scrollHeight > el.clientHeight);
  expect(scrolls).toBe(true);
  await shoot(page, 'dialog-1024', d);
  // Edit details has focus; Enter opens the editor, Ctrl+Enter saves.
  await page.keyboard.press('Enter');
  await expect(d.getByLabel('Edit details')).toBeFocused();
  await page.keyboard.press('End');
  await page.keyboard.type('\n\nChecked by keyboard.');
  await page.keyboard.press('Control+Enter');
  await expect(d.getByRole('button', { name: 'Edit details' })).toBeFocused();
  await expect(d.locator('.step-details')).toContainText('Checked by keyboard.');
  // Tab stays inside the dialog.
  for (let i = 0; i < 12; i++) await page.keyboard.press('Tab');
  expect(await d.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  await d.getByRole('button', { name: 'Edit details' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(d).toHaveAccessibleName(B);
  await page.keyboard.press('Escape');
  await expect(d).toHaveCount(0);
  await expect(titleButton(page, B)).toBeFocused();
});

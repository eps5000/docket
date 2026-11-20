/**
 * Planning and keeping things tidy (tasks.md T123; spec US7; UI_SPEC §6.2.1,
 * §6.3, §6.5, §6.9, §7, §11).
 *
 * - *Cancel item…*: the inline confirm focuses *Keep item*; the lead
 *   warning; an epic's open children listed with no Cancel button; Undo;
 *   a canceled item is still found in search.
 * - Quick capture: the title is required; the item lands in Inbox and
 *   opens; from an epic you stay on the epic and get a toast.
 * - The label page's *Move N to Ready*, with Undo.
 * - Archive and *Archive all* with Undo, the Archived filter, and the
 *   epic's "+ N archived" fold.
 * - The document viewer: sanitised Markdown, JSON pretty-printed, a run
 *   brief, and *Download*; the Checklist history dialog.
 * - Inline editing: the title with Ctrl+Enter, Esc and Undo; the conflict
 *   callout when an agent changed the outcome first; the write-check
 *   warning in the save toast.
 * - axe on each, both themes.
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

const out = process.env.DOCKET_E2E_SCREENSHOTS;

async function shoot(page: Page, name: string, target: Locator) {
  if (!out) return;
  for (const theme of ['light', 'dark'] as const) {
    await setTheme(page, theme);
    await target.screenshot({ path: join(out, `us7-${name}-${theme}.png`) });
  }
  await setTheme(page, 'light');
}

const toast = (page: Page, text: string | RegExp) =>
  page.locator('.toast').filter({ hasText: text });
const section = (page: Page, key: string) => page.locator(`section[data-section="${key}"]`);
const dialog = (page: Page) => page.getByRole('dialog');

async function openItem(page: Page, id: string, tab?: 'Details' | 'Checklist' | 'Activity') {
  await page.goto(`/items/${id}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  if (tab) await page.getByRole('tab', { name: new RegExp(`^${tab}`) }).click();
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

test.describe('Cancel item…', () => {
  test('the confirm focuses Keep item; Undo; a canceled item is still found in search', async ({
    ownerPage: page,
  }) => {
    await openItem(page, 'RCP-20');
    await page.getByRole('button', { name: 'More actions' }).click();
    await expect(page.getByRole('menuitem', { name: 'Cancel item…' })).toBeFocused();
    await page.getByRole('menuitem', { name: 'Cancel item…' }).click();
    const confirm = page.locator('[data-cancel-confirm]');
    await expect(confirm).toContainText('Cancel RCP-20? Optional reason');
    await expect(confirm.getByRole('button', { name: 'Keep item' })).toBeFocused();
    await expect(confirm.locator('[data-lead-warning]')).toHaveCount(0);
    await expectAxeClean(page, 'cancel confirm', { include: '[data-cancel-confirm]' });

    // Keep item closes it and nothing changes.
    await confirm.getByRole('button', { name: 'Keep item' }).click();
    await expect(confirm).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'More actions' })).toBeFocused();

    // Cancel, then Undo: it's back in Inbox.
    await page.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'Cancel item…' }).click();
    await confirm.getByRole('button', { name: 'Cancel item' }).click();
    await expect(page.locator('.tk-head .chip').filter({ hasText: 'Canceled' })).toBeVisible();
    await expect(page.locator('h1.struck')).toBeVisible();
    await toast(page, 'Canceled RCP-20.').getByRole('button', { name: 'Undo' }).click();
    await expect(page.locator('.tk-head .chip').filter({ hasText: 'Inbox' })).toBeVisible();

    // Cancel with a reason; it leaves the board but search still finds it.
    await page.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'Cancel item…' }).click();
    await confirm.getByLabel(/Optional reason/).fill('Offline is out of scope for V1.');
    await confirm.getByRole('button', { name: 'Cancel item' }).click();
    await expect(toast(page, 'Canceled RCP-20.')).toBeVisible();
    await expect(page.locator('.tk-head .chip').filter({ hasText: 'Canceled' })).toBeVisible();
    await page.goto('/work');
    await expect(page.locator('[data-layout="board"]')).toBeVisible();
    await expect(page.locator('[data-item="RCP-20"]')).toHaveCount(0);
    await page.keyboard.press('Control+k');
    await page.getByRole('combobox', { name: 'Search' }).fill('Offline mode');
    await expect(page.getByRole('option', { name: /RCP-20/ })).toBeVisible();
  });

  test('an item an agent leads warns that its run will be interrupted', async ({
    ownerPage: page,
  }) => {
    await openItem(page, 'RCP-15');
    await page.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'Cancel item…' }).click();
    const confirm = page.locator('[data-cancel-confirm]');
    await expect(confirm.locator('[data-lead-warning]')).toHaveText(
      'codex is working on this; its run will be interrupted.',
    );
    await shoot(page, 'cancel-confirm', page.locator('.tk-head'));
    await expectAxeClean(page, 'cancel confirm with a lead', { include: '[data-cancel-confirm]' });
    await page.keyboard.press('Escape');
    await expect(confirm).toHaveCount(0);
  });

  test('an epic with open children lists them and offers no Cancel button', async ({
    ownerPage: page,
  }) => {
    await openItem(page, 'RCP-2');
    await page.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'Cancel item…' }).click();
    const confirm = page.locator('[data-cancel-confirm]');
    await expect(confirm).toContainText('RCP-2 can’t be canceled yet.');
    await expect(confirm.getByRole('link', { name: 'RCP-15' })).toBeVisible();
    await expect(confirm.getByRole('link', { name: 'RCP-21' })).toBeVisible();
    await expect(confirm.getByRole('link', { name: 'RCP-25' })).toBeVisible();
    await expect(confirm.getByRole('button', { name: 'Cancel item' })).toHaveCount(0);
    await expect(confirm.getByRole('button', { name: 'Keep item' })).toBeFocused();
    await shoot(page, 'cancel-epic', page.locator('.tk-head'));
    await expectAxeClean(page, 'cancel confirm on an epic', { include: '[data-cancel-confirm]' });
  });
});

test.describe('quick capture', () => {
  test('the title is required; the item lands in Inbox and opens', async ({ ownerPage: page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: '+ New item' }).click();
    const dlg = dialog(page);
    await expect(dlg).toContainText('New item in Inbox');
    const title = dlg.getByLabel(/^Title/);
    await expect(title).toBeFocused();
    await dlg.getByRole('button', { name: 'Create' }).click();
    await expect(toast(page, 'Give it a title')).toBeVisible();
    await expect(title).toBeFocused();
    await title.fill('Weekly leftovers digest');
    await dlg.getByLabel('Notes (optional)').fill('Send on Sunday evening.');
    await shoot(page, 'quick-capture', dlg);
    await expectAxeClean(page, 'quick capture', { include: '[role="dialog"]' });
    await dlg.getByRole('button', { name: 'Create' }).click();
    await expect(page).toHaveURL(/\/items\/[A-Z]+-\d+/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Weekly leftovers digest');
    await expect(page.locator('.tk-head .chip').filter({ hasText: 'Inbox' })).toBeVisible();
  });

  test('from an epic: the epic is filled in and you stay on it', async ({ ownerPage: page }) => {
    await openItem(page, 'RCP-1');
    await page.getByRole('button', { name: '+ New item in this epic' }).click();
    const dlg = dialog(page);
    await expect(dlg).toContainText('New item in ◆ Meal planning MVP');
    await dlg.getByLabel(/^Title/).fill('Leftover-aware planner');
    await shoot(page, 'quick-capture-epic', dlg);
    await dlg.getByRole('button', { name: 'Create' }).click();
    await expect(toast(page, /^RCP-\d+ added to Meal planning MVP/)).toBeVisible();
    await expect(page).toHaveURL(/\/items\/RCP-1(\?|$)/);
    await expect(section(page, 'tickets')).toContainText('Leftover-aware planner');
  });
});

test.describe('the label page', () => {
  test('Move N to Ready moves every Planning item with the label, with Undo', async ({
    ownerPage: page,
  }) => {
    await page.goto('/labels/RCP/ui-refresh');
    const move = page.getByRole('button', { name: 'Move 2 to Ready' });
    await expect(move).toBeVisible();
    await expect(page.locator('[data-card="brief"]')).toContainText('written by owner');
    await shoot(page, 'label-page', page.locator('.labelpage'));
    await expectAxeClean(page, 'label page', { include: '.labelpage' });
    // The Ready gate (decision 36): undeclared items refuse the move, and the toast says why.
    await move.click();
    await expect(
      toast(page, 'Declare the shared parts RCP-23, RCP-27 will change (or none)'),
    ).toBeVisible();
    for (const id of ['RCP-23', 'RCP-27']) {
      await ok(codex, 'declare_shared_changes', { id, none: true });
    }
    await move.click();
    await expect(toast(page, 'Moved 2 items with #ui-refresh to Ready.')).toBeVisible();
    await expect(move).toHaveCount(0);
    await toast(page, 'Moved 2 items').getByRole('button', { name: 'Undo' }).click();
    await expect(page.getByRole('button', { name: 'Move 2 to Ready' })).toBeVisible();
  });
});

test.describe('archive', () => {
  test('Archive and Archive all with Undo, the Archived filter, the epic’s fold', async ({
    ownerPage: page,
  }) => {
    // The Recipe App's board: All projects also holds the stress project's done items (B35).
    await page.addInitScript(() => sessionStorage.setItem('docket.scope', 'RCP'));
    await page.goto('/work');
    const done = page.locator('section.col[aria-label="Done"]');
    await expect(done.locator('[data-item="RCP-11"]')).toBeVisible();
    await shoot(page, 'done-column', done);
    await expectAxeClean(page, 'Done column', { include: 'section.col[aria-label="Done"]' });

    // One card: Archive, then Undo.
    await done
      .locator('.tcw')
      .filter({ has: page.locator('[data-item="RCP-11"]') })
      .getByRole('button', { name: 'Archive' })
      .click();
    await expect(done.locator('[data-item="RCP-11"]')).toHaveCount(0);
    await toast(page, 'RCP-11 archived.').getByRole('button', { name: 'Undo' }).click();
    await expect(done.locator('[data-item="RCP-11"]')).toBeVisible();

    // Archive all, Undo, then Archive all again.
    await done.getByRole('button', { name: 'Archive all' }).click();
    await expect(toast(page, /^Archived 1 done item\./)).toBeVisible();
    await expect(done.locator('.tcard')).toHaveCount(0);
    await toast(page, /^Archived 1 done item\./)
      .getByRole('button', { name: 'Undo' })
      .click();
    await expect(done.locator('.tcard')).toHaveCount(1);
    await done.getByRole('button', { name: 'Archive all' }).click();
    await expect(done.locator('.tcard')).toHaveCount(0);

    // The Archived filter shows them, each with Unarchive.
    const chip = page.locator('.fchip').filter({ hasText: 'Archived' });
    await expect(chip).toContainText('1');
    await chip.click();
    await expect(page).toHaveURL(/filter=archived/);
    await expect(done.locator('.tcard.archived')).toHaveCount(1);
    await expect(done.getByRole('button', { name: 'Unarchive' })).toHaveCount(1);
    await expectAxeClean(page, 'Archived filter', { include: '[data-layout="board"]' });

    // The epic folds its archived ticket away.
    await openItem(page, 'RCP-1');
    const fold = section(page, 'tickets').locator('[data-archived-fold]');
    await expect(fold).toContainText('+ 1 archived ·');
    await expect(section(page, 'tickets').getByRole('link', { name: 'RCP-11' })).toHaveCount(0);
    await fold.getByRole('button', { name: 'Show' }).click();
    await expect(section(page, 'tickets').getByRole('link', { name: 'RCP-11' })).toBeVisible();
    await expectAxeClean(page, 'epic tickets with archived shown', {
      include: 'section[data-section="tickets"]',
    });

    // The ticket itself: Archived chip and Unarchive.
    await openItem(page, 'RCP-11');
    await page.locator('.tk-head').getByRole('button', { name: 'Unarchive' }).click();
    await expect(toast(page, 'RCP-11 is back in your views.')).toBeVisible();
    await expect(page.locator('.tk-head').getByRole('button', { name: 'Archive' })).toBeVisible();
  });
});

test.describe('documents and history', () => {
  test('the document viewer: Markdown sanitised, JSON pretty, a run brief, Download', async ({
    ownerPage: page,
  }) => {
    await ok(codex, 'put_document', {
      item_id: 'RCP-21',
      name: 'pantry-research.md',
      kind: 'planning',
      content_text:
        '# Pantry research\n\nShelf life **matters** more than brand.\n\n- rice\n- beans\n\n<script>window.__pwned = 1</script>\n',
    });
    await ok(codex, 'put_document', {
      item_id: 'RCP-21',
      name: 'pantry-research.md',
      kind: 'planning',
      content_text:
        '# Pantry research\n\nShelf life **matters** more than brand.\n\n- rice\n- beans\n- lentils\n\n<script>window.__pwned = 1</script>\n',
    });
    await ok(codex, 'put_document', {
      item_id: 'RCP-21',
      name: 'survey.json',
      kind: 'other',
      content_text: '{"households":12,"staples":["rice","beans"]}',
    });

    await openItem(page, 'RCP-21', 'Details');
    const docs = section(page, 'docs');
    await expect(docs.locator('[data-document="pantry-research.md"]')).toContainText('v2 · codex');
    await docs.getByRole('button', { name: 'pantry-research.md' }).click();
    const dlg = dialog(page);
    await expect(dlg.getByRole('heading', { name: 'Pantry research', level: 1 })).toBeVisible();
    await expect(dlg.locator('strong')).toHaveText('matters');
    await expect(dlg.locator('li')).toHaveText(['rice', 'beans', 'lentils']);
    await expect(dlg.locator('script')).toHaveCount(0);
    expect(await page.evaluate(() => (window as { __pwned?: number }).__pwned)).toBeUndefined();
    await expect(dlg.locator('[data-doc-meta]')).toContainText('v2 · codex ·');
    await expect(dlg.getByRole('link', { name: 'Download' })).toHaveAttribute(
      'download',
      'pantry-research.md',
    );
    await shoot(page, 'document-viewer', dlg);
    await expectAxeClean(page, 'document viewer', { include: '[role="dialog"]' });
    await dlg.locator('footer').getByRole('button', { name: 'Close' }).click();

    await docs.getByRole('button', { name: 'survey.json' }).click();
    await expect(dialog(page).locator('pre.docpre')).toContainText('"households": 12,');
    await dialog(page).locator('footer').getByRole('button', { name: 'Close' }).click();

    // A run brief, written by claim_lead, opens like any other document.
    const claim = await ok(codex, 'claim_lead', {
      id: 'RCP-17',
      agent_label: 'e2e-w7',
      brief: '## Brief\n\nKeep the selected week in the URL.\n\n- reload keeps the week',
    });
    const runId = claim.structured.run_id as string;
    await openItem(page, 'RCP-17', 'Details');
    const brief = section(page, 'docs').locator(`[data-document="brief-${runId}.md"]`);
    await expect(brief).toContainText('Run brief');
    await brief.getByRole('button').click();
    // exact: the dialog title, brief-<run>.md, also contains 'brief'.
    await expect(dialog(page).getByRole('heading', { name: 'Brief', exact: true })).toBeVisible();
    await expect(dialog(page)).toContainText('reload keeps the week');
    await shoot(page, 'document-viewer-brief', dialog(page));
    await expectAxeClean(page, 'document viewer (brief)', { include: '[role="dialog"]' });
  });

  test('Checklist history shows each plan version', async ({ ownerPage: page }) => {
    await openItem(page, 'RCP-14', 'Checklist');
    await section(page, 'work').getByRole('button', { name: 'Checklist history' }).click();
    const dlg = dialog(page);
    await expect(dlg).toContainText('Checklist history · RCP-14');
    await expect(dlg.locator('.ver').first()).toBeVisible();
    await shoot(page, 'checklist-history', dlg);
    await expectAxeClean(page, 'Checklist history', { include: '[role="dialog"]' });
    await page.keyboard.press('Escape');
    await expect(dlg).toHaveCount(0);
  });
});

test.describe('inline editing', () => {
  test('the title: Ctrl+Enter saves with Undo, Esc asks before discarding', async ({
    ownerPage: page,
  }) => {
    await openItem(page, 'RCP-24');
    await page.getByRole('button', { name: 'Edit title' }).click();
    const input = page.getByRole('textbox', { name: 'Edit title' });
    await expect(input).toBeFocused();
    await input.fill('Grocery delivery handoff (one partner first)');
    await shoot(page, 'inline-title', page.locator('.tk-head'));
    await expectAxeClean(page, 'title editor', { include: '.tk-head' });
    await input.press('Control+Enter');
    await expect(toast(page, 'Saved. Agents see it on their next read.')).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      'Grocery delivery handoff (one partner first)',
    );
    await expect(page.getByRole('button', { name: 'Edit title' })).toBeFocused();
    await toast(page, 'Saved.').getByRole('button', { name: 'Undo' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Grocery delivery handoff');

    await page.getByRole('button', { name: 'Edit title' }).click();
    await page.getByRole('textbox', { name: 'Edit title' }).fill('Something else');
    await page.keyboard.press('Escape');
    await expect(page.getByText('Discard your changes to the title?')).toBeVisible();
    await page.getByRole('button', { name: 'Discard' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Grocery delivery handoff');
  });

  test('a conflict keeps your text and shows theirs; Use mine anyway re-sends', async ({
    ownerPage: page,
  }) => {
    await openItem(page, 'RCP-24', 'Details');
    const outcome = section(page, 'outcome');
    await outcome.getByRole('button', { name: 'Edit outcome' }).click();
    const box = outcome.getByRole('textbox', { name: 'Edit outcome' });
    await expect(box).toBeFocused();
    await box.fill('Hand the list to one delivery partner, with a confirmation step.');

    // codex changes the outcome first.
    const cur = await ok(codex, 'get_item', { id: 'RCP-24', view: 'summary' });
    const version = (cur.structured.item as { version: number }).version;
    await ok(codex, 'update_item', {
      id: 'RCP-24',
      expected_version: version,
      outcome_md: 'Export the list as a CSV for any delivery service.',
    });

    await outcome.getByRole('button', { name: 'Save' }).click();
    const callout = outcome.locator('.conflict');
    await expect(callout).toContainText(
      /codex changed this at \d\d:\d\d\. Their version is shown above; your text is kept below to copy back\./,
    );
    await expect(callout.locator('.theirs')).toContainText(
      'Export the list as a CSV for any delivery service.',
    );
    await expect(box).toHaveValue(
      'Hand the list to one delivery partner, with a confirmation step.',
    );
    await shoot(page, 'inline-conflict', outcome);
    await expectAxeClean(page, 'conflict callout', {
      include: 'section[data-section="outcome"]',
    });
    await callout.getByRole('button', { name: 'Use mine anyway' }).click();
    await expect(toast(page, 'Saved. Agents see it on their next read.')).toBeVisible();
    await expect(outcome.locator('.conflict')).toHaveCount(0);
    await expect(outcome).toContainText(
      'Hand the list to one delivery partner, with a confirmation step.',
    );
    const after = await ok(codex, 'get_item', { id: 'RCP-24' });
    expect((after.structured.item as { outcome_md: string }).outcome_md).toBe(
      'Hand the list to one delivery partner, with a confirmation step.',
    );
  });

  test('the save toast carries write-check warnings; acceptance criteria edit per line', async ({
    ownerPage: page,
  }) => {
    await openItem(page, 'RCP-24', 'Details');
    const outcome = section(page, 'outcome');
    await outcome.getByRole('button', { name: 'Edit description' }).click();
    await outcome
      .getByRole('textbox', { name: 'Edit description' })
      .fill('Needs RCP-14 and RCP-999 first.');
    await outcome.getByRole('button', { name: 'Preview' }).click();
    await expect(outcome.getByRole('region', { name: 'description preview' })).toContainText(
      'Needs RCP-14 and RCP-999 first.',
    );
    await outcome.getByRole('button', { name: 'Save' }).click();
    const saved = toast(page, "Saved. Agents see it on their next read. ! RCP-999 doesn't exist");
    await expect(saved).toBeVisible();
    await shoot(page, 'warning-toast', page.locator('.toasts, [role="status"]').first());

    await outcome.getByRole('button', { name: 'Edit acceptance criteria' }).click();
    const first = outcome.getByRole('textbox', { name: 'Acceptance criterion 1' });
    await expect(first).toBeFocused();
    await first.fill('The partner gets the list in one tap');
    await outcome.getByRole('button', { name: '+ Add criterion' }).click();
    await outcome
      .getByRole('textbox', { name: 'Acceptance criterion 2' })
      .fill('Out-of-stock items are flagged');
    await shoot(page, 'inline-acceptance', outcome);
    await expectAxeClean(page, 'acceptance editor', {
      include: 'section[data-section="outcome"]',
    });
    await page.keyboard.press('Control+Enter');
    await expect(toast(page, 'Saved. Agents see it on their next read.').last()).toBeVisible();
    await expect(outcome).toContainText('The partner gets the list in one tap');
    await expect(outcome).toContainText('Out-of-stock items are flagged');
    await expect(outcome).toContainText('2 acceptance criteria');
  });
});

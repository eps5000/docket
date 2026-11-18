/**
 * The kit gallery (tasks.md T058): every component renders in both themes
 * with no serious axe violations, and the focus behaviour that matters works
 * in a real browser (dialog focus trap, destructive Cancel first, tabs keys).
 * Runs in the `kit` project against the Vite dev server.
 */
import { expect, expectAxeClean, setTheme, test } from './fixtures/index';

test.describe('kit gallery (/dev/kit)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/dev/kit');
    await expect(page.getByRole('heading', { level: 1, name: 'UI kit' })).toBeVisible();
  });

  test('shows every component in both themes', async ({ page }) => {
    for (const theme of ['light', 'dark'] as const) {
      const pane = page.locator(`[data-kit-theme="${theme}"]`);
      for (const group of [
        'Button',
        'Chip',
        'TypeBadge and TypeIcon',
        'RunState',
        'Provenance and decision authority',
        'Priority, Label, EpicLink',
        'Card, Callout, EmptyState, Skeleton, ErrorState',
        'Section',
        'ViewTabs',
        'TicketCard and EpicCard',
        'DecisionRow',
        'Toast',
        'Inline editor',
      ]) {
        await expect(pane.getByRole('region', { name: `${group} (${theme})` })).toBeVisible();
      }
      await expect(pane.getByText('parked · waiting on RCP-12')).toBeVisible();
      await expect(pane.locator('[data-error-state="not-built"]')).toContainText('Not built yet.');
    }
  });

  test('is axe-clean in both page themes (side-by-side panes cover both themes each time)', async ({
    page,
  }) => {
    await expectAxeClean(page, '/dev/kit');
  });

  test('dialogs trap focus, close on Esc, and destructive dialogs focus Cancel', async ({
    page,
  }) => {
    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme);
      const opener = page.getByRole('button', { name: 'Open destructive dialog' });
      await opener.click();
      const dialog = page.getByRole('dialog', { name: 'Release lead claim on RCP-15?' });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
      await expectAxeClean(page, `destructive dialog`, { themes: [theme] });
      for (let i = 0; i < 5; i++) {
        await page.keyboard.press('Tab');
        expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
      }
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect(opener).toBeFocused();
    }
    await page.getByRole('button', { name: 'Open dialog', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Title' })).toBeFocused();
    await page.keyboard.press('Escape');
  });

  test('the command palette moves with arrows and closes on Esc', async ({ page }) => {
    await page.getByRole('button', { name: 'Open command palette' }).click();
    const palette = page.getByRole('dialog', { name: 'Search or jump to' });
    await expect(page.getByRole('combobox', { name: 'Search' })).toBeFocused();
    await expect(palette.getByRole('option').first()).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowDown');
    await expect(palette.getByRole('option').nth(1)).toHaveAttribute('aria-selected', 'true');
    await expect(palette.getByRole('option').nth(1)).toContainText('Archived');
    await expectAxeClean(page, 'command palette');
    await page.keyboard.press('Escape');
    await expect(palette).toHaveCount(0);
  });

  test('view tabs follow the ARIA tabs keyboard pattern', async ({ page }) => {
    const pane = page.locator('[data-kit-theme="light"]');
    const details = pane.getByRole('tab', { name: 'Details' });
    await details.click();
    await page.keyboard.press('ArrowRight');
    await expect(pane.getByRole('tab', { name: /^Checklist/ })).toBeFocused();
    await expect(pane.getByRole('tab', { name: /^Checklist/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await page.keyboard.press('End');
    await expect(pane.getByRole('tab', { name: /^Activity/ })).toBeFocused();
    await page.keyboard.press('Home');
    await expect(details).toBeFocused();
  });

  test('screenshot (PR evidence)', async ({ page }) => {
    const out = process.env.DOCKET_E2E_SCREENSHOTS;
    test.skip(!out, 'Set DOCKET_E2E_SCREENSHOTS to a folder to capture screenshots.');
    await page.screenshot({ path: `${out}/dev-kit.png`, fullPage: true });
  });

  test('toasts announce through role=status', async ({ page }) => {
    await page.getByRole('button', { name: 'Show toast with Undo' }).click();
    const region = page.locator('.toasts[role="status"]');
    await expect(region).toContainText('Archived RCP-11.');
    await region.getByRole('button', { name: 'Undo' }).click();
    await expect(region).toContainText('Undone.');
  });
});

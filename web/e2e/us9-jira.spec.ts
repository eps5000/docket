/**
 * Jira import end to end (tasks.md T141; spec US9; UI_SPEC §9.2, §11;
 * BUILD_SPEC §9).
 *
 * The Jira site is the synthetic fixture server on the compose network
 * (docker/compose.jira-fixture.yaml; server/tests/fixtures/jira/), reached by
 * the container at https://jira-fixture.test:8443. No internet.
 *
 * - Step 1 (Connect): the fields, inline errors (a bad sign-in, an unknown
 *   project), the progress line and *Cancel* on a slow project.
 * - Step 2 (Review): summary tiles, the mapping table, the lossy items,
 *   cycles, fields used, *Download report (JSON)*, *Back*, *Import n items*.
 * - Step 3 (Import): the result with the failed attachment listed, and
 *   *Open project*; the imported items show "Imported from Jira".
 * - The API token is cleared after step 1 and never on the page again.
 * - axe on every step in both themes.
 *
 * Set DOCKET_E2E_SCREENSHOTS to a folder to also capture the PR's light
 * and dark screenshots.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { CONTAINER } from './fixtures/container';
import { expect, expectAxeClean, setTheme, test, useSeededContainer } from './fixtures/index';

useSeededContainer();

const SITE = 'https://jira-fixture.test:8443';
const EMAIL = 'owner@example.test';
const TOKEN = 'tl-fixture-api-token-0001';
const out = process.env.DOCKET_E2E_SCREENSHOTS;

/** Is the fixture reachable from the container? (CI always starts it; locally it's opt-in.) */
function fixtureUp(): boolean {
  try {
    execFileSync(
      'docker',
      [
        'exec',
        CONTAINER,
        'node',
        '-e',
        `fetch('${SITE}/__health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))`,
      ],
      { stdio: 'ignore' },
    );
    return true;
  } catch {
    return false;
  }
}

test.skip(
  !process.env.CI && !fixtureUp(),
  'Start the Jira fixture: docker/jira-fixture/make-certs.sh, then compose with docker/compose.jira-fixture.yaml',
);

async function shoot(page: Page, name: string, target: Locator) {
  if (!out) return;
  // The whole dialog, not just its scrolled viewport.
  await target.evaluate((el) => {
    (el as HTMLElement).style.maxHeight = 'none';
    (el.parentElement as HTMLElement).style.position = 'absolute';
  });
  for (const theme of ['light', 'dark'] as const) {
    await setTheme(page, theme);
    await target.screenshot({ path: join(out, `us9-${name}-${theme}.png`) });
  }
  await setTheme(page, 'light');
  await target.evaluate((el) => {
    (el as HTMLElement).style.maxHeight = '';
    (el.parentElement as HTMLElement).style.position = '';
  });
}

const dialog = (page: Page) => page.getByRole('dialog', { name: 'Import from Jira' });

async function openDialog(page: Page): Promise<Locator> {
  await page.context().addInitScript(() => localStorage.setItem('tl.notifications', 'off'));
  await page.goto('/settings');
  await page.getByRole('button', { name: 'Import from Jira…' }).click();
  const d = dialog(page);
  await expect(d).toBeVisible();
  return d;
}

async function connect(
  d: Locator,
  opts: { token?: string; project?: string; key?: string; name?: string } = {},
) {
  await d.getByLabel('Jira site').fill(SITE);
  await d.getByLabel('Email').fill(EMAIL);
  await d.getByLabel('API token').fill(opts.token ?? TOKEN);
  await d.getByLabel('Jira project key').fill(opts.project ?? 'TL');
  await d.getByLabel('Key', { exact: true }).fill(opts.key ?? 'TILL');
  await d.getByLabel('Name', { exact: true }).fill(opts.name ?? 'Till import');
  await d.getByRole('button', { name: 'Run dry run' }).click();
}

test.describe('Import from Jira (UI_SPEC §9.2)', () => {
  test('step 1: the form, inline errors, progress and Cancel', async ({ ownerPage: page }) => {
    const d = await openDialog(page);
    await expect(d.getByRole('list', { name: 'Steps' })).toHaveText(
      /1 Connect\s*2 Review\s*3 Import/,
    );
    await expect(d.locator('[aria-current="step"]')).toHaveText('1 Connect');
    await expect(d.getByText('Used for this import only. Not saved.')).toBeVisible();
    await expect(d.getByLabel('API token')).toHaveAttribute('type', 'password');
    await expect(d.getByRole('button', { name: 'Run dry run' })).toBeDisabled();
    await expectAxeClean(page, 'Jira import · connect', { include: '.dlg' });
    await shoot(page, 'connect', d);

    // A bad sign-in: the message inline, and the token field cleared.
    await connect(d, { token: 'not-the-right-token' });
    await expect(d.getByRole('alert')).toHaveText(
      "Couldn't sign in to Jira. Check the email and API token.",
    );
    await expect(d.getByLabel('API token')).toHaveValue('');

    // An unknown project.
    await d.getByLabel('API token').fill(TOKEN);
    await d.getByLabel('Jira project key').fill('NOPE');
    await d.getByRole('button', { name: 'Run dry run' }).click();
    await expect(d.getByRole('alert')).toHaveText(
      'Project NOPE not found or not visible to this account.',
    );
    await expectAxeClean(page, 'Jira import · error', { include: '.dlg' });

    // A slow project: the progress line, then Cancel.
    await d.getByLabel('API token').fill(TOKEN);
    await d.getByLabel('Jira project key').fill('SLOW');
    await d.getByRole('button', { name: 'Run dry run' }).click();
    await expect(d.getByRole('status')).toHaveText(/Reading \d+ of 120 issues…/);
    await shoot(page, 'progress', d);
    await d.getByRole('button', { name: 'Cancel' }).click();
    await expect(d.getByRole('status')).toHaveCount(0);
    await expect(d.getByRole('button', { name: 'Run dry run' })).toBeVisible();
    await expect(d.locator('[aria-current="step"]')).toHaveText('1 Connect');
  });

  test('steps 2 and 3: review the report, import, open the project', async ({
    ownerPage: page,
  }) => {
    const d = await openDialog(page);
    await connect(d);

    // Step 2: the report.
    await expect(d.locator('[aria-current="step"]')).toHaveText('2 Review', { timeout: 30_000 });
    const tiles = d.getByRole('list', { name: 'Dry-run summary' });
    await expect(tiles).toContainText('22issues');
    await expect(tiles).toContainText('20would import');
    await expect(tiles).toContainText('2skipped');
    await expect(tiles).toContainText('15lossy');
    await expect(tiles).toContainText('3 attachments');
    const mapping = d.locator('table.jira-mapping');
    await expect(mapping.getByRole('row', { name: /Type: Subtask Work step 3 2/ })).toBeVisible();
    await expect(mapping.getByRole('row', { name: /Link: Duplicate relates 1 1/ })).toBeVisible();
    await expect(d.getByText('Imported as is. They’ll show under Problems.')).toBeVisible();
    await expect(d.getByText('TL-12 → TL-13 → TL-14 → TL-12')).toBeVisible();
    await expect(d.getByText('Story points → customfield_10016')).toBeVisible();
    await expect(d.getByText('Start date → customfield_10015')).toBeVisible();
    await shoot(page, 'review', d);
    await d.getByText('By field (18)').click();
    await expect(d.getByRole('row', { name: 'Reporter 0 21 —' })).toBeVisible();
    await expect(d.getByRole('row', { name: 'Description 6 2 3' })).toBeVisible();
    await d.getByText('Lossy items (17)').click();
    await expect(d.getByText('Jira type Spike imported as Task', { exact: false })).toBeVisible();
    await expect(d.getByText('Skipped: its summary looks like a secret (API key)')).toBeVisible();
    // The token never appears again after step 1.
    expect(await page.content()).not.toContain(TOKEN);
    const download = page.waitForEvent('download');
    await d.getByRole('button', { name: 'Download report (JSON)' }).click();
    expect((await download).suggestedFilename()).toBe('jira-dry-run-TL.json');
    await expectAxeClean(page, 'Jira import · review', { include: '.dlg' });
    await shoot(page, 'review-lossy', d);

    // Back goes to step 1 (the session is dropped; the token must be entered again).
    await d.getByRole('button', { name: 'Back' }).click();
    await expect(d.locator('[aria-current="step"]')).toHaveText('1 Connect');
    await expect(d.getByLabel('API token')).toHaveValue('');
    await d.getByLabel('API token').fill(TOKEN);
    await d.getByRole('button', { name: 'Run dry run' }).click();
    await expect(d.locator('[aria-current="step"]')).toHaveText('2 Review', { timeout: 30_000 });

    // Step 3: import.
    await d.getByRole('button', { name: 'Import 17 items' }).click();
    await expect(d.locator('[aria-current="step"]')).toHaveText('3 Import');
    await expect(d.getByRole('status')).toContainText(
      'Imported 17 items into TILL. 1 attachment failed (listed). The report is saved in the project’s documents.',
      { timeout: 30_000 },
    );
    await expect(d.getByText('trace.log (TL-2): Jira answered 500')).toBeVisible();
    expect(await page.content()).not.toContain(TOKEN);
    await expectAxeClean(page, 'Jira import · result', { include: '.dlg' });
    await shoot(page, 'result', d);

    await d.getByRole('button', { name: 'Open project' }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(page).toHaveURL(/\/work/);
    await expect(page.getByRole('button', { name: /^Project:?\s*Till import$/ })).toBeVisible();

    // An imported item: the chip, and its Jira key in search.
    await page.goto('/items/TILL-2');
    await expect(page.getByText('Imported from Jira')).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Card form validation');
  });
});

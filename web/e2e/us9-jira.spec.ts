/**
 * Jira import end to end (tasks.md T141; spec US9; UI_SPEC §9.2, §11;
 * BUILD_SPEC §9).
 *
 * The Jira site is the synthetic fixture server on the compose network
 * (docker/compose.jira-fixture.yaml; server/tests/fixtures/jira/), reached by
 * the container at https://jira-fixture.test:8443. No internet.
 *
 * - Step 1 (Connect): the fields, "Which token?" and the site note, the site
 *   address normalised on blur, inline errors (B32: site not found,
 *   organization key, wrong email or token, no access, scoped token without
 *   the read scopes; and an unknown project), the progress line and *Cancel*
 *   on a slow project.
 * - Step 2 (Review): the legend, summary tiles, the changed and skipped
 *   issues by reason, the mapping table, cycles, fields used, *Download
 *   report (JSON)*, *Back*, *Import n items and m checklist steps*.
 * - A scoped token (B32) signs in through the gateway (the fixture answers
 *   as api.atlassian.com on the test network) and imports everything there.
 * - Step 3 (Import): the result with the failed attachment listed, and
 *   *Open project*; the imported items show "Imported from Jira".
 * - Decision 33 (B34): a sub-task's step carries its details (header line
 *   and description) and its Jira key as a source that links to the issue in
 *   the step dialog; the parent's History shows the "Comments from Jira
 *   sub-tasks" notes.
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
/** B32: the fixture's other credentials (server/tests/fixtures/jira/site.mjs). */
const SCOPED = 'tl-fixture-scoped-token-0001';
const LIMITED = 'tl-fixture-scoped-noread-0001';
const ORG_KEY = 'ATCTT3xFfGN0-fixture-org-key-not-real-0001';
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
  await page.context().addInitScript(() => localStorage.setItem('docket.notifications', 'off'));
  await page.goto('/settings');
  await page.getByRole('button', { name: 'Import from Jira…' }).click();
  const d = dialog(page);
  await expect(d).toBeVisible();
  return d;
}

async function connect(
  d: Locator,
  opts: { token?: string; project?: string; key?: string; name?: string; site?: string } = {},
) {
  await d.getByLabel('Jira site').fill(opts.site ?? SITE);
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

    // "Which token?" and the site note (B32).
    await expect(d.getByText('with no /jira and no path.', { exact: false })).toBeVisible();
    await d.getByText('Which token?').click();
    await expect(d.getByText('Use a personal API token')).toBeVisible();
    await expect(d.getByRole('link', { name: /id\.atlassian\.com/ })).toHaveAttribute(
      'href',
      'https://id.atlassian.com/manage-profile/security/api-tokens',
    );
    await expect(d.getByText('Organization API keys don’t work.')).toBeVisible();
    await expectAxeClean(page, 'Jira import · which token', { include: '.dlg' });
    await shoot(page, 'which-token', d);
    await d.getByText('Which token?').click();

    // The site address is normalised as the owner leaves the field.
    await d.getByLabel('Jira site').fill('jira-fixture.test:8443/jira/software/projects/TL/');
    await d.getByLabel('Email').focus();
    await expect(d.getByLabel('Jira site')).toHaveValue(SITE);

    // Each sign-in failure, in words (B32), the token field cleared each time.
    const failures: [string, Parameters<typeof connect>[1], string][] = [
      [
        'site-not-found',
        // A .localhost name: unreachable, and never a DNS query out (the no-egress audit).
        { site: 'https://nowhere.localhost' },
        'Site not found: check the URL (https://yoursite.atlassian.net).',
      ],
      [
        'org-key',
        { token: ORG_KEY },
        "That looks like an organization API key from admin.atlassian.com. Those can't read Jira. Create a personal API token at id.atlassian.com instead.",
      ],
      [
        'wrong-token',
        { token: 'not-the-right-token' },
        "Wrong email or API token. The token must belong to owner@example.test's Atlassian account.",
      ],
      [
        'no-access',
        { project: 'LOCKED' },
        "Signed in, but this account can't browse that project (or the token's scopes don't include reading Jira work items).",
      ],
      [
        'scoped-no-scopes',
        { token: LIMITED },
        "Signed in, but this account can't browse that project (or the token's scopes don't include reading Jira work items). A scoped token needs the read:jira-work and read:jira-user scopes.",
      ],
    ];
    for (const [name, opts, message] of failures) {
      await connect(d, opts);
      await expect(d.getByRole('alert')).toHaveText(message, { timeout: 15_000 });
      await expect(d.getByLabel('API token')).toHaveValue('');
      await expectAxeClean(page, `Jira import · ${name}`, { include: '.dlg' });
      await shoot(page, `error-${name}`, d);
    }

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
    const legend = d.getByRole('definition').first();
    await expect(legend).toBeVisible();
    await expect(d.locator('.jira-legend dt')).toHaveText([
      'Imported as is',
      'Imported with changes',
      'Skipped',
    ]);
    const tiles = d.getByRole('list', { name: 'Dry-run summary' });
    await expect(tiles).toContainText('22issues');
    await expect(tiles).toContainText('4as is');
    await expect(tiles).toContainText('16with changes');
    await expect(tiles).toContainText('2skipped');
    await expect(tiles).toContainText('3 attachments');
    await expect(d.locator('.jira-summary')).toHaveText(
      'Imports 17 items and 3 checklist steps. Sub-tasks become checklist steps on their parent.',
    );
    const subtasks = d.locator('[data-reason="subtask"]');
    await expect(subtasks).toContainText('3 sub-tasks → checklist steps on their parent');
    await expect(subtasks).toContainText(
      'Kept: title, done or not done, description and dates (in the step’s details), comments (in a note on the parent). Not kept: attachments, labels and links on sub-tasks (each one lists what it had).',
    );
    await expect(d.locator('[data-reason="skip_subtask"]')).toContainText(
      '1 sub-task whose parent isn’t in this import',
    );
    const mapping = d.locator('table.jira-mapping');
    await expect(
      mapping.getByRole('row', { name: /Type: Subtask Checklist step on the parent 3 3/ }),
    ).toBeVisible();
    await expect(mapping.getByRole('row', { name: /Link: Duplicate relates 1 1/ })).toBeVisible();
    await expect(d.getByText('Imported as is. They’ll show under Problems.')).toBeVisible();
    await expect(d.getByText('TL-12 → TL-13 → TL-14 → TL-12')).toBeVisible();
    await expect(d.getByText('Story points → customfield_10016')).toBeVisible();
    await expect(d.getByText('Start date → customfield_10015')).toBeVisible();
    await shoot(page, 'review', d);
    await d.getByText('By field (18)').click();
    await expect(d.getByRole('row', { name: 'Reporter 0 21 —' })).toBeVisible();
    await expect(d.getByRole('row', { name: 'Description 8 1 4' })).toBeVisible();
    await expect(d.getByRole('row', { name: 'Assignee 2 1 —' })).toBeVisible();
    await d.locator('[data-reason="subtask"] summary').click();
    await expect(
      d.getByText('Became a checklist step on TL-2; not kept: 1 attachment', { exact: true }),
    ).toBeVisible();
    await shoot(page, 'subtask-group', subtasks);
    await d.locator('[data-reason="other_type"] summary').click();
    await expect(d.getByText('Jira type Spike imported as Task', { exact: false })).toBeVisible();
    await d.locator('[data-reason="skip_secret"] summary').click();
    await expect(d.getByText('Skipped: its summary looks like a secret (API key)')).toBeVisible();
    // The token never appears again after step 1.
    expect(await page.content()).not.toContain(TOKEN);
    const download = page.waitForEvent('download');
    await d.getByRole('button', { name: 'Download report (JSON)' }).click();
    expect((await download).suggestedFilename()).toBe('jira-dry-run-TL.json');
    await expectAxeClean(page, 'Jira import · review', { include: '.dlg' });
    await shoot(page, 'review-groups', d);

    // Back goes to step 1 (the session is dropped; the token must be entered again).
    await d.getByRole('button', { name: 'Back' }).click();
    await expect(d.locator('[aria-current="step"]')).toHaveText('1 Connect');
    await expect(d.getByLabel('API token')).toHaveValue('');
    await d.getByLabel('API token').fill(TOKEN);
    await d.getByRole('button', { name: 'Run dry run' }).click();
    await expect(d.locator('[aria-current="step"]')).toHaveText('2 Review', { timeout: 30_000 });

    // Step 3: import.
    await d.getByRole('button', { name: 'Import 17 items and 3 checklist steps' }).click();
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

    // Decision 33: the sub-tasks' steps carry their details and link to Jira.
    await page.getByRole('tab', { name: /^Checklist/ }).click();
    const work = page.locator('section[data-section="work"]');
    await expect(
      work.getByRole('button', { name: 'Details for Show inline errors' }),
    ).toBeVisible();
    await expect(work.getByRole('button', { name: 'Details for Copy review' })).toHaveCount(0);
    await work.getByRole('button', { name: 'Details for Show inline errors' }).click();
    const step = page.getByRole('dialog', { name: 'Show inline errors' });
    await expect(step.getByRole('link', { name: 'TL-8 (opens in Jira)' })).toHaveAttribute(
      'href',
      `${SITE}/browse/TL-8`,
    );
    await expect(step.locator('.step-details')).toContainText(
      'Jira TL-8 · assignee Jo Sample · start Nov 2, 2026 · due Dec 4, 2026 · 3 pts',
    );
    await expect(step.getByRole('heading', { name: 'What to show' })).toBeVisible();
    await expect(step.locator('.step-details')).toContainText(
      'From Jira: panel simplified or dropped in the description',
    );
    await expectAxeClean(page, 'Step dialog · imported sub-task', { include: '.dlg' });
    await shoot(page, 'step-dialog', step);
    await page.keyboard.press('Escape');

    // The parent's "Comments from Jira sub-tasks" notes, in History, unread by agents.
    await page.getByRole('tab', { name: /^Activity/ }).click();
    const history = page.locator('section[data-section="history"]');
    const note = history
      .locator('.act')
      .filter({ hasText: 'Comments from Jira sub-tasks (1 of 2)' });
    await expect(note).toContainText('TL-7 Add Luhn check');
    await expect(note).toContainText('Sam Placeholder · 2026-03-06');
    await expect(
      history.locator('.act').filter({ hasText: 'Comments from Jira sub-tasks (2 of 2)' }),
    ).toContainText('TL-8 Show inline errors (continued)');
    await expect(history.locator('[data-notes-unread]')).toHaveText('2 notes not read yet');
    await expectAxeClean(page, 'Imported parent · History', {
      include: '[data-section="history"]',
    });
    await shoot(page, 'subtask-note', note);
  });

  test('a scoped token signs in through the gateway and imports everything there (B32)', async ({
    ownerPage: page,
  }) => {
    const d = await openDialog(page);
    await connect(d, { token: SCOPED, key: 'SCOPE', name: 'Scoped import' });
    await expect(d.locator('[aria-current="step"]')).toHaveText('2 Review', { timeout: 30_000 });
    await expect(d.getByRole('list', { name: 'Dry-run summary' })).toContainText('22issues');
    await d.getByRole('button', { name: 'Import 17 items and 3 checklist steps' }).click();
    // The two attachments that exist were downloaded through the gateway too.
    await expect(d.getByRole('status')).toContainText(
      'Imported 17 items into SCOPE. 1 attachment failed (listed).',
      { timeout: 30_000 },
    );
    await expect(d.getByText('trace.log (TL-2): Jira answered 500')).toBeVisible();
    expect(await page.content()).not.toContain(SCOPED);
  });
});

/**
 * B62 (owner decision 49): Settings → Connections → GitHub in every state, the
 * ticket's panel and Overview's Merged note, by mouse and keyboard, with axe in
 * both themes at 1440 and 1024 px on the stress data, plus the PR's screenshots
 * (DOCKET_E2E_SCREENSHOTS). Nothing reaches GitHub: records are posted the way
 * the host collector posts them. All fixture text is made up.
 */
import { join } from 'node:path';
import type { APIRequestContext, Page } from '@playwright/test';
import { expect, expectAxeClean, setTheme, test, unlock, useSeededContainer } from './fixtures';

useSeededContainer();

const out = process.env.DOCKET_E2E_SCREENSHOTS;
const REPO = 'acme/stress-app';
const SIZES = [
  { name: '1440', width: 1440, height: 900 },
  { name: '1024', width: 1024, height: 768 },
] as const;
const RUN = { ok: true, interval_ms: 300_000 };

test.beforeEach(async ({ page }) => {
  await unlock(page.context());
  await page.context().addInitScript(() => localStorage.setItem('docket.notifications', 'off'));
});

const put = async (request: APIRequestContext, path: string, data: unknown) => {
  const res = await request.put(path, { data });
  expect(res.status(), await res.text()).toBe(200);
};
const post = async (request: APIRequestContext, records: unknown[], run: unknown = RUN) => {
  const res = await request.post('/api/sync/github', { data: { records, run } });
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()) as { accepted: number; changed: number };
};
const connect = async (request: APIRequestContext) => {
  await put(request, '/api/settings/github', { enabled: true });
  await put(request, '/api/settings/github/projects/STR', {
    github_repo: REPO,
    branch_rule: 'warn',
    branch_exempt: ['mergify/*', 'main', '*docket-agent-files*'],
  });
};
const disconnect = async (request: APIRequestContext) => {
  await put(request, '/api/settings/github/projects/STR', {
    github_repo: null,
    branch_rule: 'warn',
    branch_exempt: ['mergify/*', 'main', '*docket-agent-files*'],
  });
  await put(request, '/api/settings/github', { enabled: false });
};

const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
const pr = (number: number, over: Record<string, unknown> = {}) => ({
  key: `${REPO}#${number}`,
  kind: 'pr',
  repo: REPO,
  number,
  title: `Tidy the export screen, part ${number}`,
  head_branch: `sample-dev/STR-${number}-tidy-export`,
  state: 'open',
  draft: false,
  head_sha: 'c'.repeat(40),
  merged_at: null,
  ci: 'passed',
  opened_at: at(120),
  remote_updated_at: at(10),
  related_keys: [],
  ...over,
});
const repoRecord = (ok = true, error: string | null = null) => ({
  key: `repo:${REPO}`,
  kind: 'repo',
  repo: REPO,
  ok,
  error,
  at: at(1),
});

const card = (page: Page) => page.locator('[data-card="github"]');
const section = (page: Page) => page.locator('[data-section="github"]');

test.describe.serial('the GitHub connection', () => {
  test.afterAll(async ({ request }) => {
    await disconnect(request);
  });

  test('is off by default, and tickets show no panel', async ({ page }) => {
    await page.goto('/settings');
    await expect(card(page).locator('[data-github-status="off"]')).toContainText('Off');
    await expect(card(page)).toContainText('stores no GitHub token');
    await expect(card(page).getByRole('checkbox', { name: 'Connect to GitHub' })).not.toBeChecked();
    await page.goto('/items/STR-41');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(section(page)).toHaveCount(0);
  });

  test('walks through every setup state', async ({ page, request }) => {
    await page.goto('/settings');
    const toggle = card(page).getByRole('checkbox', { name: 'Connect to GitHub' });
    await toggle.focus();
    await page.keyboard.press('Space');
    await expect(toggle).toBeChecked();
    await expect(toggle).toBeFocused();
    await expect(card(page).locator('[data-github-status="no_repos"]')).toBeVisible();

    const row = card(page).locator('[data-github-project="STR"]');
    await row.getByRole('textbox', { name: /GitHub repository/ }).fill('not a repo');
    await row.getByRole('button', { name: /^Save/ }).click();
    await expect(row.getByRole('alert')).toContainText('owner/name');
    await row.getByRole('textbox', { name: /GitHub repository/ }).fill(REPO);
    await row.getByRole('button', { name: /^Save/ }).click();
    await expect(card(page).locator('[data-github-status="helper_not_running"]')).toBeVisible();
    await expect(card(page).locator('[data-github-steps]')).toContainText('gh auth login');

    await post(request, [], { ok: false, error: 'gh_signed_out', interval_ms: 300_000 });
    await page.reload();
    await expect(card(page).locator('[data-github-status="gh_signed_out"]')).toContainText(
      'gh not signed in',
    );

    await post(request, [repoRecord()]);
    await page.reload();
    await expect(card(page).locator('[data-github-status="connected"]')).toContainText('Connected');
    await expect(card(page).locator('[data-github-repos]')).toContainText(REPO);
    await expect(card(page).locator('[data-github-steps]')).toHaveCount(0);
  });

  test('shows a ticket’s PR, with Related apart', async ({ page, request }) => {
    await connect(request);
    await post(request, [
      repoRecord(),
      pr(41, { ci: 'failed' }),
      pr(9041, {
        title: 'Shared cleanup across screens',
        head_branch: 'sample-dev/shared-cleanup',
        related_keys: ['STR-41', 'STR-42'],
      }),
      pr(9042, { title: 'merge queue: embarking STR-41', related_keys: ['STR-41'] }),
    ]);
    await page.goto('/items/STR-41');
    const panel = section(page);
    const main = panel.getByRole('list', { name: 'Pull requests for this ticket' });
    await expect(main.getByRole('link', { name: /#41 Tidy the export/ })).toHaveAttribute(
      'href',
      `https://github.com/${REPO}/pull/41`,
    );
    await expect(main).toContainText('CI failed');
    const related = panel.getByRole('list', { name: 'Related pull requests' });
    await expect(related).toContainText('#9041');
    await expect(main).not.toContainText('#9041');
    await expect(panel).not.toContainText('merge queue');
    await expect(panel.locator('[data-github-fresh]')).toContainText('Synced');
  });

  test('Overview says Merged comes from GitHub', async ({ page, request }) => {
    await connect(request);
    await post(request, [repoRecord(), pr(42, { state: 'merged', merged_at: at(30) })]);
    await page.goto('/');
    await expect(page.locator('[data-flow-merged]')).toContainText('Merged counts PRs from GitHub');
  });

  test('turning it off keeps Docket working and labels what is left', async ({ page, request }) => {
    await connect(request);
    await put(request, '/api/settings/github', { enabled: false });
    await page.goto('/items/STR-41');
    await expect(section(page).locator('[data-github-fresh]')).toContainText('isn’t updating');
    await page.goto('/');
    await expect(page.locator('[data-flow-merged]')).toContainText('recorded in Docket');
    await put(request, '/api/settings/github', { enabled: true });
  });

  /** After axe, which leaves the page in its last theme: each shot sets its own. */
  async function shoot(page: Page, name: string, size: (typeof SIZES)[number], onCard: boolean) {
    if (!out) return;
    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme);
      const path = join(out, `b62-${name}-${size.name}-${theme}.png`);
      if (onCard) await card(page).screenshot({ path });
      else await page.screenshot({ path });
    }
  }

  const noSideScroll = async (page: Page) => {
    const over = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(over).toBeLessThanOrEqual(0);
  };

  for (const size of SIZES) {
    test(`axe and layout at ${size.name} on the stress data`, async ({ page, request }) => {
      await connect(request);
      await post(request, [
        repoRecord(),
        pr(41, { ci: 'failed' }),
        pr(43, { state: 'merged', merged_at: at(30), ci: 'passed' }),
        pr(9041, {
          title: 'Shared cleanup across screens',
          head_branch: 'sample-dev/shared-cleanup',
          related_keys: ['STR-41', 'STR-42'],
        }),
      ]);
      await page.setViewportSize({ width: size.width, height: size.height });

      await page.goto('/settings');
      await expect(card(page).locator('[data-github-status="connected"]')).toBeVisible();
      await card(page).scrollIntoViewIfNeeded();
      await noSideScroll(page);
      await expectAxeClean(page, `GitHub settings: ${size.name}`);
      await shoot(page, 'settings-github', size, true);

      await page.goto('/items/STR-41');
      await expect(section(page).getByRole('list').first()).toBeVisible();
      await section(page).scrollIntoViewIfNeeded();
      await noSideScroll(page);
      await expectAxeClean(page, `Ticket GitHub panel: ${size.name}`);
      await shoot(page, 'ticket-github', size, false);

      await post(request, [], { ok: false, error: 'gh_signed_out', interval_ms: 300_000 });
      await page.goto('/settings');
      await expect(card(page).locator('[data-github-steps]')).toBeVisible();
      await card(page).scrollIntoViewIfNeeded();
      await noSideScroll(page);
      await expectAxeClean(page, `GitHub setup steps: ${size.name}`);
      await shoot(page, 'settings-steps', size, true);
      await post(request, [repoRecord()]);
    });
  }
});

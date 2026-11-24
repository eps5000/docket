/**
 * B68 (owner decision 48): the host helper's worktree facts in Settings and the
 * Worktree view, by keyboard, with axe in both themes at 1440 and 1024 px. Every
 * path and branch here is made up.
 */
import type { Page } from '@playwright/test';
import type {
  RepoWorktreeRow,
  SyncSourceResponse,
  WorktreeCleanupResponse,
  WorktreeHostState,
} from '@docket/shared';
import { mockGet } from './fixtures/api-mocks';
import { expect, expectAxeClean, test, unlock, useSeededContainer } from './fixtures';

useSeededContainer();

const SIZES = [
  { name: '1440', width: 1440, height: 900 },
  { name: '1024', width: 1024, height: 768 },
] as const;

test.beforeEach(async ({ page }) => {
  await unlock(page.context());
  await page.context().addInitScript(() => {
    localStorage.setItem('docket.notifications', 'off');
    sessionStorage.setItem('docket.scope', 'STR');
  });
});

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const row = (n: number, over: Partial<RepoWorktreeRow> = {}): RepoWorktreeRow => ({
  path: `C:/Users/sample/worktrees/feature-${n}`,
  branch: `feature/${n}`,
  last_activity_at: ago(3000),
  tracked: false,
  item_id: null,
  item_title: null,
  uncommitted_files: 0,
  unpushed_commits: 0,
  merged: true,
  verdict: 'safe_to_remove',
  why: 'Clean, merged to main, and nothing is running in it.',
  owner: null,
  command: `git -C 'C:/work/app' worktree remove 'C:/Users/sample/worktrees/feature-${n}'`,
  source: 'host',
  ...over,
});

const unknown = (n: number, why: string): RepoWorktreeRow =>
  row(n, {
    verdict: 'unknown',
    why,
    uncommitted_files: null,
    unpushed_commits: null,
    merged: null,
    command: null,
  });

const cleanup = (state: WorktreeHostState, rows: RepoWorktreeRow[]): WorktreeCleanupResponse => ({
  project: 'STR',
  main_branch: 'main',
  repo: 'ok',
  checked_at: ago(1),
  scanning: null,
  host: { state, checked_at: state === 'none' ? null : ago(state === 'fresh' ? 1 : 30) },
  rows,
});

async function openWorktrees(page: Page, data: WorktreeCleanupResponse) {
  await mockGet(page, '/api/workspaces/cleanup', data);
  await page.goto('/agents?worktrees=all#workspaces');
  await expect(page.getByRole('table', { name: 'Every worktree in the repository' })).toBeVisible();
}

const source = (status: Partial<SyncSourceResponse['status']>): SyncSourceResponse => ({
  name: 'worktrees',
  settings: { enabled: true, projects: [] },
  status: {
    last_report_at: null,
    last_success_at: null,
    last_error: null,
    interval_ms: 180_000,
    records_total: 0,
    stale: false,
    ...status,
  },
});

const card = (page: Page) => page.locator('[data-card="worktree-helper"]');

async function openSettings(page: Page, data: SyncSourceResponse, git: SyncSourceResponse = data) {
  await mockGet(page, '/api/sync/worktrees', data);
  // B76: the card shows the git source beside it.
  await mockGet(page, '/api/sync/git', { ...git, name: 'git' });
  await page.goto('/settings');
  await expect(card(page)).toBeVisible();
}

test('the view says when the helper read the worktrees', async ({ page }) => {
  await openWorktrees(page, cleanup('fresh', [row(1), row(2)]));
  await expect(page.locator('[data-worktree-cleanup] [role="status"]')).toContainText(
    'by the helper on this computer',
  );
  await expect(page.locator('[data-worktree-host-hint]')).toHaveCount(0);
  await expect(page.locator('tr[data-worktree]').first()).toHaveAttribute('data-source', 'host');
});

test('with no helper, Unknown rows say how to get an answer', async ({ page }) => {
  const why = 'It’s outside the folder Docket can read, so it can’t be checked.';
  await openWorktrees(page, cleanup('none', [unknown(1, why)]));
  await expect(page.locator('[data-worktree-host-hint="none"]')).toContainText(
    'Settings → Connections → Git checks',
  );
  await expect(page.locator('button.wc-command')).toHaveCount(0);
});

test('stale facts read Unknown and offer no command', async ({ page }) => {
  const why = 'The helper’s last check is too old to rely on.';
  await openWorktrees(page, cleanup('stale', [unknown(1, why), unknown(2, why)]));
  await expect(page.locator('[data-worktree-host-hint="stale"]')).toContainText('checked in');
  await expect(page.locator('tr[data-verdict="unknown"]')).toHaveCount(2);
  await expect(page.locator('tr[data-verdict="safe_to_remove"]')).toHaveCount(0);
  await expect(page.locator('button.wc-command')).toHaveCount(0);
});

test('the real route answers for this source', async ({ request }) => {
  const res = await request.get('/api/sync/worktrees');
  expect(res.status()).toBe(200);
  const body = (await res.json()) as SyncSourceResponse;
  expect(body.name).toBe('worktrees');
});

test('Settings shows each helper state in words', async ({ page }) => {
  await openSettings(page, source({}));
  await expect(card(page).locator('[data-worktree-helper="not_running"]')).toContainText(
    'Helper not running',
  );
  await expect(card(page).locator('[data-worktree-helper-steps]')).toContainText('manage.ps1');

  await openSettings(page, source({ last_success_at: ago(2), last_report_at: ago(2) }));
  await expect(card(page).locator('[data-worktree-helper="ok"]')).toContainText('Up to date');
  await expect(card(page).locator('[data-worktree-helper-steps]')).toHaveCount(0);

  await openSettings(page, source({ last_success_at: ago(40), stale: true }));
  await expect(card(page).locator('[data-worktree-helper="stale"]')).toContainText('Out of date');

  await openSettings(page, source({ last_error: 'git_missing', last_report_at: ago(1) }));
  await expect(card(page).locator('[data-worktree-helper="failed"]')).toContainText(
    'Git wasn’t found on this computer',
  );
});

test('the helper steps can be reached by keyboard', async ({ page }) => {
  await openSettings(page, source({}));
  const step = card(page).locator('pre.code').first();
  await step.focus();
  await expect(step).toBeFocused();
});

for (const size of SIZES) {
  test(`the view: axe and no overflow at ${size.name}`, async ({ page }) => {
    await page.setViewportSize({ width: size.width, height: size.height });
    const why = 'The helper’s last check is too old to rely on.';
    await openWorktrees(page, cleanup('stale', [unknown(1, why), row(2)]));
    await expectAxeClean(page, `Worktrees with stale helper facts at ${size.name}`);
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(width).toBeLessThanOrEqual(size.width);
  });

  test(`Settings: axe and no overflow at ${size.name}`, async ({ page }) => {
    await page.setViewportSize({ width: size.width, height: size.height });
    await openSettings(page, source({ last_error: 'git_missing', last_report_at: ago(1) }));
    await card(page).scrollIntoViewIfNeeded();
    await expectAxeClean(page, `The worktree helper card at ${size.name}`);
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(width).toBeLessThanOrEqual(size.width);
  });
}

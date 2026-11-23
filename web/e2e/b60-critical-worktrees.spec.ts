/**
 * B60 (owner decision 48): the critical path on the stress project's real
 * chain, and the worktree cleanup view on made-up rows, by mouse and keyboard,
 * with axe in both themes at 1440 and 1024 px, plus the PR's screenshots
 * (DOCKET_E2E_SCREENSHOTS).
 */
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import type {
  CriticalPathResponse,
  RepoWorktreeRow,
  WorktreeCleanupResponse,
  WorktreeVerdict,
} from '@docket/shared';
import { mockGet } from './fixtures/api-mocks';
import { expect, expectAxeClean, setTheme, test, unlock, useSeededContainer } from './fixtures';

useSeededContainer();

const out = process.env.DOCKET_E2E_SCREENSHOTS;
const SIZES = [
  { name: '1440', width: 1440, height: 900 },
  { name: '1024', width: 1024, height: 768 },
] as const;

/** The stress seed's blocked chain: STR-160 → … → STR-164. */
const GOAL = 'STR-164';

test.beforeEach(async ({ page }) => {
  await unlock(page.context());
  await page.context().addInitScript(() => {
    localStorage.setItem('docket.notifications', 'off');
    sessionStorage.setItem('docket.scope', 'STR');
  });
});

const panel = (page: Page) => page.locator('[data-critical-path]');
const nextLine = (page: Page) => page.locator('[data-critical-next]');

async function openGoal(page: Page) {
  await page.goto(`/work?layout=map&goal=${GOAL}`);
  await expect(nextLine(page)).toBeVisible();
  await expect(page.locator('.pm-node.crit').first()).toBeVisible();
}

const row = (n: number, verdict: WorktreeVerdict, over: Partial<RepoWorktreeRow> = {}) =>
  ({
    path: `C:/work/repo-wt/feature-${n}`,
    branch: `feature/${n}`,
    last_activity_at: new Date(Date.now() - (n + 2) * 3_600_000).toISOString(),
    tracked: n % 3 !== 0,
    item_id: n % 3 !== 0 ? `STR-${40 + (n % 100)}` : null,
    item_title: n % 3 !== 0 ? `Stress ticket ${n}` : null,
    uncommitted_files: 0,
    unpushed_commits: 0,
    merged: true,
    verdict,
    why: 'Clean, merged to main, and nothing is running in it.',
    owner: null,
    command: null,
    ...over,
  }) satisfies RepoWorktreeRow;

/** 180 worktrees across every verdict. */
function manyWorktrees(): WorktreeCleanupResponse {
  const rows: RepoWorktreeRow[] = [];
  for (let n = 1; n <= 180; n += 1) {
    if (n % 9 === 0) {
      rows.push(
        row(n, 'holds_work', {
          uncommitted_files: 3,
          unpushed_commits: 2,
          merged: false,
          why: 'It has 3 uncommitted files and 2 commits not on a remote.',
          owner: n % 2 ? 'you' : 'agents',
        }),
      );
    } else if (n % 7 === 0) {
      rows.push(row(n, 'in_use', { why: 'A run is working here.' }));
    } else if (n % 5 === 0) {
      rows.push(
        row(n, 'unknown', {
          uncommitted_files: null,
          unpushed_commits: null,
          merged: null,
          why: 'It’s outside the folder Docket can read, so it can’t be checked.',
        }),
      );
    } else if (n % 11 === 0) {
      rows.push(row(n, 'kept_for_later', { why: 'You chose to keep this for later.' }));
    } else {
      rows.push(
        row(n, 'safe_to_remove', {
          command: `git -C 'C:/work/repo' worktree remove 'C:/work/repo-wt/feature-${n}'`,
        }),
      );
    }
  }
  return {
    project: 'STR',
    main_branch: 'main',
    repo: 'ok',
    checked_at: new Date(Date.now() - 60_000).toISOString(),
    scanning: null,
    rows,
  };
}

async function openWorktrees(page: Page) {
  await mockGet(page, '/api/workspaces/cleanup', manyWorktrees());
  await page.goto('/agents?worktrees=all#workspaces');
  await expect(page.getByRole('table', { name: 'Every worktree in the repository' })).toBeVisible();
}

test('the real chain: the map, the reason and the list agree', async ({ page }) => {
  await openGoal(page);
  const data = (await page.evaluate(
    async (id) => (await (await fetch(`/api/items/${id}/critical-path`)).json()) as unknown,
    GOAL,
  )) as CriticalPathResponse;
  expect(data.chain.map((s) => s.item.id)).toEqual([
    'STR-160',
    'STR-161',
    'STR-162',
    'STR-163',
    'STR-164',
  ]);
  await expect(nextLine(page)).toHaveAttribute('data-critical-next', data.next!.id);
  await expect(nextLine(page)).toContainText(data.next!.why);

  // Every step is on the map, numbered in words.
  for (const [k, s] of data.chain.entries()) {
    const card = page.locator(`[data-pid="${s.item.id}"]`);
    await expect(card).toContainText(`Step ${k + 1} of ${data.chain.length}`);
  }
  await expect(page.locator('.pm-node.critnext')).toContainText('Move next');

  // The text alternative is the same chain, in order.
  await panel(page).locator('summary').click();
  const items = panel(page).locator('ol > li');
  await expect(items).toHaveCount(data.chain.length);
  for (const [k, s] of data.chain.entries()) {
    await expect(items.nth(k)).toContainText(s.item.id);
  }
});

test('a goal is chosen and cleared by keyboard', async ({ page }) => {
  await page.goto('/work?layout=map');
  const select = page.getByLabel('What’s holding up');
  await expect(select).toBeVisible();
  await select.focus();
  await select.selectOption(GOAL);
  await expect(page).toHaveURL(new RegExp(`goal=${GOAL}`));
  await expect(nextLine(page)).toBeVisible();
  const clear = page.getByRole('button', { name: 'Clear goal' });
  await clear.focus();
  await page.keyboard.press('Enter');
  await expect(page).not.toHaveURL(/goal=/);
  await expect(page.locator('.pm-node.crit')).toHaveCount(0);
});

test('the ticket and epic pages link to it', async ({ page }) => {
  await page.goto(`/items/${GOAL}?tab=deps`);
  await page.getByRole('link', { name: /See what’s holding this up/ }).click();
  await expect(page).toHaveURL(new RegExp(`goal=${GOAL}`));
  await expect(nextLine(page)).toBeVisible();

  await page.goto('/items/STR-3?tab=map');
  await page.getByRole('link', { name: /See what’s holding this epic up/ }).click();
  await expect(page).toHaveURL(/goal=STR-3/);
  await expect(panel(page).locator('[data-critical-next]')).toBeVisible();
});

test('the read is fast on the stress project', async ({ page }) => {
  await page.goto('/work?layout=map');
  const ms = await page.evaluate(async (id) => {
    const started = performance.now();
    await (await fetch(`/api/items/${id}/critical-path`)).json();
    return performance.now() - started;
  }, GOAL);
  expect(ms).toBeLessThan(1_000);
});

test('worktrees are grouped, and only Safe to remove has a command', async ({ page }) => {
  await openWorktrees(page);
  const groups = page.locator('[data-verdict-group]');
  await expect(groups).toHaveCount(5);
  await expect(groups.nth(0)).toHaveAttribute('data-verdict-group', 'holds_work');
  await expect(groups.nth(4)).toHaveAttribute('data-verdict-group', 'safe_to_remove');

  expect(await page.locator('tr:not([data-verdict="safe_to_remove"]) .wc-command').count()).toBe(0);
  await expect(page.getByText('Docket never removes a worktree.', { exact: false })).toBeVisible();
  await expect(page.getByText('Not tracked by Docket').first()).toBeVisible();

  // A value git couldn't read says so.
  const unknown = page.locator('tr[data-verdict="unknown"]').first();
  await expect(unknown).toContainText('Unknown');
  await expect(unknown).toContainText('can’t be checked');
});

test('worktree filters narrow hundreds of rows', async ({ page }) => {
  await openWorktrees(page);
  await page.getByRole('button', { name: /^Holds work/ }).click();
  await expect(page.locator('[data-verdict-group]')).toHaveCount(1);
  await page.getByRole('button', { name: /^Holds work/ }).click();

  await page.getByLabel('Filter by branch, ticket or folder').fill('feature/18');
  await expect(page.locator('tr[data-worktree]').first()).toContainText('feature/18');
  await page.getByLabel('Filter by branch, ticket or folder').fill('');

  const safe = page.locator('[data-verdict-group="safe_to_remove"]');
  await expect(safe.locator('tr[data-worktree]')).toHaveCount(50);
  await safe.getByRole('button', { name: /Show all/ }).click();
  expect(await safe.locator('tr[data-worktree]').count()).toBeGreaterThan(50);
});

for (const size of SIZES) {
  test(`critical path: axe, no overflow and screenshots at ${size.name}`, async ({ page }) => {
    await page.setViewportSize({ width: size.width, height: size.height });
    await openGoal(page);
    await panel(page).locator('summary').click();
    await expectAxeClean(page, `Critical path at ${size.name}`);
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(width).toBeLessThanOrEqual(size.width);
    if (out) {
      for (const theme of ['light', 'dark'] as const) {
        await setTheme(page, theme);
        await page.screenshot({ path: join(out, `b60-critical-path-${size.name}-${theme}.png`) });
      }
    }
  });

  test(`worktrees: axe, no overflow and screenshots at ${size.name}`, async ({ page }) => {
    await page.setViewportSize({ width: size.width, height: size.height });
    await openWorktrees(page);
    await page.locator('.wc-command summary').first().click();
    await expectAxeClean(page, `Every worktree at ${size.name}`);
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(width).toBeLessThanOrEqual(size.width);
    if (out) {
      await page.locator('[data-worktree-cleanup]').scrollIntoViewIfNeeded();
      for (const theme of ['light', 'dark'] as const) {
        await setTheme(page, theme);
        await page.screenshot({ path: join(out, `b60-worktrees-${size.name}-${theme}.png`) });
      }
    }
  });
}

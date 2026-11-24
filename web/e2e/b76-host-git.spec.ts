/**
 * B76: Docket runs no git; the helper on the host reads the repository. The
 * radar card, the Git checks card and the Worktrees view say when they're
 * waiting for the helper and when its facts are stale, in words, with how to
 * turn it on, and axe is clean in both themes on each. The spec plays the
 * helper: a fixture repository on this machine, read by the real git source
 * and posted to Docket. Every repository and branch here is made up.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { baseURL } from './container';
import {
  expect,
  expectAxeClean,
  resetSeededContainer,
  test,
  unlock,
  useSeededContainer,
} from './fixtures/index';
import { hostFolder, hostGit, hostGitPass } from './fixtures/host-git';

useSeededContainer();
test.describe.configure({ mode: 'serial' });

const host = hostFolder('docket-e2e-b76-');
const REPO = `${host.dir}/helper-app`;

function makeRepo() {
  const g = (...args: string[]) => hostGit(REPO, host.dir, ...args);
  mkdirSync(REPO, { recursive: true });
  g('init', '-q', '-b', 'main');
  writeFileSync(join(REPO, 'notes.txt'), 'one\ntwo\n');
  g('add', 'notes.txt');
  g('commit', '-q', '-m', 'start');
}

async function owner(page: Page, method: 'GET' | 'POST' | 'PUT', path: string, data?: unknown) {
  if (!(await page.context().cookies()).some((c) => c.name === 'docket_csrf')) {
    await page.request.get('/api/bootstrap');
  }
  const csrf = (await page.context().cookies()).find((c) => c.name === 'docket_csrf')?.value ?? '';
  const r = await page.request.fetch(path, {
    method,
    data,
    headers: method === 'GET' ? {} : { 'x-docket-csrf': csrf, origin: baseURL },
  });
  expect(r.ok(), `${method} ${path}: ${await r.text()}`).toBe(true);
  return (await r.json()) as Record<string, unknown>;
}

test.beforeAll(() => makeRepo());

test.afterAll(async () => {
  test.setTimeout(120_000);
  try {
    host.remove();
  } finally {
    await resetSeededContainer();
  }
});

test.beforeEach(async ({ page }) => {
  await unlock(page.context());
  await page.context().addInitScript(() => {
    localStorage.setItem('docket.notifications', 'off');
    sessionStorage.setItem('docket.scope', 'RCP');
  });
});

const radarCard = (page: Page) => page.locator('[data-card="radar"]');

test('the radar waits for the host helper, in words, with how to turn it on', async ({ page }) => {
  await owner(page, 'PUT', '/api/projects/RCP/radar', { repo_path: REPO, main_branch: 'main' });
  await page.goto('/settings/projects/RCP/shared-parts');
  const card = radarCard(page);
  await expect(card.getByText('Waiting for the helper', { exact: true })).toBeVisible();
  const note = card.locator('[data-radar-helper="waiting"]');
  await expect(note).toContainText('Waiting for the host helper.');
  await expect(note.getByRole('link', { name: /Git checks/ })).toBeVisible();
  // Run radar now says nothing was checked.
  await card.getByRole('button', { name: 'Run radar now' }).click();
  await expect(
    page.locator('.toast').filter({ hasText: 'Waiting for the host helper: nothing was checked.' }),
  ).toBeVisible();
  await expectAxeClean(page, 'the radar card, waiting for the host helper');
});

test('facts older than three passes read as out of date, never as clear', async ({ page }) => {
  await hostGitPass(page.request, host.dir, { ageMs: 20 * 60_000 });
  await page.goto('/settings/projects/RCP/shared-parts');
  const card = radarCard(page);
  await expect(card.getByText('Out of date', { exact: true })).toBeVisible();
  const note = card.locator('[data-radar-helper="stale"]');
  await expect(note).toContainText('The host helper’s facts are out of date');
  await expect(note).toContainText('none clears until it reports again');
  await expectAxeClean(page, 'the radar card, stale helper facts');
});

test('a fresh pass from the helper turns the radar on', async ({ page }) => {
  await hostGitPass(page.request, host.dir);
  await page.goto('/settings/projects/RCP/shared-parts');
  const card = radarCard(page);
  await expect(card.locator('[data-radar-helper]')).toHaveCount(0);
  await card.getByRole('button', { name: 'Run radar now' }).click();
  await expect(
    page.locator('.toast').filter({ hasText: 'Radar run: no conflicts ahead.' }),
  ).toBeVisible();
  await expect(card.getByText('On', { exact: true })).toBeVisible();
});

test('Settings → Git checks shows the git source, and the Worktrees view waits for the helper', async ({
  page,
}) => {
  await page.goto('/settings');
  const card = page.locator('[data-card="worktree-helper"]');
  await expect(card.getByRole('heading', { name: 'Git checks' })).toBeVisible();
  await expect(card.locator('[data-git-helper="ok"]')).toContainText('Up to date');
  await expect(card.locator('[data-worktree-helper="not_running"]')).toContainText(
    'Helper not running',
  );
  await card.scrollIntoViewIfNeeded();
  await expectAxeClean(page, 'the Git checks card');

  // No worktree facts yet: the view says it waits for the helper, not "checking".
  await page.goto('/agents?worktrees=all#workspaces');
  const empty = page.locator('[data-worktree-host-empty="none"]');
  await expect(empty).toContainText('Waiting for the host helper.');
  await expectAxeClean(page, 'the Worktrees view, waiting for the host helper');
});

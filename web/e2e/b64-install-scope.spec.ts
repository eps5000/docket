/**
 * B64 (owner decision 50): installs are per project. All projects shows each
 * project's real state and asks which to install into, a worktree install says
 * so, a legacy user-wide row is history with *Mark as removed* and Undo, and
 * any install has a generated, reviewable uninstall. Runs on the stress data,
 * with axe in both themes at 1440 and 1024 px, plus the PR's screenshots
 * (DOCKET_E2E_SCREENSHOTS). All fixture text is made up, and no command is run.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, expectAxeClean, setTheme, test, useSeededContainer } from './fixtures/index';
import { CONTAINER } from './fixtures/container';

useSeededContainer();
test.describe.configure({ mode: 'serial' });

const out = process.env.DOCKET_E2E_SCREENSHOTS;
const SIZES = [
  { name: '1440', width: 1440, height: 900 },
  { name: '1024', width: 1024, height: 768 },
] as const;
const AT = '2026-11-23T10:00:00.000Z';
const HASH = 'a'.repeat(64);
const MANIFEST = JSON.stringify({
  'skill:docket-worker': { version_id: 'afv_synthetic', sha256: HASH },
  agents_block: { version_id: 'afv_synthetic2', sha256: HASH },
});
const WORKTREE = 'C:/worktrees/synthetic-feature';
const LEGACY = 'ins_b64legacy';

function sql(statements: [string, unknown[]][]): void {
  const script =
    "const D=require('better-sqlite3');const db=new D('/data/docket.db');db.pragma('busy_timeout = 5000');" +
    'for (const [q, a] of JSON.parse(process.argv[1])) db.prepare(q).run(...a);db.close();';
  execFileSync(
    'docker',
    ['exec', '-w', '/app/server', CONTAINER, 'node', '-e', script, JSON.stringify(statements)],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

const installRow = (
  id: string,
  client: string,
  target: string,
  project: string | null,
  path: string | null,
): [string, unknown[]] => [
  `INSERT INTO installs (id, at, client, target_kind, project_key, path, method, manifest,
     token_used_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'command', ?, ?, ?, ?)`,
  [id, AT, client, target, project, path, MANIFEST, AT, AT, AT],
];

async function noSideScroll(page: Page) {
  const over = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(over).toBeLessThanOrEqual(0);
}

/** axe in both themes and no sideways scroll at each size, with the PR's screenshots. */
async function checkSizes(
  page: Page,
  name: string,
  label: string,
  opts: { include?: string; at?: string } = {},
) {
  for (const size of SIZES) {
    await page.setViewportSize({ width: size.width, height: size.height });
    await noSideScroll(page);
    await expectAxeClean(
      page,
      `${label} at ${size.name}`,
      opts.include ? { include: opts.include } : {},
    );
    if (out) {
      // Each shot opens on the part of the page it's evidence for.
      if (opts.at) {
        await page
          .locator(opts.at)
          .first()
          .evaluate((el) => el.scrollIntoView({ block: 'start' }));
      }
      for (const theme of ['light', 'dark'] as const) {
        await setTheme(page, theme);
        await page.screenshot({ path: join(out, `b64-${name}-${size.name}-${theme}.png`) });
      }
      await setTheme(page, 'light');
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

const overviewCard = (page: Page) => page.locator('[data-install-overview]');

test.describe('Installs stay in scope (decision 50)', () => {
  test('1. nothing installed: the main action is to choose a project', async ({
    ownerPage: page,
  }) => {
    await page.route('**/api/install-overview', (r) => r.fulfill({ json: { rows: [] } }));
    await page.goto('/agent-files?project=all');
    const card = overviewCard(page);
    await expect(card).toContainText('Nothing is installed yet. Choose a project');
    await expect(card.getByLabel('Project', { exact: true })).toBeVisible();
    await expect(card.getByRole('button', { name: 'Install into its repo' })).toBeVisible();
    await expect(page.getByRole('button', { name: /user-wide/i })).toHaveCount(0);
    await checkSizes(page, 'none', 'All projects, nothing installed', {
      at: '[data-install-overview]',
    });
    await page.unroute('**/api/install-overview');
  });

  test('2. each project’s real state; a legacy install counts for none of them', async ({
    ownerPage: page,
  }) => {
    sql([
      installRow('ins_b64repo', 'claude', 'repo', 'RCP', 'C:/code/synthetic-recipes'),
      installRow('ins_b64wt', 'codex', 'repo', 'RCP', WORKTREE),
      installRow(LEGACY, 'claude', 'user', null, null),
      [
        `INSERT INTO runs (id, item_id, client, is_lead, state, last_signal_at, last_signal_kind,
           workspace, created_at, updated_at)
         VALUES ('run_b64wt', 'RCP-25', 'codex', 0, 'finished', ?, 'session', ?, ?, ?)`,
        [
          AT,
          JSON.stringify({
            path: WORKTREE,
            branch: 'synthetic/feature',
            repo: 'C:/code/synthetic-recipes',
            base_ref: 'origin/main',
            updated_at: AT,
          }),
          AT,
          AT,
        ],
      ],
    ]);
    await page.goto('/agent-files?project=all');
    const card = overviewCard(page);
    const table = card.getByRole('table', { name: 'Install state by project' });
    await expect(
      table.locator('[data-overview-project="RCP"][data-overview-client="claude"]'),
    ).toContainText('C:/code/synthetic-recipes');
    await expect(table.locator('[data-worktree="synthetic-feature"]')).toContainText(
      'Installed in worktree synthetic-feature, not merged yet',
    );
    // A project with no install of its own is not rescued by the legacy row.
    await expect(table.locator('[data-overview-project="STR"]')).toContainText('Not installed');
    await expect(table).not.toContainText('User-wide');
    await expect(page.locator(`[data-install-row="${LEGACY}"]`)).toContainText(
      'User-wide (no longer supported)',
    );
    await checkSizes(page, 'overview', 'All projects, install state', {
      at: '[data-install-overview]',
    });
    await checkSizes(page, 'legacy-log', 'Install log with a legacy row', {
      at: '[data-install-log]',
    });
  });

  test('3. a project’s card names the worktree', async ({ ownerPage: page }) => {
    await page.goto('/agent-files?project=RCP');
    const row = page.locator('[data-install-state-row="codex"]');
    await expect(row).toContainText('Installed in worktree synthetic-feature, not merged yet');
    await checkSizes(page, 'project', 'One project, install state', { at: '[data-install-state]' });
  });

  test('4. Mark as removed on a legacy row, with Undo', async ({ ownerPage: page }) => {
    await page.goto('/agent-files?project=all');
    const row = page.locator(`[data-install-row="${LEGACY}"]`);
    await row.getByRole('button', { name: /^Mark as removed/ }).click();
    await expect(row).toHaveAttribute('data-removed', 'true');
    await expect(row).toContainText('You marked this as removed outside Docket');
    await expect(row).toBeFocused();
    await row.scrollIntoViewIfNeeded();
    await expectAxeClean(page, 'Install log, marked as removed', {
      include: '[data-install-log]',
    });
    await page.locator('.toast').getByRole('button', { name: 'Undo' }).click();
    await expect(row).not.toHaveAttribute('data-removed', 'true');
    await expect(row.getByRole('button', { name: /^Mark as removed/ })).toBeVisible();
  });

  test('5. Uninstall: the rules, then a reviewable command', async ({ ownerPage: page }) => {
    await page.goto('/agent-files?project=RCP');
    const row = page.locator('[data-install-state-row="claude"]');
    await row.getByRole('button', { name: /^Uninstall Claude Code/ }).click();
    const d = page.getByRole('dialog', { name: /^Uninstall Claude Code/ });
    await expect(d.locator('[data-uninstall-dialog]')).toContainText('A file you changed is kept');
    await checkSizes(page, 'uninstall-rules', 'Uninstall dialog', { include: '[role="dialog"]' });
    await d.getByRole('button', { name: 'Create the command' }).click();
    const result = d.locator('[data-uninstall-result]');
    await expect(result).toBeFocused();
    await expect(result.locator('.incopy pre').first()).toBeVisible();
    await result.locator('[data-uninstall-script] summary').click();
    await expect(result.locator('[data-uninstall-script]')).toContainText(
      'never deletes a folder that still holds anything',
    );
    await checkSizes(page, 'uninstall-command', 'Uninstall command', {
      include: '[role="dialog"]',
    });
    await d.getByRole('button', { name: 'Done' }).click();
    await expect(d).toHaveCount(0);
  });

  test('6. a new user-wide install is refused by the API', async ({ ownerPage: page }) => {
    await page.goto('/agent-files?project=all');
    const res = await page.evaluate(async () => {
      const csrf = document.cookie.match(/docket_csrf=([^;]+)/)?.[1] ?? '';
      const r = await fetch('/api/installs', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-docket-csrf': csrf },
        body: JSON.stringify({ client: 'claude', target_kind: 'user', method: 'command' }),
      });
      return { status: r.status, text: await r.text() };
    });
    expect(res.status).toBe(400);
    expect(res.text).toContain('no longer supported');
  });
});

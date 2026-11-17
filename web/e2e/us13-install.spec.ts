/**
 * Install and check (tasks.md T155, T156; spec US13 acceptance scenarios 4
 * and 5; UI_SPEC §6.7b; FR-124 to FR-127).
 *
 * The instance runs with a push root inside the container
 * (docker/compose.push-e2e.yaml: `/tmp/host-code`, shown as
 * `C:/Users/owner/code`). One walkthrough, in order:
 * 1. the push folder card: not set up (the API answer stubbed: the how-to),
 *    then configured but missing (Not writable; Test says why), then ready
 *    (Test writes and removes a probe);
 * 2. the Install dialog for RCP: the placeholder warning, then *Install
 *    anyway* by push into a repo that has its own CLAUDE.md: what changed,
 *    the files in the container, and CLAUDE.md byte-identical outside the
 *    markers;
 * 3. the install log: *Check* says Up to date; after an installed file is
 *    edited and another deleted, *Check* lists them, with the diff;
 *    reinstalling restores them;
 * 4. the command: the PowerShell and bash commands with *Copy* and "Run from
 *    the repo folder"; its download is logged, works once, and the log row
 *    gives the check command;
 * 5. without a push folder (stubbed), the dialog falls back to the command
 *    and says why.
 *
 * axe is clean on each screen, both themes. Set TASKLITE_E2E_SCREENSHOTS to
 * a folder to capture the PR's light and dark screenshots.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import type { PushTargetResponse } from '@tasklite/shared';
import { baseURL } from './container';
import {
  expect,
  expectAxeClean,
  resetSeededContainer,
  setTheme,
  test,
  useSeededContainer,
} from './fixtures/index';
import { CONTAINER } from './fixtures/container';

useSeededContainer();

const ROOT = '/tmp/host-code';
const REPO = `${ROOT}/recipes`;
const PRE =
  '# Recipes\n\nOur own rules: keep them exactly as they are.\n\n## Build\n`pnpm build`\n';

function sh(script: string): string {
  return execFileSync('docker', ['exec', CONTAINER, 'sh', '-c', script], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

test.afterAll(async () => {
  test.setTimeout(120_000);
  try {
    sh(`rm -rf ${ROOT}`);
  } finally {
    await resetSeededContainer();
  }
});

const out = process.env.TASKLITE_E2E_SCREENSHOTS;
async function shoot(page: Page, name: string, target: Locator) {
  if (!out) return;
  for (const theme of ['light', 'dark'] as const) {
    await setTheme(page, theme);
    await target.screenshot({ path: join(out, `us13-install-${name}-${theme}.png`) });
  }
  await setTheme(page, 'light');
}

const card = (page: Page) => page.locator('[data-card="push-folder"]');
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Install agent files' });
const logRows = (page: Page) => page.locator('[data-install-log] [data-install-row]');

const UNSET: PushTargetResponse = {
  configured: false,
  writable: null,
  container_path: null,
  host_path: null,
};

test.describe.configure({ mode: 'serial' });

test.describe('Install and check (US13)', () => {
  test.beforeAll(() => {
    sh(`rm -rf ${ROOT}`);
  });

  test('1. the push folder card: not set up, not writable, ready', async ({ ownerPage: page }) => {
    // Not set up (stubbed): the plain how-to, with Copy on each snippet.
    await page.route('**/api/push-target', (route) =>
      route.request().method() === 'GET' ? route.fulfill({ json: UNSET }) : route.continue(),
    );
    await page.goto('/settings/agent-setup');
    const c = card(page);
    await expect(c.getByText('Not set up')).toBeVisible();
    await expect(
      c.getByText('Mount your code folder into Task Lite so it can install files for you.'),
    ).toBeVisible();
    const howto = c.locator('[data-push-howto]');
    await howto
      .getByLabel('Your code folder (the one that holds your repos)')
      .fill('C:/Users/owner/code');
    await expect(howto.locator('pre').first()).toHaveText('      - C:/Users/owner/code:/host-code');
    await expect(howto.locator('pre').nth(1)).toHaveText(
      'TASKLITE_PUSH_ROOT=/host-code\nTASKLITE_PUSH_HOST_PATH=C:/Users/owner/code',
    );
    await expect(howto.getByRole('button', { name: 'Copy' })).toHaveCount(3);
    await shoot(page, '1-push-folder-unset', c);
    await expectAxeClean(page, 'Agent setup: push folder not set up', {
      include: '[data-card="push-folder"]',
    });
    await page.unroute('**/api/push-target');

    // Configured, but the folder isn't there: Not writable, and Test says why.
    await page.reload();
    await expect(c.getByText('Not writable')).toBeVisible();
    await c.getByRole('button', { name: 'Test' }).click();
    await expect(c.getByRole('status').filter({ hasText: "isn't mounted" })).toBeVisible();

    // The folder exists: Ready, and Test writes and removes a probe.
    sh(`mkdir -p ${REPO}/.git && printf '%s' '${PRE.replace(/'/g, "'\\''")}' > ${REPO}/CLAUDE.md`);
    await page.reload();
    await expect(c.getByText('Ready')).toBeVisible();
    await expect(c.getByText('C:/Users/owner/code')).toBeVisible();
    await expect(c.getByText(ROOT, { exact: true })).toBeVisible();
    await c.getByRole('button', { name: 'Test' }).click();
    await expect(
      c.getByText('Wrote and removed a test file in C:/Users/owner/code. Push install works.'),
    ).toBeVisible();
    expect(sh(`ls -A ${ROOT}`).trim()).toBe('recipes');
    await shoot(page, '1-push-folder-set', c);
    await expectAxeClean(page, 'Agent setup: push folder ready', {
      include: '[data-card="push-folder"]',
    });
  });

  test('2. push install for RCP: the placeholder warning, then what changed', async ({
    ownerPage: page,
  }) => {
    await page.goto('/settings/agent-setup?project=RCP');
    await page.locator('[data-install-footer]').getByRole('button', { name: 'Install…' }).click();
    const d = dialog(page);
    await expect(d).toBeVisible();
    await expect(
      d.getByRole('group', { name: 'Client' }).getByRole('button', { name: 'Claude Code' }),
    ).toHaveAttribute('aria-pressed', 'true');
    await expect(
      d.getByRole('group', { name: 'How' }).getByRole('button', { name: /Push/ }),
    ).toHaveAttribute('aria-pressed', 'true');
    // What will be written, and only the marked section of CLAUDE.md.
    const what = d.locator('[data-install-what]');
    await expect(what).toContainText('.claude/skills/tasklite-worker/SKILL.md');
    await expect(what).toContainText('.claude/.tasklite-manifest.json');
    await expect(what).toContainText('Only the marked Task Lite section of CLAUDE.md is touched');
    // The bundled block still has placeholders ({{KEY}} is filled for RCP's repo).
    const warn = d.locator('[data-placeholder-warning]');
    await expect(warn).toContainText(/This block still has \d+ placeholders: /);
    await expect(warn).not.toContainText('{{KEY}}');
    await expect(warn).toContainText('Edit this project’s AGENTS.md block first.');
    await d.getByLabel('Repo folder').fill('C:/Users/owner/code/recipes');
    await shoot(page, '2-dialog-push-warning', d);
    await expectAxeClean(page, 'Install dialog: push, placeholder warning', {
      include: '[role="dialog"]',
    });

    await d.getByRole('button', { name: 'Install anyway' }).click();
    const result = d.locator('[data-install-result="push"]');
    await expect(result).toContainText(
      'Installed. Logged in the install log with every file’s version.',
    );
    await expect(result.locator('li').filter({ hasText: 'CLAUDE.md' })).toContainText('Updated');
    await expect(
      result.locator('li').filter({ hasText: '.claude/skills/tasklite-worker/SKILL.md' }),
    ).toContainText('Created');
    await shoot(page, '2-dialog-push-result', d);
    await expectAxeClean(page, 'Install dialog: push result', { include: '[role="dialog"]' });

    // The files are there; CLAUDE.md keeps its own text byte for byte, then the section.
    const claude = sh(`cat ${REPO}/CLAUDE.md`);
    expect(claude.startsWith(`${PRE}\n<!-- tasklite:begin -->\n## Work tracking: Task Lite`)).toBe(
      true,
    );
    expect(claude).toContain('project key **RCP**');
    expect(claude.endsWith('<!-- tasklite:end -->\n')).toBe(true);
    expect(sh(`ls ${REPO}/.claude/skills`).trim().split('\n')).toEqual([
      'tasklite-coordinator',
      'tasklite-lead-subagents',
      'tasklite-planner',
      'tasklite-review-packet',
      'tasklite-worker',
    ]);
    await d.getByRole('button', { name: 'Done' }).click();
    await expect(d).toBeHidden();
  });

  test('3. the install log: Check, a local edit and a delete, the diff, and a reinstall', async ({
    ownerPage: page,
  }) => {
    await page.goto('/settings/agent-setup?project=RCP');
    const row = logRows(page).first();
    await expect(row).toHaveAttribute('data-method', 'push');
    await expect(row).toContainText('Claude Code');
    await expect(row).toContainText('6 files');
    await row.getByRole('button', { name: 'Versions sent' }).click();
    await expect(row.locator('[data-sent="skill:tasklite-worker"]')).toContainText('Bundled v1');
    await row.getByRole('button', { name: 'Check', exact: true }).click();
    await expect(row.locator('[data-check-result="up_to_date"]')).toContainText('Up to date');

    // Edit one installed file by hand and delete another.
    sh(
      `printf '\\nLocal tweak: we squash on merge.\\n' >> ${REPO}/.claude/skills/tasklite-worker/SKILL.md && rm ${REPO}/.claude/skills/tasklite-planner/SKILL.md`,
    );
    await row.getByRole('button', { name: 'Check', exact: true }).click();
    const result = row.locator('[data-check-result="differs"]');
    await expect(result).toContainText('2 files differ from what Task Lite sent');
    const edited = result.locator('[data-check-file=".claude/skills/tasklite-worker/SKILL.md"]');
    await expect(edited).toContainText('Edited locally');
    await expect(
      result.locator('[data-check-file=".claude/skills/tasklite-planner/SKILL.md"]'),
    ).toContainText('Missing');
    await edited.getByRole('button', { name: 'Show diff' }).click();
    await expect(edited.locator('[data-diff]')).toContainText('Local tweak: we squash on merge.');
    await shoot(page, '3-install-log-check', page.locator('[data-install-log]'));
    await expectAxeClean(page, 'Install log: check result with a diff', {
      include: '[data-install-log]',
    });

    // Reinstall by push: restored.
    await page.locator('[data-install-footer]').getByRole('button', { name: 'Install…' }).click();
    const d = dialog(page);
    await d.getByLabel('Repo folder').fill('recipes');
    await d.getByRole('button', { name: 'Install anyway' }).click();
    await expect(
      d.locator('[data-install-result="push"] li').filter({ hasText: 'tasklite-planner' }),
    ).toContainText('Created');
    await d.getByRole('button', { name: 'Done' }).click();
    const newest = logRows(page).first();
    await newest.getByRole('button', { name: 'Check', exact: true }).click();
    await expect(newest.locator('[data-check-result="up_to_date"]')).toBeVisible();
    expect(sh(`cat ${REPO}/CLAUDE.md`).startsWith(PRE)).toBe(true);
  });

  test('4. the command: Copy, "Run from the repo folder", a single-use download, the check command', async ({
    ownerPage: page,
  }) => {
    await page.goto('/settings/agent-setup?project=RCP');
    await page.locator('[data-project-install]').click();
    const d = dialog(page);
    await d
      .getByRole('group', { name: 'How' })
      .getByRole('button', { name: 'Copy a command' })
      .click();
    await d.getByRole('group', { name: 'Client' }).getByRole('button', { name: 'Codex' }).click();
    await expect(d.locator('[data-install-what]')).toContainText('AGENTS.md');
    await d.getByRole('button', { name: 'Install anyway' }).click();
    const result = d.locator('[data-install-result="command"]');
    await expect(result).toContainText('Run from the repo folder.');
    await expect(result).toContainText('Works once, until');
    const blocks = result.locator('pre');
    await expect(blocks).toHaveCount(2);
    await expect(result.getByRole('button', { name: 'Copy' })).toHaveCount(2);
    const ps = await blocks.nth(0).innerText();
    const bash = await blocks.nth(1).innerText();
    expect(ps).toContain('Invoke-WebRequest');
    expect(bash).toContain('curl -fsS');
    await shoot(page, '4-dialog-command', d);
    await expectAxeClean(page, 'Install dialog: command', { include: '[role="dialog"]' });
    await d.getByRole('button', { name: 'Done' }).click();

    // The download the command makes: once, then 404. It is logged on download.
    const token = /\/install\/([A-Za-z0-9_-]{43})/.exec(bash)![1]!;
    const first = await fetch(new URL(`/install/${token}`, baseURL));
    expect(first.status).toBe(200);
    expect(first.headers.get('content-type')).toBe('application/gzip');
    expect((await first.arrayBuffer()).byteLength).toBeGreaterThan(1000);
    expect((await fetch(new URL(`/install/${token}`, baseURL))).status).toBe(404);

    await page.reload();
    const row = logRows(page).first();
    await expect(row).toHaveAttribute('data-method', 'command');
    await expect(row).toContainText('Codex');
    await row.getByRole('button', { name: 'Check command' }).click();
    await expect(row.locator('pre').first()).toContainText('.codex/.tasklite-manifest.json');
    await expect(row.getByRole('button', { name: 'Copy' })).toHaveCount(2);
    await expectAxeClean(page, 'Install log: check command', { include: '[data-install-log]' });
  });

  test('5. without a push folder the dialog falls back to the command and says why', async ({
    ownerPage: page,
  }) => {
    await page.route('**/api/push-target', (route) =>
      route.request().method() === 'GET' ? route.fulfill({ json: UNSET }) : route.continue(),
    );
    await page.goto('/settings/agent-setup');
    await page.locator('[data-install-footer]').getByRole('button', { name: 'Install…' }).click();
    const d = dialog(page);
    await expect(
      d.getByText(/No push folder is set up, so Task Lite can’t write the files itself/),
    ).toBeVisible();
    await expect(
      d.getByRole('group', { name: 'How' }).getByRole('button', { name: 'Copy a command' }),
    ).toHaveAttribute('aria-pressed', 'true');
    await d
      .getByRole('group', { name: 'Install into' })
      .getByRole('button', { name: 'User-wide' })
      .click();
    await expect(d.locator('[data-install-what]')).toContainText('~/.claude/CLAUDE.md');
    // User-wide has no project: {{KEY}} stays, so the warning names it.
    await expect(d.locator('[data-placeholder-warning]')).toContainText('{{KEY}}');
    await expect(d.locator('[data-placeholder-warning]')).toContainText(
      'Edit the service-wide AGENTS.md block first.',
    );
    await shoot(page, '5-dialog-no-push', d);
    await expectAxeClean(page, 'Install dialog: no push folder', { include: '[role="dialog"]' });
    // Edit block goes to the AGENTS.md block's view.
    await d.getByRole('button', { name: 'Edit block' }).click();
    await expect(page).toHaveURL(/file=agents_block/);
    await expect(page.locator('[data-agent-file-view="agents_block"]')).toBeVisible();
  });
});

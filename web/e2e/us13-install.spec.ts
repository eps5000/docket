/**
 * Install and check (tasks.md T155, T156; spec US13 acceptance scenarios 4
 * and 5; UI_SPEC §6.7b; FR-124 to FR-127). B25: the dialog lives on Agent
 * files and is project-scoped; the push folder card stays on Settings.
 *
 * The instance runs with a push root inside the container
 * (docker/compose.push-e2e.yaml: `/tmp/host-code`, shown as
 * `C:/Users/owner/code`). One walkthrough, in order:
 * 1. the push folder card on Settings: not set up (the API answer stubbed:
 *    the how-to; Agent files links to it with "Set up one-click install"),
 *    then configured but missing (Not writable; Test says why), then ready
 *    (Test writes and removes a probe);
 * 2. *Install into Recipe App’s repo*: no placeholder warning (the shipped
 *    block has none), push chosen by itself, "What will be written"
 *    collapsed; push into a repo that has its own CLAUDE.md: what changed,
 *    the files in the container, and CLAUDE.md byte-identical outside the
 *    markers;
 * 3. the install log (this project's): *Check* says Up to date; after an
 *    installed file is edited and another deleted, *Check* lists them, with
 *    the diff; reinstalling, with the repo folder prefilled from the last
 *    install, restores them;
 * 4. a folder outside the push folder means a command; *Copy a command
 *    instead*; the PowerShell and bash commands with *Copy* and "Run from the
 *    repo folder"; the download is logged, works once, and the log row gives
 *    the check command;
 * 5. a project copy of the block with a `{{…}}` placeholder: the warning
 *    names it (not `{{KEY}}`, which is filled), and *Edit block* opens it;
 * 6. All projects without a push folder (stubbed): *Install user-wide* is a
 *    command, says why, and links to the set-up.
 *
 * axe is clean on each screen, both themes. Set DOCKET_E2E_SCREENSHOTS to
 * a folder to capture the PR's light and dark screenshots.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import type { PushTargetResponse } from '@docket/shared';
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
const HOST_REPO = 'C:/Users/owner/code/recipes';
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

const out = process.env.DOCKET_E2E_SCREENSHOTS;
async function shoot(page: Page, name: string, target: Locator) {
  if (!out) return;
  for (const theme of ['light', 'dark'] as const) {
    await setTheme(page, theme);
    await target.screenshot({ path: join(out, `us13-install-${name}-${theme}.png`) });
  }
  await setTheme(page, 'light');
}

const card = (page: Page) => page.locator('[data-card="push-folder"]');
const RCP_INSTALL = 'Install into Recipe App’s repo';
const dialog = (page: Page, name: string = RCP_INSTALL) => page.getByRole('dialog', { name });
const logRows = (page: Page) => page.locator('[data-install-log] [data-install-row]');
const method = (page: Page) => page.locator('[data-install-method]');

async function openRcpInstall(page: Page) {
  await page.goto('/agent-files?project=RCP');
  await page.getByRole('button', { name: RCP_INSTALL }).click();
  const d = dialog(page);
  await expect(d).toBeVisible();
  return d;
}

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

  test('1. the push folder card on Settings: not set up, not writable, ready', async ({
    ownerPage: page,
  }) => {
    // Not set up (stubbed): Agent files links to the card, which has the plain how-to.
    await page.route('**/api/push-target', (route) =>
      route.request().method() === 'GET' ? route.fulfill({ json: UNSET }) : route.continue(),
    );
    await page.goto('/agent-files?project=RCP');
    await page.locator('.aflede').getByRole('link', { name: 'Set up one-click install' }).click();
    await expect(page).toHaveURL(/\/settings#push-folder$/);
    const c = card(page);
    await expect(c.getByText('Not set up')).toBeVisible();
    await expect(
      c.getByText('Mount your code folder into Docket so it can install files for you.'),
    ).toBeVisible();
    const howto = c.locator('[data-push-howto]');
    await howto
      .getByLabel('Your code folder (the one that holds your repos)')
      .fill('C:/Users/owner/code');
    await expect(howto.locator('pre').first()).toHaveText('      - C:/Users/owner/code:/host-code');
    await expect(howto.locator('pre').nth(1)).toHaveText(
      'DOCKET_PUSH_ROOT=/host-code\nDOCKET_PUSH_HOST_PATH=C:/Users/owner/code',
    );
    await expect(howto.getByRole('button', { name: 'Copy' })).toHaveCount(3);
    await shoot(page, '1-push-folder-unset', c);
    await expectAxeClean(page, 'Settings: push folder not set up', {
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
    await expectAxeClean(page, 'Settings: push folder ready', {
      include: '[data-card="push-folder"]',
    });
  });

  test('2. Install into Recipe App’s repo: push, no placeholder warning, what changed', async ({
    ownerPage: page,
  }) => {
    const d = await openRcpInstall(page);
    await expect(
      d.getByRole('group', { name: 'Client' }).getByRole('button', { name: 'Claude Code' }),
    ).toHaveAttribute('aria-pressed', 'true');
    // No user-wide choice here: that's on All projects.
    await expect(d.getByRole('group', { name: 'Install into' })).toHaveCount(0);
    // The method is chosen: push, with "Copy a command instead".
    await expect(method(page)).toHaveAttribute('data-install-method', 'push');
    await expect(method(page)).toContainText('Docket writes the files into this folder itself.');
    await expect(
      method(page).getByRole('button', { name: 'Copy a command instead' }),
    ).toBeVisible();
    // The shipped block has no placeholders: no warning, and the primary button is there.
    await expect(d.locator('[data-placeholder-warning]')).toHaveCount(0);
    // What will be written: collapsed, then opened.
    const what = d.locator('[data-install-what]');
    await expect(what).not.toHaveAttribute('open', '');
    await what.locator('summary').click();
    await expect(what).toContainText('.claude/skills/docket-worker/SKILL.md');
    await expect(what).toContainText('.claude/.docket-manifest.json');
    await expect(what).toContainText('Only the marked Docket section of CLAUDE.md is touched');
    await d.getByLabel('Repo folder').fill(HOST_REPO);
    await expect(method(page)).toHaveAttribute('data-install-method', 'push');
    await shoot(page, '2-dialog-push', d);
    await expectAxeClean(page, 'Install dialog: push', { include: '[role="dialog"]' });

    await d.getByRole('button', { name: 'Install', exact: true }).click();
    const result = d.locator('[data-install-result="push"]');
    await expect(result).toContainText(
      'Installed. Logged in the install log with every file’s version.',
    );
    await expect(result.locator('li').filter({ hasText: 'CLAUDE.md' })).toContainText('Updated');
    await expect(
      result.locator('li').filter({ hasText: '.claude/skills/docket-worker/SKILL.md' }),
    ).toContainText('Created');
    await shoot(page, '2-dialog-push-result', d);
    await expectAxeClean(page, 'Install dialog: push result', { include: '[role="dialog"]' });

    // The files are there; CLAUDE.md keeps its own text byte for byte, then the section.
    const claude = sh(`cat ${REPO}/CLAUDE.md`);
    expect(claude.startsWith(`${PRE}\n<!-- docket:begin -->\n## Work tracking: Docket`)).toBe(true);
    expect(claude).toContain('`docket-worker` skill');
    expect(claude).not.toContain('{{');
    expect(claude.endsWith('<!-- docket:end -->\n')).toBe(true);
    expect(sh(`ls ${REPO}/.claude/skills`).trim().split('\n')).toEqual([
      'docket-coordinator',
      'docket-lead-subagents',
      'docket-planner',
      'docket-review-packet',
      'docket-worker',
    ]);
    await d.getByRole('button', { name: 'Done' }).click();
    await expect(d).toBeHidden();
  });

  test('3. the install log: Check, a local edit and a delete, the diff, and a prefilled reinstall', async ({
    ownerPage: page,
  }) => {
    await page.goto('/agent-files?project=RCP');
    await expect(page.locator('[data-install-log]')).toContainText('Install log · Recipe App');
    const row = logRows(page).first();
    await expect(row).toHaveAttribute('data-method', 'push');
    await expect(row).toContainText('Claude Code');
    await expect(row).toContainText('Recipe App’s repo');
    await expect(row).toContainText('6 files');
    await row.getByRole('button', { name: 'Versions sent' }).click();
    await expect(row.locator('[data-sent="skill:docket-worker"]')).toContainText(
      'Docket’s version v1',
    );
    await row.getByRole('button', { name: 'Check', exact: true }).click();
    await expect(row.locator('[data-check-result="up_to_date"]')).toContainText('Up to date');

    // Edit one installed file by hand and delete another.
    sh(
      `printf '\\nLocal tweak: we squash on merge.\\n' >> ${REPO}/.claude/skills/docket-worker/SKILL.md && rm ${REPO}/.claude/skills/docket-planner/SKILL.md`,
    );
    await row.getByRole('button', { name: 'Check', exact: true }).click();
    const result = row.locator('[data-check-result="differs"]');
    await expect(result).toContainText('2 files differ from what Docket sent');
    const edited = result.locator('[data-check-file=".claude/skills/docket-worker/SKILL.md"]');
    await expect(edited).toContainText('Edited locally');
    await expect(
      result.locator('[data-check-file=".claude/skills/docket-planner/SKILL.md"]'),
    ).toContainText('Missing');
    await edited.getByRole('button', { name: 'Show diff' }).click();
    await expect(edited.locator('[data-diff]')).toContainText('Local tweak: we squash on merge.');
    await shoot(page, '3-install-log-check', page.locator('[data-install-log]'));
    await expectAxeClean(page, 'Install log: check result with a diff', {
      include: '[data-install-log]',
    });

    // Reinstall: the repo folder is prefilled from the last install.
    await page.getByRole('button', { name: RCP_INSTALL }).click();
    const d = dialog(page);
    await expect(d.getByLabel('Repo folder')).toHaveValue(HOST_REPO);
    await expect(d.getByText('From Recipe App’s last install.')).toBeVisible();
    await expect(method(page)).toHaveAttribute('data-install-method', 'push');
    await d.getByRole('button', { name: 'Install', exact: true }).click();
    await expect(
      d.locator('[data-install-result="push"] li').filter({ hasText: 'docket-planner' }),
    ).toContainText('Created');
    await d.getByRole('button', { name: 'Done' }).click();
    const newest = logRows(page).first();
    await newest.getByRole('button', { name: 'Check', exact: true }).click();
    await expect(newest.locator('[data-check-result="up_to_date"]')).toBeVisible();
    expect(sh(`cat ${REPO}/CLAUDE.md`).startsWith(PRE)).toBe(true);
  });

  test('4. a folder outside the push folder, Copy a command instead, a single-use download, the check command', async ({
    ownerPage: page,
  }) => {
    const d = await openRcpInstall(page);
    // A folder outside the push folder: a command, and the dialog says why.
    await d.getByLabel('Repo folder').fill('D:/elsewhere/recipes');
    await expect(method(page)).toHaveAttribute('data-install-method', 'command');
    await expect(method(page)).toContainText('isn’t inside the push folder (C:/Users/owner/code)');
    // Back inside: push again; then Copy a command instead.
    await d.getByLabel('Repo folder').fill('');
    await expect(method(page)).toHaveAttribute('data-install-method', 'push');
    await method(page).getByRole('button', { name: 'Copy a command instead' }).click();
    await expect(method(page)).toHaveAttribute('data-install-method', 'command');
    await expect(
      method(page).getByRole('button', { name: 'Let Docket write them instead' }),
    ).toBeVisible();
    await d.getByRole('group', { name: 'Client' }).getByRole('button', { name: 'Codex' }).click();
    await d.locator('[data-install-what] summary').click();
    await expect(d.locator('[data-install-what]')).toContainText('AGENTS.md');
    await expect(d.locator('[data-placeholder-warning]')).toHaveCount(0);
    await d.getByRole('button', { name: 'Create the command' }).click();
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
    await expect(row.locator('pre').first()).toContainText('.codex/.docket-manifest.json');
    await expect(row.getByRole('button', { name: 'Copy' })).toHaveCount(2);
    await expectAxeClean(page, 'Install log: check command', { include: '[data-install-log]' });
  });

  test('5. a placeholder left in the block: the warning names it, and Edit block opens it', async ({
    ownerPage: page,
  }) => {
    // Customize the AGENTS.md block for Recipe App with a placeholder (and {{KEY}}, which is filled).
    await page.goto('/agent-files?project=RCP');
    await page
      .locator('[data-agent-file="agents_block"]')
      .getByRole('button', { name: /^Customize for Recipe App/ })
      .click();
    const v = page.locator('[data-agent-file-view="agents_block"]');
    const editor = v.getByLabel('Edit file');
    await editor.fill(
      `${(await editor.inputValue()).trimEnd()}\n\nProject {{KEY}}: branches are {{BRANCH_RULE}}.\n`,
    );
    await v.getByLabel('Note (required)').fill('Branch rule to fill in.');
    await v.getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('[data-agent-file="agents_block"]')).toHaveAttribute(
      'data-using',
      'copy',
    );

    await page.getByRole('button', { name: RCP_INSTALL }).click();
    const d = dialog(page);
    const warn = d.locator('[data-placeholder-warning]');
    await expect(warn).toContainText('This block still has 1 placeholder: {{BRANCH_RULE}}');
    await expect(warn).not.toContainText('{{KEY}}');
    await expect(warn).toContainText('Fill it in first, in Recipe App’s AGENTS.md block.');
    await expect(d.getByRole('button', { name: 'Install', exact: true })).toHaveCount(0);
    await expect(d.getByRole('button', { name: 'Install anyway' })).toBeVisible();
    await expectAxeClean(page, 'Install dialog: placeholder warning', {
      include: '[role="dialog"]',
    });
    await d.getByRole('button', { name: 'Edit block' }).click();
    await expect(page).toHaveURL(/file=agents_block/);
    await expect(v.getByLabel('Edit file')).toHaveValue(/\{\{BRANCH_RULE\}\}/);
    await v.getByRole('button', { name: 'Cancel' }).click();

    // Back to the default: no warning any more.
    await page
      .locator('[data-agent-file="agents_block"]')
      .getByRole('button', { name: /^Use default/ })
      .click();
    await expect(page.locator('[data-agent-file="agents_block"]')).toHaveAttribute(
      'data-using',
      'default',
    );
    await page.getByRole('button', { name: RCP_INSTALL }).click();
    await expect(dialog(page).locator('[data-install-method]')).toBeVisible();
    await expect(dialog(page).locator('[data-placeholder-warning]')).toHaveCount(0);
  });

  test('6. All projects without a push folder: Install user-wide is a command, and says why', async ({
    ownerPage: page,
  }) => {
    await page.route('**/api/push-target', (route) =>
      route.request().method() === 'GET' ? route.fulfill({ json: UNSET }) : route.continue(),
    );
    await page.goto('/agent-files?project=all');
    // The full install log: Recipe App's installs show here too.
    await expect(logRows(page).first()).toBeVisible();
    await page.getByRole('button', { name: 'Install user-wide' }).click();
    const d = dialog(page, 'Install user-wide');
    await expect(d.getByLabel('Repo folder')).toHaveCount(0);
    await expect(method(page)).toHaveAttribute('data-install-method', 'command');
    await expect(method(page)).toContainText(
      'With a push folder set up, Docket can write the files for you.',
    );
    await expect(
      method(page).getByRole('link', { name: 'Set up one-click install' }),
    ).toBeVisible();
    await d.locator('[data-install-what] summary').click();
    await expect(d.locator('[data-install-what]')).toContainText('~/.claude/CLAUDE.md');
    // The default block has no placeholders, not even {{KEY}}, so no warning user-wide either.
    await expect(d.locator('[data-placeholder-warning]')).toHaveCount(0);
    await shoot(page, '6-dialog-user-wide-no-push', d);
    await expectAxeClean(page, 'Install dialog: user-wide, no push folder', {
      include: '[role="dialog"]',
    });
    await d.getByRole('button', { name: 'Create the command' }).click();
    await expect(d.locator('[data-install-result="command"] pre')).toHaveCount(2);
  });
});

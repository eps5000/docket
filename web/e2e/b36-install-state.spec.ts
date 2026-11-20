/**
 * Several clients in one install, and install state (owner decision 34; B36,
 * tasks.md T175, T176; UI_SPEC §6.7b; spec US17 scenarios 1–4).
 *
 * The instance runs with a push root inside the container
 * (docker/compose.push-e2e.yaml: `/tmp/host-code`, shown as
 * `C:/Users/owner/code`). A Gameflow-like repo there has its own AGENTS.md
 * and no CLAUDE.md. One walkthrough, in order:
 * 1. Agent files (Recipe App): the install state card, both clients "Not
 *    installed" with *Install*;
 * 2. the card's *Install* for Codex opens the dialog with Codex ticked; the
 *    repo's AGENTS.md is a Codex marker; tick Claude Code too; "What will be
 *    written" lists both and the @AGENTS.md note; *Install* writes both and
 *    shows one summary, a section per client; CLAUDE.md starts with
 *    `@AGENTS.md` and AGENTS.md keeps its own text;
 * 3. both "Installed · up to date", with *Check* (up to date) and
 *    *Reinstall*;
 * 4. a project copy of a skill: both "Installed · update available" with
 *    *Update*, which opens the dialog with that client and an *Update*
 *    button;
 * 5. a local edit reported on claim: Claude Code "Changed outside Docket"
 *    with *Review changes*, which goes to the drift section.
 *
 * axe is clean on each screen. Set DOCKET_E2E_SCREENSHOTS to a folder to
 * capture the PR's light and dark screenshots.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import {
  connectAgent,
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
const REPO = `${ROOT}/gameflow`;
const HOST_REPO = 'C:/Users/owner/code/gameflow';
const OWN = '# Gameflow agent rules\n\nKeep scenes small. Run pnpm test before committing.\n';
const RCP_INSTALL = 'Install into Recipe App’s repo';

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
    await target.screenshot({ path: join(out, `b36-${name}-${theme}.png`) });
  }
  await setTheme(page, 'light');
}

const stateCard = (page: Page) => page.locator('[data-install-state]');
const stateRow = (page: Page, client: 'claude' | 'codex') =>
  page.locator(`[data-install-state-row="${client}"]`);
const dialog = (page: Page) => page.getByRole('dialog', { name: RCP_INSTALL });

test.describe.configure({ mode: 'serial' });

test.describe('Several clients and install state (decision 34)', () => {
  test.beforeAll(() => {
    sh(
      `rm -rf ${ROOT} && mkdir -p ${REPO}/.git && printf '%s' '${OWN.replace(/'/g, "'\\''")}' > ${REPO}/AGENTS.md`,
    );
  });

  test('1. the install state card: both clients not installed', async ({ ownerPage: page }) => {
    await page.goto('/agent-files?project=RCP');
    const card = stateCard(page);
    await expect(card).toContainText('Installed in Recipe App’s repo');
    await expect(stateRow(page, 'claude')).toHaveAttribute('data-state', 'not_installed');
    await expect(stateRow(page, 'codex')).toHaveAttribute('data-state', 'not_installed');
    await expect(stateRow(page, 'claude')).toContainText('Not installed');
    await expect(
      stateRow(page, 'claude').getByRole('button', { name: 'Install Claude Code' }),
    ).toBeVisible();
    await shoot(page, 'state-not-installed', card);
    await expectAxeClean(page, 'Agent files: install state, not installed', {
      include: '[data-install-state]',
    });
  });

  test('2. both clients in one install: one summary, and CLAUDE.md imports AGENTS.md', async ({
    ownerPage: page,
  }) => {
    await page.goto('/agent-files?project=RCP');
    await stateRow(page, 'codex').getByRole('button', { name: 'Install Codex' }).click();
    const d = dialog(page);
    await expect(d).toBeVisible();
    // The row's client is ticked; the other isn't.
    await expect(d.getByRole('checkbox', { name: /^Codex/ })).toBeChecked();
    await expect(d.getByRole('checkbox', { name: /^Claude Code/ })).not.toBeChecked();
    await d.getByLabel('Repo folder').fill(HOST_REPO);
    await d.getByLabel('Repo folder').blur();
    // AGENTS.md is a Codex marker.
    await expect(d.locator('[data-client="codex"]')).toContainText('found in the repo');
    await d.getByRole('checkbox', { name: /^Claude Code/ }).check();
    await expect(d.getByRole('checkbox', { name: /^Claude Code/ })).toBeChecked();
    await expect(d.locator('[data-client="claude"]')).toContainText('Not installed');
    const what = d.locator('[data-install-what]');
    await what.locator('summary').click();
    await expect(what.locator('[data-install-what-client="claude"]')).toContainText(
      '.claude/skills/docket-worker/SKILL.md',
    );
    await expect(what.locator('[data-install-what-client="codex"]')).toContainText(
      '.codex/skills/docket-worker/SKILL.md',
    );
    await expect(what.locator('[data-import-note]')).toContainText('starts with @AGENTS.md');
    await expect(d.locator('[data-connect-note]')).toContainText('.mcp.json, .codex/config.toml');
    await expect(d.getByRole('button', { name: 'Install', exact: true })).toBeVisible();
    await shoot(page, 'dialog-both-clients', d);
    await expectAxeClean(page, 'Install dialog: both clients', { include: '[role="dialog"]' });

    await d.getByRole('button', { name: 'Install', exact: true }).click();
    const summary = d.locator('[data-install-summary]');
    await expect(d.locator('[data-install-result="push"]')).toContainText(
      'Installed Claude Code and Codex.',
    );
    const claude = summary.locator('[data-install-summary-client="claude"]');
    const codex = summary.locator('[data-install-summary-client="codex"]');
    await expect(claude.locator('li').filter({ hasText: 'CLAUDE.md' })).toContainText(
      'starts with @AGENTS.md',
    );
    await expect(claude.locator('li').filter({ hasText: '.mcp.json' })).toContainText('Created');
    await expect(codex.locator('li').filter({ hasText: 'AGENTS.md' }).first()).toContainText(
      'Updated',
    );
    await expect(codex.locator('li').filter({ hasText: '.codex/config.toml' })).toContainText(
      'Created',
    );
    await shoot(page, 'summary-both-clients', d);
    await expectAxeClean(page, 'Install dialog: the one summary', { include: '[role="dialog"]' });

    expect(sh(`cat ${REPO}/CLAUDE.md`).startsWith('@AGENTS.md\n\n<!-- docket:begin -->\n')).toBe(
      true,
    );
    expect(sh(`cat ${REPO}/AGENTS.md`).startsWith(`${OWN}\n<!-- docket:begin -->\n`)).toBe(true);
    await d.getByRole('button', { name: 'Done' }).click();
    await expect(d).toBeHidden();
  });

  test('3. both up to date: Check and Reinstall', async ({ ownerPage: page }) => {
    await page.goto('/agent-files?project=RCP');
    await expect(stateRow(page, 'claude')).toHaveAttribute('data-state', 'up_to_date');
    await expect(stateRow(page, 'codex')).toHaveAttribute('data-state', 'up_to_date');
    await expect(stateRow(page, 'claude')).toContainText('Installed · up to date');
    await stateRow(page, 'claude').getByRole('button', { name: 'Check Claude Code' }).click();
    await expect(
      stateRow(page, 'claude').locator('[data-check-result="up_to_date"]'),
    ).toBeVisible();
    await expect(
      stateRow(page, 'codex').getByRole('button', { name: 'Reinstall Codex' }),
    ).toBeVisible();
    await shoot(page, 'state-up-to-date', stateCard(page));
    await shoot(page, 'agent-files-up-to-date', page.locator('.agent-files'));
    await expectAxeClean(page, 'Agent files: install state, up to date', {
      include: '[data-install-state]',
    });
  });

  test('4. a project copy of a skill: update available, and Update', async ({
    ownerPage: page,
  }) => {
    await page.goto('/agent-files?project=RCP');
    await page
      .locator('[data-agent-file="skill:docket-worker"]')
      .getByRole('button', { name: /^Customize for Recipe App/ })
      .click();
    const v = page.locator('[data-agent-file-view="skill:docket-worker"]');
    const editor = v.getByLabel('Edit file');
    await editor.fill(`${(await editor.inputValue()).trimEnd()}\n\nBranches are gf-<n>.\n`);
    await v.getByLabel('Note (required)').fill('Gameflow branch names.');
    await v.getByRole('button', { name: 'Save' }).click();
    await expect(stateRow(page, 'claude')).toHaveAttribute('data-state', 'update_available');
    await expect(stateRow(page, 'codex')).toHaveAttribute('data-state', 'update_available');
    await expect(stateRow(page, 'claude')).toContainText('Installed · update available');
    await expect(stateRow(page, 'claude')).toContainText('1 file newer in Docket');
    await shoot(page, 'state-update-available', stateCard(page));
    await expectAxeClean(page, 'Agent files: install state, update available', {
      include: '[data-install-state]',
    });

    await stateRow(page, 'claude').getByRole('button', { name: 'Update Claude Code' }).click();
    const d = dialog(page);
    await expect(d.getByRole('checkbox', { name: /^Claude Code/ })).toBeChecked();
    await expect(d.getByRole('checkbox', { name: /^Codex/ })).not.toBeChecked();
    await expect(d.locator('[data-client="claude"]')).toContainText('Installed · update available');
    await expect(d.getByRole('button', { name: 'Install', exact: true })).toHaveCount(0);
    await expect(d.getByRole('button', { name: 'Update', exact: true })).toBeVisible();
    await d.getByRole('checkbox', { name: /^Codex/ }).check();
    await expect(d.getByRole('button', { name: 'Update', exact: true })).toBeVisible();
    await shoot(page, 'dialog-update', d);
    await d.getByRole('button', { name: 'Update', exact: true }).click();
    await expect(d.locator('[data-install-summary-client="codex"]')).toBeVisible();
    await d.getByRole('button', { name: 'Done' }).click();
    await expect(stateRow(page, 'claude')).toHaveAttribute('data-state', 'up_to_date');
    await expect(stateRow(page, 'codex')).toHaveAttribute('data-state', 'up_to_date');
  });

  test('5. a local edit reported on claim: changed outside Docket, and Review changes', async ({
    ownerPage: page,
  }) => {
    sh(
      `printf -- '- Squash on merge (edited in VS Code).\\n' >> ${REPO}/.claude/skills/docket-planner/SKILL.md`,
    );
    const report = JSON.parse(sh(`bash ${REPO}/.claude/docket-check.sh`).trim()) as Record<
      string,
      unknown
    >;
    const agent = await connectAgent('codex-mcp-client', '0.50.0');
    try {
      const claim = await agent.call('claim_lead', {
        id: 'RCP-17',
        agent_label: 'orca-w3',
        workspace: { path: HOST_REPO, branch: 'rcp-17' },
        instructions: report,
      });
      expect(claim.isError, claim.text).toBe(false);
    } finally {
      await agent.close();
    }
    await page.goto('/agent-files?project=RCP');
    await expect(stateRow(page, 'claude')).toHaveAttribute('data-state', 'changed');
    await expect(stateRow(page, 'claude')).toContainText('Changed outside Docket');
    await expect(stateRow(page, 'claude')).toContainText('1 file changed');
    await expect(stateRow(page, 'codex')).toHaveAttribute('data-state', 'up_to_date');
    await shoot(page, 'state-changed', stateCard(page));
    await shoot(page, 'agent-files-states', page.locator('.agent-files'));
    await expectAxeClean(page, 'Agent files: install state, changed outside Docket', {
      include: '[data-install-state]',
    });
    await stateRow(page, 'claude')
      .getByRole('button', { name: 'Review changes to Claude Code' })
      .click();
    await expect(page.locator('[data-drift-section]')).toBeInViewport();

    // The dialog says so too, with Review changes, and the button reinstalls.
    await page.getByRole('button', { name: RCP_INSTALL }).click();
    const d = dialog(page);
    await expect(d.locator('[data-client="claude"]')).toContainText('Changed outside Docket');
    await expect(d.locator('[data-changed-warning]')).toContainText(
      'Claude Code: files were changed outside Docket.',
    );
    await expect(d.getByRole('button', { name: 'Reinstall', exact: true })).toBeVisible();
    await shoot(page, 'dialog-changed', d);
    await expectAxeClean(page, 'Install dialog: changed outside Docket', {
      include: '[role="dialog"]',
    });
    await d.getByRole('button', { name: 'Cancel' }).click();
  });
});

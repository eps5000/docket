/**
 * Running Task Lite safely: Settings and Unlock (tasks.md T129; spec US10;
 * UI_SPEC §6.7, §6.8, §7, §11; MCP_SPEC §11).
 *
 * - Projects: a row per project with counts, labels and the mini status bar.
 * - Connections: the compatibility matrix (nothing "Verified" before the
 *   smoke test); the Codex and Claude Code snippets with `$TASKLITE_TOKEN`,
 *   never the value; *Reveal token* shows the token and hides it after 30 s.
 * - Service health: the backup locations, before and after
 *   `tasklite backup now`, and the extra-location hint; *Download diagnostic
 *   log* gives metadata-only JSONL.
 * - The delete dialog: typed key, focus on Cancel, then the delete itself;
 *   agents get not_found for the deleted IDs.
 * - Unlock: a new browser is sent to /unlock, a wrong key says so, the right
 *   one goes to the page that was asked for.
 * - axe on Settings, the delete dialog and Unlock, both themes.
 *
 * Set TASKLITE_E2E_SCREENSHOTS to a folder to also capture the PR's light
 * and dark screenshots.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import {
  agentToken,
  expect,
  expectAxeClean,
  ownerKey,
  resetSeededContainer,
  setTheme,
  test,
  useSeededContainer,
} from './fixtures/index';
import { CONTAINER } from './fixtures/container';

useSeededContainer();
// This file deletes a project; leave a fresh seed for whatever runs next.
test.afterAll(async () => {
  test.setTimeout(120_000);
  await resetSeededContainer();
});

const out = process.env.TASKLITE_E2E_SCREENSHOTS;

async function shoot(page: Page, name: string, target: Locator) {
  if (!out) return;
  for (const theme of ['light', 'dark'] as const) {
    await setTheme(page, theme);
    await target.screenshot({ path: join(out, `us10-${name}-${theme}.png`) });
  }
  await setTheme(page, 'light');
}

const card = (page: Page, name: string) => page.locator(`[data-card="${name}"]`);
const toast = (page: Page, text: string | RegExp) =>
  page.locator('.toast').filter({ hasText: text });

const CODEX = `# ~/.codex/config.toml
[mcp_servers.tasklite]
url = "http://127.0.0.1:7420/mcp"
bearer_token_env_var = "TASKLITE_TOKEN"`;
const CLAUDE = `claude mcp add --transport http --scope user tasklite \\
  http://127.0.0.1:7420/mcp \\
  --header "Authorization: Bearer $TASKLITE_TOKEN"`;

test.describe('Settings', () => {
  test('projects: counts, labels and the mini status bar; axe is clean', async ({
    ownerPage: page,
  }) => {
    await page.goto('/settings');
    await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
    const rcp = page.locator('[data-project="RCP"]');
    await expect(rcp.getByText('Sample · Recipe App')).toBeVisible();
    await expect(
      rcp.getByText(/^RCP · \d+ epics · \d+ items · \d+ documents · \d+ for you$/),
    ).toBeVisible();
    await expect(
      rcp.getByRole('img', { name: /\d+ done, \d+ in review, \d+ in progress, \d+ planning/ }),
    ).toBeVisible();
    await expect(rcp.getByText(/\d+ done · \d+ active · \d+ review · \d+ planning/)).toBeVisible();
    await expect(page.locator('[data-project="DOC"]')).toBeVisible();
    await expectAxeClean(page, 'Settings');
    await shoot(
      page,
      'settings-projects',
      page.locator('section[aria-labelledby="settings-projects"]'),
    );
  });

  test('connections: the matrix, the snippets with $TASKLITE_TOKEN, and Reveal token hiding after 30 s', async ({
    ownerPage: page,
  }) => {
    await page.clock.install();
    await page.goto('/settings');
    const clients = card(page, 'clients');
    for (const name of [
      'Codex CLI (host)',
      'Claude Code (host)',
      'Orca worker · Codex',
      'Orca worker · Claude',
    ]) {
      await expect(
        clients.locator(`tr[data-client="${name}"]`).getByText('Not verified'),
      ).toBeVisible();
    }
    await expect(
      clients.locator('tr[data-client="Agent in another container"]').getByText('Not configured'),
    ).toBeVisible();
    await expect(clients.getByText('✓ Verified')).toHaveCount(0);
    await shoot(page, 'settings-clients', clients);

    const setup = card(page, 'client-setup');
    const snippet = setup.getByLabel('Client configuration');
    await expect(snippet).toHaveText(CODEX);
    await setup.getByRole('button', { name: 'Claude Code' }).click();
    await expect(snippet).toHaveText(CLAUDE);
    const token = agentToken();
    expect(await page.content()).not.toContain(token);
    await shoot(page, 'settings-client-setup', setup);

    await setup.getByRole('button', { name: 'Reveal token' }).click();
    const revealed = setup.getByLabel('Agent token');
    await expect(revealed).toHaveText(token);
    await expect(setup.getByText('Hides in 30 s.')).toBeVisible();
    await shoot(page, 'settings-reveal-token', setup);
    await page.clock.fastForward(29_000);
    await expect(revealed).toBeVisible();
    await page.clock.fastForward(2_000);
    await expect(revealed).toHaveCount(0);
    await expect(setup.getByRole('button', { name: 'Reveal token' })).toBeVisible();
    expect(await page.content()).not.toContain(token);

    // Hide token hides it at once.
    await setup.getByRole('button', { name: 'Reveal token' }).click();
    await expect(revealed).toHaveText(token);
    await setup.getByRole('button', { name: 'Hide token' }).click();
    await expect(revealed).toHaveCount(0);

    await expect(card(page, 'endpoint').getByText('Loopback only')).toBeVisible();
    await shoot(page, 'settings-endpoint', card(page, 'endpoint'));
  });

  test('service health: backup locations before and after `tasklite backup now`', async ({
    ownerPage: page,
  }) => {
    await page.goto('/settings');
    const health = card(page, 'service-health');
    await expect(health.getByText('✓ ready')).toHaveCount(2);
    await expect(health.locator('[data-backup="extra-help"]')).toHaveText(
      'Mount a host folder and set TASKLITE_BACKUP_EXTRA_DIR; see the README.',
    );
    execFileSync('docker', ['exec', CONTAINER, 'tasklite', 'backup', 'now'], { encoding: 'utf8' });
    await page.reload();
    await expect(health.locator('[data-backup="volume"]')).toHaveText(
      /^In the data volume · [A-Z][a-z]{2} \d{1,2} \d{2}:\d{2} · kept \d+ days$/,
    );
    await expect(health.getByText(/runs? (was|were) active/)).toBeVisible();
    await shoot(page, 'settings-service-health', health);
    await shoot(page, 'settings-this-browser', card(page, 'this-browser'));
  });

  test('Download diagnostic log: the last 7 days of calls, metadata only', async ({
    ownerPage: page,
    agent,
  }) => {
    const marker = 'e2e-marker-diagnostics';
    await agent.call('search_items', { project: 'RCP', text: marker });
    await agent.call('whoami');
    await page.goto('/settings');
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('link', { name: 'Download diagnostic log' }).click(),
    ]);
    const text = readFileSync((await download.path())!, 'utf8');
    const lines = text
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(Object.keys(line)).toEqual([
        'time',
        'tool',
        'client',
        'label',
        'run',
        'duration_ms',
        'result',
      ]);
    }
    expect(lines.map((l) => l.tool)).toContain('search_items');
    expect(text).not.toContain(marker);
    expect(text).not.toContain(agentToken());
  });

  test('the delete dialog: typed key, focus on Cancel; agents then get not_found', async ({
    ownerPage: page,
    agent,
  }) => {
    expect((await agent.call('get_item', { id: 'DOC-4' })).isError).toBe(false);
    await page.goto('/settings');
    const doc = page.locator('[data-project="DOC"]');
    await doc.getByRole('button', { name: 'Delete…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Delete Sample · Docs Site?' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await expect(dialog.getByText(/This permanently removes \d+ work items/)).toBeVisible();
    await expect(
      dialog.getByText(/Backups keep a copy until their 14-day retention ends/),
    ).toBeVisible();
    const confirm = dialog.getByRole('button', { name: 'Delete project' });
    await expect(confirm).toBeDisabled();
    await dialog.getByLabel('Type DOC to confirm').fill('doc');
    await expect(confirm).toBeDisabled();
    await expectAxeClean(page, 'Delete project dialog', { include: '[role="dialog"]' });
    await dialog.getByLabel('Type DOC to confirm').fill('');
    await shoot(page, 'delete-dialog', dialog);

    // Cancel changes nothing.
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(doc).toBeVisible();

    await doc.getByRole('button', { name: 'Delete…' }).click();
    await dialog.getByLabel('Type DOC to confirm').fill('DOC');
    await expect(confirm).toBeEnabled();
    await confirm.click();
    await expect(dialog).toHaveCount(0);
    await expect(toast(page, 'Deleted Sample · Docs Site.')).toBeVisible();
    await expect(page.locator('[data-project="DOC"]')).toHaveCount(0);
    await expect(page.locator('[data-project="RCP"]')).toBeVisible();

    const gone = await agent.call('get_item', { id: 'DOC-4' });
    expect(gone.isError).toBe(true);
    expect(gone.structured.code).toBe('not_found');
    expect((await agent.call('get_item', { id: 'RCP-14' })).isError).toBe(false);
  });
});

test.describe('Unlock', () => {
  test('a new browser unlocks with the owner key and lands where it asked to go', async ({
    browser,
  }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto('/settings');
    await expect(page).toHaveURL(/\/unlock/);
    await expect(page.getByRole('heading', { name: 'Unlock Task Lite' })).toBeVisible();
    await expect(page.getByText('docker compose exec tasklite tasklite owner-key')).toBeVisible();
    await expect(page.getByLabel('Owner key')).toBeFocused();
    await expectAxeClean(page, 'Unlock');
    await shoot(page, 'unlock', page.locator('main.unlock'));

    await page.getByLabel('Owner key').fill('NOT-THE-KEY');
    await page.getByRole('button', { name: 'Unlock' }).click();
    await expect(page.getByText('That key didn’t match.')).toBeVisible();
    await expectAxeClean(page, 'Unlock with the error');
    await shoot(page, 'unlock-error', page.locator('main.unlock'));

    await page.getByLabel('Owner key').fill(ownerKey());
    await page.getByRole('button', { name: 'Unlock' }).click();
    await expect(page).toHaveURL(/\/settings$/);
    await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
    await context.close();
  });
});

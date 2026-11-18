/**
 * Drift: agent files changed outside Docket (tasks.md T161; spec US14
 * acceptance scenarios 3–5; UI_SPEC §6.7b-1; FR-131–FR-133; SC-017).
 *
 * Against the container's e2e push folder (docker/compose.push-e2e.yaml:
 * `/tmp/host-code`, shown as `C:/Users/owner/code`). One walkthrough:
 * 1. install into Recipe App's repo by push, then hand-edit the installed
 *    `docket-worker`; the scheduled check (it runs at startup: the
 *    container restarts) finds it: a Problems row, *Review* → the "Changed
 *    outside Docket" entry with its diff, the row chip; *Adopt as Recipe
 *    App's copy*;
 * 2. hand-edit again; an agent runs the installed `docket-check` (in the
 *    container, with its own bash) and claims RCP-17 with the output: the
 *    Problems row names the agent; the agent bar and Lead and runs show
 *    "Instructions: docket-worker · default v1" with ⚠ "edited locally";
 *    the chip opens the entry; *Keep local*; the same report raises nothing;
 * 3. a further edit is reported on the next claim and alerts again;
 *    *Restore Docket's version* rewrites the file.
 *
 * axe is clean on each screen, both themes. Set DOCKET_E2E_SCREENSHOTS to
 * a folder to capture the PR's screenshots.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { baseURL } from './container';
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
const REPO = `${ROOT}/recipes`;
const HOST_REPO = 'C:/Users/owner/code/recipes';
const WORKER_FILE = `${REPO}/.claude/skills/docket-worker/SKILL.md`;
const WORKER = 'skill:docket-worker';

function sh(script: string): string {
  return execFileSync('docker', ['exec', CONTAINER, 'sh', '-c', script], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function restartAndWait(): Promise<void> {
  execFileSync('docker', ['restart', '--time', '10', CONTAINER], { stdio: 'ignore' });
  const until = Date.now() + 60_000;
  while (Date.now() < until) {
    try {
      if ((await fetch(new URL('/readyz', baseURL))).ok) return;
    } catch {
      // Not up yet.
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('Docket did not come back after the restart');
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
    await target.screenshot({ path: join(out, `us14-drift-${name}-${theme}.png`) });
  }
  await setTheme(page, 'light');
}

/** The owner's API from the unlocked page's context (cookies and the CSRF header). */
async function owner(page: Page, method: 'GET' | 'POST', path: string, data?: unknown) {
  const csrf = (await page.context().cookies()).find((c) => c.name === 'docket_csrf')?.value ?? '';
  const r = await page.request.fetch(path, {
    method,
    data,
    headers: method === 'GET' ? {} : { 'x-docket-csrf': csrf, origin: baseURL },
  });
  expect(r.ok(), `${method} ${path}: ${await r.text()}`).toBe(true);
  return (await r.json()) as Record<string, unknown>;
}

/** Run the installed docket-check as an agent would: one shell call, one line of JSON. */
function docketcheck(): Record<string, unknown> {
  const line = sh(`bash ${REPO}/.claude/docket-check.sh`).trim();
  console.log(`docket-check (${line.length} characters): ${line.slice(0, 300)}…`);
  return JSON.parse(line) as Record<string, unknown>;
}

const toast = (page: Page, text: string | RegExp) =>
  page.locator('.toast').filter({ hasText: text });

test.describe.configure({ mode: 'serial' });

/** RCP-25's run from test 3, released in test 4 so it can claim again. */
let lastRun = '';

test.describe('Drift (US14)', () => {
  test('1. a hand edit, found by the scheduled check; Review; Adopt as Recipe App’s copy', async ({
    ownerPage: page,
  }) => {
    test.setTimeout(120_000);
    sh(`rm -rf ${ROOT} && mkdir -p ${REPO}/.git`);
    const install = await owner(page, 'POST', '/api/installs', {
      client: 'claude',
      target_kind: 'repo',
      project: 'RCP',
      path: HOST_REPO,
      method: 'push',
    });
    expect(install.install_id).toMatch(/^ins_/);
    expect(sh(`ls ${REPO}/.claude`)).toContain('docket-check.sh');
    sh(`printf '\\n- Always run pnpm lint first (edited in VS Code).\\n' >> ${WORKER_FILE}`);

    // The scheduled check runs at startup (and every 15 minutes).
    await restartAndWait();
    await page.goto('/');
    const problems = page.locator('[data-card="problems"]');
    const row = problems.locator('[data-problem="agent_files_drift"]');
    await expect(row).toContainText(
      'docket-worker edited outside Docket · Recipe App · C:/Users/owner/code/recipes · found by the scheduled check',
    );
    await shoot(page, '1-problem', problems);
    await row.getByRole('link', { name: 'Review' }).click();
    await expect(page).toHaveURL(/\/agent-files#drift-dft_/);

    const section = page.locator('[data-drift-section]');
    await expect(
      section.getByRole('heading', { name: 'Changed outside Docket · 1' }),
    ).toBeVisible();
    const entry = section.locator('[data-drift]');
    await expect(entry.getByRole('heading', { name: 'docket-worker' })).toBeVisible();
    await expect(entry.getByText('Edited locally')).toBeVisible();
    await expect(entry.getByText(HOST_REPO)).toBeVisible();
    await expect(entry.getByText('Found by the scheduled check of the push folder')).toBeVisible();
    const diff = entry.getByRole('region', {
      name: 'docket-worker: Docket’s version → the local file',
    });
    await expect(diff).toContainText('Always run pnpm lint first (edited in VS Code).');
    await expect(diff).toContainText('2 lines added, 0 lines removed');
    await shoot(page, '1-section', section);
    await expectAxeClean(page, 'Agent files: changed outside Docket');

    // All projects: the entry's project is named; pick Recipe App to see the row chip.
    await page.goto('/agent-files?project=RCP');
    const fileRow = page.locator(`[data-agent-file="${WORKER}"]`);
    await expect(fileRow.locator('[data-drift-chip]')).toHaveText('changed outside Docket');
    await page
      .locator('[data-drift]')
      .getByRole('button', { name: 'Adopt as Recipe App’s copy (docket-worker)' })
      .click();
    await expect(
      toast(page, 'Adopted: the local docket-worker is now Recipe App’s copy.'),
    ).toBeVisible();
    await expect(page.locator('[data-drift-section]')).toHaveCount(0);
    await expect(fileRow).toHaveAttribute('data-using', 'copy');
    await expect(fileRow.locator('[data-drift-chip]')).toHaveCount(0);
  });

  test('2. reported on claim: the agent bar’s instructions, ⚠ edited locally; Keep local stays quiet', async ({
    ownerPage: page,
  }) => {
    sh(`printf -- '- And squash on merge.\\n' >> ${WORKER_FILE}`);
    const agent = await connectAgent('codex-mcp-client', '0.50.0');
    try {
      const report = docketcheck();
      const files = report.files as { key: string; content?: string }[];
      expect(files.filter((f) => f.content !== undefined).map((f) => f.key)).toEqual([WORKER]);
      const claim = await agent.call('claim_lead', {
        id: 'RCP-17',
        agent_label: 'orca-w3',
        workspace: { path: HOST_REPO, branch: 'rcp-17' },
        instructions: report,
      });
      expect(claim.isError, claim.text).toBe(false);

      await page.goto('/');
      await expect(page.locator('[data-problem="agent_files_drift"]')).toContainText(
        'docket-worker edited outside Docket · Recipe App · C:/Users/owner/code/recipes · reported by codex · orca-w3 on RCP-17',
      );

      await page.goto('/items/RCP-17');
      const bar = page.locator('[data-agent-bar]');
      const instr = bar.locator('[data-ab="instructions"]');
      await expect(instr).toContainText('Instructions: docket-worker · default v1 (+5 more)');
      await expect(instr.getByText('edited locally')).toBeVisible();
      await shoot(page, '2-agent-bar', bar);
      await expectAxeClean(page, 'Ticket: run instructions on the agent bar');

      // Lead and runs lists every file.
      await page.getByRole('tab', { name: /Activity/ }).click();
      const lines = page.locator('[data-run-instructions]');
      await expect(lines).toContainText('docket-worker · default v1');
      await expect(lines).toContainText('AGENTS.md block · default v1');
      await shoot(page, '2-lead-and-runs', page.locator('[data-run]').first());

      // The chip opens the entry.
      await instr.getByRole('link', { name: /docket-worker edited locally/ }).click();
      await expect(page).toHaveURL(/\/agent-files#drift-dft_/);
      const entry = page.locator('[data-drift]');
      await expect(entry.getByText(/Reported by codex · orca-w3/)).toBeVisible();
      await expect(entry.getByRole('link', { name: 'RCP-17' })).toBeVisible();
      await entry.getByRole('button', { name: 'Keep local (docket-worker)' }).click();
      await expect(
        toast(page, 'Kept the local docket-worker. A further change there alerts you again.'),
      ).toBeVisible();
      await expect(page.locator('[data-drift-section]')).toHaveCount(0);

      // The same content reported again raises nothing.
      const again = await agent.call('claim_lead', { id: 'RCP-25', instructions: docketcheck() });
      expect(again.isError, again.text).toBe(false);
      // Free RCP-25 for the next claim.
      const released = await agent.call('release_lead', {
        id: 'RCP-25',
        run_id: again.structured.run_id,
        reason: 'Reported only',
      });
      expect(released.isError, released.text).toBe(false);
      await page.goto('/');
      await expect(page.locator('[data-problem="agent_files_drift"]')).toHaveCount(0);
    } finally {
      await agent.close();
    }
  });

  test('3. a further edit alerts again; Restore Docket’s version rewrites the file', async ({
    ownerPage: page,
  }) => {
    sh(`printf -- '- One more local rule.\\n' >> ${WORKER_FILE}`);
    const agent = await connectAgent('codex-mcp-client', '0.50.0');
    try {
      const claim = await agent.call('claim_lead', { id: 'RCP-25', instructions: docketcheck() });
      expect(claim.isError, claim.text).toBe(false);
      lastRun = claim.structured.run_id as string;
    } finally {
      await agent.close();
    }
    await page.goto('/agent-files?project=RCP#drift');
    const entry = page.locator('[data-drift]');
    await expect(entry.getByRole('region')).toContainText('One more local rule.');
    await entry.getByRole('button', { name: 'Restore Docket’s version (docket-worker)' }).click();
    await expect(toast(page, /Restored: Docket reinstalled its version in/)).toBeVisible();
    await expect(page.locator('[data-drift-section]')).toHaveCount(0);
    // The installed file is Recipe App's copy (the adopted text) again, without the later edits.
    const now = sh(`cat ${WORKER_FILE}`);
    expect(now).toContain('Always run pnpm lint first (edited in VS Code).');
    expect(now).not.toContain('One more local rule.');
    expect(now).not.toContain('And squash on merge.');
  });

  test('4. a secret in a reported file: the claim succeeds, the text is withheld, Adopt says why', async ({
    ownerPage: page,
  }) => {
    const secret = `ghp_${'Q'.repeat(36)}`;
    sh(`printf -- '- Push with ${secret}\n' >> ${WORKER_FILE}`);
    const agent = await connectAgent('codex-mcp-client', '0.50.0');
    try {
      const report = docketcheck();
      expect(JSON.stringify(report)).toContain(secret);
      const released = await agent.call('release_lead', {
        id: 'RCP-25',
        run_id: lastRun,
        reason: 'Again',
      });
      expect(released.isError, released.text).toBe(false);
      const claim = await agent.call('claim_lead', { id: 'RCP-25', instructions: report });
      expect(claim.isError, claim.text).toBe(false);
    } finally {
      await agent.close();
    }
    await page.goto('/agent-files?project=RCP#drift');
    const entry = page.locator('[data-drift]');
    await expect(entry.getByText('Content withheld: it looked like a secret.')).toBeVisible();
    await expect(entry).not.toContainText(secret);
    const adopt = entry.getByRole('button', {
      name: 'Adopt as Recipe App’s copy (docket-worker)',
    });
    await expect(adopt).toBeDisabled();
    await expect(
      entry.getByText('Adopt: Content withheld: the local text looked like a secret.'),
    ).toBeVisible();
    await shoot(page, '4-withheld', entry);
    await expectAxeClean(page, 'Agent files: content withheld');
    await entry.getByRole('button', { name: 'Keep local (docket-worker)' }).click();
    await expect(page.locator('[data-drift-section]')).toHaveCount(0);
  });
});

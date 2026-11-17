/**
 * PR evidence: light and dark screenshots of every shell. Skipped unless
 * TASKLITE_E2E_SCREENSHOTS names an output folder.
 */
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { bootstrap, emptyNeedsYou, mockGet } from './fixtures/api-mocks';
import {
  connectAgent,
  expect,
  resetSeededContainer,
  setTheme,
  test,
  unlock,
} from './fixtures/index';
import type { McpAgent } from './fixtures/mcp';

const out = process.env.TASKLITE_E2E_SCREENSHOTS;

test.describe('screenshots', () => {
  test.skip(!out, 'Set TASKLITE_E2E_SCREENSHOTS to a folder to capture screenshots.');

  async function shoot(page: Page, name: string) {
    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme);
      await page.screenshot({ path: join(out!, `${name}-${theme}.png`), fullPage: true });
    }
  }

  test.beforeEach(async ({ page }) => {
    await unlock(page.context());
    // The views as the owner sees them after answering the notifications callout.
    await page.context().addInitScript(() => localStorage.setItem('tl.notifications', 'off'));
  });

  for (const [name, path] of [
    ['needs-you', '/'],
    ['work-board', '/work'],
    ['work-list', '/work?layout=list'],
    ['work-map', '/work?layout=map'],
    ['work-timeline', '/work?layout=timeline'],
    ['item-details', '/items/RCP-14?tab=details'],
    ['item-checklist', '/items/RCP-14?tab=checklist'],
    ['item-deps', '/items/RCP-14?tab=deps'],
    ['item-activity', '/items/RCP-14?tab=activity'],
    ['item-packet-banner', '/items/RCP-12?tab=checklist'],
    ['item-stale-activity', '/items/RCP-15?tab=activity'],
    ['epic-details', '/items/RCP-1'],
    ['packet', '/review/RCP-12'],
    ['label', '/labels/RCP/ui-refresh'],
    ['agents', '/agents'],
    ['settings', '/settings'],
  ] as const) {
    test(name, async ({ page }) => {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await page.waitForLoadState('networkidle');
      await shoot(page, name);
    });
  }

  test('palette with results', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: /^For you now/ })).toBeVisible();
    await page.keyboard.press('Control+k');
    const box = page.getByRole('combobox', { name: 'Search' });
    await expect(box).toBeFocused();
    await page.keyboard.type('pantry');
    await expect(page.getByRole('option').first()).toBeVisible();
    await page.waitForLoadState('networkidle');
    await shoot(page, 'palette');
  });

  test('needs you with the notifications callout', async ({ page }) => {
    await page.context().addInitScript(() => localStorage.removeItem('tl.notifications'));
    await page.goto('/');
    await expect(page.locator('[data-card="notify-optin"]')).toBeVisible();
    await page.waitForLoadState('networkidle');
    await shoot(page, 'needs-you-optin');
  });

  test('unlock', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await page.goto('/unlock');
    await expect(page.getByRole('heading', { name: 'Unlock Task Lite' })).toBeVisible();
    await shoot(page, 'unlock');
    await context.close();
  });

  test('dialog', async ({ page }) => {
    await page.goto('/settings');
    await page.getByRole('button', { name: 'Rotate owner key…' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await shoot(page, 'dialog-rotate-key');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '+ New' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await shoot(page, 'dialog-quick-capture');
  });

  test('rail at 1100px with open tabs', async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 800 });
    await page.goto('/items/RCP-12');
    await page.goto('/items/RCP-14?tab=checklist');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await shoot(page, 'rail-1100');
  });

  test('empty states', async ({ page }) => {
    await mockGet(page, '/api/bootstrap', bootstrap);
    await mockGet(page, '/api/needs-you', emptyNeedsYou);
    await page.goto('/');
    await expect(page.getByText('Nothing deferred.')).toBeVisible();
    await shoot(page, 'needs-you-empty');
  });
});

/**
 * B20 evidence: the coordination views with real agent state, driven through
 * MCP (the e2e fixtures' helper): RCP-17 parked on the coordinator, DOC-5
 * parked on RCP-11 (done, so ready to resume), RCP-25 released with work off
 * the remote (at risk), RCP-14's seeded live lead, and RCP-18 In progress with
 * no lead (its run failed). The same file shoots the UI before and after the
 * change, so it waits only on what both have.
 */
test.describe('screenshots: coordination states (B20)', () => {
  test.skip(!out, 'Set TASKLITE_E2E_SCREENSHOTS to a folder to capture screenshots.');
  test.describe.configure({ mode: 'serial' });

  const tag = process.env.TASKLITE_E2E_SCREENSHOTS_TAG ?? 'b20';
  async function shootB20(page: Page, name: string) {
    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme);
      await page.screenshot({ path: join(out!, `${tag}-${name}-${theme}.png`), fullPage: true });
    }
    await setTheme(page, 'light');
  }
  async function ok(agent: McpAgent, tool: string, args: Record<string, unknown>) {
    const res = await agent.call(tool, args);
    expect(res.isError, `${tool}: ${res.text}`).toBe(false);
    return res.structured;
  }

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    await resetSeededContainer();
    const claude = await connectAgent('claude', '1.0.0');
    const codex = await connectAgent('codex', '1.0.0');
    try {
      const a = await ok(claude, 'claim_lead', {
        id: 'RCP-17',
        agent_label: 'orca-w4',
        workspace: { path: 'C:/work/rcp-17', branch: 'rcp-17-week-reload' },
        orchestrator: { name: 'orca', dispatch_id: 'ctx_demo1', task_id: 'task_demo1' },
        brief: 'Work Task Lite item RCP-17.',
      });
      await ok(claude, 'set_plan', {
        id: 'RCP-17',
        run_id: a.run_id,
        steps: [
          { text: 'Reproduce the jump' },
          { text: 'Keep the week in the URL' },
          { text: 'Test' },
        ],
        reason: 'Plan',
      });
      await ok(claude, 'report_commit', {
        id: 'RCP-17',
        run_id: a.run_id,
        sha: '4be1c09',
        pushed: true,
      });
      await ok(claude, 'heartbeat', {
        run_id: a.run_id,
        workspace: { dirty: false },
        resources_started: [{ kind: 'dev_server', label: 'vite :5173', locator: { port: 5173 } }],
      });
      await ok(claude, 'park_run', {
        run_id: a.run_id,
        reason: 'Waiting for the coordinator to send the next batch',
        waiting_on: { orchestrator: true },
      });

      const b = await ok(claude, 'claim_lead', {
        id: 'DOC-5',
        agent_label: 'orca-w5',
        workspace: { path: 'C:/work/doc-5', branch: 'doc-5-search' },
      });
      await ok(claude, 'park_run', {
        run_id: b.run_id,
        reason: 'Waiting for RCP-11 to be done',
        waiting_on: { items: ['RCP-11'] },
      });

      const c = await ok(codex, 'claim_lead', {
        id: 'RCP-25',
        agent_label: 'orca-w2',
        workspace: { path: 'C:/work/rcp-25', branch: 'rcp-25-pantry-screens' },
      });
      await ok(codex, 'report_commit', {
        id: 'RCP-25',
        run_id: c.run_id,
        sha: '6f00e12',
        pushed: true,
      });
      await ok(codex, 'report_commit', { id: 'RCP-25', run_id: c.run_id, sha: '77aa001' });
      await ok(codex, 'heartbeat', { run_id: c.run_id, workspace: { dirty: true } });
      await ok(codex, 'release_lead', { id: 'RCP-25', run_id: c.run_id, reason: 'Session ends.' });
    } finally {
      await claude.close();
      await codex.close();
    }
  });
  test.afterAll(async () => {
    test.setTimeout(120_000);
    await resetSeededContainer();
  });

  test.beforeEach(async ({ page }) => {
    await unlock(page.context());
    await page.context().addInitScript(() => localStorage.setItem('tl.notifications', 'off'));
  });

  for (const [name, path] of [
    ['item-parked', '/items/RCP-17?tab=details'],
    ['item-parked-activity', '/items/RCP-17?tab=activity'],
    ['item-ready-to-resume', '/items/DOC-5?tab=checklist'],
    ['item-live', '/items/RCP-14?tab=details'],
    ['item-no-lead', '/items/RCP-18?tab=details'],
    ['agents', '/agents'],
    ['agents-parked', '/agents?state=parked'],
    ['agents-workspaces', '/agents#workspaces'],
    ['needs-you', '/'],
    ['work-board', '/work'],
    ['epic-details', '/items/RCP-1?tab=details'],
    ['timeline', '/work?layout=timeline'],
    ['settings', '/settings'],
  ] as const) {
    test(`B20 ${name}`, async ({ page }) => {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await page.waitForLoadState('networkidle');
      await shootB20(page, name);
    });
  }

  test('B20 agents with Recent open, and the timeline burn-down expanded', async ({ page }) => {
    // Sections that start collapsed (after the change only): open them, then shoot.
    await page.goto('/agents');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await page.waitForLoadState('networkidle');
    const recent = page.getByRole('button', { name: /^Recent/ });
    if ((await recent.count()) > 0) {
      await recent.click();
      await shootB20(page, 'agents-recent-open');
    }
    await page.goto('/work?layout=timeline');
    await page.waitForLoadState('networkidle');
    const toggle = page.getByRole('button', { name: /^Remaining effort/ });
    if ((await toggle.count()) > 0 && (await toggle.getAttribute('aria-expanded')) === 'false') {
      await toggle.click();
      await expect(page.locator('[data-burndown-chart] svg')).toBeVisible();
      await shootB20(page, 'timeline-expanded');
    }
  });

  // B22: the Help center (US12), viewport-sized so the side panel shows over its page.
  async function shootB22(page: Page, name: string) {
    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme);
      await page.screenshot({ path: join(out!, `b22-${name}-${theme}.png`) });
    }
  }

  test('B22 help index, an article, the side panel and palette results', async ({ page }) => {
    await page.goto('/help');
    await expect(page.getByRole('heading', { name: 'Getting started' })).toBeVisible();
    await shootB22(page, 'help');
    await page.goto('/help/workspaces-and-pruning');
    await expect(page.getByRole('region', { name: 'Related' })).toBeVisible();
    await shootB22(page, 'article');
    await page.goto('/agents');
    await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: 'Help: Workspace states and safe pruning' }).click();
    const panel = page.getByRole('dialog');
    await expect(panel).toBeVisible();
    // Let the slide-in finish.
    await panel.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
    await shootB22(page, 'panel-agents-workspaces');
    await page.keyboard.press('Escape');
    await page.goto('/');
    await expect(page.getByRole('heading', { name: /^For you now/ })).toBeVisible();
    await page.waitForLoadState('networkidle');
    await shootB22(page, 'needs-you');
    await page.keyboard.press('Control+k');
    await page.getByRole('combobox', { name: 'Search' }).fill('restore');
    await expect(page.getByRole('group', { name: 'Help' })).toBeVisible();
    await shootB22(page, 'palette-help');
    await page.keyboard.press('Escape');
    // The "?" on Settings → Agent setup (after B23), and its article in the panel.
    await page.goto('/settings/agent-setup?project=RCP');
    await page.waitForLoadState('networkidle');
    await shootB22(page, 'agent-setup');
    await page
      .getByRole('button', { name: 'Help: Agent setup: skills and the AGENTS.md block' })
      .first()
      .click();
    const setupPanel = page.getByRole('dialog');
    await expect(setupPanel).toBeVisible();
    await setupPanel.evaluate((el) => Promise.all(el.getAnimations().map((x) => x.finished)));
    await shootB22(page, 'panel-agent-setup');
  });
});

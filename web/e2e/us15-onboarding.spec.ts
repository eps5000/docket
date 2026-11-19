/**
 * Onboarding (tasks.md T165; spec US15 scenarios 1, 3, 4 and 6; UI_SPEC
 * §6.7d; FR-135–FR-140; owner decision 31).
 *
 * One walkthrough, in order:
 * 1. Settings → *New project*: the key uppercases as you type and a taken
 *    key is refused; creating it offers "Onboard it with an agent" (the
 *    line, the prompt, *Import from Jira…*, which opens the import with
 *    the new project as its target);
 * 2. an agent (the SDK client) onboards it: creates an epic and items in
 *    Planning, attaches a planning document, publishes a decision, proposes
 *    Workflow notes, enriches an item the owner made, and finishes; another
 *    agent creates a project with onboard_project, which shows "created by
 *    claude · review" in Settings and in the project switcher;
 * 3. Needs you shows one review card per onboarding, with the counts, the
 *    summary and questions, the proposal link, *Install agent files* and
 *    *Mark reviewed*; the tab title counts it; *Created* opens Work with
 *    only those items and a removable chip; *Mark reviewed* clears the card
 *    and the chip.
 *
 * axe is clean on each screen, both themes. Set DOCKET_E2E_SCREENSHOTS to
 * a folder to capture the PR's screenshots.
 */
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import {
  connectAgent,
  expect,
  expectAxeClean,
  setTheme,
  test,
  useSeededContainer,
} from './fixtures/index';
import { baseURL } from './container';
import type { McpAgent } from './fixtures/mcp';

useSeededContainer();

const out = process.env.DOCKET_E2E_SCREENSHOTS;

async function shoot(page: Page, name: string, target: Locator) {
  if (!out) return;
  for (const theme of ['light', 'dark'] as const) {
    await setTheme(page, theme);
    await target.screenshot({ path: join(out, `us15-${name}-${theme}.png`) });
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

const toast = (page: Page, text: string | RegExp) =>
  page.locator('.toast').filter({ hasText: text });

let agent: McpAgent;
let other: McpAgent;
const created: string[] = [];

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  // Normalised to `claude` (the chip's name), with structured results (claude-code is text-only).
  agent = await connectAgent('claude-agent-sdk', '1.0.0');
  other = await connectAgent('claude-agent-sdk', '1.0.0');
});
test.afterAll(async () => {
  await agent?.close();
  await other?.close();
});

async function ok(a: McpAgent, tool: string, args: Record<string, unknown>) {
  const r = await a.call(tool, args);
  expect(r.isError, `${tool}: ${r.text}`).toBe(false);
  return r;
}

test.describe('Onboarding (US15)', () => {
  test('1. New project, then "Onboard it with an agent"', async ({ ownerPage: page }) => {
    await page.goto('/settings');
    await page.getByRole('button', { name: 'New project' }).click();
    const dialog = page.getByRole('dialog', { name: 'New project' });
    await expect(dialog).toBeVisible();
    const key = dialog.getByLabel('Key');
    await expect(key).toBeFocused();
    await key.fill('rcp');
    await expect(key).toHaveValue('RCP');
    await expect(dialog.getByText('RCP is taken. Pick another key.')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Create project' })).toBeDisabled();
    await key.fill('gf');
    await expect(key).toHaveValue('GF');
    await dialog.getByLabel('Name').fill('Gameflow');
    await dialog.getByLabel('Blockers clear when').selectOption('merged');
    await expect(
      dialog.getByText('2–5 letters. Item IDs start with it, like GF-12.'),
    ).toBeVisible();
    await shoot(page, '1-new-project', dialog);
    await expectAxeClean(page, 'Settings: New project');
    await dialog.getByRole('button', { name: 'Create project' }).click();

    const next = page.getByRole('dialog', { name: 'Gameflow created' });
    await expect(next.getByRole('heading', { name: 'Onboard it with an agent' })).toBeVisible();
    await expect(
      next.getByText('Onboard this repo into Docket as project GF, using onboard_project.'),
    ).toBeVisible();
    await expect(next.getByText('/mcp__docket__onboard GF')).toBeVisible();
    await shoot(page, '1-onboard-with-agent', next);
    await expectAxeClean(page, 'Settings: Onboard it with an agent');

    // Import from Jira… opens the import with the new (empty) project as its target.
    await next.getByRole('button', { name: 'Import from Jira…' }).click();
    const jira = page.getByRole('dialog', { name: /Import from Jira/ });
    await expect(jira).toBeVisible();
    await expect(jira.getByRole('button', { name: 'Existing empty project' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await jira.getByRole('button', { name: 'Cancel' }).click();
    await expect(jira).toHaveCount(0);

    // The project is there, with the owner's blocker rule, and no "created by" chip.
    const row = page.locator('[data-project="GF"]');
    await expect(row.getByText('Gameflow')).toBeVisible();
    await expect(row.locator('[data-blocker-rule="GF"] select')).toHaveValue('merged');
    await expect(row.locator('[data-created-by]')).toHaveCount(0);
  });

  test('2. agents onboard: GF adopted and filled in Planning; ON created, with its chip', async ({
    ownerPage: page,
  }) => {
    const start = await ok(agent, 'onboard_project', { key: 'GF' });
    const session = start.structured.session_id as string;
    expect(start.text).toContain('Onboard this repo into Docket project GF');
    const epic = (
      await ok(agent, 'create_item', {
        project: 'GF',
        type: 'Epic',
        title: 'Match flow',
        status: 'planning',
        description_md: 'Source: specs/001-match/spec.md',
      })
    ).structured.item as { id: string };
    created.push(epic.id);
    for (const [title, path] of [
      ['Lobby screen', 'specs/001-match/tasks.md#T001'],
      ['Matchmaking queue', 'specs/001-match/tasks.md#T002'],
    ] as const) {
      const it = (
        await ok(agent, 'create_item', {
          project: 'GF',
          type: 'Task',
          title,
          epic: epic.id,
          status: 'planning',
          acceptance: ['It works on a phone'],
          description_md: `Source: ${path}`,
        })
      ).structured.item as { id: string };
      created.push(it.id);
    }
    await ok(agent, 'put_document', {
      item_id: epic.id,
      name: '001-match-spec.md',
      kind: 'planning',
      content_text: '# Match flow\n',
    });
    await ok(agent, 'publish_decision', {
      project: 'GF',
      scope: { kind: 'project' },
      title: 'Server-authoritative state',
      decision: 'The server owns match state.',
    });
    await ok(agent, 'propose_agent_file_change', {
      project: 'GF',
      file: 'workflow',
      content: '## Checks to run\n- `pnpm test` before a packet.\n',
      reason: 'From the README.',
      based_on_version_id: null,
    });
    // An item the owner captured: the agent enriches it.
    const mine = (
      await owner(page, 'POST', '/api/items', {
        title: 'Sound settings',
        type: 'Task',
        project: 'GF',
      })
    ).item as { id: string; version: number };
    await ok(agent, 'update_item', {
      id: mine.id,
      expected_version: mine.version,
      acceptance: ['Volume persists across launches'],
    });
    // Ready is refused while onboarding.
    const ready = await agent.call('set_status', { id: created[1], status: 'ready' });
    expect(ready.isError).toBe(true);
    expect(ready.text).toContain("You're onboarding GF");
    await ok(agent, 'finish_onboarding', {
      session_id: session,
      summary: 'Created the Match flow epic and two tasks; enriched Sound settings.',
      questions: ['Is ranked play in scope for the pilot?'],
    });

    // Another agent creates a project with onboard_project: the chip shows until reviewed.
    const on = await ok(other, 'onboard_project', { key: 'ON', name: 'Onboarded' });
    expect((on.structured.project as { created: boolean }).created).toBe(true);
    await ok(other, 'finish_onboarding', {
      session_id: on.structured.session_id,
      summary: 'Nothing to import yet.',
    });

    await page.goto('/settings');
    const chip = page.locator('[data-project="ON"] [data-created-by]');
    await expect(chip).toHaveText('created by claude · review');
    await shoot(page, '2-created-by-settings', page.locator('[data-project="ON"]'));
    await page.locator('.scopebtn').click();
    const menu = page.getByRole('menu', { name: 'Choose project' });
    await expect(menu.getByRole('menuitemradio', { name: /Onboarded/ })).toContainText(
      'created by claude · review',
    );
    await shoot(page, '2-created-by-switcher', menu);
    await expectAxeClean(page, 'Project switcher: created by chip');
    await page.keyboard.press('Escape');
  });

  test('3. Needs you: one card each; Created opens Work filtered; Mark reviewed', async ({
    ownerPage: page,
  }) => {
    await page.goto('/');
    const cards = page.locator('[data-onboarding]');
    await expect(cards).toHaveCount(2);
    const gf = cards.filter({ hasText: 'Gameflow was set up by claude · review' });
    await expect(gf).toBeVisible();
    const counts = gf.getByRole('list', { name: 'What the onboarding changed' });
    await expect(counts).toContainText('3 created');
    await expect(counts).toContainText('1 enriched');
    await expect(counts).toContainText('1 document');
    await expect(counts).toContainText('1 decision');
    await expect(counts).toContainText('1 proposal');
    await expect(gf.getByText('Created the Match flow epic and two tasks')).toBeVisible();
    await expect(gf.getByText('Is ranked play in scope for the pilot?')).toBeVisible();
    await expect(gf.getByRole('link', { name: 'Review the proposal' })).toBeVisible();
    // The badge: each card counts toward the tab title.
    await expect(page).toHaveTitle(/^\(\d+\) Docket$/);
    await shoot(page, '3-review-card', gf);
    await expectAxeClean(page, 'Needs you: onboarding review card');

    // Install agent files: B25's install, for that project.
    await gf.getByRole('button', { name: 'Install agent files' }).click();
    const install = page.getByRole('dialog', { name: /Install into Gameflow/ });
    await expect(install).toBeVisible();
    await install.getByRole('button', { name: 'Cancel' }).click();

    // Created: Work, only the items it created, with a removable chip.
    await gf.locator('[data-onb-link="created"]').click();
    await expect(page).toHaveURL(/\/work\?.*onboarding=onb_.*onboarding_change=created/);
    const filter = page.locator('[data-onboarding-filter]');
    await expect(filter.getByRole('button')).toHaveText(/Onboarding by claude \(GF\) · created/);
    await expect(page.getByText('Lobby screen')).toBeVisible();
    await expect(page.getByText('Matchmaking queue')).toBeVisible();
    await expect(page.getByText('Sound settings')).toHaveCount(0);
    await shoot(page, '3-work-filtered', page.locator('.work'));
    await expectAxeClean(page, 'Work: onboarding filter');
    await filter.getByRole('button').click();
    await expect(page.locator('[data-onboarding-filter]')).toHaveCount(0);
    await expect(page).not.toHaveURL(/onboarding=/);

    // Mark reviewed: the card goes, and ON's chip with its own review.
    await page.goto('/');
    await gf.getByRole('button', { name: 'Mark reviewed' }).click();
    await expect(toast(page, 'Marked the onboarding of Gameflow reviewed.')).toBeVisible();
    await expect(page.locator('[data-onboarding]')).toHaveCount(1);
    const onCard = page.locator('[data-onboarding]').filter({ hasText: 'Onboarded was set up by' });
    await onCard.getByRole('button', { name: 'Mark reviewed' }).click();
    await expect(page.locator('[data-onboarding]')).toHaveCount(0);
    await page.goto('/settings');
    await expect(page.locator('[data-project="ON"]')).toBeVisible();
    await expect(page.locator('[data-project="ON"] [data-created-by]')).toHaveCount(0);
  });
});

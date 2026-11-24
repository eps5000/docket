/**
 * B82 (owner decision 65): tickets agents create arrive shaped or ask for a
 * planner, on the seeded projects with synthetic tickets an agent creates over
 * MCP. A story created mid-epic with only a description is Needs shaping on
 * the ticket, the epic, the map and the producer's digest; the owner's Move to
 * Ready lists exactly what's missing and offers *Ask a planner to shape this*;
 * a planner shapes it and moves it to Ready. axe passes in both themes at
 * 1440 x 900 and 1024 px, plus the PR's screenshots (DOCKET_E2E_SCREENSHOTS).
 */
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import {
  connectAgent,
  expect,
  expectAxeClean,
  setTheme,
  test,
  useSeededContainer,
} from './fixtures/index';
import type { McpAgent } from './fixtures/mcp';

useSeededContainer();

const out = process.env.DOCKET_E2E_SCREENSHOTS;
const SIZES = [
  { name: '1440', width: 1440, height: 900 },
  { name: '1024', width: 1024, height: 768 },
] as const;
const NOTE = 'Check it against the synthetic export story';

async function shots(page: Page, name: string) {
  if (!out) return;
  for (const theme of ['light', 'dark'] as const) {
    await setTheme(page, theme);
    await page.screenshot({ path: join(out, `b82-${name}-${theme}.png`) });
  }
  await setTheme(page, 'light');
}

let producer: McpAgent;
let planner: McpAgent;
test.beforeAll(async () => {
  producer = await connectAgent('codex');
  planner = await connectAgent('claude');
});
test.afterAll(async () => {
  await producer.close();
  await planner.close();
});

const ok = async (agent: McpAgent, tool: string, args: Record<string, unknown>) => {
  const res = await agent.call(tool, args);
  expect(res.isError, res.text).toBe(false);
  return res;
};
const versionOf = async (id: string) =>
  ((await ok(producer, 'get_item', { id, view: 'summary' })).structured.item as { version: number })
    .version;

test('create_item arrives shaped with shared parts or none, and Needs shaping with neither', async () => {
  const shaped = await ok(producer, 'create_item', {
    project: 'RCP',
    type: 'Task',
    title: 'Synthetic shaped task',
    status: 'planning',
    outcome_md: 'Synthetic outcome.',
    acceptance: ['Synthetic criterion'],
    shared: ['table:synthetic_exports'],
  });
  expect(shaped.text).not.toContain('needs shaping');
  const none = await ok(producer, 'create_item', {
    project: 'RCP',
    type: 'Task',
    title: 'Synthetic task with no shared changes',
    status: 'planning',
    outcome_md: 'Synthetic outcome.',
    acceptance: ['Synthetic criterion'],
    shared: 'none',
  });
  expect(none.text).not.toContain('needs shaping');
  const bare = await ok(producer, 'create_item', {
    project: 'RCP',
    type: 'Task',
    title: 'Synthetic bare task',
    description_md: 'Only a short synthetic description.',
  });
  expect(bare.text).toContain(
    'needs shaping: no outcome, no acceptance criteria and shared changes not declared',
  );
});

test("a story added mid-epic is Needs shaping everywhere; the owner's Move to Ready asks a planner; the planner shapes it to Ready", async ({
  ownerPage: page,
}) => {
  const epic = (
    await ok(producer, 'create_item', {
      project: 'RCP',
      type: 'Epic',
      title: 'Synthetic reporting epic',
      status: 'planning',
      outcome_md: 'Synthetic outcome.',
      acceptance: ['Synthetic criterion'],
      shared: 'none',
    })
  ).structured.item as { id: string };
  const story = (
    await ok(producer, 'create_item', {
      project: 'RCP',
      type: 'Story',
      title: 'Synthetic export story',
      description_md: 'Only a short synthetic description.',
      epic: epic.id,
      status: 'planning',
    })
  ).structured.item as { id: string };
  const id = story.id;

  for (const vp of SIZES) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    // The ticket says it, in words.
    await page.goto(`/items/${id}`);
    const header = page.locator('[data-section="header"]');
    await expect(header.locator('.shapechip')).toContainText(
      'Needs shaping: no outcome, no acceptance criteria and shared changes not declared',
    );

    // Move to Ready never dead-ends: exactly what's missing, and the ways forward.
    await header.getByRole('button', { name: 'Move to Ready' }).click();
    const panel = page.locator('[data-ready-refusal]');
    await expect(panel).toBeVisible();
    await expect(panel.locator('[data-missing]')).toHaveCount(3);
    await expect(panel.getByRole('button', { name: 'Ask a planner to shape this' })).toBeVisible();
    await expect(panel.getByRole('button', { name: 'It changes no shared part' })).toBeVisible();
    await shots(page, `refusal-${vp.name}`);
    await expectAxeClean(page, `ready refusal ${vp.name}`, { include: '[data-section="header"]' });
    await panel.getByRole('button', { name: 'Close' }).click();
    await expect(panel).toHaveCount(0);

    // The epic page and its map mark it.
    await page.goto(`/items/${epic.id}`);
    await expect(page.locator('.epicready-line')).toContainText('Needs shaping: 1');
    await expect(page.locator('.epicready-line')).toContainText('(Planning, needs shaping)');
    await shots(page, `epic-${vp.name}`);
    await expectAxeClean(page, `epic page ${vp.name}`, { include: '[data-section="header"]' });
    await page.goto(`/items/${epic.id}?tab=map`);
    const card = page.locator(`.pm-node[data-pid="${id}"]`);
    await expect(card.locator('.pm-shape')).toHaveText('· needs shaping');
    await shots(page, `map-${vp.name}`);
    await expectAxeClean(page, `map ${vp.name}`, { include: `.pm-node[data-pid="${id}"]` });
  }

  // Ask a planner, with a note: recorded on the ticket and in the producer's digest.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/items/${id}`);
  await page.getByRole('button', { name: 'Move to Ready' }).click();
  await page.getByLabel('Note for the planner (optional)').fill(NOTE);
  await page.getByRole('button', { name: 'Ask a planner to shape this' }).click();
  await expect(
    page.locator('.toast').filter({ hasText: `Asked a planner to shape ${id}.` }),
  ).toBeVisible();
  await expect(page.locator('.shapechip')).toContainText('you asked a planner');
  await shots(page, 'asked-1440');
  await expectAxeClean(page, 'asked a planner', { include: '[data-section="header"]' });

  const digest = await ok(producer, 'get_digest', { project: 'RCP' });
  expect(digest.text).toContain('needs shaping');
  expect(digest.text).toContain(`${id} in ${epic.id}`);
  expect(digest.text).toContain(`the owner asked: ${NOTE}`);

  // The planner shapes it: outcome, acceptance, shared changes declared; then Ready.
  const item = await ok(planner, 'get_item', { id });
  expect(item.text).toContain('needs shaping');
  await ok(planner, 'update_item', {
    id,
    expected_version: await versionOf(id),
    outcome_md: 'Synthetic outcome: the export lists every order.',
    acceptance: ['The export has one row per synthetic order'],
  });
  await ok(planner, 'declare_shared_changes', { id, none: true });
  await ok(planner, 'set_status', { id, status: 'ready' });
  await page.reload();
  await expect(page.locator('[data-section="header"] .chip.st-ready')).toBeVisible();
  await expect(page.locator('.shapechip')).toHaveCount(0);
  const after = await ok(producer, 'get_digest', { project: 'RCP' });
  expect(after.text).not.toContain(`${id} in ${epic.id}`);
});

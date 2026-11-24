/**
 * B74 (owner decision 58): an epic starts only when its tickets are ready, on
 * the seeded projects with synthetic tickets an agent creates over MCP. Pick
 * next epic, the epic card and the epic page say "Not ready to start" with the
 * tickets; claim_lead is refused with epic_not_ready until they're shaped;
 * known gaps are approved through the question form and on the item page; and
 * axe passes in both themes at 1440 x 900 and 1024 px, plus the PR's
 * screenshots (DOCKET_E2E_SCREENSHOTS).
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
const GAPS = ['Which retry limit to use', 'Wording of the empty state'];

async function shots(page: Page, name: string) {
  if (!out) return;
  for (const theme of ['light', 'dark'] as const) {
    await setTheme(page, theme);
    await page.screenshot({ path: join(out, `b74-${name}-${theme}.png`) });
  }
  await setTheme(page, 'light');
}

let agent: McpAgent;
test.beforeAll(async () => {
  agent = await connectAgent('codex');
});
test.afterAll(async () => {
  await agent.close();
});

const ok = async (tool: string, args: Record<string, unknown>) => {
  const res = await agent.call(tool, args);
  expect(res.isError, res.text).toBe(false);
  return res.structured;
};
const create = async (type: string, title: string, extra: Record<string, unknown> = {}) => {
  const out = await ok('create_item', {
    project: 'RCP',
    type,
    title,
    status: 'planning',
    ...extra,
  });
  return (out.item as { id: string; version: number }).id;
};
const versionOf = async (id: string) =>
  ((await ok('get_item', { id, view: 'summary' })).item as { version: number }).version;
const releaseOf = async (epic: string) => {
  const found = await ok('search_items', { project: 'RCP', epic, type: ['Release'] });
  return (found.items as { id: string }[])[0]!.id;
};
const gapped = async (title: string, epic: string) => {
  const id = await create('Task', title, { epic });
  await ok('declare_shared_changes', { id, none: true });
  await ok('update_item', {
    id,
    expected_version: await versionOf(id),
    known_gaps: GAPS.map((gap) => ({ gap })),
  });
  return id;
};

/** One epic with a Planning ticket that has known gaps, and an Inbox idea. */
async function seedEpic() {
  const epic = await create('Epic', 'Synthetic offline mode');
  const release = await releaseOf(epic);
  const shaped = await gapped('Synthetic retry settings', epic);
  const idea = await create('Task', 'Synthetic later idea', { epic, status: 'inbox' });
  await ok('declare_shared_changes', { id: epic, none: true });
  await ok('set_status', { id: epic, status: 'ready' });
  return { epic, release, shaped, idea };
}

test('an epic with unshaped tickets is Not ready to start everywhere, and its claim is refused until they are shaped', async ({
  ownerPage: page,
}) => {
  const { epic, release, shaped, idea } = await seedEpic();

  // The agent can't start it, and hears which tickets and the four ways forward.
  const refused = await agent.call('claim_lead', { id: epic, agent_label: 'e2e-producer' });
  expect(refused.isError).toBe(true);
  expect(refused.structured).toMatchObject({ code: 'epic_not_ready' });
  expect(refused.text).toContain(`${shaped} (Planning)`);
  expect(refused.text).toContain(`${idea} (Inbox)`);
  expect(refused.text).toContain(`${release} (Inbox)`);

  for (const vp of SIZES) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    // Pick next epic: its own group, the tickets linked, never Best next.
    await page.goto('/projects/RCP/next-epic');
    const row = page.locator(`[data-pick-group="not_ready"] [data-pick-row="${epic}"]`);
    await expect(row).toBeVisible();
    await expect(row).not.toHaveAttribute('data-best-next', '');
    await expect(row.locator('[data-epic-readiness]')).toContainText(
      'Not ready to start: 3 unshaped tickets',
    );
    await expect(row.getByRole('link', { name: shaped })).toBeVisible();
    await shots(page, `pick-${vp.name}`);
    await expectAxeClean(page, `pick next epic ${vp.name}`, { include: '.pickepic' });

    // The epic page links each ticket with its status.
    await page.goto(`/items/${epic}`);
    const line = page.locator('.epicready-line');
    await expect(line).toContainText('Not ready to start: 3 unshaped tickets');
    // Decision 65 may add ", needs shaping" after the status.
    await expect(line).toContainText('(Inbox');
    await shots(page, `epic-${vp.name}`);
    await expectAxeClean(page, `epic page ${vp.name}`, { include: '[data-section="header"]' });
  }

  // The card on Work says it in words; the seeded In progress epic is started unshaped.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.context().addInitScript(() => sessionStorage.setItem('docket.scope', 'RCP'));
  await page.goto('/work');
  const card = page.locator(`a.epiccard[href="/items/${epic}"]`);
  await expect(card.locator('[data-epic-readiness="not_ready"]')).toContainText(
    'Not ready to start: 3 unshaped tickets',
  );
  await expect(
    page.locator('a.epiccard[href="/items/RCP-1"] [data-epic-readiness="started_unshaped"]'),
  ).toContainText('Started with 5 unshaped tickets');
  await shots(page, 'cards-1440');
  await expectAxeClean(page, 'epic cards', { include: '.epiccard' });

  // Shaping the way forward: the idea leaves the epic, the gaps are approved.
  await ok('update_item', { id: idea, expected_version: await versionOf(idea), epic: null });
  const asked = await agent.call('set_status', { id: shaped, status: 'ready' });
  expect(asked.isError).toBe(true);
  expect(asked.text).toContain(`Approve moving ${shaped} to Ready with these gaps?`);
  await page.goto(`/items/${shaped}`);
  await page
    .locator('[data-banner="question"]')
    .getByRole('button', { name: /^Answer/ })
    .click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.locator('[data-q-gaps]')).toContainText(GAPS[0]!);
  await page.keyboard.press('Enter');
  await expect(
    page.locator('.toast').filter({ hasText: `Answer posted to ${shaped}` }),
  ).toBeVisible();
  await expect
    .poll(async () => (await agent.call('get_item', { id: shaped, view: 'summary' })).text)
    .toContain('ready');

  await ok('set_status', { id: release, status: 'planning' });
  await ok('declare_shared_changes', { id: release, none: true });
  await ok('set_status', { id: release, status: 'ready' });
  // Now every ticket, including the Release, is at least Ready: the epic starts.
  await ok('claim_lead', { id: epic, agent_label: 'e2e-producer' });
});

test('known gaps on the item page: the question dialog, approval in the header, and the implementer’s view', async ({
  ownerPage: page,
}) => {
  const epic = await create('Epic', 'Synthetic sync epic');
  const viaPage = await gapped('Synthetic conflict banner', epic);
  // Docket asks the owner when the agent proposes Ready.
  const asked = await agent.call('set_status', { id: viaPage, status: 'ready' });
  expect(asked.isError).toBe(true);

  for (const vp of SIZES) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.goto(`/items/${viaPage}`);
    const section = page.locator('[data-section="known-gaps"]');
    await expect(section).toContainText('2 open · needs your approval to move to Ready');
    await expect(section).toContainText(GAPS[1]!);
    await shots(page, `gaps-${vp.name}`);
    await expectAxeClean(page, `known gaps ${vp.name}`, { include: '[data-section="known-gaps"]' });

    await page
      .locator('[data-banner="question"]')
      .getByRole('button', { name: /^Answer/ })
      .click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.locator('[data-q-gaps] li')).toHaveCount(2);
    await shots(page, `dialog-${vp.name}`);
    await expectAxeClean(page, `gaps question ${vp.name}`, { include: '.dlg' });
    await page.keyboard.press('Escape');
  }

  // The owner approves in the header instead: the question is answered for them.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('button', { name: 'Approve gaps and move to Ready' }).click();
  await expect(
    page
      .locator('.toast')
      .filter({ hasText: `Approved ${viaPage}'s known gaps and moved it to Ready.` }),
  ).toBeVisible();
  await expect(page.locator('[data-banner="question"]')).toHaveCount(0);
  await expect(page.locator('[data-section="known-gaps"]')).toContainText('approved by you');

  // The implementer sees Known gaps to shape, and records how each was settled.
  const claim = await ok('claim_lead', { id: viaPage, agent_label: 'e2e-worker' });
  const run_id = claim.run_id as string;
  const context = await agent.call('get_context', { id: viaPage, run_id, budget: 'small' });
  expect(context.text).toContain('known gaps to shape (2 open');
  await ok('update_item', {
    id: viaPage,
    run_id,
    expected_version: await versionOf(viaPage),
    known_gaps: [
      { gap: GAPS[0], settled: 'Three retries, then a quiet banner' },
      { gap: GAPS[1], settled: 'Reused the list wording' },
    ],
  });
  await page.reload();
  const section = page.locator('[data-section="known-gaps"]');
  await expect(section.locator('h3')).toHaveText('Known gaps to shape');
  await expect(section).toContainText('Three retries, then a quiet banner');
  await shots(page, 'settled-1440');
  await expectAxeClean(page, 'settled gaps', { include: '[data-section="known-gaps"]' });
});

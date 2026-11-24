/**
 * B78 (owner decision 61): implementers report how they finished, on the
 * seeded RCP project with synthetic tickets an agent creates over MCP. The
 * real case, made up: the implementer merged its work, but one acceptance
 * item needs a switch another ticket turns on, so it parks on that ticket
 * with a partial exit and its session ends.
 *
 * - The run's line is its park, not "PR open, CI running"; the card says
 *   "Finished partly: 1 item left"; the item page lists the item with why and
 *   what would finish it.
 * - The producer's digest lists it; an agent's Done is refused; a note
 *   settles it, and the item page says so.
 * - axe in both themes, no horizontal overflow, and screenshots at
 *   1440 x 900 and 1024 px (DOCKET_E2E_SCREENSHOTS).
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
const LEFT = {
  text: 'Check the export with the new format switched on',
  why: 'The switch is turned on by another ticket',
  needs: 'The ticket that turns the switch on, then a quick check',
};

async function shots(page: Page, name: string) {
  if (!out) return;
  for (const theme of ['light', 'dark'] as const) {
    await setTheme(page, theme);
    await page.screenshot({ path: join(out, `b78-${name}-${theme}.png`) });
  }
  await setTheme(page, 'light');
}

const noOverflow = async (page: Page, width: number) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    width,
  );

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
const ready = async (title: string, acceptance: string[]) => {
  const out = await ok('create_item', {
    project: 'RCP',
    type: 'Task',
    title,
    status: 'planning',
    acceptance,
  });
  const id = (out.item as { id: string }).id;
  await ok('declare_shared_changes', { id, none: true });
  await ok('set_status', { id, status: 'ready' });
  return id;
};

test('a partial exit: the truthful run line, the card, the item page, the digest, Done refused, then settled', async ({
  ownerPage: page,
}) => {
  const flag = await ready('Synthetic format switch', ['The new format can be switched on']);
  const id = await ready('Synthetic export in the new format', ['Export works', LEFT.text]);
  const claim = await ok('claim_lead', {
    id,
    agent_label: 'e2e-w3',
    orchestrator: { name: 'e2e-producer', dispatch_id: 'ctx_e2e_b78' },
  });
  const run_id = claim.run_id as string;
  await ok('heartbeat', { run_id, note: 'PR open, CI running, reviewer running' });
  await ok('park_run', {
    run_id,
    reason: `Waiting for ${flag} to turn the switch on`,
    waiting_on: { items: [flag] },
    exit: { outcome: 'partial', left: [{ ...LEFT, item: flag }] },
  });

  // The producer's digest lists it, and an agent can't close the ticket as Done.
  const digest = await ok('get_digest', { project: 'RCP' });
  expect(digest.finished_partly).toMatchObject({
    total: 1,
    rows: [{ item_id: id, left: [{ ...LEFT, item: flag }] }],
  });
  const done = await agent.call('set_status', { id, status: 'done' });
  expect(done.isError).toBe(true);
  expect(done.text).toContain(LEFT.text);

  await page.context().addInitScript(() => sessionStorage.setItem('docket.scope', 'RCP'));
  for (const vp of SIZES) {
    await page.setViewportSize({ width: vp.width, height: vp.height });

    // The card leads with how it finished, then the park.
    await page.goto('/work');
    const card = page.locator(`a.tcard[data-item="${id}"]`);
    await expect(card.locator('[data-finished-partly]')).toHaveText(/Finished partly: 1 item left/);
    await expect(card.locator('[data-finished-partly]')).toHaveAttribute(
      'title',
      `${LEFT.text}: ${LEFT.why}`,
    );
    await noOverflow(page, vp.width);
    await shots(page, `card-${vp.name}`);
    await expectAxeClean(page, `card ${vp.name}`, { include: `a.tcard[data-item="${id}"]` });

    // The item page: each item, why, what would finish it, and the ticket.
    await page.goto(`/items/${id}`);
    const block = page.locator('[data-finished-partly-block="open"]');
    await expect(block).toContainText('Finished partly: 1 item left');
    await expect(block).toContainText('waiting on its producer');
    await expect(block).toContainText(LEFT.text);
    await expect(block).toContainText(`Why: ${LEFT.why}`);
    await expect(block).toContainText(`Needs: ${LEFT.needs}`);
    await expect(block.getByRole('link', { name: flag })).toBeVisible();
    await noOverflow(page, vp.width);
    await shots(page, `item-${vp.name}`);
    await expectAxeClean(page, `item page ${vp.name}`, { include: '[data-section="header"]' });

    // Lead and runs: the park, never the line from before it.
    await page.goto(`/items/${id}?tab=activity`);
    const row = page.locator(`[data-run="${run_id}"]`);
    await expect(row).toContainText(
      `Finished partly: 1 item left · Parked: Waiting for ${flag} to turn the switch on`,
    );
    await expect(row).not.toContainText('PR open, CI running');
  }

  // The producer closes it with a note: the digest clears and the item page says how.
  await ok('add_note', { id, text: `Moved the check to ${flag}, which turns the switch on.` });
  const after = await ok('get_digest', { project: 'RCP' });
  expect(after.finished_partly).toBeUndefined();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/items/${id}`);
  const settled = page.locator('[data-finished-partly-block="settled"]');
  await expect(settled).toContainText('Settled: closed with a note');
  await shots(page, 'settled-1440');
  await expectAxeClean(page, 'settled', { include: '[data-section="header"]' });
});

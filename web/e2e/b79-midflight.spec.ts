/**
 * B79 (owner decision 62), on the seeded instance with synthetic tickets that
 * agents create over MCP:
 *
 * - **Added mid-flight:** a bug and a story added to an epic whose work has
 *   begun land in Inbox; the producer's digest lists them as untriaged;
 *   closing the epic is refused, listing them; the epic card, the epic page
 *   and the Map tab mark them.
 * - **Idle:** a ticket left In progress with no run. Three idle days can't
 *   pass in a test, so Needs you's response gains that ticket's idle problem
 *   (the server's own row and words are covered in b79-midflight.test.ts);
 *   *Decide…* then moves it through the real API, and Undo puts it back.
 * - **Acknowledged:** acknowledging a real problem folds it on the item page
 *   into "You acknowledged 1 problem", collapsed and not counted.
 *
 * axe is clean in both themes at 1440 x 900 and 1024 px, plus the PR's
 * screenshots (DOCKET_E2E_SCREENSHOTS).
 */
import { join } from 'node:path';
import type { Page, Route } from '@playwright/test';
import type { NeedsYouResponse, Problem } from '@docket/shared';
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
test.describe.configure({ mode: 'serial' });

const out = process.env.DOCKET_E2E_SCREENSHOTS;
const SIZES = [
  { name: '1440', width: 1440, height: 900 },
  { name: '1024', width: 1024, height: 768 },
] as const;

async function shots(page: Page, name: string) {
  if (!out) return;
  for (const theme of ['light', 'dark'] as const) {
    await setTheme(page, theme);
    await page.screenshot({ path: join(out, `b79-${name}-${theme}.png`) });
  }
  await setTheme(page, 'light');
}

const toast = (page: Page, text: string | RegExp) =>
  page.locator('.toast').filter({ hasText: text });

/** Wait for toasts to finish fading in before axe (B25); endless animations are skipped. */
async function settle(page: Page) {
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getComputedTiming().endTime !== Infinity)
        .map((a) => a.finished.catch(() => undefined)),
    ),
  );
}

let producer: McpAgent;
let worker: McpAgent;
test.beforeAll(async () => {
  producer = await connectAgent('claude');
  worker = await connectAgent('codex');
});
test.afterAll(async () => {
  await producer.close();
  await worker.close();
});

const ok = async (agent: McpAgent, tool: string, args: Record<string, unknown>) => {
  const res = await agent.call(tool, args);
  expect(res.isError, res.text).toBe(false);
  return res.structured;
};
const create = async (type: string, title: string, extra: Record<string, unknown> = {}) => {
  const res = await ok(producer, 'create_item', { project: 'RCP', type, title, ...extra });
  return (res.item as { id: string }).id;
};
/** Shaped and Ready: planning, no shared changes, then ready. */
const ready = async (type: string, title: string, extra: Record<string, unknown> = {}) => {
  const id = await create(type, title, { status: 'planning', ...extra });
  await ok(producer, 'declare_shared_changes', { id, none: true });
  await ok(producer, 'set_status', { id, status: 'ready' });
  return id;
};
const statusOf = async (id: string) =>
  ((await ok(producer, 'get_item', { id, view: 'summary' })).item as { status: string }).status;

test('a bug and a story added mid-flight are untriaged in the digest, marked everywhere, and hold the epic open', async ({
  ownerPage: page,
}) => {
  const epic = await ready('Epic', 'Synthetic offline sync');
  const first = await ready('Task', 'Synthetic sync queue', { epic });
  await ok(producer, 'claim_lead', { id: epic, agent_label: 'e2e-producer' });
  await ok(worker, 'claim_lead', { id: first, agent_label: 'e2e-worker' });
  const bug = await create('Bug', 'Synthetic crash when the queue is empty', { epic });
  const story = await create('Story', 'Synthetic sync on metered networks', { epic });

  // The producer's digest lists them first, untriaged.
  const digest = await producer.call('get_digest', { project: 'RCP' });
  expect(digest.isError, digest.text).toBe(false);
  expect(digest.text).toContain('added mid-flight 1:');
  expect(digest.text).toContain(
    `${epic} added since this epic started: 2 untriaged: ${bug} bug, ${story} story`,
  );

  // Closing the epic is refused, listing them.
  const refused = await producer.call('set_status', { id: epic, status: 'done' });
  expect(refused.isError).toBe(true);
  expect(refused.text).toContain(`Can't close epic ${epic}`);
  expect(refused.text).toContain(`${bug} (bug)`);
  expect(refused.text).toContain(`${story} (story)`);

  for (const vp of SIZES) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    // The epic card: one line, the tickets in its tooltip.
    await page.goto('/work');
    const card = page.locator(`a.epiccard[href="/items/${epic}"]`);
    await expect(card.locator('[data-epic-midflight]')).toContainText(
      'Added since it started: 2 tickets · 2 untriaged',
    );
    await shots(page, `card-${vp.name}`);
    await expectAxeClean(page, `epic card ${vp.name}`, {
      include: `a.epiccard[href="/items/${epic}"]`,
    });

    // The epic page: each ticket linked, saying untriaged.
    await page.goto(`/items/${epic}`);
    const line = page.locator('.epicmid-line');
    await expect(line).toContainText('Added since it started: 2 tickets · 2 untriaged');
    await expect(line.getByRole('link', { name: bug })).toBeVisible();
    await expect(line).toContainText(`${story} (untriaged)`);
    await shots(page, `epic-${vp.name}`);
    await expectAxeClean(page, `epic page ${vp.name}`, { include: '[data-section="header"]' });

    // The Map tab marks both cards, in words.
    await page.goto(`/items/${epic}?tab=map`);
    for (const id of [bug, story]) {
      await expect(page.locator(`.pm-node[data-pid="${id}"] .pm-added`)).toHaveText(
        '· added mid-flight',
      );
    }
    await expect(page.locator(`.pm-node[data-pid="${first}"] .pm-added`)).toHaveCount(0);
    await shots(page, `map-${vp.name}`);
    await expectAxeClean(page, `epic map ${vp.name}`, { include: '[data-section="map"]' });
  }

  // Triaged: the bug to Ready here, the story out of the epic. The digest lets go.
  await ok(producer, 'set_status', { id: bug, status: 'planning' });
  await ok(producer, 'declare_shared_changes', { id: bug, none: true });
  await ok(producer, 'set_status', { id: bug, status: 'ready' });
  const v = (
    (await ok(producer, 'get_item', { id: story, view: 'summary' })).item as {
      version: number;
    }
  ).version;
  await ok(producer, 'update_item', { id: story, expected_version: v, epic: null });
  const after = await producer.call('get_digest', { project: 'RCP' });
  expect(after.text).not.toContain(`${epic} added since this epic started`);
});

/** Needs you, with an idle problem for `id` added to the server's own answer. */
async function withIdle(page: Page, id: string, title: string) {
  const idle: Problem = {
    kind: 'idle_ticket',
    id: `idle_ticket:${id}`,
    item_id: id,
    title,
    reason: `${id} is In progress but nobody has worked on it since Nov 20`,
    related: [],
    link_id: null,
    run_id: null,
    resource_ids: [],
    explanation: {
      what: `${id} is In progress but nobody has worked on it since Nov 20: no agent, no run and no activity.`,
      fix: 'Move it to Planning, Ready or Inbox, cancel it, or clear its branches. If someone will pick it up again, acknowledge this.',
      who: 'owner',
      who_text: 'You (nobody is working on it)',
    },
    reached_you: null,
    acknowledged: null,
    resolution: null,
  };
  await page.route(/\/api\/needs-you(\?.*)?$/, async (route: Route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const res = await route.fetch();
    const body = (await res.json()) as NeedsYouResponse;
    const has = body.problems.some((p) => p.id === idle.id);
    const alive = (await statusOf(id)) === 'progress';
    await route.fulfill({
      response: res,
      json: { ...body, problems: has || !alive ? body.problems : [idle, ...body.problems] },
    });
  });
}

test('an idle ticket: Decide… moves it through the real API, and Undo puts it back', async ({
  ownerPage: page,
}) => {
  const title = 'Synthetic export to calendar';
  const id = await ready('Task', title);
  const claim = await ok(worker, 'claim_lead', { id, agent_label: 'e2e-worker' });
  await ok(worker, 'finish_run', {
    run_id: claim.run_id,
    result: 'finished',
    summary: 'Synthetic: stopped without handing off.',
  });
  expect(await statusOf(id)).toBe('progress');
  await withIdle(page, id, title);

  for (const vp of SIZES) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.goto('/');
    const row = page.locator(`[data-card="problems"] [data-problem-id="idle_ticket:${id}"]`);
    await expect(row).toContainText('nobody has worked on it since Nov 20');
    await expect(row.getByRole('button', { name: 'Decide…' })).toBeVisible();
    await expectAxeClean(page, `Needs you, an idle ticket ${vp.name}`, {
      include: '[data-card="problems"]',
    });

    await row.getByRole('button', { name: 'Decide…' }).click();
    const dialog = page.getByRole('dialog', { name: `What happens to ${id}?` });
    await expect(dialog.getByRole('radio')).toHaveCount(5);
    await dialog.getByRole('radio', { name: /Move it to Planning/ }).check();
    await shots(page, `idle-dialog-${vp.name}`);
    await expectAxeClean(page, `the idle dialog ${vp.name}`, { include: '[role="dialog"]' });
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
  }

  // The real move, then Undo.
  await page.setViewportSize({ width: 1440, height: 900 });
  const row = page.locator(`[data-card="problems"] [data-problem-id="idle_ticket:${id}"]`);
  await row.getByRole('button', { name: 'Decide…' }).click();
  const dialog = page.getByRole('dialog', { name: `What happens to ${id}?` });
  await dialog.getByRole('radio', { name: /Move it to Planning/ }).check();
  await dialog.getByRole('button', { name: 'Move it to Planning' }).click();
  const moved = toast(page, `${id}: Moved to Planning.`);
  await expect(moved).toBeVisible();
  await expect.poll(() => statusOf(id)).toBe('planning');
  await expect(row).toHaveCount(0);
  await moved.getByRole('button', { name: 'Undo' }).click();
  await expect(toast(page, 'Undone.')).toBeVisible();
  await expect.poll(() => statusOf(id)).toBe('progress');
});

test('an acknowledged problem folds on the item page, collapsed and not counted', async ({
  ownerPage: page,
}) => {
  const id = await ready('Task', 'Synthetic recipe import retry');
  const claim = await ok(worker, 'claim_lead', { id, agent_label: 'e2e-worker' });
  await ok(worker, 'finish_run', {
    run_id: claim.run_id,
    result: 'failed',
    summary: 'Synthetic failure.',
    error: 'Synthetic: the import fixture was missing.',
  });

  // Acknowledge it on the ticket's own banner: it folds away at once.
  await page.goto(`/items/${id}`);
  const open = page.locator(
    `[data-banner="problems"] [data-problem-id="failed_run:${String(claim.run_id)}"]`,
  );
  await open.getByRole('button', { name: 'Acknowledge' }).click();
  await expect(toast(page, 'Acknowledged.')).toBeVisible();
  await expect(open).toHaveCount(0);

  for (const vp of SIZES) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.goto(`/items/${id}`);
    const banners = page.locator('[data-banner="problems"]');
    const fold = banners.getByRole('button', { name: 'You acknowledged 1 problem' });
    await expect(fold).toHaveAttribute('aria-expanded', 'false');
    await expect(banners).not.toContainText('open problem');
    await expect(banners.locator(`[data-problem-id="failed_run:${claim.run_id}"]`)).toHaveCount(0);
    await settle(page);
    await expectAxeClean(page, `the folded line ${vp.name}`, {
      include: '[data-banner="problems"]',
    });

    await fold.click();
    await expect(fold).toHaveAttribute('aria-expanded', 'true');
    const banner = banners.locator(`[data-problem-id="failed_run:${claim.run_id}"]`);
    await expect(banner.getByRole('img', { name: 'Problem (acknowledged)' })).toBeVisible();
    await expect(banner).toContainText(/Acknowledged by you \d+[sm] ago/);
    await shots(page, `acked-${vp.name}`);
    await expectAxeClean(page, `the acknowledged problem, opened ${vp.name}`, {
      include: '[data-banner="problems"]',
    });
  }
});

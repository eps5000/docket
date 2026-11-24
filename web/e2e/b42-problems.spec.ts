/**
 * Problems that say what's wrong, who fixes it and what to do, end to end
 * (owner decision 37; tasks.md T189; spec US18 scenarios 7–9; UI_SPEC §6.1,
 * §6.3), against the seeded instance and a fixture repository on this
 * machine, read by the real helper's git source (B76):
 *
 * - `rcp-1-old` (RCP-1, no lead) and `rcp-14-old` (RCP-14, a live lead) are
 *   both out of date with main. RCP-1's problem reaches Problems at once
 *   ("Nobody is working on RCP-1"); RCP-14's waits under "Agents are
 *   handling 1 problem";
 * - *Open the item* lands on RCP-1's problem banner, focused; *Remind the
 *   agent* posts a note (Undo takes it back); *Not an active branch* clears
 *   the finding at once (Undo brings it back);
 * - *Acknowledge* takes it off Needs you and the banner says so; an agent's
 *   `propose_resolution` brings it back with a card; *Go a different way*
 *   (a note), a second proposal, *Approve*; the agent's `get_context` shows
 *   each choice.
 *
 * axe is clean in both themes on Needs you, the banner and the proposal card.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { baseURL } from './container';
import {
  connectAgent,
  expect,
  expectAxeClean,
  resetSeededContainer,
  test,
  unlock,
  useSeededContainer,
} from './fixtures/index';
import { hostFolder, hostGit, hostGitPass } from './fixtures/host-git';
import type { McpAgent } from './fixtures/mcp';

useSeededContainer();
test.describe.configure({ mode: 'serial' });

const host = hostFolder('docket-e2e-b42-');
const REPO = `${host.dir}/b42-radar`;

/** Two branches that each change a line main changed since: both out of date with main. */
function makeFixtureRepo() {
  const g = (...args: string[]) => hostGit(REPO, host.dir, ...args);
  const write = (text: string) => writeFileSync(join(REPO, 'shared.txt'), text);
  mkdirSync(REPO, { recursive: true });
  g('init', '-q', '-b', 'main');
  write('one\ntwo\nthree\n');
  g('add', 'shared.txt');
  g('commit', '-q', '-m', 'start');
  g('checkout', '-q', '-b', 'rcp-1-old');
  write('one old\ntwo\nthree\n');
  g('commit', '-qam', 'old1');
  g('checkout', '-q', '-b', 'rcp-14-old', 'main');
  write('one\ntwo\nthree old\n');
  g('commit', '-qam', 'old14');
  g('checkout', '-q', 'main');
  write('one main\ntwo\nthree main\n');
  g('commit', '-qam', 'main');
}

/** The owner's API from the unlocked page's context (cookies and the CSRF header). */
async function owner(page: Page, method: 'GET' | 'POST' | 'PUT', path: string, data?: unknown) {
  if (!(await page.context().cookies()).some((c) => c.name === 'docket_csrf')) {
    await page.request.get('/api/bootstrap');
  }
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

let codex: McpAgent;
let problemId = '';

test.beforeAll(async () => {
  codex = await connectAgent('codex');
  makeFixtureRepo();
});

test.afterAll(async () => {
  test.setTimeout(120_000);
  await codex?.close();
  try {
    host.remove();
  } finally {
    await resetSeededContainer();
  }
});

test.beforeEach(async ({ page }) => {
  await unlock(page.context());
  await page.context().addInitScript(() => localStorage.setItem('docket.notifications', 'off'));
  await page.context().addInitScript(() => sessionStorage.setItem('docket.scope', 'RCP'));
});

test('an agent problem with no lead reaches you; Open lands on the banner; Remind and Not an active branch undo', async ({
  page,
}) => {
  for (const [id, branch] of [
    ['RCP-1', 'rcp-1-old'],
    ['RCP-14', 'rcp-14-old'],
  ] as const) {
    const r = await codex.call('declare_shared_changes', { id, none: true, branches: [branch] });
    expect(r.isError, r.text).toBe(false);
  }
  await owner(page, 'PUT', '/api/projects/RCP/radar', { repo_path: REPO, main_branch: 'main' });
  // B76: the helper on the host reads the repository and posts what it found.
  await hostGitPass(page.request, host.dir);
  await owner(page, 'POST', '/api/projects/RCP/radar/run', {});

  await page.goto('/');
  const card = page.locator('[data-card="problems"]');
  const row = card.locator('[data-problem="radar_conflict"]');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText(
    "RCP-1's branch rcp-1-old is out of date with main: 1 file conflicts (shared.txt).",
  );
  await expect(row).toContainText(
    "Rebase it onto main, or split it into short story PRs. If it's an old draft, remove it from RCP-1's branches.",
  );
  await expect(row).toContainText('An agent (RCP-1 has no lead yet)');
  await expect(row).toContainText('Nobody is working on RCP-1');
  problemId = (await row.getAttribute('data-problem-id')) ?? '';
  expect(problemId).toMatch(/^rdf_/);
  const mine = card.locator(`[data-problem-id="${problemId}"]`);
  // RCP-14 has a lead: the agents handle it first, and Needs you says so.
  const health = page.locator('[data-card="health"]');
  const handling = health.getByRole('button', { name: 'Agents are handling 1 problem' });
  await handling.click();
  await expect(health.locator('[data-more-problems="agents"] [data-problem]')).toContainText(
    'An agent (the lead of RCP-14)',
  );
  await settle(page);
  await expectAxeClean(page, 'Needs you, problems with the three lines');

  // Open the item: the banner, focused.
  await mine.getByRole('link', { name: 'Open the item' }).click();
  await expect(page).toHaveURL(new RegExp(`/items/RCP-1\\?tab=details&problem=${problemId}`));
  const banner = page.locator(`[data-banner="problems"] [data-problem-id="${problemId}"]`);
  await expect(banner).toBeFocused();
  await expect(banner.getByRole('img', { name: 'Problem' })).toBeVisible();
  await expect(banner).toContainText('Out of date with main');
  await settle(page);
  await expectAxeClean(page, 'the item’s problem banner');

  // It stays on every tab.
  await page
    .getByRole('tablist')
    .getByRole('tab', { name: /^Activity/ })
    .click();
  await expect(banner).toBeVisible();

  // Remind the agent: an owner note; Undo takes it back.
  await banner.getByRole('button', { name: 'Remind the agent' }).click();
  const reminded = toast(page, 'Reminded RCP-1’s agent.');
  await expect(reminded).toBeVisible();
  await expect(page.getByRole('tabpanel')).toContainText("Reminder from Docket's Problems");
  await reminded.getByRole('button', { name: 'Undo' }).click();
  await expect(toast(page, 'Undone.')).toBeVisible();

  // Not an active branch: the finding clears at once; Undo brings it back.
  await banner.getByRole('button', { name: 'Not an active branch: rcp-1-old' }).click();
  const removed = toast(
    page,
    'Removed rcp-1-old from RCP-1’s branches; the radar stops checking it.',
  );
  await expect(removed).toBeVisible();
  await expect(banner).toHaveCount(0);
  await removed.getByRole('button', { name: 'Undo' }).click();
  await expect(toast(page, 'Undone.')).toBeVisible();
  await expect(banner).toBeVisible();
});

test('Acknowledge, then propose, a different way, propose again, approve', async ({ page }) => {
  await page.goto('/');
  const card = page.locator('[data-card="problems"]');
  const row = card.locator(`[data-problem-id="${problemId}"]`);
  await row.getByRole('button', { name: 'Acknowledge' }).click();
  await expect(toast(page, 'Acknowledged.')).toBeVisible();
  await expect(row).toHaveCount(0);
  await expect(
    page
      .locator('[data-card="health"]')
      .getByRole('button', { name: 'You acknowledged 1 problem' }),
  ).toBeVisible();

  // The banner keeps it, saying so.
  await page.goto(`/items/RCP-1?problem=${problemId}`);
  const banner = page.locator(`[data-banner="problems"] [data-problem-id="${problemId}"]`);
  await expect(banner.getByRole('img', { name: 'Problem (acknowledged)' })).toBeVisible();
  await expect(banner).toContainText(/Acknowledged by you \d+[sm] ago/);

  // A proposal brings it back to Needs you, with a card.
  const first = await codex.call('propose_resolution', {
    problem: problemId,
    kind: 'split',
    plan_md: '1. Land the shell tokens as one story.\n2. Rebase the rest onto main.',
    reason: 'The epic branch is far behind main.',
  });
  expect(first.isError, first.text).toBe(false);
  await page.goto('/');
  const proposal = page.locator('[data-card="resolutions"] [data-resolution-card]');
  await expect(proposal).toHaveCount(1);
  await expect(proposal).toContainText('Proposed: Split the work');
  await expect(proposal).toContainText('The epic branch is far behind main.');
  await expect(row).toHaveCount(1);
  await settle(page);
  await expectAxeClean(page, 'Needs you, a proposed resolution');

  // Go a different way: a note is required; it reaches the agent; the problem stays open.
  await proposal.getByRole('button', { name: 'Go a different way' }).click();
  const note = proposal.getByLabel('Which way instead (required)');
  await expect(note).toBeFocused();
  await note.fill('Keep the epic whole; rebase it in two passes.');
  await proposal.getByRole('button', { name: 'Send: go a different way' }).click();
  await expect(toast(page, /The problem stays open\./)).toBeVisible();
  await expect(proposal).toHaveCount(0);
  let ctx = await codex.call('get_context', { id: 'RCP-1' });
  expect(ctx.text).toContain(
    'go a different way; propose again · owner: Keep the epic whole; rebase it in two passes.',
  );

  // The agent proposes again: back on Needs you; Approve.
  const again = await codex.call('propose_resolution', {
    problem: problemId,
    kind: 'reorder',
    plan_md: '1. Rebase onto main in two passes.',
    reason: 'As you asked.',
  });
  expect(again.isError, again.text).toBe(false);
  await page.goto('/');
  await expect(proposal).toHaveCount(1);
  await expect(proposal).toContainText('Proposed: Change the order of work');
  await proposal.getByRole('button', { name: 'Approve' }).click();
  await expect(toast(page, 'Approved. codex reads it on its next call.')).toBeVisible();
  await expect(proposal).toHaveCount(0);
  ctx = await codex.call('get_context', { id: 'RCP-1' });
  expect(ctx.text).toContain('reorder for');
  expect(ctx.text).toContain('approved: go ahead');

  // The banner shows the decided proposal.
  await page.goto(`/items/RCP-1?problem=${problemId}`);
  await expect(banner.locator('[data-resolution-state="approved"]')).toContainText('Approved');
  await settle(page);
  await expectAxeClean(page, 'the banner with an approved proposal');
});

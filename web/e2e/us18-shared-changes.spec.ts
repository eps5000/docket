/**
 * Shared changes and conflict guardrails end to end (owner decision 36;
 * tasks.md T185; spec US18; UI_SPEC §6.3.6), against the seeded instance:
 *
 * - Settings → Projects → Shared parts: the registry (*Add a part*) and the
 *   radar card (a fixture repo created inside the container's push folder);
 * - an overlap: an agent's refused claim raises the Needs you card, the Work
 *   card shows "overlap", and *They're compatible* lets the claim through;
 * - an undeclared hold: a packet whose changed files touch an undeclared part
 *   is held, and *Add to the declaration* opens it;
 * - the item's Shared changes section with a lease (*Release lease*) and a
 *   radar finding, which Problems also lists ("Heading for a conflict");
 * - B40, B41: the item's branches, found by the radar (one local branch
 *   names the item) or ambiguous (several do), then *Add branch* twice and
 *   *Remove* on each.
 *
 * axe is clean in both themes on each screen. Set DOCKET_E2E_SCREENSHOTS to a
 * folder to also capture the PR's light and dark screenshots.
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
  unlock,
  useSeededContainer,
} from './fixtures/index';
import { CONTAINER } from './fixtures/container';
import type { McpAgent } from './fixtures/mcp';

useSeededContainer();
test.describe.configure({ mode: 'serial' });

const ROOT = '/tmp/host-code';
const REPO = 'recipe-radar';
const out = process.env.DOCKET_E2E_SCREENSHOTS;

async function shoot(page: Page, name: string, target?: Locator) {
  if (!out) return;
  for (const theme of ['light', 'dark'] as const) {
    await setTheme(page, theme);
    const path = join(out, `b39-${name}-${theme}.png`);
    if (target) await target.screenshot({ path });
    else await page.screenshot({ path, fullPage: true });
  }
  await setTheme(page, 'light');
}

function sh(script: string): string {
  return execFileSync('docker', ['exec', CONTAINER, 'sh', '-c', script], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Two worktree branches that both change line 2 of shared.txt: they conflict. */
function makeFixtureRepo() {
  sh(
    [
      'set -e',
      `rm -rf ${ROOT}/${REPO} ${ROOT}/wt-a ${ROOT}/wt-b`,
      `mkdir -p ${ROOT}/${REPO}`,
      `cd ${ROOT}/${REPO}`,
      'G="git -c user.name=e2e -c user.email=e2e@docket.invalid -c commit.gpgsign=false"',
      '$G init -q -b main',
      "printf 'one\\ntwo\\nthree\\n' > shared.txt",
      '$G add shared.txt',
      '$G commit -q -m start',
      '$G branch feat/a',
      '$G branch feat/b',
      '$G worktree add -q ../wt-a feat/a',
      '$G worktree add -q ../wt-b feat/b',
      "cd ../wt-a && printf 'one\\ntwo from a\\nthree\\n' > shared.txt && $G commit -qam a",
      "cd ../wt-b && printf 'one\\ntwo from b\\nthree\\n' > shared.txt && $G commit -qam b",
    ].join('\n'),
  );
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
        // Only animations that end (a toast fading in), not a live run's endless pulse.
        .filter((a) => a.effect?.getComputedTiming().endTime !== Infinity)
        .map((a) => a.finished.catch(() => undefined)),
    ),
  );
}

let codex: McpAgent;

test.beforeAll(async () => {
  codex = await connectAgent('codex');
  makeFixtureRepo();
});

test.afterAll(async () => {
  test.setTimeout(120_000);
  await codex?.close();
  try {
    sh(`rm -rf ${ROOT}/${REPO} ${ROOT}/wt-a ${ROOT}/wt-b`);
  } finally {
    await resetSeededContainer();
  }
});

test.beforeEach(async ({ page }) => {
  await unlock(page.context());
  await page.context().addInitScript(() => localStorage.setItem('docket.notifications', 'off'));
  // Recipe App only: the stress project's items stay out of the views.
  await page.context().addInitScript(() => sessionStorage.setItem('docket.scope', 'RCP'));
});

test('Settings → Shared parts: register parts and point the radar at a repository', async ({
  page,
}) => {
  await page.goto('/settings');
  await page.locator('[data-project-shared-parts="RCP"]').click();
  await expect(page).toHaveURL(/\/settings\/projects\/RCP\/shared-parts$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/^Shared parts · .*Recipe App$/);
  await expect(page.getByText('No shared parts yet.')).toBeVisible();

  // Add a part through the dialog.
  await page.getByRole('button', { name: 'Add a part' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add a shared part' });
  await dialog.getByLabel('Key').fill('Model: Recipe');
  await dialog.getByLabel('Paths (one per line)').fill('server/src/models/recipe.ts');
  await expectAxeClean(page, 'add a shared part dialog', { themes: ['light'] });
  await dialog.getByRole('button', { name: 'Add part' }).click();
  await expect(toast(page, 'Registered model:Recipe.')).toBeVisible();
  // Two more through the API: a single-writer file and a table.
  for (const part of [
    {
      key: 'file:server/src/db/migrations/meta/_journal.json',
      single_writer: true,
      note: 'One migration at a time',
    },
    { key: 'table:decks', paths: ['server/src/db/decks/**'] },
  ]) {
    await owner(page, 'POST', '/api/projects/RCP/shared-parts', part);
  }
  const table = page.getByRole('table', { name: 'Shared parts' });
  await expect(table.locator('[data-part]')).toHaveCount(3);
  await expect(table.locator('[data-part="model:Recipe"]')).toContainText(
    'server/src/models/recipe.ts',
  );
  await expect(
    table.locator('[data-part="file:server/src/db/migrations/meta/_journal.json"]'),
  ).toContainText('single-writer');

  // The radar: off until a repository is set, then idle.
  const radar = page.locator('[data-card="radar"]');
  await expect(radar).toContainText('Radar off: no repository');
  await radar.getByLabel('Repository folder (inside the push folder)').fill(REPO);
  await radar.getByRole('button', { name: 'Save' }).click();
  await expect(toast(page, 'Saved the radar settings.')).toBeVisible();
  await expect(radar.getByText('Not run yet', { exact: true })).toBeVisible();
  await settle(page);
  await expectAxeClean(page, 'Settings → Shared parts');
  await shoot(page, 'settings-shared-parts');
});

test('an overlap: the refused claim asks you once, Work shows it, and They’re compatible lets it start', async ({
  page,
}) => {
  for (const id of ['RCP-14', 'RCP-17']) {
    const r = await codex.call('declare_shared_changes', {
      id,
      changes: [
        {
          part: 'model:Recipe',
          change: 'change',
          note: id === 'RCP-14' ? 'Units per ingredient' : 'Adds a source URL',
        },
      ],
    });
    expect(r.isError, r.text).toBe(false);
  }
  for (let i = 0; i < 2; i++) {
    const refused = await codex.call('claim_lead', { id: 'RCP-17', branch: 'feat/a' });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('seam_conflict');
  }

  await page.goto('/');
  const card = page.locator('[data-card="shared-questions"] [data-overlap]');
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('RCP-14 and RCP-17 both change model Recipe');
  await expect(card.getByRole('button', { name: 'Run one after the other' })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Open both' })).toBeVisible();
  await expectAxeClean(page, 'Needs you, an overlap card');
  await shoot(page, 'overlap-card', card);

  // The Work card's marker.
  await page.goto('/work?layout=board');
  await expect(page.locator('a[data-item="RCP-17"]')).toContainText('overlap');

  // They're compatible, with a note: the note box takes focus.
  await page.goto('/');
  await card.getByRole('button', { name: 'They’re compatible' }).click();
  const note = card.getByLabel('Note for both agents (optional)');
  await expect(note).toBeFocused();
  await note.fill('RCP-17 only adds a field; RCP-14 reads it.');
  await card.getByRole('button', { name: 'Mark compatible' }).click();
  await expect(toast(page, 'Marked RCP-14 and RCP-17 compatible.')).toBeVisible();
  await expect(card).toHaveCount(0);

  const claimed = await codex.call('claim_lead', { id: 'RCP-17', branch: 'feat/a' });
  expect(claimed.isError, claimed.text).toBe(false);
});

test('an undeclared hold: the packet waits, and Add to the declaration opens it', async ({
  page,
}) => {
  expect((await codex.call('declare_shared_changes', { id: 'RCP-25', none: true })).isError).toBe(
    false,
  );
  const claim = await codex.call('claim_lead', { id: 'RCP-25' });
  expect(claim.isError, claim.text).toBe(false);
  const run_id = claim.structured.run_id as string;
  expect(
    (
      await codex.call('declare_human_review', {
        id: 'RCP-25',
        run_id,
        items: ['Open the pantry.'],
      })
    ).isError,
  ).toBe(false);
  const packet = await codex.call('submit_packet', {
    id: 'RCP-25',
    run_id,
    built_from_commit: '7d21aa3',
    estimate: '2 min',
    how: ['Open the pantry screen.'],
    checked: [],
    changed_files: ['server/src/db/decks/schema.ts', 'web/src/pantry/Empty.tsx'],
    branch: 'feat/b',
  });
  expect(packet.isError, packet.text).toBe(false);
  expect(packet.structured.held_undeclared).toEqual(['table:decks']);

  await page.goto('/');
  const card = page.locator('[data-card="shared-questions"] [data-hold]');
  await expect(card).toContainText('RCP-25 changed shared parts it didn’t declare: table decks');
  await expect(card).toContainText('server/src/db/decks/schema.ts');
  await expectAxeClean(page, 'Needs you, an undeclared hold');
  await shoot(page, 'undeclared-hold', card);
  await card.getByRole('button', { name: 'Add to the declaration' }).click();
  await expect(toast(page, 'Added table decks to RCP-25’s declaration.')).toBeVisible();
  await expect(card).toHaveCount(0);
});

test('the item’s Shared changes: declaration, lease with Release lease, and a radar finding in Problems', async ({
  page,
}) => {
  const lease = await codex.call('take_lease', {
    id: 'RCP-17',
    part: 'file:server/src/db/migrations/meta/_journal.json',
  });
  expect(lease.isError, lease.text).toBe(false);

  // Run the radar: RCP-17 (feat/a) and RCP-25 (feat/b) both change shared.txt line 2.
  await page.goto('/settings/projects/RCP/shared-parts');
  const radar = page.locator('[data-card="radar"]');
  await radar.getByRole('button', { name: 'Run radar now' }).click();
  await expect(toast(page, 'Radar run: 1 conflict ahead.')).toBeVisible();
  await expect(radar.locator('[data-finding]')).toContainText('RCP-17 (feat/a) and RCP-25');

  await page.goto('/items/RCP-17?tab=details');
  const section = page.locator('section[data-section="shared"]');
  await expect(section.locator('[data-part="model:Recipe"]')).toContainText('Adds a source URL');
  await expect(section.locator('[data-overlap]')).toContainText('compatible');
  await expect(section.locator('[data-lease]')).toContainText(
    'file:server/src/db/migrations/meta/_journal.json',
  );
  await expect(section.locator('[data-finding]')).toContainText(
    'Heading for a conflict with RCP-25: 1 file · feat/a vs feat/b',
  );
  await settle(page);
  await expectAxeClean(page, 'item Details, Shared changes');
  await shoot(page, 'item-shared-changes', section);

  // The declaration editor opens, and Esc closes it.
  await section.getByRole('button', { name: 'Edit shared changes' }).click();
  const dialog = page.getByRole('dialog', { name: 'Shared changes · RCP-17' });
  await expect(dialog.getByLabel('Part', { exact: true })).toHaveValue('model:Recipe');
  await expectAxeClean(page, 'the declaration editor', { themes: ['light'] });
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  // Release lease.
  await section
    .getByRole('button', {
      name: 'Release lease on file:server/src/db/migrations/meta/_journal.json',
    })
    .click();
  await expect(toast(page, /Released the lease on file /)).toBeVisible();
  await expect(section.locator('[data-lease]')).toHaveCount(0);

  // Decision 37: both items have a lead, so the agents handle the finding first; Needs you
  // says so and opens it. The agent sees it in its context.
  await page.goto('/');
  await page
    .locator('[data-card="problems"]')
    .getByRole('button', { name: 'Agents are handling 1 problem' })
    .click();
  const row = page.locator('[data-more-problems="agents"] [data-problem="radar_conflict"]');
  await expect(row).toContainText(
    "RCP-17's branch feat/a and RCP-25's branch feat/b change the same lines: 1 file conflicts (shared.txt).",
  );
  await expect(row).toContainText('An agent (the leads of RCP-17 and RCP-25)');
  await settle(page);
  await expectAxeClean(page, 'Needs you, a radar finding in Problems');
  await shoot(page, 'radar-finding', page.locator('[data-card="problems"]'));
  const ctx = await codex.call('get_context', { id: 'RCP-17' });
  expect(ctx.text).toContain('conflict ahead with RCP-25 (feat/a vs feat/b) · 1 file · shared.txt');
});

test('B40, B41: the item’s branches: found by the radar, several matching, Add branch and Remove', async ({
  page,
}) => {
  // RCP-14 and RCP-15 are In progress with no reported branch. One local branch names
  // RCP-14; two name RCP-15 (in either case, with or without the hyphen).
  sh(
    [
      'set -e',
      `cd ${ROOT}/${REPO}`,
      'G="git -c user.name=e2e -c user.email=e2e@docket.invalid -c commit.gpgsign=false"',
      '$G branch rcp-14-week-plan main',
      '$G branch rcp-15-a main',
      '$G branch RCP15-b main',
    ].join('\n'),
  );
  await owner(page, 'POST', '/api/projects/RCP/radar/run', {});

  const section = page.locator('section[data-section="shared"]');
  const state = section.locator('[data-branch-source]');
  await page.goto('/items/RCP-14?tab=details');
  await expect(state).toHaveAttribute('data-branch-source', 'discovered');
  await expect(state).toContainText('Branch found by the radar: rcp-14-week-plan');

  await page.goto('/items/RCP-15?tab=details');
  await expect(state).toHaveAttribute('data-branch-source', 'matches');
  await expect(state).toContainText('Several branches match; add the branch: RCP15-b, rcp-15-a');
  await settle(page);
  await expectAxeClean(page, 'item Details, several branches match');
  await shoot(page, 'branch-several', section);

  // Add branch: the dialog suggests the matches; a reported branch wins over them.
  const add = section.getByRole('button', { name: 'Add branch' });
  await add.click();
  const dialog = page.getByRole('dialog', { name: 'Add branch · RCP-15' });
  const input = dialog.getByLabel('Branch', { exact: true });
  await expect(input).toHaveValue('RCP15-b');
  await input.fill('rcp-15-a');
  await expectAxeClean(page, 'the add branch dialog', { themes: ['light'] });
  await dialog.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(toast(page, 'Added rcp-15-a to RCP-15’s branches.')).toBeVisible();
  await expect(dialog).toHaveCount(0);
  const reported = section.locator('[data-branch-source="reported"]');
  await expect(reported).toHaveCount(1);
  await expect(reported).toContainText('rcp-15-a');
  await expect(reported).toContainText('reported by you');

  // B41: a second branch; the section lists both, each with Remove.
  await add.click();
  await expect(input).toHaveValue('');
  await input.fill('RCP15-b');
  await dialog.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(toast(page, 'Added RCP15-b to RCP-15’s branches.')).toBeVisible();
  await expect(reported).toHaveCount(2);
  await expect(section.getByRole('list', { name: 'Reported branches' })).toBeVisible();
  await settle(page);
  await expectAxeClean(page, 'item Details, two reported branches');
  await shoot(page, 'branches-reported', section);
  await owner(page, 'POST', '/api/projects/RCP/radar/run', {});
  const shared = (await owner(page, 'GET', '/api/items/RCP-15/shared')) as {
    branches: { reported: { name: string; reported_by: string }[] };
  };
  expect(shared.branches.reported.map((b) => [b.name, b.reported_by])).toEqual([
    ['rcp-15-a', 'owner'],
    ['RCP15-b', 'owner'],
  ]);

  // Remove one: focus moves to Add branch.
  await section.getByRole('button', { name: 'Remove branch rcp-15-a' }).click();
  await expect(toast(page, 'Removed rcp-15-a from RCP-15’s branches.')).toBeVisible();
  await expect(reported).toHaveCount(1);
  await expect(add).toBeFocused();

  // Remove the last: the radar's matches show again.
  await section.getByRole('button', { name: 'Remove branch RCP15-b' }).click();
  await expect(toast(page, 'Removed RCP15-b; the radar looks for RCP-15’s branch.')).toBeVisible();
  await expect(reported).toHaveCount(0);
  await expect(state).toHaveAttribute('data-branch-source', 'matches');
  await settle(page);
  await expectAxeClean(page, 'item Details, branches removed');
});

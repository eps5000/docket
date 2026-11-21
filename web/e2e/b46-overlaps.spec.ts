/**
 * Overlaps reach the owner only when they need the owner, end to end (owner
 * decision 39; tasks.md T198; FR-177–FR-184; UI_SPEC §6.3.6, §6.7):
 *
 * - two add-only branches inserting at the same line: both agents keep their
 *   claims, the radar gives a merge order, and Needs you gets no card, only
 *   the quiet "Docket handled N overlaps today" line;
 * - a same-member overlap: Docket sequences it, the ticket says why, and the
 *   owner overrules it with Undo;
 * - a change to an approved design reaches the owner with its note;
 * - Settings → Overlap handling, global and per project.
 *
 * axe is clean in both themes on each.
 */
import { execFileSync } from 'node:child_process';
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
import { CONTAINER } from './fixtures/container';
import type { McpAgent } from './fixtures/mcp';

useSeededContainer();
test.describe.configure({ mode: 'serial' });

const ROOT = '/tmp/host-code';
const REPO = 'overlap-radar';

function sh(script: string): string {
  return execFileSync('docker', ['exec', CONTAINER, 'sh', '-c', script], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Two branches that each only add a line, at the same place: a real text conflict. */
function makeSameLineRepo() {
  sh(
    [
      'set -e',
      `rm -rf ${ROOT}/${REPO}`,
      `mkdir -p ${ROOT}/${REPO}`,
      `cd ${ROOT}/${REPO}`,
      'G="git -c user.name=e2e -c user.email=e2e@docket.invalid -c commit.gpgsign=false"',
      '$G init -q -b main',
      "printf '# Models\\nRecipe\\nDeck\\n' > models.md",
      '$G add models.md',
      '$G commit -q -m start',
      '$G checkout -q -b add-units main',
      "printf '# Models\\nRecipe\\nRecipe.units\\nDeck\\n' > models.md",
      '$G commit -qam units',
      '$G checkout -q -b add-source main',
      "printf '# Models\\nRecipe\\nRecipe.source\\nDeck\\n' > models.md",
      '$G commit -qam source',
      '$G checkout -q main',
    ].join('\n'),
  );
}

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

/** Wait for toasts to finish fading in before axe (B25). */
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

async function ok(agent: McpAgent, tool: string, args: Record<string, unknown>) {
  const r = await agent.call(tool, args);
  expect(r.isError, `${tool}: ${r.text}`).toBe(false);
  return r;
}

/** A new item, declared and moved to Ready. */
async function readyItem(title: string, changes: Record<string, unknown>[], parts?: string[]) {
  const created = await ok(first, 'create_item', {
    project: 'RCP',
    type: 'Task',
    title,
    status: 'planning',
  });
  const id = (created.structured.item as { id: string }).id;
  await ok(first, 'declare_shared_changes', {
    id,
    changes,
    ...(parts ? { new_parts: parts.map((key) => ({ key })) } : {}),
  });
  await ok(first, 'set_status', { id, status: 'ready' });
  return id;
}

let first: McpAgent;
let second: McpAgent;

test.beforeAll(async () => {
  first = await connectAgent('codex');
  second = await connectAgent('claude-agent-sdk');
  makeSameLineRepo();
});

test.afterAll(async () => {
  test.setTimeout(120_000);
  await first?.close();
  await second?.close();
  try {
    sh(`rm -rf ${ROOT}/${REPO}`);
  } finally {
    await resetSeededContainer();
  }
});

test.beforeEach(async ({ page }) => {
  await unlock(page.context());
  await page.context().addInitScript(() => localStorage.setItem('docket.notifications', 'off'));
  await page.context().addInitScript(() => sessionStorage.setItem('docket.scope', 'RCP'));
});

test('two add-only branches at the same line: both keep working, with a merge order and no card', async ({
  page,
}) => {
  const a = await readyItem(
    'Add units to Recipe',
    [{ part: 'model:Recipe.units', change: 'add' }],
    ['model:Recipe'],
  );
  const b = await readyItem('Add source to Recipe', [
    { part: 'model:Recipe.source', change: 'add' },
  ]);
  await ok(first, 'claim_lead', { id: a, branch: 'add-units' });
  // The meaning is safe, so the second claim succeeds too.
  await ok(second, 'claim_lead', { id: b, branch: 'add-source' });

  await owner(page, 'PUT', '/api/projects/RCP/radar', { repo_path: REPO, main_branch: 'main' });
  await owner(page, 'POST', '/api/projects/RCP/radar/run', {});

  // Both agents are told who goes first, and neither stopped.
  const later = await ok(second, 'get_context', { id: b });
  expect(later.text).toContain(`rebase after ${a} merges`);
  const earlier = await ok(first, 'get_context', { id: a });
  expect(earlier.text).toContain('you merge first');

  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Needs you' })).toBeVisible();
  await expect(page.locator('[data-card="shared-questions"] [data-overlap]')).toHaveCount(0);
  const line = page.locator('[data-card="overlaps-handled"]');
  await expect(line.locator('summary')).toHaveText(/Docket handled \d+ overlaps? today/);
  await line.locator('summary').click();
  await expect(line.locator('[data-handled]').first()).toContainText('Docket: in parallel');
  await expectAxeClean(page, 'Needs you, the handled line');

  await page.goto(`/items/${b}?tab=details`);
  const section = page.locator('section[data-section="shared"]');
  const row = section.locator('[data-overlap]');
  await expect(row).toContainText('Docket: in parallel');
  await expect(row).toContainText('They add different members');
  await expect(section.locator('[data-merge-first]')).toHaveText(`Rebases after ${a} merges`);
  await expect(section).toContainText('The radar sees committed local branches only');
  await expectAxeClean(page, 'The ticket, an automatic parallel outcome', {
    include: 'section[data-section="shared"]',
  });
});

test('the same member: Docket sequences it, and the owner overrules with Undo', async ({
  page,
}) => {
  const a = await readyItem(
    'Change the deck title',
    [{ part: 'table:decks.title', change: 'change' }],
    ['table:decks'],
  );
  const b = await readyItem('Rename the deck title', [
    { part: 'table:decks.title', change: 'change' },
  ]);
  await ok(first, 'claim_lead', { id: a });
  const refused = await second.call('claim_lead', { id: b });
  expect(refused.isError).toBe(true);
  expect(refused.text).toContain('seam_conflict');
  expect(refused.text).toContain('Docket queued');

  await page.goto('/');
  await expect(page.locator('[data-card="shared-questions"] [data-overlap]')).toHaveCount(0);

  await page.goto(`/items/${b}?tab=details`);
  const row = page.locator('section[data-section="shared"] [data-overlap]');
  await expect(row).toContainText('Docket: in order');
  await expect(row).toContainText('They change the same member.');
  await expect(row).toContainText(`${b} waits until ${a} is merged.`);
  await expectAxeClean(page, 'The ticket, an automatic sequence', {
    include: 'section[data-section="shared"]',
  });

  await row.getByRole('button', { name: /Run in parallel/ }).click();
  const done = toast(page, `${a} and ${b} now run in parallel.`);
  await expect(done).toBeVisible();
  await expect(row).toContainText('compatible');
  await settle(page);
  await done.getByRole('button', { name: 'Undo' }).click();
  await expect(row).toContainText('Docket: in order');
});

test('a change to an approved design reaches the owner, with the note', async ({ page }) => {
  const a = await readyItem(
    'Rework exports',
    [{ part: 'endpoint:POST /decks/{id}/export', change: 'change' }],
    ['endpoint:POST /decks/{id}/export'],
  );
  const b = await readyItem('Make exports async', [
    {
      part: 'endpoint:POST /decks/{id}/export',
      change: 'change',
      design_impact: 'changes_approved_design',
      design_note: 'Decision 12: exports stay synchronous',
    },
  ]);
  await ok(first, 'claim_lead', { id: a });
  const refused = await second.call('claim_lead', { id: b });
  expect(refused.isError).toBe(true);

  await page.goto('/');
  const card = page
    .locator('[data-card="shared-questions"] [data-overlap]')
    .filter({ hasText: 'Decision 12' });
  await expect(card).toBeVisible();
  await expect(card).toContainText('Docket recommends');
  await expect(card.getByRole('button', { name: 'Run one after the other' })).toBeVisible();
  await expectAxeClean(page, 'Needs you, an approved-design card');
});

test('Settings → Overlap handling: a default and a per-project override', async ({ page }) => {
  await page.goto('/settings');
  const card = page.locator('[data-card="overlap-handling"]');
  await expect(card.getByRole('radio', { name: /Agents resolve/ })).toBeChecked();
  await expectAxeClean(page, 'Settings, Overlap handling', {
    include: '[data-card="overlap-handling"]',
  });

  await card.getByRole('radio', { name: /Ask on every overlap/ }).check();
  await expect(toast(page, 'Overlap handling: Ask on every overlap.')).toBeVisible();
  await expect(card.getByRole('radio', { name: /Ask on every overlap/ })).toBeChecked();

  const select = card.getByRole('combobox', { name: 'Overlap handling for Sample · Recipe App' });
  await select.selectOption('agents_resolve');
  await expect(toast(page, 'Overlap handling for RCP: Agents resolve.')).toBeVisible();
  await expect
    .poll(async () => {
      const r = await owner(page, 'GET', '/api/settings/overlap-handling');
      return (r.projects as { key: string; effective: string }[]).find((p) => p.key === 'RCP')
        ?.effective;
    })
    .toBe('agents_resolve');

  await select.selectOption('');
  await expect(toast(page, 'RCP follows the default.')).toBeVisible();
  await card.getByRole('radio', { name: /Agents resolve/ }).check();
  await expect(card.getByRole('radio', { name: /Agents resolve/ })).toBeChecked();
});

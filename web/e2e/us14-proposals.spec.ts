/**
 * Agent proposals (tasks.md T160; spec US14 acceptance scenarios 1, 2 and
 * 6's server side; UI_SPEC §6.7b-1; FR-128–FR-130).
 *
 * One walkthrough, in order:
 * 1. an agent (the SDK client) reads `docket-worker` for RCP and proposes
 *    a change; nothing changes; Needs you shows "1 agent file change
 *    proposed", which opens Agent files; All projects links to Recipe App's
 *    proposals; the file row has a "1 proposal" chip; the proposal shows the
 *    agent, its item, the reason and the diff; *Approve* saves Recipe App's
 *    copy, whose history says "proposed by … · approved by owner";
 * 2. the agent proposes again from the version it read before (the copy has
 *    changed since): the three-way view; *Edit, then approve* saves the
 *    owner's text;
 * 3. a third proposal is declined with a note.
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
import type { McpAgent } from './fixtures/mcp';

useSeededContainer();

const out = process.env.DOCKET_E2E_SCREENSHOTS;

async function shoot(page: Page, name: string, target: Locator) {
  if (!out) return;
  for (const theme of ['light', 'dark'] as const) {
    await setTheme(page, theme);
    await target.screenshot({ path: join(out, `us14-${name}-${theme}.png`) });
  }
  await setTheme(page, 'light');
}

const WORKER = 'skill:docket-worker';
const toast = (page: Page, text: string | RegExp) =>
  page.locator('.toast').filter({ hasText: text });
const card = (page: Page) => page.locator('[data-proposal]');

let agent: McpAgent;
let run: string;
/** The version the agent read first (the default), for the later "changed since". */
let firstRead: { version_id: string; content: string; source: string };

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  agent = await connectAgent('codex-mcp-client', '0.50.0');
  const claim = await agent.call('claim_lead', { id: 'RCP-17', agent_label: 'orca-w3' });
  expect(claim.isError, claim.text).toBe(false);
  run = claim.structured.run_id as string;
});
test.afterAll(async () => {
  await agent?.close();
});

async function read(): Promise<{ version_id: string; content: string; source: string }> {
  const r = await agent.call('get_agent_files', { project: 'RCP', file: WORKER });
  expect(r.isError, r.text).toBe(false);
  return (r.structured.files as { version_id: string; content: string; source: string }[])[0]!;
}

async function propose(content: string, reason: string, based_on: string) {
  const r = await agent.call('propose_agent_file_change', {
    project: 'RCP',
    file: WORKER,
    content,
    reason,
    based_on_version_id: based_on,
    run_id: run,
  });
  expect(r.isError, r.text).toBe(false);
  return r.structured.proposal_id as string;
}

test.describe('Agent proposals (US14)', () => {
  test('1. an agent proposes; Needs you; review the diff; Approve saves Recipe App’s copy', async ({
    ownerPage: page,
  }) => {
    firstRead = await read();
    expect(firstRead.source).toBe('default');
    const listing = await agent.call('get_agent_files', { project: 'RCP' });
    console.log(`get_agent_files RCP (listing):\n${listing.text}`);
    await propose(
      `${firstRead.content.trimEnd()}\n\n## Recipe App\n\n- Run \`pnpm lint\` before each commit.\n`,
      'RCP-17 broke CI on lint; lint before each commit.',
      firstRead.version_id,
    );
    // Nothing changed yet.
    expect((await read()).version_id).toBe(firstRead.version_id);

    await page.goto('/');
    const line = page.getByRole('link', { name: '1 agent file change proposed' });
    await expect(line).toBeVisible();
    await shoot(page, '1-needs-you', page.locator('[data-card="agents-strip"]'));
    await line.click();
    await expect(page).toHaveURL(/\/agent-files#proposals$/);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Agent files · Defaults' }),
    ).toBeVisible();
    // All projects: a line for Recipe App's proposals.
    await page.getByRole('link', { name: 'Recipe App · 1 proposed change' }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: 'Agent files · Recipe App' }),
    ).toBeVisible();

    const section = page.locator('[data-proposals]');
    await expect(section.getByRole('heading', { name: 'Proposed changes · 1' })).toBeVisible();
    await expect(page.locator(`[data-agent-file="${WORKER}"] [data-proposal-chip]`)).toHaveText(
      '1 proposal',
    );
    const c = card(page);
    await expect(c.getByRole('heading', { name: 'docket-worker' })).toBeVisible();
    await expect(c.getByText('Proposed by codex · orca-w3 on RCP-17')).toBeVisible();
    await expect(c.getByText('RCP-17 broke CI on lint; lint before each commit.')).toBeVisible();
    const diff = c.getByRole('region', { name: 'docket-worker: the proposed change' });
    await expect(diff).toContainText('Run `pnpm lint` before each commit.');
    await expect(diff).toContainText('lines added, 0 lines removed');
    await shoot(page, '1-proposal', section);
    await expectAxeClean(page, 'Agent files: a proposal');

    await c.getByRole('button', { name: 'Approve the change to docket-worker' }).click();
    await expect(
      toast(page, 'Approved: docket-worker saved as Recipe App’s copy.'),
    ).toBeVisible();
    await expect(section).toHaveCount(0);
    const row = page.locator(`[data-agent-file="${WORKER}"]`);
    await expect(row).toHaveAttribute('data-using', 'copy');
    await expect(row.locator('[data-proposal-chip]')).toHaveCount(0);

    // History names the proposer and the approver.
    await row.getByRole('link', { name: 'docket-worker' }).click();
    const view = page.locator(`[data-agent-file-view="${WORKER}"]`);
    await expect(view.getByText(/proposed by codex · orca-w3 · approved by owner/)).toBeVisible();
    await expect((await read()).source).toBe('project');

    // Needs you is clear again.
    await page.goto('/');
    await expect(page.getByRole('link', { name: /agent file changes? proposed/ })).toHaveCount(0);
  });

  test('2. a proposal from before the copy changed: the three-way view; Edit, then approve', async ({
    ownerPage: page,
  }) => {
    // The agent proposes from the text it read first, before Recipe App's copy existed.
    await propose(
      `${firstRead.content.trimEnd()}\n\n- Write the PR description first.\n`,
      'Ask for a PR description up front.',
      firstRead.version_id,
    );
    await page.goto('/agent-files?project=RCP#proposals');
    const c = card(page);
    await expect(c.getByText('Changed since the agent read it')).toBeVisible();
    const three = c.locator('[data-three-way]');
    await expect(
      three.getByRole('region', { name: 'docket-worker: what changed since the agent read it' }),
    ).toContainText('Run `pnpm lint` before each commit.');
    await expect(
      three.getByRole('region', { name: 'docket-worker: what the agent proposes' }),
    ).toContainText('Write the PR description first.');
    await shoot(page, '2-three-way', page.locator('[data-proposals]'));
    await expectAxeClean(page, 'Agent files: a three-way proposal');

    // Approve asks first: approving would drop the lint rule.
    await c.getByRole('button', { name: 'Approve the change to docket-worker' }).click();
    await expect(c.getByText(/Approve anyway\? The changes made to docket-worker/)).toBeVisible();
    await c.getByRole('button', { name: 'Edit, then approve' }).click();
    const editor = c.getByLabel('Edit the proposed text');
    await expect(editor).toBeFocused();
    const merged = `${(await editor.inputValue()).trimEnd()}\n\n## Recipe App\n\n- Run \`pnpm lint\` before each commit.\n`;
    await editor.fill(merged);
    await c.getByLabel('Note (optional)').fill('Kept the lint rule');
    await c.getByRole('button', { name: 'Save' }).click();
    await expect(
      toast(page, 'Approved: docket-worker saved as Recipe App’s copy.'),
    ).toBeVisible();
    const now = await read();
    expect(now.content).toContain('Write the PR description first.');
    expect(now.content).toContain('Run `pnpm lint` before each commit.');
  });

  test('3. Decline… with a note', async ({ ownerPage: page }) => {
    const current = await read();
    await propose('# Do whatever you like.\n', 'Simpler', current.version_id);
    await page.goto('/agent-files?project=RCP');
    const c = card(page);
    await c.getByRole('button', { name: 'Decline… (docket-worker)' }).click();
    await c.getByLabel('Why (optional)').fill('Too vague');
    await c.getByRole('button', { name: 'Decline proposal' }).click();
    await expect(toast(page, 'Declined the proposed change to docket-worker.')).toBeVisible();
    await expect(page.locator('[data-proposals]')).toHaveCount(0);
    expect((await read()).version_id).toBe(current.version_id);
  });
});

/**
 * Project decisions get their own page; tickets show their own, end to end
 * (owner decision 38; tasks.md T195; spec US5 scenario 6; FR-173–FR-176;
 * UI_SPEC §6.1, §6.3.5, §6.3.7):
 *
 * - a ticket (RCP-12) and an epic (RCP-1) list only their own scopes'
 *   decisions, with "N project decisions also apply · View" counting the
 *   active project ones, and *View* opens the project Decisions page;
 * - an agent's project decision is a Needs you card ("New project-wide
 *   decision by <agent>: <title>") with the text and the reason; *Confirm*,
 *   *Acknowledge* and *Withdraw…* each take it off Needs you, and Undo brings
 *   it back; *Open* lands on the page, focused on the record; an agent's item
 *   decision makes no card;
 * - the project page: *Needs your review*, *Confirm*, *Supersede*,
 *   *Withdraw…* with Undo, *+ Record a decision*, and no sideways scroll at
 *   1024 px;
 * - agents' project decisions from before decision 38 share one grouped card
 *   per project, with *Review* and *Acknowledge all* (Undo brings it back);
 * - the agent's `get_context` still lists every project decision.
 *
 * axe is clean in both themes on the sections, the cards and the page.
 */
import { execFileSync } from 'node:child_process';
import type { Page } from '@playwright/test';
import { expect, expectAxeClean, test, useSeededContainer } from './fixtures/index';
import { CONTAINER } from './fixtures/container';
import type { McpAgent } from './fixtures/mcp';

useSeededContainer();
test.describe.configure({ mode: 'serial' });

/** Run SQL updates in the container's database (fixture: records from before decision 38). */
function sql(statements: [string, unknown[]][]): void {
  const script =
    "const D=require('better-sqlite3');const db=new D('/data/docket.db');db.pragma('busy_timeout = 5000');" +
    'for (const [q, a] of JSON.parse(process.argv[1])) db.prepare(q).run(...a);db.close();';
  execFileSync(
    'docker',
    ['exec', '-w', '/app/server', CONTAINER, 'node', '-e', script, JSON.stringify(statements)],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

async function publish(
  agent: McpAgent,
  scope: { kind: string; id?: string },
  title: string,
  project = 'RCP',
): Promise<string> {
  const res = await agent.call('publish_decision', {
    project,
    scope,
    title,
    decision: `${title}: the text.`,
    rationale: `Why ${title}.`,
  });
  expect(res.isError, res.text).toBe(false);
  return (res.structured.decision as { id: string }).id;
}

const section = (page: Page) => page.locator('section[data-section="decisions"]');
const row = (page: Page, title: string) =>
  section(page)
    .locator('.decrow')
    .filter({ has: page.locator('.dt', { hasText: title }) });
const card = (page: Page, title: string) =>
  page.locator('[data-project-decision-card]').filter({ hasText: title });
const toast = (page: Page, text: string) => page.locator('.toast').filter({ hasText: text });

async function openNeedsYou(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Needs you' })).toBeVisible();
}

test('a ticket and an epic list their own scopes, with one line for the project ones', async ({
  ownerPage: page,
  agent,
}) => {
  await publish(agent, { kind: 'project' }, 'Prototypes for owner review');
  await publish(agent, { kind: 'project' }, 'Open with no commands');
  const old = await publish(agent, { kind: 'project' }, 'An old project rule');
  const w = await agent.call('withdraw_decision', { decision_id: old, reason: 'Gone.' });
  expect(w.isError, w.text).toBe(false);

  await page.goto('/items/RCP-12');
  const sec = section(page);
  await expect(sec).toBeVisible();
  // RCP-12: epic RCP-1's owner record and label ui-refresh's agent record; no project rows.
  await expect(row(page, 'Units are metric internally')).toContainText('◆ Meal planning MVP');
  await expect(row(page, 'Use design tokens v2 spacing')).toContainText('#ui-refresh');
  await expect(row(page, 'Prototypes for owner review')).toHaveCount(0);
  await expect(sec.locator('.sechead')).toContainText('2 in scope · 1 by agents');
  // Two active project decisions; the withdrawn one doesn't count.
  const line = sec.locator('[data-also-apply]');
  await expect(line).toHaveText('2 project decisions also apply · View');
  // The toggle covers only what's listed: nothing inactive here.
  await expect(sec.getByRole('button', { name: /Show withdrawn and superseded/ })).toHaveCount(0);
  await expectAxeClean(page, 'ticket Decisions with the also-apply line', {
    include: 'section[data-section="decisions"]',
  });

  // The epic: its own record, chipped "This epic", and the same line.
  await page.goto('/items/RCP-1');
  await expect(row(page, 'Units are metric internally')).toContainText('This epic');
  await expect(section(page).locator('[data-also-apply]')).toHaveText(
    '2 project decisions also apply · View',
  );
  await expectAxeClean(page, 'epic Decisions with the also-apply line', {
    include: 'section[data-section="decisions"]',
  });

  // View opens the project Decisions page.
  await section(page).getByRole('link', { name: 'View RCP project decisions' }).click();
  await expect(page).toHaveURL(/\/projects\/RCP\/decisions$/);
  await expect(row(page, 'Prototypes for owner review')).toBeVisible();
  await expect(row(page, 'Open with no commands')).toBeVisible();

  // Agents still get every project decision in context.
  const ctx = await agent.call('get_context', { id: 'RCP-12', budget: 'medium' });
  expect(ctx.isError, ctx.text).toBe(false);
  const context = ctx.structured.context as { decisions: { title: string }[] };
  const titles = context.decisions.map((d) => d.title);
  expect(titles).toEqual(
    expect.arrayContaining(['Prototypes for owner review', 'Open with no commands']),
  );
});

test('Needs you: a card per agent project decision, until confirmed, acknowledged or withdrawn', async ({
  ownerPage: page,
  agent,
}) => {
  await publish(agent, { kind: 'item', id: 'RCP-12' }, 'An item rule makes no card');
  await openNeedsYou(page);
  await expect(page.getByText('An item rule makes no card')).toHaveCount(0);

  const proto = card(page, 'Prototypes for owner review');
  await expect(proto.getByRole('heading')).toHaveText(
    /^New project-wide decision by .+: Prototypes for owner review$/,
  );
  await expect(proto).toContainText('Prototypes for owner review: the text.');
  await expect(proto).toContainText('Why: Why Prototypes for owner review.');
  await expectAxeClean(page, 'Needs you: project decision cards', {
    include: '[data-card="project-decisions"]',
  });

  // Confirm → gone; Undo → back.
  await proto.getByRole('button', { name: 'Confirm' }).click();
  const confirmed = toast(page, 'Confirmed “Prototypes for owner review”');
  await expect(confirmed).toBeVisible();
  await expect(proto).toHaveCount(0);
  await confirmed.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByRole('status')).toContainText('Undone.');
  await expect(proto).toBeVisible();

  // Acknowledge → gone (it stays an agent decision); Undo → back.
  const open = card(page, 'Open with no commands');
  await open.getByRole('button', { name: 'Acknowledge' }).click();
  const acked = toast(page, 'It stays an agent decision.');
  await expect(acked).toBeVisible();
  await expect(open).toHaveCount(0);
  await acked.getByRole('button', { name: 'Undo' }).click();
  await expect(open).toBeVisible();

  // Withdraw… asks for an optional reason inline.
  await open.getByRole('button', { name: 'Withdraw…' }).click();
  const reason = open.getByLabel('Reason for withdrawing (optional)');
  await expect(reason).toBeFocused();
  await reason.fill('We do use commands');
  await open.getByRole('button', { name: 'Withdraw', exact: true }).click();
  await expect(toast(page, 'Withdrew “Open with no commands”.')).toBeVisible();
  await expect(open).toHaveCount(0);

  // Open lands on the page, focused on the record.
  await proto.getByRole('link', { name: 'Open' }).click();
  await expect(page).toHaveURL(/\/projects\/RCP\/decisions\?decision=dec_/);
  const focused = row(page, 'Prototypes for owner review');
  await expect(focused).toBeFocused();
  await expect(focused).toHaveClass(/focused/);
});

test('the project page: Needs your review, Confirm, Supersede, Withdraw with Undo, at 1024 px', async ({
  ownerPage: page,
  agent,
}) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await publish(agent, { kind: 'project' }, 'Follow the Gameflow constitution');
  await page.goto('/projects/RCP/decisions');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Project decisions · Sample · Recipe App' }),
  ).toBeVisible();
  // No sideways scroll at 1024 px.
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);

  // Needs your review: agents' active, unconfirmed records.
  const review = page.getByRole('button', { name: /^Needs your review \(\d+\)$/ });
  await review.click();
  await expect(review).toHaveAttribute('aria-pressed', 'true');
  await expect(page).toHaveURL(/filter=review/);
  await expect(row(page, 'Follow the Gameflow constitution')).toBeVisible();
  await expect(section(page).locator('.decrow .auth', { hasText: 'Owner' })).toHaveCount(0);
  await expectAxeClean(page, 'project Decisions page (Needs your review)');

  // Confirm takes it out of the filter; Undo brings it back.
  await row(page, 'Follow the Gameflow constitution')
    .getByRole('button', { name: 'Confirm' })
    .click();
  const confirmed = toast(page, 'Confirmed “Follow the Gameflow constitution”');
  await expect(confirmed).toBeVisible();
  await expect(row(page, 'Follow the Gameflow constitution')).toHaveCount(0);
  await confirmed.getByRole('button', { name: 'Undo' }).click();
  await expect(row(page, 'Follow the Gameflow constitution')).toBeVisible();

  // All: Supersede opens the form prefilled; saving supersedes the agent's record.
  await page.getByRole('button', { name: 'All', exact: true }).click();
  await row(page, 'Follow the Gameflow constitution')
    .getByRole('button', { name: 'Supersede' })
    .click();
  const form = section(page).locator('form[data-decision-form]');
  await expect(form.getByLabel(/^Title/)).toHaveValue('Follow the Gameflow constitution');
  await form.getByLabel(/^Title/).fill('Follow the constitution, v1.2');
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('status')).toContainText('is superseded');
  await expect(row(page, 'Follow the constitution, v1.2')).toContainText('Owner');
  await expect(row(page, 'Follow the Gameflow constitution')).toHaveCount(0);

  // Withdraw… with Undo.
  const mine = row(page, 'Follow the constitution, v1.2');
  await mine.getByRole('button', { name: 'Withdraw…' }).click();
  await mine.getByRole('button', { name: 'Withdraw', exact: true }).click();
  const withdrew = toast(page, 'Withdrew “Follow the constitution, v1.2”.');
  await expect(withdrew).toBeVisible();
  await expect(row(page, 'Follow the constitution, v1.2')).toHaveCount(0);
  await withdrew.getByRole('button', { name: 'Undo' }).click();
  await expect(row(page, 'Follow the constitution, v1.2')).toBeVisible();

  // + Record a decision: scope Project.
  await section(page).getByRole('button', { name: '+ Record a decision' }).click();
  await expect(form.locator('[data-scope]')).toHaveText('Project');
  await form.getByLabel(/^Title/).fill('Ship behind a flag');
  await form.getByLabel(/^Decision/).fill('Every new screen ships behind a flag first.');
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(row(page, 'Ship behind a flag')).toContainText('Owner');
  await expectAxeClean(page, 'project Decisions page (All)');

  // Settings → Projects links here too.
  await page.goto('/settings');
  await page.locator('[data-project-decisions="RCP"]').click();
  await expect(page).toHaveURL(/\/projects\/RCP\/decisions$/);
});

test('older agent project decisions share one card: Review and Acknowledge all', async ({
  ownerPage: page,
  agent,
}) => {
  const ids: string[] = [];
  for (const t of ['Docs use sentence case', 'One example per endpoint', 'No screenshots'])
    ids.push(await publish(agent, { kind: 'project' }, t, 'DOC'));
  // As if they were recorded before decision 38 (migration 0014 marks those).
  sql(ids.map((id) => ['UPDATE decision_records SET review_grouped = 1 WHERE id = ?', [id]]));

  await openNeedsYou(page);
  const group = page.locator('[data-project-decision-group="DOC"]');
  await expect(group.getByRole('heading')).toHaveText(
    '3 project-wide decisions by agents to review',
  );
  await expect(group.locator('.pdec-list li')).toHaveCount(3);
  for (const t of ['Docs use sentence case', 'One example per endpoint', 'No screenshots'])
    await expect(card(page, t)).toHaveCount(0);
  await expectAxeClean(page, 'Needs you: the grouped card', {
    include: '[data-project-decision-group="DOC"]',
  });

  // Review: the page, filtered.
  await group.getByRole('link', { name: 'Review' }).click();
  await expect(page).toHaveURL(/\/projects\/DOC\/decisions\?filter=review$/);
  await expect(row(page, 'No screenshots')).toBeVisible();
  // Confirming one from the page shrinks the card.
  await row(page, 'No screenshots').getByRole('button', { name: 'Confirm' }).click();
  await expect(toast(page, 'Confirmed “No screenshots”')).toBeVisible();

  await openNeedsYou(page);
  await expect(group.getByRole('heading')).toHaveText(
    '2 project-wide decisions by agents to review',
  );
  await group.getByRole('button', { name: 'Acknowledge all' }).click();
  const acked = toast(page, 'Acknowledged 2 project-wide decisions in Sample · Docs Site.');
  await expect(acked).toBeVisible();
  await expect(group).toHaveCount(0);
  await acked.getByRole('button', { name: 'Undo' }).click();
  await expect(group).toBeVisible();
  await group.getByRole('button', { name: 'Acknowledge all' }).click();
  await expect(group).toHaveCount(0);
});

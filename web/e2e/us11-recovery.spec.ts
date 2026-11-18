/**
 * Crash recovery end to end (tasks.md T098; spec US11; UI_SPEC §6.1, §6.3.2,
 * §6.6; owner decision 26).
 *
 * Agents create real recovery state through MCP (the official SDK client):
 * a run that left a dev server, a run that stopped with work off the remote,
 * runs parked too long and ready to resume. The owner sees and acts on it in
 * the browser against the seeded container:
 * - the four recovery Problems rows, *Mark released* and *Handled* with Undo;
 * - "Where the work lives" and *Copy resume note*;
 * - Agents → Workspaces states, with "Hide safe to prune" on by default;
 * - axe on each, in both themes.
 *
 * B20 adds the coordination views over the same state: the item's agent bar
 * (a parked lead, ready to resume or not), parked Board cards and the epic's
 * Tickets list, the Needs you strip's links into Agents, and the workspace
 * chip on recovery Problems rows.
 *
 * Time-based rows (orphaned after ORPHAN_AFTER, parked past PARK_MAX,
 * unattended past RESUME_UNATTENDED) can't wait for the clock: after the
 * agent's calls, `age()` moves the run's recorded times back in the
 * container's database. Docket derives the rows on read, so this is the
 * same state the clock would reach.
 *
 * Set DOCKET_E2E_SCREENSHOTS to a folder to also capture the PR's light
 * and dark screenshots.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { CONTAINER } from './fixtures/container';
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

async function shoot(page: Page, name: string) {
  if (!out) return;
  for (const theme of ['light', 'dark'] as const) {
    await setTheme(page, theme);
    await page.screenshot({ path: join(out, `us11-${name}-${theme}.png`), fullPage: true });
  }
  await setTheme(page, 'light');
}

/** Run SQL updates in the container's database (fixture: ageing recorded times). */
function age(statements: [string, unknown[]][]): void {
  const script =
    "const D=require('better-sqlite3');const db=new D('/data/docket.db');db.pragma('busy_timeout = 5000');" +
    'for (const [q, a] of JSON.parse(process.argv[1])) db.prepare(q).run(...a);db.close();';
  execFileSync(
    'docker',
    ['exec', '-w', '/app/server', CONTAINER, 'node', '-e', script, JSON.stringify(statements)],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
}
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const MIN = 60_000;

async function ok(agent: McpAgent, tool: string, args: Record<string, unknown>) {
  const res = await agent.call(tool, args);
  expect(res.isError, `${tool}: ${res.text}`).toBe(false);
  return res;
}

let agent: McpAgent;
const runs: Record<string, string> = {};

test.beforeAll(async () => {
  // Not `claude-code`: that name gets text-only results by default (MCP_SPEC §3 Results),
  // and this file reads structuredContent. The normalised client is `claude` either way.
  agent = await connectAgent('claude', '1.0.0');
});
test.afterAll(async () => {
  await agent?.close();
});

/** The Problems card, scoped to RCP (where every recovery row of this file lives). */
async function openNeedsYou(page: Page) {
  await page.context().addInitScript(() => {
    sessionStorage.setItem('docket.scope', 'RCP');
    localStorage.setItem('docket.notifications', 'off');
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /^Problems · \d+/ })).toBeVisible();
}
const row = (page: Page, kind: string, item: string) =>
  page.locator(`[data-problem="${kind}"]`).filter({ hasText: item });

test.describe.serial('US11 recovery', () => {
  test('Orphaned resources: Mark released clears the row; Undo brings it back', async ({
    ownerPage: page,
  }) => {
    const claim = await ok(agent, 'claim_lead', {
      id: 'RCP-17',
      agent_label: 'orca-w1',
      workspace: { path: 'C:/work/rcp-17', branch: 'rcp-17-week-reload', base_ref: 'origin/main' },
    });
    const run_id = (runs.orphan = claim.structured.run_id as string);
    await ok(agent, 'report_commit', { id: 'RCP-17', run_id, sha: '4be1c09', pushed: true });
    await ok(agent, 'heartbeat', {
      run_id,
      workspace: { dirty: false },
      resources_started: [
        { kind: 'dev_server', label: 'dev server :5173', locator: { port: 5173, pid: 4242 } },
      ],
    });
    const fin = await ok(agent, 'finish_run', { run_id, result: 'finished', summary: 'Done.' });
    expect(fin.text).toContain('! 1 resource still declared: dev server :5173');
    // ORPHAN_AFTER (15 min) has passed since the run ended.
    age([
      [
        "UPDATE events SET at = ? WHERE type = 'run.ended' AND json_extract(data, '$.run_id') = ?",
        [ago(20 * MIN), run_id],
      ],
    ]);

    await openNeedsYou(page);
    const r = row(page, 'orphaned_resources', 'RCP-17');
    // Key fact first (B20): what is still running, then since when.
    await expect(r).toContainText(
      'dev server :5173 (pid 4242, port 5173) still running 20m after its run ended',
    );
    await r.getByRole('button', { name: 'Mark released' }).click();
    const toast = page.getByRole('status');
    await expect(toast).toContainText('Marked released.');
    await expect(r).toHaveCount(0);
    await toast.getByRole('button', { name: 'Undo' }).click();
    await expect(toast).toContainText('Undone.');
    await expect(row(page, 'orphaned_resources', 'RCP-17')).toHaveCount(1);
  });

  test('Unpushed work may be lost: Handled clears the row; Undo brings it back', async ({
    ownerPage: page,
  }) => {
    const claim = await ok(agent, 'claim_lead', {
      id: 'RCP-25',
      agent_label: 'orca-w2',
      workspace: {
        path: 'C:/work/rcp-25',
        branch: 'rcp-25-pantry-screens',
        base_ref: 'origin/main',
      },
      orchestrator: { name: 'orca', dispatch_id: 'ctx_6f2d91', task_id: 'task_25' },
      brief:
        'Work Docket item RCP-25 using the docket-worker skill.\nWorktree: C:/work/rcp-25.',
    });
    const run_id = (runs.unpushed = claim.structured.run_id as string);
    await ok(agent, 'set_plan', {
      id: 'RCP-25',
      run_id,
      steps: [{ text: 'Empty pantry state' }, { text: 'Pantry list screen' }],
      reason: 'Plan',
    });
    await ok(agent, 'report_commit', { id: 'RCP-25', run_id, sha: '6f00e12', pushed: true });
    await ok(agent, 'report_commit', { id: 'RCP-25', run_id, sha: '77aa001' });
    await ok(agent, 'heartbeat', { run_id, workspace: { dirty: true } });
    await ok(agent, 'release_lead', {
      id: 'RCP-25',
      run_id,
      reason: 'Stopping; the session ends.',
    });

    await openNeedsYou(page);
    const r = row(page, 'unpushed_work', 'RCP-25');
    await expect(r.locator('.reason')).toHaveAttribute(
      'title',
      '1 commit not pushed · uncommitted changes · C:/work/rcp-25 · run ended (released by the agent)',
    );
    // Whole facts: each is its own unit, so a wrap never cuts one.
    await expect(r.locator('.reason .fact')).toHaveCount(4);
    // The worktree's state chip, as on Agents → Workspaces.
    await expect(r.locator('.chip')).toHaveText('At risk');
    await r.getByRole('button', { name: 'Handled' }).click();
    const toast = page.getByRole('status');
    await expect(toast).toContainText('Marked handled.');
    await expect(r).toHaveCount(0);
    await toast.getByRole('button', { name: 'Undo' }).click();
    await expect(toast).toContainText('Undone.');
    await expect(row(page, 'unpushed_work', 'RCP-25')).toHaveCount(1);
  });

  test('Parked for 24 h and Ready to resume, unattended, each opening Activity', async ({
    ownerPage: page,
  }) => {
    // RCP-17 again (resumable): parked on the coordinator for over PARK_MAX.
    const a = await ok(agent, 'claim_lead', {
      id: 'RCP-17',
      agent_label: 'orca-w3',
      workspace: { path: 'C:/work/rcp-17-b', branch: 'rcp-17-week-reload' },
    });
    runs.parkedLong = a.structured.run_id as string;
    await ok(agent, 'park_run', {
      run_id: runs.parkedLong,
      reason: 'Waiting for the coordinator to send the next batch',
      waiting_on: { orchestrator: true },
    });
    // RCP-18 (resumable): parked on RCP-11, which is done, for over RESUME_UNATTENDED.
    const b = await ok(agent, 'claim_lead', {
      id: 'RCP-18',
      agent_label: 'orca-w4',
      workspace: { path: 'C:/work/rcp-18', branch: 'rcp-18-import-url' },
    });
    runs.ready = b.structured.run_id as string;
    const parked = await ok(agent, 'park_run', {
      run_id: runs.ready,
      reason: 'Waiting for RCP-11 to be done',
      waiting_on: { items: ['RCP-11'] },
    });
    expect(parked.structured).toEqual({ run_state: 'parked', resume_ready: true });
    age([
      ['UPDATE runs SET parked_at = ? WHERE id = ?', [ago(25 * 60 * MIN), runs.parkedLong]],
      ['UPDATE runs SET parked_at = ? WHERE id = ?', [ago(40 * MIN), runs.ready]],
    ]);

    await openNeedsYou(page);
    await expect(row(page, 'parked_too_long', 'RCP-17')).toContainText(
      'waiting on the coordinator · keeps its claim',
    );
    await expect(row(page, 'parked_too_long', 'RCP-17').locator('.chip')).toHaveText('Parked');
    await expect(row(page, 'resume_unattended', 'RCP-18')).toContainText(
      'Ready to resume: RCP-11 is done · parked 40m',
    );
    await expect(row(page, 'resume_unattended', 'RCP-18').locator('.chip')).toHaveText('Parked');
    // All four recovery rows fit the card at once.
    for (const kind of [
      'orphaned_resources',
      'unpushed_work',
      'parked_too_long',
      'resume_unattended',
    ])
      await expect(page.locator(`[data-problem="${kind}"]`)).toHaveCount(1);
    await expectAxeClean(page, 'needs you with recovery problems');
    await shoot(page, 'needs-you-problems');

    await row(page, 'resume_unattended', 'RCP-18').getByRole('link', { name: 'Open' }).click();
    await expect(page).toHaveURL(/\/items\/RCP-18\?tab=activity/);
    const block = page.locator(`[data-run="${runs.ready}"] [data-section="where-the-work-lives"]`);
    await expect(block.locator('[data-ws="parked"]')).toContainText(
      'Parked · waiting on RCP-11 · since',
    );
    await expect(block.locator('[data-ws="parked"]')).toContainText('Ready to resume');
    await expect(block.getByRole('button', { name: 'Copy resume note' })).toBeVisible();
  });

  test('B20: the agent bar, parked Board cards, the epic Tickets list and the strip links', async ({
    ownerPage: page,
  }) => {
    await page.context().addInitScript(() => localStorage.setItem('docket.notifications', 'off'));
    const bar = page.getByRole('region', { name: 'Lead agent' });

    // A parked lead, on any tab: run line, the parked line, the worktree chip, the actions.
    await page.goto('/items/RCP-17?tab=details');
    await expect(bar).toHaveAttribute('data-agent-bar', 'parked');
    await expect(bar.locator('.runline .rl')).toHaveText(/^parked\s· claude · orca-w3$/);
    await expect(bar.locator('[data-ab="parked"]')).toHaveText(
      /^Parked: waiting on the coordinator since \w{3} \d+ \d\d:\d\d$/,
    );
    await expect(bar.locator('.chip')).toHaveText('Parked');
    await expect(bar.getByRole('button', { name: 'Release lead claim…' })).toBeVisible();
    await expect(bar.getByRole('button', { name: 'Copy resume note' })).toBeVisible();
    await expectAxeClean(page, 'agent bar, parked lead');

    // Ready to resume, on another tab.
    await page.goto('/items/RCP-18?tab=checklist');
    await expect(bar.locator('[data-ab="parked"]')).toContainText(
      /^Parked: waiting on RCP-11 since \d\d:\d\d/,
    );
    await expect(bar.locator('[data-ab="parked"]')).toContainText('Ready to resume');

    // Board: one run line per parked card, state · reason · agent.
    await page.goto('/work');
    const runLine = (id: string) => page.locator(`a.tcard[data-item="${id}"] .runline`);
    await expect(runLine('RCP-17')).toHaveCount(1);
    await expect(runLine('RCP-17').locator('.rl')).toHaveText(
      /^parked\s· waiting on the coordinator\s· claude · orca-w3$/,
    );
    await expect(runLine('RCP-18').locator('.rl')).toHaveText(
      /^parked\s· ready to resume\s· claude · orca-w4$/,
    );
    // No wrapped run line starts with the separator: each "·" sits on its segment's line.
    const leading = await page.locator('a.tcard .runline .rl').evaluateAll((els) =>
      els.flatMap((el) => {
        const lines = new Map<number, string>();
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          const text = n.textContent ?? '';
          for (let i = 0; i < text.length; i++) {
            const r = document.createRange();
            r.setStart(n, i);
            r.setEnd(n, i + 1);
            const top = Math.round(r.getBoundingClientRect().top);
            if (!lines.has(top)) lines.set(top, text.slice(i).trimStart());
          }
        }
        return [...lines.values()].filter((l) => l.startsWith('·'));
      }),
    );
    expect(leading).toEqual([]);
    await expectAxeClean(page, 'board with parked cards', { include: '[data-layout="board"]' });

    // The epic's Tickets list uses the same pieces.
    await page.goto('/items/RCP-1');
    await expect(page.locator('[data-ticket="RCP-17"] .runline .rl')).toHaveText(
      /^parked\s· waiting on the coordinator\s· claude · orca-w3$/,
    );
    await expect(page.locator('[data-ticket="RCP-16"]')).toContainText('Blocked by');
    await expectAxeClean(page, 'epic tickets with run state');

    // The Needs you strip: a count opens Agents filtered to that state.
    await page.context().addInitScript(() => sessionStorage.setItem('docket.scope', 'RCP'));
    await page.goto('/');
    const strip = page.locator('[data-card="agents-strip"]');
    await expect(strip.locator('a[data-state="parked"]')).toContainText('× 2');
    const risk = strip.locator('a[data-state="workspaces-at-risk"]');
    await expect(risk).toHaveText(/^\d+ workspaces? at risk$/);
    const n = Number((await risk.innerText()).split(' ')[0]);
    await strip.locator('a[data-state="parked"]').click();
    await expect(page).toHaveURL(/\/agents\?state=parked$/);
    const active = page.locator('[data-section="agents-active"]');
    await expect(active.locator('tbody tr')).toHaveCount(2);
    await expect(
      active.locator('tbody tr').filter({ hasText: 'RCP-18' }).locator('.rl'),
    ).toHaveText(/^parked\s· ready to resume$/);
    await expectAxeClean(page, 'agents filtered to parked');

    // "n workspaces at risk" opens Agents → Workspaces, whose header says the same n.
    await page.goto('/');
    await risk.click();
    await expect(page).toHaveURL(/\/agents#workspaces$/);
    await expect(page.getByRole('button', { name: /^Workspaces/ })).toContainText(`${n} at risk`);
    await expect(page.locator('#workspaces')).toBeInViewport();
  });

  test('Where the work lives and Copy resume note', async ({ ownerPage: page }) => {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto('/items/RCP-25?tab=activity');
    const block = page.locator(
      `[data-run="${runs.unpushed}"] [data-section="where-the-work-lives"]`,
    );
    await expect(block.locator('[data-ws="path"]')).toContainText('rcp-25-pantry-screens');
    await expect(block.locator('[data-ws="path"]')).toContainText('C:/work/rcp-25');
    await expect(block.locator('[data-ws="path"]')).toContainText('At risk');
    await expect(block.locator('[data-ws="push"]')).toContainText('last commit 77aa001');
    await expect(block.locator('[data-ws="push"]')).toContainText('1 commit not pushed');
    await expect(block.locator('[data-ws="push"]')).toContainText('uncommitted changes');
    await expect(block.locator('[data-ws="orchestrator"]')).toContainText('orca · ctx_6f2d91');

    await block.getByRole('button', { name: 'Copy resume note' }).click();
    await expect(page.getByRole('status')).toContainText('Copied the resume note.');
    // The OS clipboard may store CRLF (Windows); the note itself uses LF.
    const note = (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n');
    const dv = /brief (dv_\w+)/.exec(note)?.[1];
    expect(dv).toBeTruthy();
    expect(note).toBe(
      [
        'Resume RCP-25: worktree C:/work/rcp-25 on rcp-25-pantry-screens @ 6f00e12',
        '(1 unpushed commit / uncommitted changes),',
        `brief ${dv} (${new URL(page.url()).origin}/api/documents/${dv}/content), checklist 0/2, claim_lead first`,
      ].join('\n'),
    );

    // Copy the worktree path.
    await block.getByRole('button', { name: 'Copy worktree path C:/work/rcp-25' }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('C:/work/rcp-25');

    // The brief opens in the document viewer.
    await block.getByRole('button', { name: 'Brief' }).click();
    const dialog = page.getByRole('dialog', { name: `brief-${runs.unpushed}.md` });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Close', exact: true }).last().click();
    await expect(dialog).toHaveCount(0);

    // RCP-17's finished run lists its dev server, with Mark released once the run has ended.
    await page.goto('/items/RCP-17?tab=activity');
    const r17 = page.locator(`[data-run="${runs.orphan}"] [data-section="where-the-work-lives"]`);
    await expect(r17).toContainText('dev server :5173 · running');
    await expect(r17.getByRole('button', { name: 'Mark released' })).toBeVisible();
    await expect(r17.locator('[data-ws="push"]')).toContainText('pushed ✓');

    await page.goto('/items/RCP-25?tab=activity');
    await expect(block).toBeVisible();
    await expectAxeClean(page, 'lead and runs with where the work lives');
    await shoot(page, 'where-the-work-lives');
  });

  test('Agents → Workspaces: every state, Hide safe to prune on by default', async ({
    ownerPage: page,
  }) => {
    // DOC-5: one clean pushed finished worktree (safe), one never reported (unknown), one open (in use).
    const s = await ok(agent, 'claim_lead', {
      id: 'DOC-5',
      workspace: { path: 'C:/work/doc-5', branch: 'doc-5-search' },
    });
    const safe = s.structured.run_id as string;
    await ok(agent, 'report_commit', { id: 'DOC-5', run_id: safe, sha: 'a1b2c3d', pushed: true });
    await ok(agent, 'heartbeat', { run_id: safe, workspace: { dirty: false } });
    await ok(agent, 'finish_run', { run_id: safe, result: 'finished', summary: 'Done.' });
    const u = await ok(agent, 'claim_lead', {
      id: 'DOC-5',
      workspace: { path: 'C:/work/doc-5-b', branch: 'doc-5-b' },
    });
    await ok(agent, 'finish_run', {
      run_id: u.structured.run_id as string,
      result: 'finished',
      summary: 'Nothing reported.',
    });
    await ok(agent, 'claim_lead', {
      id: 'DOC-5',
      workspace: { path: 'C:/work/doc-5-c', branch: 'doc-5-c' },
    });

    await page.goto('/agents');
    const card = page.locator('[data-section="agents-workspaces"]');
    const hide = card.getByRole('button', { name: 'Hide safe to prune' });
    await expect(hide).toHaveAttribute('aria-pressed', 'true');
    const rowOf = (path: string) => card.locator(`tbody tr:has(td[title="${path}"])`);
    const stateOf = (path: string) => rowOf(path).locator('td').first();
    await expect(stateOf('C:/work/rcp-25')).toHaveText('At risk');
    await expect(stateOf('C:/work/rcp-17-b')).toHaveText('Parked');
    await expect(stateOf('C:/work/rcp-18')).toHaveText('Parked');
    await expect(stateOf('C:/work/doc-5-c')).toHaveText('In use');
    await expect(stateOf('C:/work/doc-5-b')).toHaveText('Unknown');
    await expect(rowOf('C:/work/doc-5')).toHaveCount(0); // safe to prune: hidden by default
    // Sort order: At risk, In use, Parked, Unknown, Safe to prune.
    const states = await card.locator('tbody tr td:first-child').allInnerTexts();
    const order = ['At risk', 'In use', 'Parked', 'Unknown', 'Safe to prune'];
    expect(states.map((x) => order.indexOf(x.trim()))).toEqual(
      [...states.map((x) => order.indexOf(x.trim()))].sort((a, b) => a - b),
    );
    await expect(rowOf('C:/work/rcp-25')).toContainText('1 behind');
    // The header counts them (B20).
    const atRisk = states.filter((x) => x.trim() === 'At risk').length;
    expect(atRisk).toBeGreaterThan(0);
    await expect(card.getByRole('button', { name: /^Workspaces/ })).toContainText(
      `${atRisk} at risk`,
    );
    await expectAxeClean(page, 'agents with workspaces');

    await hide.click();
    await expect(hide).toHaveAttribute('aria-pressed', 'false');
    await expect(stateOf('C:/work/doc-5')).toHaveText('Safe to prune');
    await shoot(page, 'agents-workspaces');
  });
});

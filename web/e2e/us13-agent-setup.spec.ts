/**
 * Agent setup: agent files and Workflow notes (tasks.md T153, T154, T157;
 * spec US13 acceptance scenarios 1–3 and 6; UI_SPEC §6.7b).
 *
 * One walkthrough, in order:
 * 1. view the bundled `tasklite-worker` (rendered and Raw);
 * 2. edit it service-wide (the note is required), then its diff against
 *    bundled and its history;
 * 3. override it for RCP, then RCP's effective set says where each file
 *    comes from; revert the override and undo the revert from the toast;
 * 4. write RCP's Workflow notes;
 * 5. `get_context` for an RCP item delivers them (the compact text is
 *    printed);
 * 6. an upgrade changes the bundled file (the image's copy is edited and
 *    the container restarted): "Bundled version updated", the three-way
 *    diffs, and the owner's version kept.
 *
 * axe is clean on each screen, both themes. Set TASKLITE_E2E_SCREENSHOTS to
 * a folder to also capture the PR's light and dark screenshots.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { baseURL } from './container';
import {
  expect,
  expectAxeClean,
  resetSeededContainer,
  setTheme,
  test,
  useSeededContainer,
} from './fixtures/index';
import { CONTAINER } from './fixtures/container';

useSeededContainer();

const SKILL = '/app/skills/tasklite-worker/SKILL.md';
const BACKUP = '/tmp/tasklite-worker.SKILL.md';

function docker(args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

async function restartAndWait(): Promise<void> {
  docker(['restart', '--time', '10', CONTAINER]);
  const until = Date.now() + 60_000;
  while (Date.now() < until) {
    try {
      if ((await fetch(new URL('/readyz', baseURL))).ok) return;
    } catch {
      // Not up yet.
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('Task Lite did not come back after the restart');
}

// The upgrade step edits the image's copy of the skill; put it back, then a fresh seed.
test.afterAll(async () => {
  test.setTimeout(180_000);
  try {
    docker([
      'exec',
      '-u',
      'root',
      CONTAINER,
      'sh',
      '-c',
      `[ -f ${BACKUP} ] && cp ${BACKUP} ${SKILL} || true`,
    ]);
    await restartAndWait();
  } finally {
    await resetSeededContainer();
  }
});

const out = process.env.TASKLITE_E2E_SCREENSHOTS;

async function shoot(page: Page, name: string, target: Locator) {
  if (!out) return;
  for (const theme of ['light', 'dark'] as const) {
    await setTheme(page, theme);
    await target.screenshot({ path: join(out, `us13-${name}-${theme}.png`) });
  }
  await setTheme(page, 'light');
}

const toast = (page: Page, text: string | RegExp) =>
  page.locator('.toast').filter({ hasText: text });
const fileRow = (page: Page, key: string) => page.locator(`[data-agent-file="${key}"]`);
const view = (page: Page) => page.locator('[data-agent-file-view="skill:tasklite-worker"]');

const ADDED = '## Our rules\n\n- Squash on merge; branch per item.';
const OVERRIDE = '- RCP plans with Spec Kit: read specs/ before claiming.';
const NOTES = [
  '- Branch per item: `rcp-<n>-<slug>`; PRs against `main`.',
  '- Run `pnpm test` before submit_for_review.',
  '- The owner moves items to Ready.',
].join('\n');

test.describe.configure({ mode: 'serial' });

test.describe('Agent setup (US13)', () => {
  test('1. the bundled tasklite-worker: list, rendered and Raw; axe is clean', async ({
    ownerPage: page,
  }) => {
    await page.goto('/settings');
    await page.getByRole('tab', { name: 'Agent setup' }).click();
    await expect(page).toHaveURL(/\/settings\/agent-setup$/);
    const table = page.getByRole('table', { name: 'Agent files' });
    await expect(table.getByRole('row')).toHaveCount(7);
    for (const key of [
      'skill:tasklite-coordinator',
      'skill:tasklite-lead-subagents',
      'skill:tasklite-planner',
      'skill:tasklite-review-packet',
      'skill:tasklite-worker',
      'agents_block',
    ]) {
      await expect(fileRow(page, key).getByText('Bundled', { exact: true })).toBeVisible();
    }
    await expect(page.getByRole('button', { name: 'Install (coming next)' })).toBeDisabled();

    await fileRow(page, 'skill:tasklite-worker')
      .getByRole('link', { name: 'tasklite-worker' })
      .click();
    await expect(page).toHaveURL(/file=skill%3Atasklite-worker/);
    const v = view(page);
    await expect(v.getByRole('heading', { name: 'tasklite-worker' })).toBeVisible();
    await expect(
      v.getByRole('group', { name: 'Layer' }).getByRole('button', { name: 'Bundled' }),
    ).toHaveAttribute('aria-pressed', 'true');
    await expect(v.getByText('In use service-wide.')).toBeVisible();
    await expect(v.getByLabel('Front matter')).toContainText('name: tasklite-worker');
    await expect(v.locator('[data-markdown] h1').first()).toBeVisible();
    await shoot(page, '1-bundled-worker', page.locator('.agent-setup'));
    await expectAxeClean(page, 'Agent setup: bundled file view');

    await v.getByRole('group', { name: 'Show as' }).getByRole('button', { name: 'Raw' }).click();
    await expect(v.locator('pre.afraw')).toContainText('name: tasklite-worker');
    await v
      .getByRole('group', { name: 'Show as' })
      .getByRole('button', { name: 'Rendered' })
      .click();
  });

  test('2. edit service-wide (note required), then the diff and the history', async ({
    ownerPage: page,
  }) => {
    await page.goto('/settings/agent-setup?file=skill:tasklite-worker');
    const v = view(page);
    await v.getByRole('button', { name: 'Edit service-wide' }).click();
    const editor = v.getByLabel('Edit file');
    await expect(editor).toBeFocused();
    const bundled = await editor.inputValue();
    await editor.fill(`${bundled.trimEnd()}\n\n${ADDED}\n`);
    // The note is required.
    await v.getByRole('button', { name: 'Save' }).click();
    await expect(v.getByText('Add a note saying what changed.')).toBeVisible();
    await expect(v.getByLabel('Note (required)')).toBeFocused();
    await expectAxeClean(page, 'Agent setup: editor');
    await v.getByLabel('Note (required)').fill('Squash on merge.');
    await v.getByRole('button', { name: 'Save' }).click();
    await expect(toast(page, 'Saved tasklite-worker (service-wide) v1.')).toBeVisible();
    await expect(v.getByLabel('Edit file')).toHaveCount(0);

    await expect(fileRow(page, 'skill:tasklite-worker').getByText('Your edit')).toBeVisible();
    await expect(
      v.getByRole('group', { name: 'Layer' }).getByRole('button', { name: 'Service-wide' }),
    ).toHaveAttribute('aria-pressed', 'true');
    await expect(v.getByText(/v1 · owner · .* · “Squash on merge\.”/)).toBeVisible();

    // Diff against bundled: only the added lines.
    await v.getByLabel('Diff against').selectOption({ label: 'Bundled v1 (current)' });
    const diff = v.locator('[data-diff]');
    // A blank line, then the three lines of ADDED.
    await expect(diff).toContainText('4 lines added, 0 lines removed');
    await expect(diff.locator('[data-op="add"]').filter({ hasText: '## Our rules' })).toHaveCount(
      1,
    );
    await expect(diff.locator('[data-op="del"]')).toHaveCount(0);
    await shoot(page, '2-service-edit-diff', v);
    await expectAxeClean(page, 'Agent setup: diff');
    await v.getByRole('button', { name: 'Close diff' }).click();

    await v.getByRole('button', { name: 'History (1)' }).click();
    const hist = v.getByRole('region', { name: 'Service-wide history' });
    await expect(hist.locator('[data-version="1"]')).toContainText('Squash on merge.');
    await expect(hist.locator('[data-version="1"]')).toContainText('Current');
    await shoot(page, '2-service-edit-history', v);
    await expectAxeClean(page, 'Agent setup: history');
  });

  test('3. override it for RCP; RCP’s effective set; revert and undo', async ({
    ownerPage: page,
  }) => {
    await page.goto('/settings');
    await page.locator('[data-project-agent-files="RCP"]').click();
    await expect(page).toHaveURL(/\/settings\/agent-setup\?project=RCP$/);
    await expect(
      page.getByRole('heading', { name: /Recipe App · Agent files & workflow/ }),
    ).toBeVisible();
    await fileRow(page, 'skill:tasklite-worker').getByRole('link').click();
    const v = view(page);
    await expect(v.getByText(/As .*Recipe App gets it\./)).toBeVisible();
    await v
      .getByRole('group', { name: 'Layer' })
      .getByRole('button', { name: /Recipe App/ })
      .click();
    await expect(v.getByText(/No .*Recipe App override\./)).toBeVisible();
    await v.getByRole('button', { name: 'Edit' }).click();
    const editor = v.getByLabel('Edit file');
    // A new override starts from the service-wide edit.
    await expect(editor).toHaveValue(/## Our rules/);
    await editor.fill(`${(await editor.inputValue()).trimEnd()}\n${OVERRIDE}\n`);
    await v.getByLabel('Note (required)').fill('RCP uses Spec Kit.');
    await v.getByRole('button', { name: 'Save' }).click();
    await expect(toast(page, /Saved tasklite-worker \(.*Recipe App\) v1\./)).toBeVisible();
    await expect(
      fileRow(page, 'skill:tasklite-worker').getByText('Project override'),
    ).toBeVisible();

    const set = page.getByRole('list', { name: 'Effective agent files' });
    await expect(set.locator('[data-effective-file="skill:tasklite-worker"]')).toContainText(
      'Project override',
    );
    await expect(set.locator('[data-effective-file="skill:tasklite-coordinator"]')).toContainText(
      'Bundled',
    );
    await expect(set.locator('[data-effective-file="agents_block"]')).toContainText('Bundled');
    await shoot(page, '3-project-override', page.locator('.agent-setup'));
    await shoot(page, '3-effective-set', page.locator('.afset'));
    await expectAxeClean(page, 'Agent setup: project override and effective set');

    // DOC still gets the service-wide edit.
    await page.goto('/settings/agent-setup?project=DOC');
    await expect(fileRow(page, 'skill:tasklite-worker').getByText('Your edit')).toBeVisible();

    // Revert the override, then undo from the toast.
    await page.goto('/settings/agent-setup?project=RCP&file=skill:tasklite-worker&layer=project');
    await v.getByRole('button', { name: 'Revert to service-wide' }).click();
    const reverted = toast(
      page,
      /Reverted tasklite-worker \(.*Recipe App\) to the service-wide edit\./,
    );
    await expect(reverted).toBeVisible();
    await expect(fileRow(page, 'skill:tasklite-worker').getByText('Your edit')).toBeVisible();
    await reverted.getByRole('button', { name: 'Undo' }).click();
    await expect(
      fileRow(page, 'skill:tasklite-worker').getByText('Project override'),
    ).toBeVisible();
  });

  test('4–5. Workflow notes, delivered by get_context for an RCP item', async ({
    ownerPage: page,
    agent,
  }) => {
    await page.goto('/settings/agent-setup?project=RCP');
    const wf = page.locator('[data-workflow="RCP"]');
    await expect(wf.getByText(/Agents get this in get_context/)).toBeVisible();
    await expect(wf.getByText(/No Workflow notes yet/)).toBeVisible();
    await wf.getByRole('button', { name: 'Edit' }).click();
    await wf.getByLabel('Edit Workflow notes').fill(NOTES);
    await wf.getByLabel('Note (optional)').fill('First notes.');
    await wf.getByRole('button', { name: 'Save' }).click();
    await expect(toast(page, /Saved the Workflow notes of .*Recipe App \(v1\)\./)).toBeVisible();
    await expect(wf.locator('[data-markdown] li')).toHaveCount(3);
    await expect(wf.getByText('v1 ·', { exact: false })).toBeVisible();
    await shoot(page, '4-workflow-notes', page.locator('[data-project-agent-section="RCP"]'));
    await expectAxeClean(page, 'Agent setup: Workflow notes');

    const ctx = await agent.call('get_context', { id: 'RCP-14' });
    expect(ctx.isError).toBe(false);
    console.log(`> get_context {"id":"RCP-14"}\n${ctx.text}`);
    expect(ctx.text).toContain(`workflow: RCP v1\n  ${NOTES.split('\n').join('\n  ')}`);
    const context = ctx.structured.context as { workflow: unknown };
    expect(context.workflow).toEqual({
      project: 'RCP',
      version_no: 1,
      content_md: NOTES,
      truncated: false,
    });
    // Another project's item doesn't get them.
    expect((await agent.call('get_context', { id: 'DOC-4' })).text).not.toContain('workflow:');
    // Agents have no tool for agent files or Workflow notes.
    expect(
      (await agent.listTools()).filter((t) => /agent_?file|workflow|skill|install/i.test(t)),
    ).toEqual([]);
  });

  test('6. an upgrade changes the bundled file: "Bundled version updated", the edit kept', async ({
    ownerPage: page,
  }) => {
    test.setTimeout(120_000);
    docker([
      'exec',
      '-u',
      'root',
      CONTAINER,
      'sh',
      '-c',
      `cp ${SKILL} ${BACKUP} && printf '\\n## New in this release\\n\\n- Report the workspace on every claim.\\n' >> ${SKILL}`,
    ]);
    await restartAndWait();

    await page.goto('/settings/agent-setup');
    const row = fileRow(page, 'skill:tasklite-worker');
    await expect(row.getByText('Bundled version updated')).toBeVisible();
    await expect(row.getByText('Your edit')).toBeVisible();
    await expect(
      fileRow(page, 'skill:tasklite-planner').getByText('Bundled version updated'),
    ).toHaveCount(0);
    await shoot(page, '6-bundled-updated-list', page.getByRole('table', { name: 'Agent files' }));

    await row.getByRole('link').click();
    const v = view(page);
    await expect(v.getByText('Bundled version updated.')).toBeVisible();
    // The owner's version is kept, and still applies.
    await expect(v.getByText('In use service-wide.')).toBeVisible();
    await expect(v.locator('[data-markdown]')).toContainText('Squash on merge; branch per item.');
    await v.getByRole('button', { name: 'Diff bundled v1 → v2' }).click();
    const diff = v.locator('[data-diff]');
    await expect(
      diff.locator('[data-op="add"]').filter({ hasText: 'New in this release' }),
    ).toHaveCount(1);
    await shoot(page, '6-bundled-updated-three-way', v);
    await expectAxeClean(page, 'Agent setup: bundled version updated');
    await v.getByRole('button', { name: 'Diff bundled v2 → your edit' }).click();
    await expect(
      diff.locator('[data-op="del"]').filter({ hasText: 'New in this release' }),
    ).toHaveCount(1);
    await expect(diff.locator('[data-op="add"]').filter({ hasText: 'Our rules' })).toHaveCount(1);

    // RCP's override was based on bundled v1 too.
    await page.goto('/settings/agent-setup?project=RCP');
    await expect(
      page
        .locator('[data-effective-file="skill:tasklite-worker"]')
        .getByText('Bundled version updated'),
    ).toBeVisible();
  });
});

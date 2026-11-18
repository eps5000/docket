/**
 * Agent files: the defaults, a project's copies and Workflow notes (tasks.md
 * T153, T154, T157; spec US13 acceptance scenarios 1–3 and 6; UI_SPEC
 * §6.7b as redesigned in B25).
 *
 * One walkthrough, in order:
 * 1. the old `/settings/agent-setup` redirects to Agent files, which has its
 *    own nav item, follows the project switcher, and no longer sits in
 *    Settings; All projects lists the defaults; a file opens rendered and Raw;
 * 2. edit the default (the note is required), compare it with Docket's
 *    version, its history; *Reset to Docket’s version* and Undo;
 * 3. pick Recipe App in the switcher: *Customize for Recipe App*, the
 *    project's copy, "Customized in" on All projects, *Use default* and Undo,
 *    and *Compare with* the default;
 * 4. Workflow notes: *Start from template* loads the starter unsaved; then
 *    the notes are saved, and `get_context` for an RCP item delivers them;
 * 5. an upgrade changes Docket's version of the file (the image's copy is
 *    edited and the container restarted): the edited default and RCP's copy
 *    are both flagged, with their comparisons, and both are kept.
 *
 * None of these screens says bundled, layer, override, effective set or
 * service-wide. axe is clean on each screen, both themes. Set
 * DOCKET_E2E_SCREENSHOTS to a folder to capture the PR's screenshots.
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

const SKILL = '/app/skills/docket-worker/SKILL.md';
const BACKUP = '/tmp/docket-worker.SKILL.md';

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
  throw new Error('Docket did not come back after the restart');
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

const out = process.env.DOCKET_E2E_SCREENSHOTS;

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
const view = (page: Page, key = 'skill:docket-worker') =>
  page.locator(`[data-agent-file-view="${key}"]`);

/** The internal words the redesign keeps off these screens (B25). */
const INTERNAL = /bundled|\blayers?\b|override|effective set|service-wide/i;
async function expectPlainWords(page: Page) {
  for (const sel of ['.afpagehead', '.aflede', '.aflist', '.afvhead', '.afuse', '.aftools']) {
    const loc = page.locator(sel);
    for (let i = 0; i < (await loc.count()); i++) {
      expect(await loc.nth(i).innerText(), sel).not.toMatch(INTERNAL);
    }
  }
}

async function chooseProject(page: Page, name: string) {
  await page.locator('.scopebtn').click();
  await page.getByRole('menuitemradio', { name }).click();
}

const ADDED = '## Our rules\n\n- Squash on merge; branch per item.';
const COPY_LINE = '- RCP plans with Spec Kit: read specs/ before claiming.';
const NOTES = [
  '- Branch per item: `rcp-<n>-<slug>`; PRs against `main`.',
  '- Run `pnpm test` before submit_for_review.',
  '- The owner moves items to Ready.',
].join('\n');

test.describe.configure({ mode: 'serial' });

test.describe('Agent files (US13)', () => {
  test('1. the old route redirects; All projects lists the defaults; a file, rendered and Raw', async ({
    ownerPage: page,
  }) => {
    // Settings has no Agent setup tab any more.
    await page.goto('/settings');
    await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Agent setup' })).toHaveCount(0);
    await expect(page.getByRole('tablist', { name: 'Settings sections' })).toHaveCount(0);
    await shoot(page, '1-settings-no-agent-tab', page.locator('.settings'));

    // The old route redirects to Agent files (no project: All projects).
    await page.goto('/settings/agent-setup');
    await expect(page).toHaveURL(/\/agent-files$/);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Agent files · Defaults' }),
    ).toBeVisible();
    // Its own nav item, after Agents, current here.
    const nav = page.getByRole('navigation', { name: 'Primary' });
    await expect(nav.getByRole('link', { name: 'Agent files' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(page.getByRole('button', { name: 'Install user-wide' })).toBeVisible();

    const table = page.getByRole('table', { name: 'Default agent files' });
    await expect(table.getByRole('row')).toHaveCount(7);
    for (const key of [
      'skill:docket-coordinator',
      'skill:docket-lead-subagents',
      'skill:docket-planner',
      'skill:docket-review-packet',
      'skill:docket-worker',
      'agents_block',
    ]) {
      await expect(fileRow(page, key)).toHaveAttribute('data-default', 'task-lite');
      await expect(fileRow(page, key).getByText('Docket’s version')).toBeVisible();
    }

    await fileRow(page, 'skill:docket-worker')
      .getByRole('link', { name: 'docket-worker' })
      .click();
    await expect(page).toHaveURL(/file=skill%3Adocket-worker/);
    const v = view(page);
    await expect(v.getByRole('heading', { name: 'docket-worker' })).toBeVisible();
    await expect(
      v.getByText('Every project uses Docket’s version, unless it has its own copy.'),
    ).toBeVisible();
    await expect(v.getByLabel('Front matter')).toContainText('name: docket-worker');
    await expect(v.locator('[data-markdown] h1').first()).toBeVisible();
    await expectPlainWords(page);
    await shoot(page, '1-all-projects', page.locator('.agent-files'));
    await expectAxeClean(page, 'Agent files: All projects, a file');

    await v.getByRole('group', { name: 'Show as' }).getByRole('button', { name: 'Raw' }).click();
    await expect(v.locator('pre.afraw')).toContainText('name: docket-worker');
    await v
      .getByRole('group', { name: 'Show as' })
      .getByRole('button', { name: 'Rendered' })
      .click();
  });

  test('2. edit the default (note required), compare, history; Reset to Docket’s version and Undo', async ({
    ownerPage: page,
  }) => {
    await page.goto('/agent-files?project=all&file=skill:docket-worker');
    await expect(page).toHaveURL(/\/agent-files\?file=skill%3Adocket-worker$/);
    const v = view(page);
    await v.getByRole('button', { name: 'Edit', exact: true }).click();
    const editor = v.getByLabel('Edit file');
    await expect(editor).toBeFocused();
    const original = await editor.inputValue();
    await editor.fill(`${original.trimEnd()}\n\n${ADDED}\n`);
    // The note is required.
    await v.getByRole('button', { name: 'Save' }).click();
    await expect(v.getByText('Add a note saying what changed.')).toBeVisible();
    await expect(v.getByLabel('Note (required)')).toBeFocused();
    await expectAxeClean(page, 'Agent files: editing the default');
    await v.getByLabel('Note (required)').fill('Squash on merge.');
    await v.getByRole('button', { name: 'Save' }).click();
    await expect(toast(page, 'Saved the default docket-worker (v1).')).toBeVisible();
    await expect(v.getByLabel('Edit file')).toHaveCount(0);

    const row = fileRow(page, 'skill:docket-worker');
    await expect(row).toHaveAttribute('data-default', 'edited');
    await expect(row.getByText('Edited')).toBeVisible();
    await expect(row.getByRole('button', { name: /^Reset docket-worker/ })).toBeVisible();
    await expect(v.getByText(/Edited default v1 · owner · .* · “Squash on merge\.”/)).toBeVisible();

    // Compare with Docket's version: only the added lines.
    await v.getByLabel('Compare with').selectOption({ label: 'Docket’s version v1' });
    const diff = v.locator('[data-diff]');
    await expect(diff).toContainText('4 lines added, 0 lines removed');
    await expect(diff.locator('[data-op="add"]').filter({ hasText: '## Our rules' })).toHaveCount(
      1,
    );
    await expect(diff.locator('[data-op="del"]')).toHaveCount(0);
    await expectAxeClean(page, 'Agent files: compare');
    await v.getByRole('button', { name: 'Close comparison' }).click();

    await v.getByRole('button', { name: 'History (2)' }).click();
    const hist = v.getByRole('region', { name: 'Default history' });
    await expect(hist.locator('[data-version="service-1"]')).toContainText('Squash on merge.');
    await expect(hist.locator('[data-version="service-1"]')).toContainText('In use');
    await expect(hist.locator('[data-version="bundled-1"]')).toContainText(
      'Docket’s version v1',
    );
    await expectAxeClean(page, 'Agent files: history');

    // Edit docket-planner's default too; Reset it to Docket's version, then Undo.
    await page.goto('/agent-files?file=skill:docket-planner');
    const pv = view(page, 'skill:docket-planner');
    await pv.getByRole('button', { name: 'Edit', exact: true }).click();
    const pe = pv.getByLabel('Edit file');
    await pe.fill(`${(await pe.inputValue()).trimEnd()}\n\n- Plans live in specs/.\n`);
    await pv.getByLabel('Note (required)').fill('Plans in specs/.');
    await pv.getByRole('button', { name: 'Save' }).click();
    await expect(toast(page, 'Saved the default docket-planner (v1).')).toBeVisible();
    await pv.getByRole('button', { name: 'Reset to Docket’s version' }).click();
    const reset = toast(page, 'The default docket-planner is Docket’s version again.');
    await expect(reset).toBeVisible();
    await expect(fileRow(page, 'skill:docket-planner')).toHaveAttribute(
      'data-default',
      'task-lite',
    );
    await reset.getByRole('button', { name: 'Undo' }).click();
    await expect(fileRow(page, 'skill:docket-planner')).toHaveAttribute('data-default', 'edited');
  });

  test('3. Recipe App: Customize, its copy, Customized in, Use default and Undo, Compare', async ({
    ownerPage: page,
  }) => {
    await page.goto('/agent-files?project=all');
    await expect(page.getByRole('heading', { level: 1, name: /Defaults/ })).toBeVisible();
    // The page follows the project switcher.
    await chooseProject(page, 'Recipe App');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Agent files · Recipe App' }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Install into Recipe App’s repo' }),
    ).toBeVisible();
    const worker = fileRow(page, 'skill:docket-worker');
    await expect(worker).toHaveAttribute('data-using', 'default');
    await expect(worker).toContainText('Default (edited)');
    await expect(fileRow(page, 'skill:docket-coordinator')).toContainText('Default');

    // Customize: the editor opens on a new copy, starting from the default.
    await worker.getByRole('button', { name: /^Customize for Recipe App/ }).click();
    const v = view(page);
    const editor = v.getByLabel('Edit file');
    await expect(editor).toBeFocused();
    await expect(editor).toHaveValue(/## Our rules/);
    await expect(
      v.getByText(/A new copy for Recipe App, starting from the default\./),
    ).toBeVisible();
    await editor.fill(`${(await editor.inputValue()).trimEnd()}\n${COPY_LINE}\n`);
    await v.getByLabel('Note (required)').fill('RCP uses Spec Kit.');
    await v.getByRole('button', { name: 'Save' }).click();
    await expect(toast(page, 'Customized docket-worker for Recipe App.')).toBeVisible();
    await expect(worker).toHaveAttribute('data-using', 'copy');
    await expect(worker).toContainText(/Recipe App’s copy · edited/);
    await expect(worker.getByRole('button', { name: /^Use default/ })).toBeVisible();
    await expect(v.getByText('Recipe App’s agents use Recipe App’s copy.')).toBeVisible();

    // Compare the copy with the default.
    await v.getByLabel('Compare with').selectOption({ label: 'The default (Edited default v1)' });
    await expect(
      v.locator('[data-diff] [data-op="add"]').filter({ hasText: 'RCP plans with Spec Kit' }),
    ).toHaveCount(1);
    await v.getByRole('button', { name: 'Close comparison' }).click();
    await expectPlainWords(page);
    await shoot(page, '3-project-copy', page.locator('.agent-files'));
    await expectAxeClean(page, 'Agent files: one project, its copy');

    // All projects: "Customized in" links to Recipe App's view of the file.
    await chooseProject(page, 'All projects');
    const inCell = fileRow(page, 'skill:docket-worker').locator('[data-customized-in]');
    await expect(inCell.getByRole('link', { name: 'Recipe App' })).toBeVisible();
    await expect(
      fileRow(page, 'skill:docket-coordinator').locator('[data-customized-in]'),
    ).toHaveText('—');
    await inCell.getByRole('link', { name: 'Recipe App' }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: 'Agent files · Recipe App' }),
    ).toBeVisible();
    await expect(view(page).getByText('Recipe App’s agents use Recipe App’s copy.')).toBeVisible();

    // Docs Site still uses the default.
    await page.goto('/agent-files?project=DOC');
    await expect(fileRow(page, 'skill:docket-worker')).toHaveAttribute('data-using', 'default');

    // Use default, then Undo from the toast.
    await page.goto('/agent-files?project=RCP');
    await fileRow(page, 'skill:docket-worker')
      .getByRole('button', { name: /^Use default/ })
      .click();
    const back = toast(page, 'Recipe App uses the default docket-worker again.');
    await expect(back).toBeVisible();
    await expect(fileRow(page, 'skill:docket-worker')).toHaveAttribute('data-using', 'default');
    await back.getByRole('button', { name: 'Undo' }).click();
    await expect(fileRow(page, 'skill:docket-worker')).toHaveAttribute('data-using', 'copy');

    // The old route with a project and a file lands on that project's view of it.
    await page.goto('/settings/agent-setup?project=RCP&file=skill:docket-worker&layer=project');
    await expect(page).toHaveURL(/\/agent-files\?file=skill%3Adocket-worker$/);
    await expect(view(page).getByText('Recipe App’s agents use Recipe App’s copy.')).toBeVisible();
  });

  test('4. Workflow notes: Start from template (unsaved), then saved notes reach get_context', async ({
    ownerPage: page,
    agent,
  }) => {
    await page.goto('/agent-files?project=RCP');
    const wf = page.locator('[data-workflow="RCP"]');
    await expect(wf.getByText(/Rules agents get with every Recipe App item/)).toBeVisible();
    await expect(wf.getByText(/No Workflow notes yet/)).toBeVisible();
    await wf.getByRole('button', { name: 'Start from template' }).click();
    const editor = wf.getByLabel('Edit Workflow notes');
    await expect(editor).toHaveValue(
      /## Moving work to Ready\n- Only the owner moves items to Ready\./,
    );
    await expect(editor).toHaveValue(/## Labels/);
    expect(await editor.inputValue()).not.toContain('{{');
    await shoot(page, '4-workflow-template', wf);
    await expectAxeClean(page, 'Agent files: Workflow notes from the template');
    // Unsaved: cancelling leaves the notes empty.
    await wf.getByRole('button', { name: 'Cancel' }).click();
    const discard = page.getByRole('button', { name: 'Discard' });
    if (await discard.isVisible().catch(() => false)) await discard.click();
    await expect(wf.getByText(/No Workflow notes yet/)).toBeVisible();

    await wf.getByRole('button', { name: 'Edit' }).click();
    await wf.getByLabel('Edit Workflow notes').fill(NOTES);
    await wf.getByLabel('Note (optional)').fill('First notes.');
    await wf.getByRole('button', { name: 'Save' }).click();
    await expect(toast(page, /Saved the Workflow notes of Recipe App \(v1\)\./)).toBeVisible();
    await expect(wf.locator('[data-markdown] li')).toHaveCount(3);
    // Let the toast finish fading in: mid-animation, its colours fail contrast.
    await page
      .locator('.toast')
      .evaluateAll((els) =>
        Promise.all(els.flatMap((el) => el.getAnimations().map((x) => x.finished))),
      );
    await expectAxeClean(page, 'Agent files: Workflow notes');

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
    // Agents can't write agent files or Workflow notes: since decision 30 (B26) they
    // can only read them and propose a change (FR-130).
    expect(
      (await agent.listTools()).filter((t) => /agent_?file|workflow|skill|install/i.test(t)),
    ).toEqual(['get_agent_files', 'propose_agent_file_change']);
  });

  test('5. an upgrade changes Docket’s version: the edited default and RCP’s copy are flagged and kept', async ({
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

    // All projects: the edited default is flagged.
    await page.goto('/agent-files?project=all');
    const flag = page.locator('[data-default-changed="skill:docket-worker"]');
    await expect(flag).toContainText(
      'Docket’s version of docket-worker changed since you edited the default.',
    );
    await expect(page.locator('[data-default-changed="skill:docket-planner"]')).toHaveCount(0);
    await flag.getByRole('button', { name: /^Compare/ }).click();
    const v = view(page);
    await expect(
      v.getByText('Docket’s version changed since the default was edited.'),
    ).toBeVisible();
    // The edit is kept and still applies.
    await expect(
      v.getByText('Every project uses this default, unless it has its own copy.'),
    ).toBeVisible();
    const diff = v.locator('[data-diff]');
    await expect(
      diff.locator('[data-op="add"]').filter({ hasText: 'New in this release' }),
    ).toHaveCount(1);
    await expectAxeClean(page, 'Agent files: Docket’s version changed');

    // Recipe App: its copy is flagged "the default changed", with Compare.
    await chooseProject(page, 'Recipe App');
    const rcpFlag = page.locator('[data-default-changed="skill:docket-worker"]');
    await expect(rcpFlag).toContainText(
      'The default docket-worker changed since Recipe App’s copy was made.',
    );
    await expect(fileRow(page, 'skill:docket-planner')).toContainText('Default (edited)');
    await shoot(page, '5-project-default-changed', page.locator('.agent-files'));
    await rcpFlag.getByRole('button', { name: /^Compare/ }).click();
    const rv = view(page);
    await expect(
      rv.getByText('The default changed since Recipe App’s copy was made.'),
    ).toBeVisible();
    await expect(
      rv.locator('[data-diff] [data-op="add"]').filter({ hasText: 'New in this release' }),
    ).toHaveCount(1);
    await expectPlainWords(page);
    await shoot(page, '5-file-view-default-changed', rv);
    await expectAxeClean(page, 'Agent files: the default changed since the copy');
    await rv.getByRole('button', { name: 'The default → Recipe App’s copy' }).click();
    await expect(
      rv.locator('[data-diff] [data-op="add"]').filter({ hasText: 'RCP plans with Spec Kit' }),
    ).toHaveCount(1);
    // Kept: Recipe App's agents still get the copy.
    await expect(rv.getByText('Recipe App’s agents use Recipe App’s copy.')).toBeVisible();
  });
});

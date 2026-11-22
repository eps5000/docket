/**
 * First run (B32; UI_SPEC §6.0): a Docket with no projects.
 *
 * The file resets the sample seed, then deletes every project through the
 * owner API (deleted projects don't count), and checks:
 * - Needs you is the Welcome page: the three starts, "How Docket works",
 *   Help; Work, Agents and Agent files point back to it;
 * - the header's button is *+ New project*; *Import from Jira* opens the
 *   import with "New project" selected;
 * - creating the first project lands on its "What next" choices (Import
 *   from Jira, Onboard it with an agent, Install agent files) and switches
 *   to it;
 * - then *+ New item* is one click, with a caret menu (New item, New
 *   project), and the switcher ends with *+ New project*;
 * - axe in both themes on the Welcome page, both menus and the dialogs.
 *
 * It resets the seed again afterwards. Set DOCKET_E2E_SCREENSHOTS to a
 * folder to capture the PR's light and dark screenshots.
 */
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

useSeededContainer();
test.afterAll(async () => {
  test.setTimeout(120_000);
  await resetSeededContainer();
});

const out = process.env.DOCKET_E2E_SCREENSHOTS;

async function shoot(page: Page, name: string, target?: Locator, wholeDialog = false) {
  if (!out) return;
  // A dialog whole, not just its scrolled viewport.
  if (wholeDialog && target) {
    await target.evaluate((el) => {
      (el as HTMLElement).style.maxHeight = 'none';
      (el.parentElement as HTMLElement).style.position = 'absolute';
    });
  }
  for (const theme of ['light', 'dark'] as const) {
    await setTheme(page, theme);
    const path = join(out, `us17-${name}-${theme}.png`);
    if (target) await target.screenshot({ path });
    else await page.screenshot({ path, fullPage: true });
  }
  await setTheme(page, 'light');
  if (wholeDialog && target) {
    await target.evaluate((el) => {
      (el as HTMLElement).style.maxHeight = '';
      (el.parentElement as HTMLElement).style.position = '';
    });
  }
}

/** The owner's API from the page's context (the CSRF cookie first; decision 32). */
async function owner(page: Page, method: 'GET' | 'DELETE', path: string, data?: unknown) {
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

test.describe('First run (UI_SPEC §6.0)', () => {
  test('no projects: the Welcome page, the pointers, then the first project and its choices', async ({
    ownerPage: page,
  }) => {
    test.setTimeout(180_000);
    await page.context().addInitScript(() => localStorage.setItem('docket.notifications', 'off'));
    const boot = (await owner(page, 'GET', '/api/bootstrap')) as { projects: { key: string }[] };
    for (const p of boot.projects) {
      await owner(page, 'DELETE', `/api/projects/${p.key}`, { confirm_key: p.key });
    }

    // Overview is the Welcome page.
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Welcome to Docket');
    await expect(page.getByText('The shared record your AI agents work from.')).toBeVisible();
    const starts = page.getByRole('list', { name: 'Ways to start' });
    await expect(starts.getByRole('heading', { level: 2 })).toHaveText([
      'Create a project',
      'Import from Jira',
      'Onboard a repo with an agent',
    ]);
    await expect(
      page.getByText('Onboard this repo into Docket as project <KEY>, using onboard_project.'),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'Connect an agent' })).toHaveAttribute(
      'href',
      '/help/connect-an-agent',
    );
    await expect(page.getByText('How Docket works:')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Help: Your first look around' })).toBeVisible();
    await expect(page.getByRole('button', { name: '+ New project' })).toHaveAttribute(
      'title',
      'Create your first project',
    );
    await expectAxeClean(page, 'Welcome');
    await shoot(page, 'welcome');

    // Work, Agents and Agent files point back to it.
    for (const path of ['/work', '/agents', '/agent-files']) {
      await page.goto(path);
      await expect(page.getByText('No projects yet.', { exact: false })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Start on the Welcome page' })).toHaveAttribute(
        'href',
        '/',
      );
    }
    await expectAxeClean(page, 'Agent files with no projects');
    await page.goto('/work');
    await shoot(page, 'work-pointer');

    // Import from Jira: the import, with "New project" selected.
    await page.goto('/');
    await page.getByRole('button', { name: 'Import from Jira…' }).click();
    const jira = page.getByRole('dialog', { name: 'Import from Jira' });
    await expect(jira).toBeVisible();
    await expect(jira.getByRole('button', { name: 'New project', pressed: true })).toBeVisible();
    await jira.getByRole('button', { name: 'Cancel' }).click();
    await expect(jira).toHaveCount(0);

    // Create a project → its "What next" choices.
    await page.getByRole('button', { name: 'New project', exact: true }).click();
    const create = page.getByRole('dialog', { name: 'New project' });
    await create.getByLabel('Key').fill('GF');
    await create.getByLabel('Name').fill('Gameflow');
    await create.getByRole('button', { name: 'Create project' }).click();
    const next = page.getByRole('dialog', { name: 'Gameflow created' });
    await expect(next.getByRole('heading', { level: 3 })).toHaveText('What next');
    await expect(next.getByRole('heading', { level: 4 })).toHaveText([
      'Import from Jira',
      'Onboard it with an agent',
      'Install agent files',
    ]);
    await expect(
      next.getByText('Onboard this repo into Docket as project GF, using onboard_project.'),
    ).toBeVisible();
    await expect(next.getByRole('link', { name: 'Install agent files' })).toHaveAttribute(
      'href',
      '/agent-files?project=GF',
    );
    await expectAxeClean(page, 'New project · what next', { include: '.dlg' });
    await shoot(page, 'what-next', next, true);
    // The first project becomes the scope.
    await expect(page.locator('.scopebtn')).toContainText('Gameflow');
    await next.getByRole('button', { name: 'Done' }).click();

    // Now: the Welcome page is gone, and + New item is one click with a caret.
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Overview');
    const newItem = page.getByRole('button', { name: '+ New item' });
    await expect(newItem).toHaveAttribute('title', 'New item: capture it in Inbox');
    await page.getByRole('button', { name: 'More to create' }).click();
    const menu = page.getByRole('menu', { name: 'Create' });
    await expect(menu.getByRole('menuitem')).toHaveCount(2);
    await expect(menu.getByRole('menuitem').first()).toBeFocused();
    await expectAxeClean(page, 'Header · + New item menu');
    await shoot(page, 'new-item-menu', page.locator('header.top'));
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog', { name: 'New project' })).toBeVisible();
    await page
      .getByRole('dialog', { name: 'New project' })
      .getByRole('button', { name: 'Cancel' })
      .click();
    await newItem.click();
    await expect(page.getByRole('dialog', { name: 'New item in Inbox' })).toBeVisible();
    await page.keyboard.press('Escape');

    // The switcher ends with + New project, after a separator.
    await page.locator('.scopebtn').click();
    const switcher = page.getByRole('menu', { name: 'Choose project' });
    await expect(switcher.getByRole('separator')).toHaveCount(1);
    await expect(switcher.getByRole('menuitem', { name: 'New project' })).toBeVisible();
    await page.keyboard.press('End');
    await expect(switcher.getByRole('menuitem', { name: 'New project' })).toBeFocused();
    await expectAxeClean(page, 'Project switcher · + New project');
    await shoot(page, 'switcher-new-project', page.locator('.side'));
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog', { name: 'New project' })).toBeVisible();
  });
});

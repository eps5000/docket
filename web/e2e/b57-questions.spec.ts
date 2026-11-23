/**
 * Questions the owner can read (owner decision 47; UI_SPEC §6.1, §6.3).
 *
 * A question at the contract's real lengths, on Overview's Needs you and on
 * the ticket: the recommendation in two actions, the keyboard, Something
 * else, Undo, delivery to a text-only client, and axe in both themes at
 * 1440 x 900 and 1024 px. All content is synthetic.
 *
 * Set DOCKET_E2E_SCREENSHOTS to a folder to capture the PR's evidence.
 */
import { join } from 'node:path';
import type { Page } from '@playwright/test';
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

/** Real length: a full background, three options and long consequences. */
const LONG = {
  question:
    'When someone opens a shared meal plan, should they see the original portions or the portions they usually cook for themselves?',
  context:
    'People can send a weekly meal plan to a friend or family member. Today the plan always opens with the portions the sender chose, so someone who cooks for two can receive a plan written for six and has to change every recipe by hand. We can adjust the plan when it opens, but then two people looking at the same plan may see different amounts and could be confused when they talk about it. Shopping lists are built from these portions, so the choice also changes how much food people buy.',
  why_it_matters:
    'This changes what people see and buy, and it sets what "sharing a plan" means in the product. It needs your call because either answer is reasonable and it is awkward to change once people rely on it.',
  options: [
    {
      label: 'Use their usual portions',
      description:
        'The plan opens scaled to the portions this person normally cooks, with a small notice saying it was adjusted and a way to see the original.',
      consequences:
        'Most people can cook and shop straight away. The downside is that two people can see different amounts for the same plan, so a conversation about it may need the notice to make sense.',
      recommended: true,
    },
    {
      label: 'Keep the original portions',
      description:
        'Everyone sees exactly what the sender wrote, and anyone who wants different amounts changes them after opening the plan.',
      consequences:
        'Everyone always sees the same numbers. The downside is extra work for most people, and a shopping list made without adjusting could buy far too much food.',
    },
    {
      label: 'Ask each time',
      description:
        'The first time someone opens a shared plan, they choose between the original portions and their usual portions.',
      consequences:
        'Nobody is surprised by the amounts. The downside is one more step before anyone can see the plan, and many people will dismiss it without reading.',
    },
  ],
  recommendation_reason:
    'Most shared plans are opened to cook from, so starting with amounts that fit the person saves the most work, and the notice keeps the difference visible.',
  details:
    'Follows dec_01JB7Q. Touches server/src/domain/plans.ts and web/src/routes/plans/SharedPlan.tsx. Last checked at commit 4be1c09.',
};

const VIEWPORTS = [
  { name: '1440', width: 1440, height: 900 },
  { name: '1024', width: 1024, height: 768 },
] as const;

const toast = (page: Page, text: string | RegExp) =>
  page.locator('.toast').filter({ hasText: text });

async function shoot(page: Page, name: string) {
  if (!out) return;
  for (const theme of ['light', 'dark'] as const) {
    await setTheme(page, theme);
    await page.screenshot({ path: join(out, `b57-${name}-${theme}.png`) });
  }
  await setTheme(page, 'light');
}

/** The dialog's body scrolls inside it and nothing overflows the page. */
async function expectDialogFits(page: Page) {
  const box = await page.locator('.dlg').boundingBox();
  const vp = page.viewportSize()!;
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(vp.width);
  expect(box!.y + box!.height).toBeLessThanOrEqual(vp.height);
  await expect(
    page.locator('.dlg footer').getByRole('button', { name: 'Send answer' }),
  ).toBeInViewport();
  const overflow = await page.evaluate(() => {
    const body = document.querySelector<HTMLElement>('.dlg .body')!;
    return {
      page: document.documentElement.scrollWidth > window.innerWidth,
      body: body.scrollWidth > body.clientWidth,
    };
  });
  expect(overflow).toEqual({ page: false, body: false });
}

let codex: McpAgent;
test.beforeEach(async () => {
  codex = await connectAgent('codex');
});
test.afterEach(async () => {
  await codex.close();
});

async function ask(id: string) {
  const claim = await codex.call('claim_lead', { id, agent_label: 'e2e-w7' });
  expect(claim.isError, claim.text).toBe(false);
  const run_id = claim.structured.run_id as string;
  const asked = await codex.call('ask_owner', { id, run_id, ...LONG });
  expect(asked.isError, asked.text).toBe(false);
  return run_id;
}

test('a real-length question: card and dialog at both sizes, axe, the recommendation in two actions, Undo', async ({
  ownerPage: page,
}) => {
  const run_id = await ask('RCP-17');
  const answerName = 'Answer codex · e2e-w7 on RCP-17';

  for (const vp of VIEWPORTS) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.goto('/');
    const row = page.locator('[data-row="question"][data-item="RCP-17"]');
    await expect(row).toContainText(LONG.question.slice(0, 40));
    await expect(row.locator('.q-rec')).toContainText('Use their usual portions');
    await row.scrollIntoViewIfNeeded();
    await shoot(page, `card-${vp.name}`);
    await expectAxeClean(page, `question card ${vp.name}`, { include: '[data-card="for-you"]' });

    await row.getByRole('button', { name: answerName }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('radio', { name: /Use their usual portions/ })).toBeFocused();
    await expectDialogFits(page);
    await shoot(page, `modal-${vp.name}`);
    await expectAxeClean(page, `answer dialog ${vp.name}`, { include: '.dlg' });
    // Clicking inside the dialog doesn't trigger the row's "open the item".
    await dialog.getByText('Why this matters').click();
    await expect(page).toHaveURL(/\/$/);
    await page.keyboard.press('Escape');
    await expect(row.getByRole('button', { name: answerName })).toBeFocused();
  }

  // Technical details stay collapsed until asked for.
  await page.setViewportSize({ width: 1440, height: 900 });
  const row = page.locator('[data-row="question"][data-item="RCP-17"]');
  await row.getByRole('button', { name: answerName }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('dec_01JB7Q')).toBeHidden();
  await dialog.getByText('Technical details').click();
  await expect(dialog.getByText(/dec_01JB7Q/)).toBeVisible();
  await expectAxeClean(page, 'answer dialog with details', { include: '.dlg' });
  await page.keyboard.press('Escape');

  // Two actions: Answer, then Enter on the recommended option.
  await row.getByRole('button', { name: answerName }).click();
  await expect(dialog.getByRole('radio', { name: /Use their usual portions/ })).toBeFocused();
  await page.keyboard.press('Enter');
  const posted = toast(page, 'Answer posted to RCP-17');
  await expect(posted).toBeVisible();
  await expect(row).toHaveCount(0);

  // Undo puts the question back, unread and unanswered.
  await posted.getByRole('button', { name: 'Undo' }).click();
  await expect(row).toBeVisible();

  // Send it again: the agent receives it once.
  await row.getByRole('button', { name: answerName }).click();
  await dialog.getByRole('button', { name: 'Send answer' }).click();
  await expect(row).toHaveCount(0);
  const got = await codex.call('get_item', { id: 'RCP-17', run_id });
  expect(got.structured.item).toMatchObject({
    open_question: {
      answer: 'Chose: Use their usual portions (the recommended option)',
      choice: { option: 'Use their usual portions', recommended: true, note: null },
    },
  });
  const again = await codex.call('get_item', { id: 'RCP-17', run_id });
  expect(again.structured.item).toMatchObject({ open_question: null });
});

test('the ticket: keyboard to another option with a note, and a text-only client sees it', async ({
  ownerPage: page,
}) => {
  const textOnly = await connectAgent('claude-code');
  try {
    // An Inbox item with no lead: asking needs no claim.
    const asked = await textOnly.call('ask_owner', { id: 'RCP-20', ...LONG });
    expect(asked.isError, asked.text).toBe(false);

    await page.goto('/items/RCP-20');
    const banner = page.locator('[data-banner="question"]');
    await expect(banner.locator('.q-rec')).toContainText('Use their usual portions');
    await banner.getByRole('button', { name: /^Answer/ }).click();
    const dialog = page.getByRole('dialog');
    await page.keyboard.press('ArrowDown');
    await expect(dialog.getByRole('radio', { name: /Keep the original portions/ })).toBeChecked();
    await page.keyboard.press('Tab');
    await expect(dialog.getByLabel('Add a note (optional)')).toBeFocused();
    await page.keyboard.type('Sharing should stay simple.');
    await page.keyboard.press('Control+Enter');
    await expect(page.locator('.callout.answered')).toContainText(
      'Chose: Keep the original portions. Note: Sharing should stay simple.',
    );

    const got = await textOnly.call('get_item', { id: 'RCP-20' });
    expect(got.text).toContain(
      'answer: Chose: Keep the original portions. Note: Sharing should stay simple.',
    );
  } finally {
    await textOnly.close();
  }
});

test('Something else: needs text, then goes as a free-text answer', async ({ ownerPage: page }) => {
  const asked = await codex.call('ask_owner', { id: 'RCP-16', ...LONG });
  expect(asked.isError, asked.text).toBe(false);
  await page.goto('/items/RCP-16');
  await page
    .locator('[data-banner="question"]')
    .getByRole('button', { name: /^Answer/ })
    .click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('radio', { name: /Something else/ }).check();
  await expect(dialog.getByLabel('Add a note (optional)')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Send answer' }).click();
  await expect(toast(page, 'Write your answer first.')).toBeVisible();
  await expect(dialog.getByLabel('Your answer')).toBeFocused();
  await expectAxeClean(page, 'Something else', { include: '.dlg' });
  await dialog.getByLabel('Your answer').fill('Show both amounts side by side.');
  await dialog.getByRole('button', { name: 'Send answer' }).click();
  await expect(page.locator('.callout.answered')).toContainText('Show both amounts side by side.');
  const got = await codex.call('get_item', { id: 'RCP-16' });
  const q = (got.structured.item as { open_question: Record<string, unknown> }).open_question;
  expect(q.answer).toBe('Show both amounts side by side.');
  expect(q).not.toHaveProperty('choice');
});

test('an older question keeps its inline answer box', async ({ ownerPage: page }) => {
  await page.goto('/items/DOC-4');
  const banner = page.locator('[data-banner="question"]');
  await expect(banner).toContainText('Should nutrition values be documented per serving');
  await expect(banner.getByLabel('Your answer')).toBeVisible();
  await expect(banner.locator('.q-rec')).toHaveCount(0);
  await expect(banner.getByRole('button', { name: 'Send answer' })).toBeVisible();
});

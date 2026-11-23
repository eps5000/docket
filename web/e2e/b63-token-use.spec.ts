/**
 * B63 (owner decision 48): token use. Off by default with the owner's note in
 * Settings, a real turn reaching its ticket through the sync route, then every
 * view on the stress data with axe in both themes at 1440 and 1024 px, plus the
 * PR's screenshots (DOCKET_E2E_SCREENSHOTS). All fixture text is made up.
 */
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import type {
  UsageBucket,
  UsageCost,
  UsageItemResponse,
  UsageSettingsResponse,
  UsageSummaryResponse,
  UsageTokens,
} from '@docket/shared';
import { mockGet } from './fixtures/api-mocks';
import {
  connectAgent,
  expect,
  expectAxeClean,
  setTheme,
  test,
  unlock,
  useSeededContainer,
} from './fixtures';

useSeededContainer();

const out = process.env.DOCKET_E2E_SCREENSHOTS;
const SIZES = [
  { name: '1440', width: 1440, height: 900 },
  { name: '1024', width: 1024, height: 768 },
] as const;
const TITLE = 'Measure token use from local agent logs';
const AT = '2026-11-23T10:00:00.000Z';
const RUN = { ok: true, interval_ms: 300_000 };

test.beforeEach(async ({ page }) => {
  await unlock(page.context());
  await page.context().addInitScript(() => localStorage.setItem('docket.notifications', 'off'));
});

const setSource = async (page: Page, enabled: boolean) => {
  const res = await page.request.put('/api/usage/settings', {
    data: { enabled, coordinator_folders: [] },
  });
  expect(res.ok()).toBe(true);
};

async function noSideScroll(page: Page) {
  const over = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(over).toBeLessThanOrEqual(0);
}

const tokens = (k = 1): UsageTokens => ({
  fresh_input: 41_200 * k,
  cached_input: 18_400_000 * k,
  cache_write: 612_000 * k,
  output: 96_300 * k,
});
const priced = (usd: number): UsageCost => ({ usd, unpriced_tokens: 0, unpriced_models: [] });
const bucket = (k: number, usd: number): UsageBucket => ({
  tokens: tokens(k),
  cost: priced(usd),
  turns: Math.round(420 * k),
  sessions: Math.max(1, Math.round(9 * k)),
});

const ticket = (id: string, title: string, k: number, usd: number) => ({
  id,
  title,
  project: 'STR',
  status: 'progress' as const,
  tokens: tokens(k),
  cost: priced(usd),
});

const SUMMARY: UsageSummaryResponse = {
  enabled: true,
  prices_as_of: '2026-11-23',
  last_turn_at: AT,
  from: '2026-11-16T10:00:00.000Z',
  to: AT,
  total: {
    ...bucket(1, 18.64),
    cost: {
      usd: 18.64,
      unpriced_tokens: 12_400,
      unpriced_models: ['a-model-with-no-listed-price'],
    },
  },
  linked: bucket(0.72, 13.4),
  overhead: bucket(0.19, 3.6),
  unlinked: bucket(0.09, 1.64),
  linked_pct: 72,
  models: [],
  top_tickets: {
    count: 7,
    rows: [
      ticket(
        'STR-40',
        'A long synthetic ticket title that has to truncate on a narrow page',
        0.3,
        5,
      ),
      ticket('STR-41', 'Second synthetic ticket', 0.2, 3.2),
      ticket('STR-42', 'Third synthetic ticket', 0.1, 2),
    ],
  },
};

const ITEM: UsageItemResponse = {
  enabled: true,
  prices_as_of: '2026-11-23',
  last_turn_at: AT,
  item_id: 'STR-3',
  rollup: true,
  total: bucket(1, 18.64),
  models: [
    { model: 'claude-opus-5-5', tokens: tokens(0.7), cost: priced(14.1), turns: 290 },
    { model: 'gpt-5.5', tokens: tokens(0.25), cost: priced(4.54), turns: 110 },
    {
      model: 'a-model-with-no-listed-price',
      tokens: tokens(0.05),
      cost: {
        usd: null,
        unpriced_tokens: 12_400,
        unpriced_models: ['a-model-with-no-listed-price'],
      },
      turns: 20,
    },
  ],
  sessions: {
    count: 14,
    rows: Array.from({ length: 12 }, (_, i) => ({
      session_id: `sess-synthetic-${i}`,
      client: i % 3 === 0 ? ('codex' as const) : ('claude-code' as const),
      first_at: AT,
      last_at: AT,
      turns: 30 + i,
      models: ['claude-opus-5-5'],
      tokens: tokens(0.06),
      cost: priced(1.1),
    })),
  },
  children: [
    ticket('STR-40', 'A long synthetic ticket title that has to truncate on a narrow page', 0.4, 7),
    ticket('STR-41', 'Second synthetic ticket', 0.3, 6),
    ticket('STR-42', 'Third synthetic ticket', 0.2, 4),
  ],
};

const SETTINGS: UsageSettingsResponse = {
  enabled: true,
  coordinator_folders: [
    { project: 'STR', path: 'c:/work/a-long-synthetic-path/that-needs-truncating/coordinator' },
  ],
  helper: 'running',
  last_read_at: new Date().toISOString(),
  turns_stored: 4210,
};

async function withData(page: Page) {
  await mockGet(page, '/api/usage', SUMMARY);
  await mockGet(page, '/api/usage/items/STR-3', ITEM);
  await mockGet(page, '/api/usage/settings', SETTINGS);
}

test.describe.serial('the real source', () => {
  test('is off by default, shows the note, and nothing else appears', async ({ page }) => {
    await page.goto('/settings');
    const toggle = page.getByRole('switch', { name: TITLE });
    await expect(toggle).not.toBeChecked();
    const card = page.locator('[data-card="usage-source"]');
    await expect(card.locator('[data-usage-status]')).toHaveText('Off');
    await expect(card.locator('[data-usage-note]')).toContainText(
      'which include your conversations with those agents',
    );
    await expect(card).toContainText('Counts already collected stay in Docket');

    await page.goto('/');
    await expect(page.locator('[data-card="flow-chart"]')).toBeVisible();
    await expect(page.locator('[data-card="token-use"]')).toHaveCount(0);
    await page.goto('/brief');
    await expect(page.locator('[data-brief-section="finished"]')).toBeVisible();
    await expect(page.locator('[data-brief-section="cost"]')).toHaveCount(0);
    await page.goto('/items/RCP-17?tab=details');
    await expect(page.locator('[data-section="outcome"]')).toBeVisible();
    await expect(page.locator('[data-section="token-use"]')).toHaveCount(0);
  });

  test('the switch works by keyboard and says the helper isn’t running', async ({ page }) => {
    await page.goto('/settings');
    const toggle = page.getByRole('switch', { name: TITLE });
    await toggle.focus();
    await page.keyboard.press('Space');
    const status = page.locator('[data-usage-status]');
    await expect(status).toHaveAttribute('data-usage-status', 'not_running');
    await expect(status).toContainText('the helper isn’t running');
    await expect(toggle).toBeChecked();
    await expect(toggle).toBeFocused();
    await page.keyboard.press('Space');
    await expect(status).toHaveText('Off');
    await expect(toggle).not.toBeChecked();
  });

  test('a turn reaches its ticket, and a folder Docket doesn’t know is refused', async ({
    page,
  }) => {
    await page.goto('/');
    await setSource(page, true);
    const agent = await connectAgent('claude-agent-sdk');
    let runId: string | null = null;
    try {
      const claim = await agent.call('claim_lead', {
        id: 'RCP-17',
        agent_label: 'b63-w1',
        workspace: { path: 'C:\\Work\\B63-Usage\\', branch: 'b63-usage' },
      });
      expect(claim.isError, claim.text).toBe(false);
      runId = claim.structured.run_id as string;
      const config = (await (await page.request.get('/api/sync/usage')).json()) as {
        settings: { enabled: boolean; workspaces: string[] };
      };
      expect(config.settings.enabled).toBe(true);
      expect(config.settings.workspaces).toContain('c:/work/b63-usage');

      const record = {
        // Per attempt, so a retry is a new turn.
        key: `claude-code:msg_b63_e2e_${test.info().retry}`,
        client: 'claude-code',
        session_id: 'sess-b63-e2e',
        // After the claim, and not in the future, or the window would leave it out.
        at: new Date().toISOString(),
        workspace: 'c:/work/b63-usage',
        model: 'claude-opus-5-5',
        fresh_input: 1200,
        cached_input: 340_000,
        cache_write: 5000,
        cache_write_1h: 0,
        output: 800,
      };
      const sent = await page.request.post('/api/sync/usage', {
        data: {
          records: [
            record,
            { ...record, key: 'claude-code:msg_b63_other', workspace: 'c:/private/not-known' },
          ],
          run: RUN,
        },
      });
      expect(await sent.json()).toEqual({ accepted: 1, changed: 1, ignored: 1 });
      const extra = await page.request.post('/api/sync/usage', {
        data: { records: [{ ...record, content: 'PLANTED' }], run: RUN },
      });
      expect(extra.status()).toBe(400);

      await page.goto('/items/RCP-17?tab=details');
      const section = page.locator('[data-section="token-use"]');
      await expect(section.locator('[data-usage-kind="cached_input"]')).toContainText('340K');
      await expect(section.locator('[data-usage-kind="fresh_input"]')).toContainText('1.2K');
      await expect(section.locator('[data-usage-cost]')).toContainText('API-equivalent estimate');
      await expect(section).toContainText('A subscription plan may cost less.');

      await page.goto('/');
      await expect(page.locator('[data-card="token-use"]')).toContainText('100% linked');
    } finally {
      if (runId) {
        await agent.call('finish_run', { run_id: runId, result: 'finished', summary: 'Done.' });
      }
      await agent.close();
      await setSource(page, false);
    }
    await page.goto('/items/RCP-17?tab=details');
    await expect(page.locator('[data-section="outcome"]')).toBeVisible();
    await expect(page.locator('[data-section="token-use"]')).toHaveCount(0);
  });
});

for (const size of SIZES) {
  test(`axe and layout at ${size.name} on the stress data`, async ({ page }) => {
    await page.setViewportSize({ width: size.width, height: size.height });
    await withData(page);

    await page.goto('/');
    const card = page.locator('[data-card="token-use"]');
    await expect(card).toContainText('72% linked to tickets');
    await expect(card).toContainText('not linked to a ticket');
    await noSideScroll(page);
    await expectAxeClean(page, `Overview token use: ${size.name}`);

    await page.goto('/brief');
    const cost = page.locator('[data-brief-section="cost"]');
    await expect(cost).toContainText('API-equivalent estimate');
    await expect(cost.getByRole('link', { name: /STR-40/ })).toBeVisible();
    await noSideScroll(page);
    await expectAxeClean(page, `Brief cost: ${size.name}`);

    await page.goto('/items/STR-3?tab=details');
    const section = page.locator('[data-section="token-use"]');
    await expect(section.getByRole('region', { name: 'Token use by ticket' })).toBeVisible();
    await expect(section.getByRole('row', { name: /no-listed-price/ })).toContainText(
      'Not available',
    );
    await noSideScroll(page);
    await expectAxeClean(page, `Epic token use: ${size.name}`);

    await page.goto('/settings');
    await expect(page.locator('[data-usage-status]')).toHaveAttribute(
      'data-usage-status',
      'running',
    );
    await noSideScroll(page);
    await expectAxeClean(page, `Settings token use: ${size.name}`);
  });
}

test.describe('screenshots', () => {
  test.skip(!out, 'Set DOCKET_E2E_SCREENSHOTS to a folder to capture screenshots.');

  async function shoot(page: Page, name: string, size: (typeof SIZES)[number]) {
    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme);
      await page.screenshot({ path: join(out!, `b63-${name}-${size.name}-${theme}.png`) });
    }
  }

  for (const size of SIZES) {
    test(`token use at ${size.name}`, async ({ page }) => {
      await page.setViewportSize({ width: size.width, height: size.height });

      await page.goto('/settings');
      const off = page.locator('[data-card="usage-source"]');
      await expect(off.locator('[data-usage-status]')).toHaveText('Off');
      await off.scrollIntoViewIfNeeded();
      await shoot(page, 'settings-off', size);

      await withData(page);
      await page.goto('/settings');
      const on = page.locator('[data-card="usage-source"]');
      await expect(on.locator('[data-usage-folders]')).toBeVisible();
      await on.scrollIntoViewIfNeeded();
      await shoot(page, 'settings-on', size);

      await page.goto('/');
      const card = page.locator('[data-card="token-use"]');
      await expect(card).toBeVisible();
      await card.scrollIntoViewIfNeeded();
      await shoot(page, 'overview', size);

      await page.goto('/brief');
      const cost = page.locator('[data-brief-section="cost"]');
      await expect(cost).toBeVisible();
      await cost.scrollIntoViewIfNeeded();
      await shoot(page, 'brief', size);

      await page.goto('/items/STR-3?tab=details');
      const section = page.locator('[data-section="token-use"]');
      await expect(section).toBeVisible();
      await section.scrollIntoViewIfNeeded();
      await shoot(page, 'epic', size);
    });
  }
});

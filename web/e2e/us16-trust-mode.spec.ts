/**
 * Trust mode, end to end (owner decision 32; BUILD_SPEC §3; T167).
 *
 * Local trust (the default run):
 * - the app opens with no unlock;
 * - an owner action made by a script (no browser headers) works, and Activity
 *   shows it as "owner (script: curl/8.4.0)";
 * - agents connect with no token; a foreign Origin is still refused.
 *
 * Protected mode (`@protected`, run with DOCKET_E2E_PROTECTED=1 against an
 * instance with DOCKET_PROTECTED_MODE=on):
 * - a new browser must unlock, and then an owner action works from it;
 * - a script without the session is refused;
 * - MCP needs the token: without it 401, with it `whoami` answers.
 */
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { baseURL } from './container';
import {
  connectAgent,
  expect,
  setTheme,
  test,
  unlockViaUi,
  useSeededContainer,
} from './fixtures/index';

useSeededContainer();

const out = process.env.DOCKET_E2E_SCREENSHOTS;
async function shoot(page: Page, name: string, target: Locator) {
  if (!out) return;
  for (const theme of ['light', 'dark'] as const) {
    await setTheme(page, theme);
    await target.screenshot({ path: join(out, `us16-${name}-${theme}.png`) });
  }
  await setTheme(page, 'light');
}

const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'e2e-trust', version: '0.0.0' },
  },
};
const MCP_HEADERS = { accept: 'application/json, text/event-stream' };

test.describe('local trust (decision 32)', () => {
  test('an owner action from a script shows in Activity as owner (script: curl/8.4.0)', async ({
    page,
    request,
  }) => {
    const res = await request.post('/api/items/RCP-14/notes', {
      headers: { 'user-agent': 'curl/8.4.0' },
      data: { text: 'Scripted: check the units table first.' },
    });
    expect(res.status(), await res.text()).toBe(200);
    await page.goto('/items/RCP-14?tab=activity');
    const row = page.locator('.act').filter({ hasText: 'owner (script: curl/8.4.0)' }).first();
    await expect(row).toBeVisible();
    await expect(row.locator('[data-owner-via="script"]')).toHaveText(
      '· owner (script: curl/8.4.0)',
    );
    await shoot(page, 'activity-owner-script', row.locator('xpath=ancestor::section[1]'));
  });

  test('agents connect without a token; a foreign Origin is still refused', async ({ request }) => {
    const mcp = await request.post('/mcp', { headers: MCP_HEADERS, data: INIT });
    expect(mcp.status()).toBe(200);
    const agent = await connectAgent('e2e-trust');
    expect((await agent.call('whoami')).isError).toBe(false);
    await agent.close();
    const foreign = await request.post('/api/items/RCP-14/notes', {
      headers: { origin: 'https://evil.example' },
      data: { text: 'From a website.' },
    });
    expect(foreign.status()).toBe(403);
    const foreignMcp = await request.post('/mcp', {
      headers: { ...MCP_HEADERS, origin: 'https://evil.example' },
      data: INIT,
    });
    expect(foreignMcp.status()).toBe(403);
    // A browser page without the CSRF header is refused too.
    const noCsrf = await request.post('/api/items/RCP-14/notes', {
      headers: { origin: baseURL, 'sec-fetch-site': 'same-origin' },
      data: { text: 'No CSRF.' },
    });
    expect(noCsrf.status()).toBe(403);
  });
});

test.describe('protected mode (decision 32)', () => {
  test('a new browser unlocks, then acts as the owner; a script without the session is refused @protected', async ({
    browser,
    request,
  }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto('/items/RCP-14?tab=activity');
    await expect(page).toHaveURL(/\/unlock\?next=/);
    await unlockViaUi(page);
    await expect(page).toHaveURL(/\/items\/RCP-14\?tab=activity$/);
    await page.getByPlaceholder(/Leave a note/).fill('From the browser, unlocked.');
    await page.getByRole('button', { name: 'Add note' }).click();
    await expect(page.getByText('From the browser, unlocked.').first()).toBeVisible();
    await expect(page.locator('[data-owner-via="script"]')).toHaveCount(0);
    await context.close();

    const script = await request.post('/api/items/RCP-14/notes', {
      headers: { 'user-agent': 'curl/8.4.0' },
      data: { text: 'Scripted.' },
    });
    expect(script.status()).toBe(401);
  });

  test('MCP needs the agent token @protected', async ({ request }) => {
    const none = await request.post('/mcp', { headers: MCP_HEADERS, data: INIT });
    expect(none.status()).toBe(401);
    const agent = await connectAgent('e2e-trust');
    const who = await agent.call('whoami');
    expect(who.isError).toBe(false);
    await agent.close();
  });
});

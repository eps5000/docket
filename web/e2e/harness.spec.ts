/**
 * The end-to-end harness itself (tasks.md T062): the MCP client helper talks
 * to /mcp with the official SDK, the unlock helper gives a context an owner
 * session, and the notification helper controls the permission.
 */
import {
  connectAgent,
  denyNotifications,
  expect,
  grantNotifications,
  lock,
  test,
  unlock,
  useSeededContainer,
} from './fixtures/index';

useSeededContainer();

test.describe('e2e harness', () => {
  test('the MCP client helper calls whoami through /mcp', async ({ agent }) => {
    const tools = await agent.listTools();
    expect(tools).toContain('whoami');
    expect(tools.length).toBe(38);

    const res = await agent.call('whoami');
    if (res.isError) {
      // whoami is still a stub until US1 (T076): the structured "not implemented" error proves the round trip.
      expect(res.structured).toMatchObject({ code: 'unavailable' });
      expect(String(res.structured.message)).toContain('whoami');
    } else {
      expect(res.structured).toHaveProperty('client');
    }
    console.log(`whoami via the MCP helper: ${res.isError ? 'tool error' : 'result'}: ${res.text}`);
  });

  test('two helpers are two agent sessions', async () => {
    const a = await connectAgent('codex');
    const b = await connectAgent('claude');
    expect(await a.listTools()).toEqual(await b.listTools());
    await a.close();
    await b.close();
  });

  test('the unlock helper gives a context an owner session, and lock ends it', async ({ page }) => {
    expect((await page.request.get('/api/bootstrap')).status()).toBe(401);
    await unlock(page.context());
    // Unlocked: the route answers (US2 built it), not 401.
    expect((await page.request.get('/api/bootstrap')).status()).toBe(200);
    await lock(page.context());
    expect((await page.request.get('/api/bootstrap')).status()).toBe(401);
  });

  test('the notification helper grants and denies the permission', async ({ browser }) => {
    const granted = await browser.newContext();
    await grantNotifications(granted);
    const p1 = await granted.newPage();
    await p1.goto('/unlock');
    expect(await p1.evaluate(() => Notification.permission)).toBe('granted');
    await granted.close();

    const denied = await browser.newContext();
    await denyNotifications(denied);
    const p2 = await denied.newPage();
    await p2.goto('/unlock');
    expect(await p2.evaluate(() => Notification.permission)).toBe('denied');
    expect(await p2.evaluate(() => Notification.requestPermission())).toBe('denied');
    await denied.close();
  });
});

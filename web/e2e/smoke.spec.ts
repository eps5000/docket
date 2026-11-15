import { expect, seriousViolations, test } from './fixtures';

test.describe('smoke', () => {
  test('the container is healthy and ready', async ({ request }) => {
    const health = await request.get('/healthz');
    expect(health.status()).toBe(200);
    expect(await health.text()).toBe('ok');

    const ready = await request.get('/readyz');
    expect(ready.status()).toBe(200);
    expect(await ready.json()).toMatchObject({ status: 'ready' });
  });

  test('the served HTML says Task Lite is running before JavaScript runs', async ({ request }) => {
    const res = await request.get('/');
    expect(res.status()).toBe(200);
    expect(await res.text()).toContain('Task Lite is running');
  });

  for (const colorScheme of ['light', 'dark'] as const) {
    test(`shows "Task Lite is running" with no serious axe violations (${colorScheme})`, async ({
      page,
      makeAxeBuilder,
    }) => {
      await page.emulateMedia({ colorScheme });
      await page.goto('/');
      await expect(
        page.getByRole('heading', { level: 1, name: 'Task Lite is running' }),
      ).toBeVisible();
      expect(seriousViolations(await makeAxeBuilder().analyze())).toEqual([]);
    });
  }

  test('the app mounts without errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    // React replaced the static placeholder, which is marked data-static.
    await expect(page.locator('#root main[data-static]')).toHaveCount(0);
    await expect(page.locator('#root main')).toHaveCount(1);
    expect(errors).toEqual([]);
  });

  test('client-side routes fall back to the app', async ({ page }) => {
    await page.goto('/work/board');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Task Lite is running' }),
    ).toBeVisible();
  });
});

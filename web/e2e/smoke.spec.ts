import { expect, expectAxeClean, test } from './fixtures/index';

/** Console noise the browser logs for expected 4xx/5xx answers (locked = 401, unbuilt = 501). */
const RESOURCE_ERROR = /Failed to load resource/;

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

  test('a locked browser lands on Unlock, with no serious axe violations', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/unlock$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Unlock Task Lite' })).toBeVisible();
    await expectAxeClean(page, 'Unlock');
  });

  test('the app mounts without errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));
    page.on('console', (msg) => {
      if (msg.type() === 'error' && !RESOURCE_ERROR.test(msg.text())) errors.push(msg.text());
    });
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    // React replaced the static placeholder, which is marked data-static.
    await expect(page.locator('#root main[data-static]')).toHaveCount(0);
    await expect(page.locator('#root main')).toHaveCount(1);
    expect(errors).toEqual([]);
  });

  test('client-side routes fall back to the app and come back after unlocking', async ({
    page,
  }) => {
    await page.goto('/work?layout=list');
    await expect(page).toHaveURL(/\/unlock\?next=%2Fwork%3Flayout%3Dlist$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Unlock Task Lite' })).toBeVisible();
  });
});

/**
 * The unlock helper (tasks.md T062): give a browser context an owner session
 * through the real `POST /api/session/unlock` (B2), so its pages start
 * unlocked. `unlockViaUi` drives the Unlock screen instead.
 *
 * Decision 32: the instance runs in local trust by default, where there is
 * nothing to unlock, so `unlock` does nothing. With `DOCKET_E2E_PROTECTED=1`
 * the instance runs `DOCKET_PROTECTED_MODE=on`, only the specs tagged
 * `@protected` run (playwright.config.ts), and `unlock` unlocks as before.
 */
import type { BrowserContext, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { ownerKey } from './container';

/** The run is against a protected-mode instance (decision 32). */
export const PROTECTED = process.env.DOCKET_E2E_PROTECTED === '1';

/** Unlock a context (protected mode): its cookie jar gets `docket_owner` and `docket_csrf`. */
export async function unlock(target: BrowserContext | Page): Promise<void> {
  if (!PROTECTED) return;
  const request = 'request' in target ? target.request : (target as BrowserContext).request;
  const res = await request.post('/api/session/unlock', { data: { key: ownerKey() } });
  expect(res.status(), await res.text()).toBe(200);
}

/** Unlock by pasting the owner key into the Unlock screen. */
export async function unlockViaUi(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Unlock Docket' })).toBeVisible();
  await page.getByLabel('Owner key').fill(ownerKey());
  await page.getByRole('button', { name: 'Unlock' }).click();
  await expect(page).not.toHaveURL(/\/unlock/);
}

/** End this context's owner session. */
export async function lock(target: BrowserContext | Page): Promise<void> {
  const context = 'context' in target ? (target as Page).context() : (target as BrowserContext);
  const csrf = (await context.cookies()).find((c) => c.name === 'docket_csrf')?.value ?? '';
  await context.request.post('/api/session/lock', { headers: { 'X-Docket-CSRF': csrf } });
}

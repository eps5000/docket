/**
 * The notification-permission helper (tasks.md T062; UI_SPEC §6.7a, used by
 * T079): grant or deny desktop notifications for the app's origin, and
 * record every `new Notification(...)` the page creates, so tests can assert
 * what notified without a real OS notification.
 */
import type { BrowserContext, Page } from '@playwright/test';
import { baseURL } from '../container';

export interface RecordedNotification {
  title: string;
  body?: string;
  tag?: string;
}

/** Let the app's origin show notifications. */
export async function grantNotifications(context: BrowserContext): Promise<void> {
  await context.grantPermissions(['notifications'], { origin: new URL(baseURL).origin });
  // Headless Chromium keeps `Notification.permission` at "denied" even when
  // granted, so make the page see what the permission says.
  await context.addInitScript(() => {
    const N = window.Notification;
    if (!N) return;
    Object.defineProperty(N, 'permission', { configurable: true, get: () => 'granted' });
    N.requestPermission = () => Promise.resolve('granted');
  });
}

/**
 * Make `Notification.permission` read `denied` and `requestPermission()`
 * resolve `denied` ("Blocked by the browser").
 */
export async function denyNotifications(context: BrowserContext): Promise<void> {
  await context.clearPermissions();
  await context.addInitScript(() => {
    const N = window.Notification;
    if (!N) return;
    Object.defineProperty(N, 'permission', { configurable: true, get: () => 'denied' });
    N.requestPermission = () => Promise.resolve('denied');
  });
}

/** Record notifications instead of showing them; read them with `recordedNotifications`. */
export async function recordNotifications(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const w = window as unknown as {
      __tlNotifications: { title: string; body?: string; tag?: string }[];
      Notification: typeof Notification;
    };
    w.__tlNotifications = [];
    const Real = w.Notification;
    if (!Real) return;
    class Recorder extends EventTarget {
      static get permission() {
        return Real.permission;
      }
      static requestPermission = Real.requestPermission.bind(Real);
      title: string;
      body?: string;
      tag?: string;
      onclick: ((this: Recorder, ev: Event) => unknown) | null = null;
      constructor(title: string, opts: NotificationOptions = {}) {
        super();
        this.title = title;
        this.body = opts.body;
        this.tag = opts.tag;
        w.__tlNotifications.push({ title, body: opts.body, tag: opts.tag });
      }
      close() {}
    }
    w.Notification = Recorder as unknown as typeof Notification;
  });
}

export async function recordedNotifications(page: Page): Promise<RecordedNotification[]> {
  return page.evaluate(
    () =>
      (window as unknown as { __tlNotifications?: RecordedNotification[] }).__tlNotifications ?? [],
  );
}

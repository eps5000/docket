/**
 * Desktop notifications and the tab title (UI_SPEC §6.7a; FR-068; T085).
 *
 * - **Opt-in:** off until the owner turns it on (Needs you callout or the
 *   Settings switch). The choice lives in `localStorage` (`tl.notifications`).
 * - **What notifies:** only new for-you events on the live stream
 *   (`for_you: true`: a packet submitted, a question asked). Nothing else.
 * - **One tab per browser:** the tab holding the Web Locks lock
 *   `tasklite-notifications` notifies; the others stay quiet. Seqs already
 *   notified are recorded in `localStorage` (`tl.notified`), so a seq never
 *   notifies twice in this browser, and a burst notifies once per item.
 * - **Already pending:** the stream starts at the current end on page load,
 *   so items that were already for you never notify.
 * - **Privacy:** generated here from the stream and `GET /api/needs-you`.
 *   Nothing leaves the machine.
 */
import type { ForYouRow, NeedsYouResponse } from '@docket/shared';
import type { StreamChange } from './api';
import { paths } from './paths';
import { readJson, readString, STORAGE_KEYS, writeJson, writeString } from './persistence';

// ---- Tab title ----

/** `(N) Task Lite`, or `Task Lite` when nothing is for you. Works with notifications off. */
export function tabTitle(forYou: number | undefined): string {
  return forYou && forYou > 0 ? `(${forYou}) Task Lite` : 'Task Lite';
}

// ---- Preference and permission ----

export type NotifyPref = 'on' | 'off';
export type Permission = 'granted' | 'denied' | 'default' | 'unsupported';

/** The owner's choice, or null before they made one (the callout shows then). */
export function readPref(): NotifyPref | null {
  const v = readString(STORAGE_KEYS.notifications);
  return v === 'on' || v === 'off' ? v : null;
}

export function writePref(pref: NotifyPref): void {
  writeString(STORAGE_KEYS.notifications, pref);
  listeners.forEach((fn) => fn());
}

const listeners = new Set<() => void>();
/** Called when the preference changes in this tab (other tabs get a `storage` event). */
export function onPrefChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function permission(): Permission {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
  return window.Notification.permission as Permission;
}

/** The Settings status line (UI_SPEC §6.7). */
export function statusLine(pref: NotifyPref | null, perm: Permission, host: string): string {
  if (perm === 'denied') {
    return `Blocked by the browser. Allow notifications for ${host} in your browser settings.`;
  }
  if (perm === 'unsupported') return 'This browser can’t show desktop notifications.';
  return pref === 'on' && perm === 'granted' ? 'On' : 'Off';
}

/** *Turn on*: ask the browser, and remember the answer. */
export async function turnOn(): Promise<Permission> {
  if (permission() === 'unsupported') return 'unsupported';
  let perm = permission();
  if (perm === 'default') {
    try {
      perm = (await window.Notification.requestPermission()) as Permission;
    } catch {
      perm = permission();
    }
  }
  writePref(perm === 'granted' ? 'on' : 'off');
  return perm;
}

export function turnOff(): void {
  writePref('off');
}

// ---- What a notification says (UI_SPEC §6.7a) ----

export interface NotificationText {
  title: string;
  body: string;
  /** Where a click goes: the packet, or the item's question. */
  path: string;
  /** One OS notification per item and kind. */
  tag: string;
}

const truncate = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;

export function notificationFor(row: ForYouRow): NotificationText {
  if (row.kind === 'packet') {
    return {
      title: `Handoff ready: ${row.item_id} ${row.title}`,
      body: `${row.to_verify} ${row.to_verify === 1 ? 'thing' : 'things'} to verify · about ${row.estimate}`,
      path: paths.review(row.item_id),
      tag: `tl-packet-${row.item_id}`,
    };
  }
  const asker = row.asked_by.split(' · ')[0] ?? row.asked_by;
  return {
    title: `${asker} asks on ${row.item_id}`,
    body: truncate(row.text, 120),
    path: paths.item(row.item_id),
    tag: `tl-question-${row.item_id}`,
  };
}

// ---- Dedupe ----

/** Seqs kept in `tl.notified` (the newest; older ones can't come back on the stream). */
const NOTIFIED_KEEP = 200;
/** A burst on one item notifies once (UI_SPEC §6.7a). */
export const BURST_MS = 30_000;

export function alreadyNotified(seq: number): boolean {
  return readJson<number[]>(STORAGE_KEYS.notified, []).includes(seq);
}

export function markNotified(seq: number): void {
  const seen = readJson<number[]>(STORAGE_KEYS.notified, []);
  if (seen.includes(seq)) return;
  writeJson(STORAGE_KEYS.notified, [...seen, seq].slice(-NOTIFIED_KEEP));
}

// ---- The notifier ----

export interface NotifierDeps {
  /** A fresh Needs you for all projects (the row says what to show). */
  fetchNeedsYou: () => Promise<NeedsYouResponse>;
  /** Go to a path in this tab. */
  navigate: (path: string) => void;
  now?: () => number;
}

/**
 * Turns for-you stream changes into desktop notifications, in the one tab
 * that claimed the job. `start()` claims (Web Locks, held until `stop()`).
 */
export class Notifier {
  private claimed = false;
  private release: (() => void) | null = null;
  private readonly recent = new Map<string, number>();
  private readonly deps: NotifierDeps;

  constructor(deps: NotifierDeps) {
    this.deps = deps;
  }

  get isClaimed(): boolean {
    return this.claimed;
  }

  start(): void {
    const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
    if (!locks) {
      // No Web Locks: every tab notifies, and the seq record still dedupes.
      this.claimed = true;
      return;
    }
    void locks
      .request('tasklite-notifications', { mode: 'exclusive' }, () => {
        this.claimed = true;
        return new Promise<void>((resolve) => {
          this.release = resolve;
        });
      })
      .catch(() => {});
  }

  stop(): void {
    this.claimed = false;
    this.release?.();
    this.release = null;
  }

  async handle(change: StreamChange): Promise<NotificationText | null> {
    if (!change.for_you || !this.claimed) return null;
    if (readPref() !== 'on' || permission() !== 'granted') return null;
    if (alreadyNotified(change.seq)) return null;
    markNotified(change.seq);
    const kind = change.type === 'packet.submitted' ? 'packet' : 'question';
    const itemIds = change.objects.filter((o) => o.kind === 'item').map((o) => o.id);
    const now = (this.deps.now ?? Date.now)();
    let rows: ForYouRow[];
    try {
      rows = (await this.deps.fetchNeedsYou()).for_you_now;
    } catch {
      return null;
    }
    const row = rows.find((r) => r.kind === kind && itemIds.includes(r.item_id));
    if (!row) return null; // Already handled (answered, decided) by the time we looked.
    const key = `${row.kind}:${row.item_id}`;
    const last = this.recent.get(key);
    if (last !== undefined && now - last < BURST_MS) return null;
    this.recent.set(key, now);
    const text = notificationFor(row);
    try {
      const n = new window.Notification(text.title, { body: text.body, tag: text.tag });
      n.onclick = () => {
        window.focus();
        this.deps.navigate(text.path);
        n.close();
      };
    } catch {
      return null;
    }
    return text;
  }
}

/** *Send a test notification* (Settings). True when the browser accepted it. */
export function sendTestNotification(): boolean {
  if (permission() !== 'granted') return false;
  try {
    new window.Notification('Task Lite notifications are on', {
      body: 'You’ll see one when a handoff is ready or an agent asks you something.',
      tag: 'tl-test',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Live updates (UI_SPEC §7; FR-063; T086).
 *
 * - **Connection:** the stream disconnected for more than 10 s shows
 *   "Reconnecting to the service…"; after 60 s, "Service unreachable.
 *   Changes you make won't be saved." and write actions are disabled.
 * - **Focus is kept across re-renders:** queries refetch in place, so the
 *   focused control normally survives. When a refetch does replace it (a
 *   list re-keyed, a row re-mounted), the same control, found by a stable
 *   key, gets focus back with its caret, without scrolling.
 */
import type { QueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

// ---- Connection ----

export type Connection = 'ok' | 'reconnecting' | 'unreachable';

export const RECONNECTING_AFTER_MS = 10_000;
export const UNREACHABLE_AFTER_MS = 60_000;

/** The banner state for a stream that has been down since `downSince` (null: up). */
export function connectionFor(downSince: number | null, now: number): Connection {
  if (downSince === null) return 'ok';
  const down = now - downSince;
  if (down > UNREACHABLE_AFTER_MS) return 'unreachable';
  if (down > RECONNECTING_AFTER_MS) return 'reconnecting';
  return 'ok';
}

export const CONNECTION_TEXT: Record<Exclude<Connection, 'ok'>, string> = {
  reconnecting: 'Reconnecting to the service…',
  unreachable: 'Service unreachable. Changes you make won’t be saved.',
};

/**
 * Track how long the stream has been down (`down`: unlocked and not open);
 * re-evaluates once a second while it is.
 */
export function useConnection(down: boolean): Connection {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!down) return;
    const since = Date.now();
    const t = setInterval(() => setElapsed(Date.now() - since), 1000);
    return () => {
      clearInterval(t);
      setElapsed(0);
    };
  }, [down]);
  return down ? connectionFor(0, elapsed) : 'ok';
}

// ---- Focus ----

const CONTAINERS =
  '[data-focus-key],[data-item],[data-row],[data-run],[data-problem],[data-section],[data-card],[data-banner],[role="dialog"],[role="tabpanel"]';
const FOCUSABLE =
  'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"]), [role="tab"]';

function containerKey(el: Element): string {
  const parts: string[] = [];
  for (let c = el.parentElement?.closest(CONTAINERS); c; c = c.parentElement?.closest(CONTAINERS)) {
    const attr = [...c.attributes].find((a) =>
      [
        'data-focus-key',
        'data-item',
        'data-row',
        'data-run',
        'data-problem',
        'data-section',
        'data-card',
        'data-banner',
      ].includes(a.name),
    );
    parts.unshift(attr ? `${attr.name}=${attr.value}` : (c.getAttribute('role') ?? c.tagName));
  }
  return parts.join('>');
}

/**
 * A key that names the same control after a re-render: its own
 * `data-focus-key` or `id`, else where it sits (the keyed containers around
 * it) plus what it is (tag, role, accessible name or href).
 */
export function focusKey(el: Element): string | null {
  if (el === document.body || el === document.documentElement) return null;
  const own = el.getAttribute('data-focus-key');
  if (own) return `k:${own}`;
  const what = [
    el.tagName,
    el.getAttribute('role') ?? '',
    el.getAttribute('aria-label') ?? el.getAttribute('name') ?? '',
    el.getAttribute('href') ?? '',
    el.tagName === 'BUTTON' || el.getAttribute('role') === 'tab'
      ? (el.textContent ?? '').trim().slice(0, 60)
      : '',
  ].join('|');
  return `${containerKey(el)}::${what}${el.id && !el.id.startsWith('«') && !el.id.startsWith(':') ? `#${el.id}` : ''}`;
}

interface FocusSnapshot {
  el: Element;
  key: string;
  start: number | null;
  end: number | null;
}

function caretOf(el: Element): { start: number | null; end: number | null } {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    try {
      return { start: el.selectionStart, end: el.selectionEnd };
    } catch {
      return { start: null, end: null };
    }
  }
  return { start: null, end: null };
}

/** Put focus back on the control `snap` named, if it was replaced. Returns true if it did. */
export function restoreFocus(snap: FocusSnapshot | null): boolean {
  if (!snap || snap.el.isConnected) return false;
  const active = document.activeElement;
  if (active && active !== document.body) return false;
  const match = [...document.querySelectorAll(FOCUSABLE)].find((el) => focusKey(el) === snap.key);
  if (!(match instanceof HTMLElement)) return false;
  match.focus({ preventScroll: true });
  if (
    (match instanceof HTMLInputElement || match instanceof HTMLTextAreaElement) &&
    snap.start !== null
  ) {
    try {
      match.setSelectionRange(snap.start, snap.end ?? snap.start);
    } catch {
      // Some input types have no caret.
    }
  }
  return true;
}

/**
 * Keep the owner's focus across live updates: remember the focused control
 * (and its caret) as it changes, and after each query update put focus back
 * on the same control if the update replaced it.
 */
export function useFocusKeeper(queryClient: QueryClient): void {
  useEffect(() => {
    if (typeof document === 'undefined') return;
    let snap: FocusSnapshot | null = null;
    const remember = () => {
      const el = document.activeElement;
      if (!el || el === document.body) return;
      const key = focusKey(el);
      if (key) snap = { el, key, ...caretOf(el) };
    };
    const onCaret = () => {
      if (snap && document.activeElement === snap.el) Object.assign(snap, caretOf(snap.el));
    };
    document.addEventListener('focusin', remember);
    document.addEventListener('selectionchange', onCaret);
    document.addEventListener('input', onCaret, true);
    let frame = 0;
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== 'updated') return;
      cancelAnimationFrame(frame);
      // After React has committed the new data.
      frame = requestAnimationFrame(() => {
        if (restoreFocus(snap)) remember();
      });
    });
    return () => {
      cancelAnimationFrame(frame);
      unsubscribe();
      document.removeEventListener('focusin', remember);
      document.removeEventListener('selectionchange', onCaret);
      document.removeEventListener('input', onCaret, true);
    };
  }, [queryClient]);
}

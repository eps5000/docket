/**
 * Times and small text helpers (UI_SPEC §10): relative under 24 h ("40s",
 * "47m", "16h"), "Nov 5" beyond that, "Nov 6 10:42" in packet and audit
 * contexts; always local time, the full ISO time goes in `title`.
 */

const MONTH_DAY = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
const TIME = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });

function toDate(value: string | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

/** "40s", "47m", "16h", or "Nov 5" when 24 h or more ago. */
export function formatAge(at: string | Date, now: Date = new Date()): string {
  const d = toDate(at);
  const s = Math.max(0, Math.round((now.getTime() - d.getTime()) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return MONTH_DAY.format(d);
}

/** "Nov 5". */
export function formatDay(at: string | Date): string {
  return MONTH_DAY.format(toDate(at));
}

/** "Nov 6 10:42" (packet and audit contexts). */
export function formatStamp(at: string | Date): string {
  const d = toDate(at);
  return `${MONTH_DAY.format(d)} ${TIME.format(d)}`;
}

/** "10:42". */
export function formatClock(at: string | Date): string {
  return TIME.format(toDate(at));
}

/** The full ISO time, for `title`. */
export function isoTitle(at: string | Date): string {
  return toDate(at).toISOString();
}

/** `1 item` / `2 items`. */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Truncate a path in the middle: `C:/Users/…/rcp-21` (UI_SPEC §6.3.2). */
export function middleTruncate(text: string, max = 36): string {
  if (text.length <= max) return text;
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
}

/** "40s ago", "47m ago", or "Nov 5" (a date needs no "ago"). */
export function formatAgo(at: string | Date, now: Date = new Date()): string {
  const age = formatAge(at, now);
  return /^\d+[smh]$/.test(age) ? `${age} ago` : age;
}

/** "10:57" when within the last 24 h, else "Nov 14 10:57" (a park's "since"). */
export function formatSince(at: string | Date, now: Date = new Date()): string {
  const d = toDate(at);
  return now.getTime() - d.getTime() < 86_400_000 ? formatClock(d) : formatStamp(d);
}

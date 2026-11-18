/**
 * Browser persistence (UI_SPEC §2, "Persistence"). One key per row of the
 * table, and nothing else is stored:
 *
 * | State                                   | Storage          |
 * |-----------------------------------------|------------------|
 * | Project scope                           | sessionStorage   |
 * | Open-item tabs + each tab's view        | sessionStorage   |
 * | Theme                                   | localStorage     |
 * | Desktop notifications on/off            | localStorage     |
 * | Which events were already notified      | localStorage     |
 * | Collapsed sections (per section *type*) | localStorage     |
 *
 * Everything else (filters, layout) lives in the URL query.
 *
 * Storage can be missing or throw (private windows, blocked site data), so
 * every read and write is guarded and falls back to the default.
 */

export const STORAGE_KEYS = {
  /** sessionStorage: `all` or a project key. Resets on every new visit (owner decision 10). */
  scope: 'docket.scope',
  /** sessionStorage: `{tabs: [{id, type, title, view}], order}`. */
  openTabs: 'docket.tabs',
  /** localStorage: `system` | `light` | `dark`. */
  theme: 'docket.theme',
  /** localStorage: `on` | `off` (UI_SPEC §6.7a; filled by T085). */
  notifications: 'docket.notifications',
  /** localStorage: event seqs already notified in this browser (UI_SPEC §6.7a; T085). */
  notified: 'docket.notified',
  /**
   * localStorage: `{[sectionType]: boolean}`, kept only where it differs from
   * the section's default (most sections start open; Recent and the burn-down
   * start collapsed).
   */
  collapsed: 'docket.collapsed',
} as const;

export type StorageKey = (typeof STORAGE_KEYS)[keyof typeof STORAGE_KEYS];

/** Which storage each key lives in (UI_SPEC §2). */
export const STORAGE_AREA: Record<StorageKey, 'session' | 'local'> = {
  'docket.scope': 'session',
  'docket.tabs': 'session',
  'docket.theme': 'local',
  'docket.notifications': 'local',
  'docket.notified': 'local',
  'docket.collapsed': 'local',
};

function area(key: StorageKey): Storage | null {
  try {
    if (typeof window === 'undefined') return null;
    return STORAGE_AREA[key] === 'session' ? window.sessionStorage : window.localStorage;
  } catch {
    return null;
  }
}

export function readString(key: StorageKey): string | null {
  try {
    return area(key)?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function writeString(key: StorageKey, value: string | null): void {
  try {
    const store = area(key);
    if (!store) return;
    if (value === null) store.removeItem(key);
    else store.setItem(key, value);
  } catch {
    // Storage is a convenience; the UI works without it.
  }
}

export function readJson<T>(key: StorageKey, fallback: T): T {
  const raw = readString(key);
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(key: StorageKey, value: unknown): void {
  writeString(key, JSON.stringify(value));
}

// ---- Collapsed sections (per section type) ----

export function isSectionCollapsed(type: string, defaultCollapsed = false): boolean {
  const map = readJson<Record<string, boolean>>(STORAGE_KEYS.collapsed, {});
  return typeof map[type] === 'boolean' ? map[type] : defaultCollapsed;
}

export function setSectionCollapsed(
  type: string,
  collapsed: boolean,
  defaultCollapsed = false,
): void {
  const map = readJson<Record<string, boolean>>(STORAGE_KEYS.collapsed, {});
  if (collapsed === defaultCollapsed) delete map[type];
  else map[type] = collapsed;
  writeJson(STORAGE_KEYS.collapsed, map);
}

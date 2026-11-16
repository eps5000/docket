/**
 * Open-item tabs (UI_SPEC §2): every ticket or epic you open becomes a tab.
 * At most 8; when a 9th opens, the oldest inactive one closes. Each tab
 * remembers its own view tab. Closing the active tab moves to its
 * neighbour, or back to the page you came from. Kept in sessionStorage.
 */
import type { ItemType } from '@tasklite/shared';
import type { ItemTab } from '../lib/paths';

export const MAX_OPEN_TABS = 8;

export interface OpenTab {
  id: string;
  /** Known once the item has loaded. */
  type?: ItemType;
  title?: string;
  /** The view tab this item was last on. */
  view?: ItemTab;
}

export interface OpenTabsState {
  tabs: OpenTab[];
  /** The last non-item page (path + query), for closing the last tab. */
  lastPage: string;
}

export const EMPTY_TABS: OpenTabsState = { tabs: [], lastPage: '/' };

/** Open (or keep) `id`; when that makes 9, drop the oldest tab other than `id`. */
export function openTab(state: OpenTabsState, id: string): OpenTabsState {
  if (state.tabs.some((t) => t.id === id)) return state;
  const tabs = [...state.tabs, { id }];
  while (tabs.length > MAX_OPEN_TABS) {
    const oldest = tabs.findIndex((t) => t.id !== id);
    tabs.splice(oldest, 1);
  }
  return { ...state, tabs };
}

/** Update what a tab knows (type, title) or remembers (view). */
export function updateTab(
  state: OpenTabsState,
  id: string,
  patch: Partial<Omit<OpenTab, 'id'>>,
): OpenTabsState {
  let changed = false;
  const tabs = state.tabs.map((t) => {
    if (t.id !== id) return t;
    const next = { ...t, ...patch };
    changed = (Object.keys(patch) as (keyof typeof patch)[]).some((k) => t[k] !== next[k]);
    return next;
  });
  return changed ? { ...state, tabs } : state;
}

/**
 * Close `id`. When it was the active tab, returns where to go: the right
 * neighbour, else the left one, else the page you came from.
 */
export function closeTab(
  state: OpenTabsState,
  id: string,
  activeId: string | null,
): { state: OpenTabsState; goTo: { tab: OpenTab } | { page: string } | null } {
  const index = state.tabs.findIndex((t) => t.id === id);
  if (index < 0) return { state, goTo: null };
  const tabs = state.tabs.filter((t) => t.id !== id);
  const next = { ...state, tabs };
  if (activeId !== id) return { state: next, goTo: null };
  const neighbour = tabs[index] ?? tabs[index - 1];
  return { state: next, goTo: neighbour ? { tab: neighbour } : { page: state.lastPage } };
}

export function setLastPage(state: OpenTabsState, page: string): OpenTabsState {
  return state.lastPage === page ? state : { ...state, lastPage: page };
}

/** Parse what sessionStorage held; anything malformed is dropped. */
export function parseTabs(raw: unknown): OpenTabsState {
  if (!raw || typeof raw !== 'object') return EMPTY_TABS;
  const r = raw as { tabs?: unknown; lastPage?: unknown };
  const tabs = Array.isArray(r.tabs)
    ? r.tabs
        .filter((t): t is OpenTab => !!t && typeof (t as OpenTab).id === 'string')
        .slice(-MAX_OPEN_TABS)
    : [];
  const lastPage = typeof r.lastPage === 'string' && r.lastPage.startsWith('/') ? r.lastPage : '/';
  return { tabs, lastPage };
}

/**
 * Shell state shared by the shell and the screens (UI_SPEC §2):
 * - project scope (sessionStorage, resets to All projects on each visit);
 * - theme (localStorage; System → Light → Dark), applied as `data-theme` on
 *   the `.tl` body;
 * - open-item tabs and each tab's view (sessionStorage);
 * - the breadcrumb each screen sets;
 * - the command palette and Quick capture.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { PROJECT_KEY_RE } from '@tasklite/shared';
import { readJson, readString, STORAGE_KEYS, writeJson, writeString } from '../lib/persistence';
import {
  closeTab as closeTabState,
  openTab as openTabState,
  parseTabs,
  setLastPage as setLastPageState,
  updateTab as updateTabState,
  type OpenTab,
  type OpenTabsState,
} from './openTabs';

// ---- Theme ----

export type Theme = 'system' | 'light' | 'dark';
export const THEME_ORDER: readonly Theme[] = ['system', 'light', 'dark'];

export function readTheme(): Theme {
  const v = readString(STORAGE_KEYS.theme);
  return v === 'light' || v === 'dark' ? v : 'system';
}

/** Apply the theme to the token scope (`<body class="tl">`). */
export function applyTheme(theme: Theme): void {
  if (typeof document === 'undefined') return;
  if (theme === 'system') delete document.body.dataset.theme;
  else document.body.dataset.theme = theme;
}

export function nextTheme(theme: Theme): Theme {
  return THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length]!;
}

// ---- Scope ----

export type Scope = 'all' | string;

export function readScope(): Scope {
  const v = readString(STORAGE_KEYS.scope);
  return v && PROJECT_KEY_RE.test(v) ? v : 'all';
}

// ---- Breadcrumb ----

export type Crumb =
  | { kind: 'text'; text: string; mono?: boolean }
  | { kind: 'link'; text: string; to: string; mono?: boolean; epic?: boolean }
  | { kind: 'current'; text: string; mono?: string };

export interface BreadcrumbSpec {
  crumbs: Crumb[];
  /** Settings: the "Service-wide" pill. */
  serviceWide?: boolean;
}

// ---- Context ----

interface ShellState {
  scope: Scope;
  setScope: (scope: Scope) => void;
  theme: Theme;
  setTheme: (theme: Theme) => void;
  tabs: OpenTabsState;
  openTab: (id: string) => void;
  updateTab: (id: string, patch: Partial<Omit<OpenTab, 'id'>>) => void;
  closeTab: (id: string, activeId: string | null) => { tab: OpenTab } | { page: string } | null;
  setLastPage: (page: string) => void;
  breadcrumb: BreadcrumbSpec | null;
  setBreadcrumb: (b: BreadcrumbSpec | null) => void;
  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;
  /** Quick capture; `epic` when opened from *+ New item in this epic*. */
  capture: { epic?: { id: string; title: string; project: string } } | null;
  setCapture: (c: ShellState['capture']) => void;
}

const Ctx = createContext<ShellState | null>(null);

export function ShellStateProvider({ children }: { children: ReactNode }) {
  const [scope, setScopeState] = useState<Scope>(readScope);
  const [theme, setThemeState] = useState<Theme>(readTheme);
  const [tabs, setTabs] = useState<OpenTabsState>(() =>
    parseTabs(readJson(STORAGE_KEYS.openTabs, null)),
  );
  const [breadcrumb, setBreadcrumb] = useState<BreadcrumbSpec | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [capture, setCapture] = useState<ShellState['capture']>(null);

  useEffect(() => applyTheme(theme), [theme]);
  useEffect(() => writeJson(STORAGE_KEYS.openTabs, tabs), [tabs]);

  const setScope = useCallback((s: Scope) => {
    writeString(STORAGE_KEYS.scope, s);
    setScopeState(s);
  }, []);
  const setTheme = useCallback((t: Theme) => {
    writeString(STORAGE_KEYS.theme, t === 'system' ? null : t);
    setThemeState(t);
  }, []);
  const openTab = useCallback((id: string) => setTabs((s) => openTabState(s, id)), []);
  const updateTab = useCallback(
    (id: string, patch: Partial<Omit<OpenTab, 'id'>>) =>
      setTabs((s) => updateTabState(s, id, patch)),
    [],
  );
  const closeTab = useCallback(
    (id: string, activeId: string | null) => {
      const out = closeTabState(tabs, id, activeId);
      setTabs(out.state);
      return out.goTo;
    },
    [tabs],
  );
  const setLastPage = useCallback((page: string) => setTabs((s) => setLastPageState(s, page)), []);

  const value = useMemo<ShellState>(
    () => ({
      scope,
      setScope,
      theme,
      setTheme,
      tabs,
      openTab,
      updateTab,
      closeTab,
      setLastPage,
      breadcrumb,
      setBreadcrumb,
      paletteOpen,
      setPaletteOpen,
      capture,
      setCapture,
    }),
    [
      scope,
      setScope,
      theme,
      setTheme,
      tabs,
      openTab,
      updateTab,
      closeTab,
      setLastPage,
      breadcrumb,
      paletteOpen,
      capture,
    ],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useShell(): ShellState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useShell() outside ShellStateProvider');
  return v;
}

/** Set the header breadcrumb for as long as the calling screen is mounted. */
export function useBreadcrumb(spec: BreadcrumbSpec | null): void {
  const { setBreadcrumb } = useShell();
  const key = JSON.stringify(spec);
  useEffect(() => {
    setBreadcrumb(key === 'null' ? null : (JSON.parse(key) as BreadcrumbSpec));
    return () => setBreadcrumb(null);
  }, [key, setBreadcrumb]);
}

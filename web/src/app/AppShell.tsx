import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router';
import { ToastRegion } from '../components/kit';
import { paths } from '../lib/paths';
import { toasts, useToasts } from '../lib/undo';
import { QuickCaptureHost } from '../routes/dialogs/QuickCapture';
import { Header } from './Header';
import { PaletteHost } from './PaletteHost';
import { isLocked, setOnLocked } from './queryClient';
import { useShell } from './ShellState';
import { isPaletteShortcut } from './shortcuts';
import { Sidebar } from './Sidebar';
import { TabStrip } from './TabStrip';
import { useBootstrap } from './useBootstrap';
import { useLiveStream } from './useLiveStream';
import './shell.css';

/** `/items/RCP-14` → `RCP-14`. */
export function itemIdFromPath(pathname: string): string | null {
  const m = /^\/items\/([^/]+)\/?$/.exec(pathname);
  return m ? decodeURIComponent(m[1]!) : null;
}

/**
 * The app shell (UI_SPEC §2): sidebar (rail at ≤ 1180px), header, open-item
 * tab strip, and the view. It also owns the session gate (any 401 goes to
 * /unlock), the live stream, the palette shortcut and the toast region.
 */
export function AppShell() {
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { openTab, setLastPage, setPaletteOpen } = useShell();
  const boot = useBootstrap();
  const toastList = useToasts();
  const viewRef = useRef<HTMLElement>(null);
  const first = useRef(true);
  const activeId = itemIdFromPath(location.pathname);
  const here = `${location.pathname}${location.search}`;

  // Session gate: a 401 anywhere means locked; come back here after unlocking.
  const hereRef = useRef(here);
  useEffect(() => {
    hereRef.current = here;
  }, [here]);
  useEffect(() => {
    setOnLocked(() => navigate(paths.unlock(hereRef.current), { replace: true }));
    return () => setOnLocked(() => {});
  }, [navigate]);

  // The stream needs an unlocked session: open it once bootstrap answered anything but 401.
  const unlocked = boot.isSuccess || (boot.isError && !isLocked(boot.error));
  useLiveStream(queryClient, unlocked);

  // Open-item tabs follow the location; other pages become "the page you came from".
  useEffect(() => {
    if (activeId) openTab(activeId);
    else setLastPage(here);
  }, [activeId, here, openTab, setLastPage]);

  // Move focus to the view on navigation (not on first load), like the prototype.
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    viewRef.current?.focus({ preventScroll: true });
  }, [location.pathname]);

  // Ctrl K and / open the palette (unless typing in a field).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !isPaletteShortcut(e)) return;
      if (document.querySelector('[role="dialog"]')) return;
      e.preventDefault();
      setPaletteOpen(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setPaletteOpen]);

  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <div className="shell">
        <Sidebar />
        <div className="mainwrap">
          <Header />
          <TabStrip activeId={activeId} />
          <main className="view" id="main" ref={viewRef} tabIndex={-1}>
            <Outlet />
          </main>
        </div>
      </div>
      <PaletteHost />
      <QuickCaptureHost />
      <ToastRegion toasts={toastList} onDismiss={toasts.dismiss} />
    </>
  );
}

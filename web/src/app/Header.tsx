import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Link, useLocation } from 'react-router';
import { Button, Icon, IconButton } from '../components/kit';
import { navSection } from './Sidebar';
import { nextTheme, useShell, type BreadcrumbSpec, type Crumb, type Theme } from './ShellState';
import { useBootstrap, useNoProjects } from './useBootstrap';

const PAGE_TITLES = {
  'needs-you': 'Needs you',
  work: 'Work',
  agents: 'Agents',
  'agent-files': 'Agent files',
  settings: 'Settings',
  help: 'Help',
} as const;

function CrumbView({ c }: { c: Crumb }) {
  if (c.kind === 'link') {
    return (
      <Link to={c.to} className={c.mono ? 'mono' : undefined}>
        {c.epic && <span aria-hidden="true">◆ </span>}
        {c.text}
      </Link>
    );
  }
  if (c.kind === 'current') {
    return (
      <span>
        {c.mono && <span className="mono">{c.mono} </span>}
        <b>{c.text}</b>
      </span>
    );
  }
  return <span className={c.mono ? 'mono' : undefined}>{c.text}</span>;
}

/** `Scope / Page` by default; screens override it (tickets, packet, Settings). */
function Breadcrumb() {
  const { breadcrumb, scope } = useShell();
  const { pathname } = useLocation();
  const boot = useBootstrap();
  const scopeName =
    scope === 'all'
      ? 'All projects'
      : (boot.data?.projects.find((p) => p.key === scope)?.short_name ?? scope);
  const section = navSection(pathname);
  const spec: BreadcrumbSpec = breadcrumb ?? {
    crumbs:
      section === 'settings'
        ? [{ kind: 'current', text: 'Settings' }]
        : [
            { kind: 'text', text: scopeName },
            { kind: 'current', text: section ? PAGE_TITLES[section] : 'Docket' },
          ],
    serviceWide: section === 'settings',
  };
  const title = spec.crumbs
    .map((c) => (c.kind === 'current' && c.mono ? `${c.mono} ${c.text}` : c.text))
    .join(' / ');
  return (
    <nav className="crumbs" aria-label="Breadcrumb" title={title}>
      {spec.crumbs.map((c, i) => (
        <span key={i}>
          {i > 0 && <span aria-hidden="true"> / </span>}
          <CrumbView c={c} />
        </span>
      ))}
      {spec.serviceWide && <span className="scopebar">Service-wide</span>}
    </nav>
  );
}

const THEME_ICON: Record<Theme, 'system' | 'sun' | 'moon'> = {
  system: 'system',
  light: 'sun',
  dark: 'moon',
};

/**
 * The header's create button (UI_SPEC §2; B32). With no projects it is
 * *+ New project*. Otherwise *+ New item* stays one click (Quick capture),
 * and a caret beside it opens a small menu: *New item*, *New project*.
 */
function NewButton() {
  const { setCapture, setProjectDialog } = useShell();
  const noProjects = useNoProjects();
  const [open, setOpen] = useState(false);
  const caret = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const onDown = (e: MouseEvent) => {
      if (!menu.current?.contains(e.target as Node) && !caret.current?.contains(e.target as Node))
        setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  if (noProjects) {
    return (
      <Button
        variant="primary"
        size="sm"
        className="newbtn"
        title="Create your first project"
        onClick={() => setProjectDialog({ kind: 'new' })}
      >
        + New project
      </Button>
    );
  }

  const close = (focusCaret = true) => {
    setOpen(false);
    if (focusCaret) caret.current?.focus();
  };
  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(
      menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [],
    );
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      items[(i + 1) % items.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      items[(i - 1 + items.length) % items.length]?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      items[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      items[items.length - 1]?.focus();
    } else if (e.key === 'Tab') {
      close(false);
    }
  };
  const pick = (what: 'item' | 'project') => {
    close(false);
    if (what === 'item') setCapture({});
    else setProjectDialog({ kind: 'new' });
  };

  return (
    <div className="newsplit">
      <Button
        variant="primary"
        size="sm"
        className="newbtn"
        title="New item: capture it in Inbox"
        onClick={() => setCapture({})}
      >
        + New item
      </Button>
      <button
        ref={caret}
        type="button"
        className="btn primary sm newcaret"
        aria-label="More to create"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Create a new item or a new project"
        onClick={() => setOpen(!open)}
      >
        <Icon name="chev" small />
      </button>
      {open && (
        <div ref={menu} className="newmenu" role="menu" aria-label="Create" onKeyDown={onMenuKey}>
          <button type="button" role="menuitem" tabIndex={-1} onClick={() => pick('item')}>
            New item
            <span className="src">Capture it in Inbox</span>
          </button>
          <button type="button" role="menuitem" tabIndex={-1} onClick={() => pick('project')}>
            New project
            <span className="src">A key, a name, then what next</span>
          </button>
        </div>
      )}
    </div>
  );
}

/** Header: breadcrumb · + New item (▾) · Search (Ctrl K) · theme (UI_SPEC §2). */
export function Header() {
  const { theme, setTheme, setPaletteOpen } = useShell();
  return (
    <header className="top">
      <Breadcrumb />
      <NewButton />
      <button
        type="button"
        className="search"
        title="Search or jump to (Ctrl K or /)"
        aria-keyshortcuts="Control+K /"
        onClick={() => setPaletteOpen(true)}
      >
        <span aria-hidden="true">⌕</span>
        <span className="grow">Search or jump to…</span>
        <kbd>Ctrl K</kbd>
      </button>
      <IconButton
        icon={THEME_ICON[theme]}
        aria-label={`Theme: ${theme}. Switch theme`}
        title={`Theme: ${theme}`}
        onClick={() => setTheme(nextTheme(theme))}
      />
    </header>
  );
}

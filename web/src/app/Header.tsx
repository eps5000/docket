import { Link, useLocation } from 'react-router';
import { Button, IconButton } from '../components/kit';
import { navSection } from './Sidebar';
import { nextTheme, useShell, type BreadcrumbSpec, type Crumb, type Theme } from './ShellState';
import { useBootstrap } from './useBootstrap';

const PAGE_TITLES = {
  'needs-you': 'Needs you',
  work: 'Work',
  agents: 'Agents',
  settings: 'Settings',
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
            { kind: 'current', text: section ? PAGE_TITLES[section] : 'Task Lite' },
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

/** Header: breadcrumb · + New · Search (Ctrl K) · theme (UI_SPEC §2). */
export function Header() {
  const { theme, setTheme, setPaletteOpen, setCapture } = useShell();
  return (
    <header className="top">
      <Breadcrumb />
      <Button
        variant="primary"
        size="sm"
        className="newbtn"
        title="Capture a new item in Inbox"
        onClick={() => setCapture({})}
      >
        + New
      </Button>
      <button
        type="button"
        className="search"
        aria-label="Search or jump to (Ctrl+K)"
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

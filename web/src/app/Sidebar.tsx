import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { Icon, isNotBuilt, type IconName } from '../components/kit';
import { paths } from '../lib/paths';
import { useShell } from './ShellState';
import { useAgentsNow, useBootstrap, useNeedsYouCount } from './useBootstrap';

/** Which nav item a path belongs to (UI_SPEC §2, §6.4: the packet keeps Overview active). */
export function navSection(
  pathname: string,
): 'overview' | 'work' | 'agents' | 'agent-files' | 'settings' | 'help' | null {
  if (
    pathname === '/' ||
    pathname === '/brief' ||
    pathname.startsWith('/review/') ||
    pathname.startsWith('/overview')
  )
    return 'overview';
  if (
    pathname.startsWith('/work') ||
    pathname.startsWith('/items/') ||
    pathname.startsWith('/labels/')
  )
    return 'work';
  if (pathname.startsWith('/agents')) return 'agents';
  if (pathname.startsWith('/agent-files')) return 'agent-files';
  if (pathname.startsWith('/settings')) return 'settings';
  if (pathname === '/help' || pathname.startsWith('/help/')) return 'help';
  return null;
}

function NavItem({
  to,
  icon,
  label,
  section,
  badge,
}: {
  to: string;
  icon: IconName;
  label: string;
  section: ReturnType<typeof navSection>;
  badge?: { n: number; tone: 'red' | 'gray'; sr: string; title?: string };
}) {
  const { pathname } = useLocation();
  const current = navSection(pathname) === section;
  return (
    <Link
      to={to}
      className="navbtn"
      aria-current={current ? 'page' : undefined}
      title={label}
      data-nav={section ?? undefined}
    >
      <Icon name={icon} />
      <span className="nl">{label}</span>
      {badge && badge.n > 0 && (
        <span className={`badge${badge.tone === 'gray' ? ' n' : ''}`} title={badge.title}>
          {' '}
          {badge.n}
          <span className="sr"> {badge.sr}</span>
        </span>
      )}
    </Link>
  );
}

/**
 * The switcher's focusable rows: the projects, *Project decisions* for the
 * current project (decision 38), and *+ New project* (B32).
 */
const MENU_ITEMS = '[role="menuitemradio"], [role="menuitem"]';

/**
 * Project switcher: a menu of `menuitemradio` items, each with its for-you
 * count (UI_SPEC §2, §11), and after a separator *Project decisions* (with
 * a project chosen; decision 38) and *+ New project* (B32).
 */
function ProjectSwitcher() {
  const { scope, setScope, setProjectDialog } = useShell();
  const navigate = useNavigate();
  const boot = useBootstrap();
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const projects = boot.data?.projects ?? [];
  const current = projects.find((p) => p.key === scope);
  const options = [
    {
      key: 'all',
      name: 'All projects',
      color: null as string | null,
      createdBy: null as string | null,
    },
  ].concat(
    projects.map((p) => ({
      key: p.key,
      name: p.short_name,
      color: p.color,
      // "created by <agent> · review" until the owner reviews its onboarding (decision 31).
      createdBy: p.created_by ?? null,
    })),
  );

  useEffect(() => {
    if (!open) return;
    const items = menu.current?.querySelectorAll<HTMLElement>(MENU_ITEMS);
    const checked = menu.current?.querySelector<HTMLElement>('[aria-checked="true"]');
    (checked ?? items?.[0])?.focus();
    const onDown = (e: MouseEvent) => {
      if (!menu.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node))
        setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const close = (focusButton = true) => {
    setOpen(false);
    if (focusButton) btn.current?.focus();
  };

  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(menu.current?.querySelectorAll<HTMLElement>(MENU_ITEMS) ?? []);
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

  const name = current ? current.short_name : scope === 'all' ? 'All projects' : scope;
  return (
    <div className="scopewrap">
      <button
        ref={btn}
        type="button"
        className="scopebtn"
        aria-haspopup="menu"
        aria-expanded={open}
        title={`Project: ${name}`}
        onClick={() => setOpen(!open)}
      >
        {current ? (
          <span className="sw" style={{ background: current.color }} aria-hidden="true" />
        ) : (
          <Icon name="folder" small />
        )}
        <span className="grow txt">
          <span className="lbl2">Project</span> <span className="nm">{name}</span>
        </span>
        <span className="chev" aria-hidden="true">
          <Icon name="chev" small />
        </span>
      </button>
      {open && (
        <div
          ref={menu}
          className="scopemenu"
          role="menu"
          aria-label="Choose project"
          onKeyDown={onMenuKey}
        >
          {options.map((o) => (
            <button
              key={o.key}
              type="button"
              role="menuitemradio"
              aria-checked={scope === o.key}
              tabIndex={-1}
              onClick={() => {
                setScope(o.key);
                close();
              }}
            >
              {o.color ? (
                <span className="sw" style={{ background: o.color }} aria-hidden="true" />
              ) : (
                <Icon name="folder" small />
              )}
              <span className="grow">
                {o.name}
                {o.createdBy && (
                  <span className="chip c-warn scopechip" data-created-by={o.createdBy}>
                    created by {o.createdBy.split(' · ')[0]} · review
                  </span>
                )}
              </span>
            </button>
          ))}
          <div className="hint">Scopes every page except Settings.</div>
          <div role="separator" className="scopesep" />
          {current && (
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="scopenew"
              data-project-decisions-menu={current.key}
              onClick={() => {
                close(false);
                void navigate(paths.projectDecisions(current.key));
              }}
            >
              <Icon name="check" small />
              <span className="grow">Project decisions</span>
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="scopenew"
            onClick={() => {
              close(false);
              setProjectDialog({ kind: 'new' });
            }}
          >
            <Icon name="plus" small />
            <span className="grow">New project</span>
          </button>
        </div>
      )}
    </div>
  );
}

function HealthLine() {
  const boot = useBootstrap();
  const health = boot.data?.health;
  const clients = health?.checks.clients;
  let text: string;
  let tone: 'ok' | 'bad' | 'unknown';
  if (health?.status === 'ready') {
    tone = 'ok';
    text = clients ? `Healthy · ${clients} clients` : 'Healthy';
  } else if (health?.status === 'not_ready' || (boot.isError && !isNotBuilt(boot.error))) {
    tone = 'bad';
    text = 'Service problem';
  } else {
    tone = 'unknown';
    text = 'Health not reported yet';
  }
  return (
    <Link
      to={paths.settings()}
      className={`health health-${tone}`}
      title={`${text}. Open settings`}
    >
      <span className="row">
        <i className={`ri ri-health-${tone}`} aria-hidden="true">
          {tone === 'ok' ? '✓' : tone === 'bad' ? '!' : '?'}
        </i>
        <span className="hx">{text}</span>
      </span>
    </Link>
  );
}

/** The 220px sidebar, a 64px icon rail at ≤ 1180px (UI_SPEC §2). */
export function Sidebar() {
  // Decision 41: what the owner can act on on the page, from the page's own response.
  const forYou = useNeedsYouCount();
  // Decision 43: tickets being worked in this project, the Overview card's number.
  const working = useAgentsNow()?.working ?? 0;
  return (
    <nav className="side" aria-label="Primary">
      <div className="logo">
        <i aria-hidden="true">D</i>
        <span>Docket</span>
      </div>
      <ProjectSwitcher />
      <NavItem
        to={paths.overview()}
        icon="attention"
        label="Overview"
        section="overview"
        badge={{ n: forYou ?? 0, tone: 'red', sr: 'for you' }}
      />
      <NavItem to={paths.work()} icon="work" label="Work" section="work" />
      <NavItem
        to={paths.agents()}
        icon="agents"
        label="Agents"
        section="agents"
        badge={{
          n: working,
          tone: 'gray',
          sr: working === 1 ? 'ticket being worked' : 'tickets being worked',
          title:
            'Tickets being worked in this project. Parked or waiting tickets aren’t counted. This counts tickets in Docket, not agent sessions.',
        }}
      />
      <NavItem to={paths.agentFiles()} icon="doc" label="Agent files" section="agent-files" />
      <div className="navsec" aria-hidden="true">
        Service-wide
      </div>
      <NavItem to={paths.settings()} icon="plug" label="Settings" section="settings" />
      <NavItem to={paths.help()} icon="question" label="Help" section="help" />
      <HealthLine />
    </nav>
  );
}

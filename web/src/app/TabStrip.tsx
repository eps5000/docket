import { Link, useNavigate } from 'react-router';
import { IconButton, TypeIcon } from '../components/kit';
import { paths } from '../lib/paths';
import { useShell } from './ShellState';

/**
 * The open-item tab strip (UI_SPEC §2): each tab is a fixed 200px link with
 * type icon, ID and title, plus ×. It scrolls sideways and is hidden when
 * empty. Tabs are links (they navigate), in a labelled nav.
 */
export function TabStrip({ activeId }: { activeId: string | null }) {
  const { tabs, closeTab } = useShell();
  const navigate = useNavigate();
  if (tabs.tabs.length === 0) return null;
  return (
    <nav className="tabstrip" aria-label="Open items">
      {tabs.tabs.map((t) => {
        const on = t.id === activeId;
        return (
          <div className="otab" key={t.id} data-open-tab={t.id} data-active={on || undefined}>
            <Link
              className="og"
              to={paths.item(t.id, t.view)}
              aria-current={on ? 'page' : undefined}
              title={t.title ? `${t.id} ${t.title}` : t.id}
            >
              {t.type && <TypeIcon type={t.type} />}
              <span className="mono">{t.id}</span>
              {t.title && <span className="tt2">{t.title}</span>}
            </Link>
            <IconButton
              className="ox"
              icon="x"
              bare
              aria-label={`Close ${t.id}`}
              onClick={() => {
                const goTo = closeTab(t.id, activeId);
                if (!goTo) return;
                if ('tab' in goTo) navigate(paths.item(goTo.tab.id, goTo.tab.view));
                else navigate(goTo.page);
              }}
            />
          </div>
        );
      })}
    </nav>
  );
}

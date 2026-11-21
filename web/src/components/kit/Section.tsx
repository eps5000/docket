import { useId, useState, type ReactNode } from 'react';
import { isSectionCollapsed, setSectionCollapsed } from '../../lib/persistence';
import { Icon } from './icons';

export interface SectionProps {
  /**
   * The section *type* ("work", "outcome", "runs"). Collapse state is stored
   * per type in localStorage, so closing Work once keeps it closed on the
   * next ticket (UI_SPEC §2).
   */
  sectionKey: string;
  title: string;
  /** Shown after the title as "· summary". */
  summary?: ReactNode;
  /** Actions at the right of the header (*Checklist history*, *Open packet*, *Edit*). */
  extraHead?: ReactNode;
  /** Start collapsed until the owner opens it (Agents → Recent, the burn-down); remembered like any other. */
  defaultCollapsed?: boolean;
  /** An anchor (`/agents#workspaces`). */
  id?: string;
  /**
   * The page's main content (the project Decisions page; decision 38): always
   * open, whatever was collapsed for this section type elsewhere, and the
   * header is not a toggle.
   */
  alwaysOpen?: boolean;
  children?: ReactNode;
}

/**
 * Collapsible section (UI_SPEC §4 Section). The header is a button: chevron +
 * h3 title + "· summary", with `aria-expanded`. Collapsed sections use
 * `--panel-2` and render only the header.
 */
export function Section({
  sectionKey,
  title,
  summary,
  extraHead,
  defaultCollapsed = false,
  id,
  alwaysOpen = false,
  children,
}: SectionProps) {
  const [storedCollapsed, setCollapsed] = useState(() =>
    isSectionCollapsed(sectionKey, defaultCollapsed),
  );
  const collapsed = !alwaysOpen && storedCollapsed;
  const bodyId = useId();
  const toggle = () => {
    const next = !collapsed;
    setSectionCollapsed(sectionKey, next, defaultCollapsed);
    setCollapsed(next);
  };
  return (
    <section
      className={`card sec${collapsed ? ' collapsed' : ''}`}
      data-section={sectionKey}
      aria-label={title}
      id={id}
    >
      <div className="sechead">
        {alwaysOpen ? (
          <div className="sectog fixed">
            <h3>{title}</h3>
            {summary !== undefined && summary !== '' && <span className="src">· {summary}</span>}
          </div>
        ) : (
          <button
            type="button"
            className="sectog"
            aria-expanded={!collapsed}
            aria-controls={collapsed ? undefined : bodyId}
            onClick={toggle}
          >
            <span className="chev" aria-hidden="true">
              <Icon name="chev" small />
            </span>
            <h3>{title}</h3>
            {summary !== undefined && summary !== '' && <span className="src">· {summary}</span>}
          </button>
        )}
        {extraHead}
      </div>
      {!collapsed && (
        <div className="secbody" id={bodyId}>
          {children}
        </div>
      )}
    </section>
  );
}

import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';

export interface ViewTab<K extends string = string> {
  key: K;
  label: string;
  /** Muted text after the label; zero counts are hidden (UI_SPEC §10). */
  count?: number | string;
  /** A 7px attention dot with sr-only text ("packet ready", "stale run", "in a dependency cycle"). */
  dot?: { tone: 'warn' | 'bad'; text: string };
  /** One-line hint in `title`. */
  hint?: string;
}

/**
 * ARIA tabs (UI_SPEC §4 ViewTabs, §11): `role=tablist/tab/tabpanel`, roving
 * tabindex, arrow keys move and select, Home/End jump. Only the active panel
 * is rendered.
 */
export function ViewTabs<K extends string>({
  label,
  tabs,
  active,
  onChange,
  extra,
  children,
}: {
  /** "Ticket views" / "Epic views". */
  label: string;
  tabs: readonly ViewTab<K>[];
  active: K;
  onChange: (key: K) => void;
  /** At the right of the tab row (*+ New item in this epic*). */
  extra?: ReactNode;
  /** The active tab's panel. */
  children?: ReactNode;
}) {
  const base = useId();
  const refs = useRef(new Map<K, HTMLButtonElement>());
  const tabId = (k: K) => `${base}-tab-${k}`;
  const panelId = `${base}-panel`;

  const move = (to: K) => {
    onChange(to);
    refs.current.get(to)?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const n = tabs.length;
    let next: number | null = null;
    if (e.key === 'ArrowRight') next = (index + 1) % n;
    else if (e.key === 'ArrowLeft') next = (index - 1 + n) % n;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = n - 1;
    if (next === null) return;
    e.preventDefault();
    move(tabs[next]!.key);
  };

  return (
    <>
      <div className="tabrow">
        <div className="tabs" role="tablist" aria-label={label}>
          {tabs.map((t, i) => {
            const selected = t.key === active;
            const showCount = t.count !== undefined && t.count !== 0 && t.count !== '';
            return (
              <button
                key={t.key}
                ref={(el) => {
                  if (el) refs.current.set(t.key, el);
                  else refs.current.delete(t.key);
                }}
                type="button"
                role="tab"
                id={tabId(t.key)}
                aria-selected={selected}
                aria-controls={selected ? panelId : undefined}
                tabIndex={selected ? 0 : -1}
                title={t.hint}
                onClick={() => onChange(t.key)}
                onKeyDown={(e) => onKeyDown(e, i)}
              >
                {t.label}
                {showCount && <span className="count">{t.count}</span>}
                {t.dot && (
                  <>
                    <span
                      className={`tabdot${t.dot.tone === 'bad' ? ' bad' : ''}`}
                      aria-hidden="true"
                      title={t.dot.text}
                    />
                    <span className="sr"> ({t.dot.text})</span>
                  </>
                )}
              </button>
            );
          })}
        </div>
        {extra && <div className="extra">{extra}</div>}
      </div>
      <div role="tabpanel" id={panelId} aria-labelledby={tabId(active)} tabIndex={0}>
        {children}
      </div>
    </>
  );
}

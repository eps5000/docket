import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useFocusTrap } from './focus';

export interface PaletteOption {
  key: string;
  label: ReactNode;
  /** Right-aligned extras: project, status chip. */
  meta?: ReactNode;
  /** Shows an "Archived" tag (UI_SPEC §4 CommandPalette). */
  archived?: boolean;
  onSelect: () => void;
}

export interface PaletteGroup {
  /** "Work items", "Labels", "Go to". */
  label: string;
  options: PaletteOption[];
}

/**
 * The command palette shell (UI_SPEC §4, §6.9): an input "Search items, IDs,
 * labels or views…", then grouped results. ↑↓ move, Enter opens, Esc closes.
 * The caller supplies the groups (US2 T084 fills item and label results).
 */
export function CommandPalette({
  query,
  onQueryChange,
  groups,
  onClose,
  status,
}: {
  query: string;
  onQueryChange: (q: string) => void;
  groups: readonly PaletteGroup[];
  onClose: () => void;
  /** A line under the results: loading, error or "No matches". */
  status?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const listId = useId();
  const [hi, setHi] = useState(0);
  const flat = groups.flatMap((g) => g.options);
  const index = flat.length === 0 ? -1 : Math.min(hi, flat.length - 1);
  const optionId = (k: number) => `${listId}-o${k}`;
  useFocusTrap(ref, {
    onEscape: onClose,
    initial: (root) => root.querySelector<HTMLElement>('input'),
  });

  const choose = (opt: PaletteOption | undefined) => {
    if (!opt) return;
    onClose();
    opt.onSelect();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (flat.length) setHi((index + 1) % flat.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (flat.length) setHi((index - 1 + flat.length) % flat.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(flat[index]);
    }
  };

  const visible = groups.filter((g) => g.options.length > 0);
  const starts = visible.map((_, gi) =>
    visible.slice(0, gi).reduce((n, g) => n + g.options.length, 0),
  );
  const node = (
    <div
      className="ov"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        className="dlg pal"
        role="dialog"
        aria-modal="true"
        aria-label="Search or jump to"
        tabIndex={-1}
      >
        <input
          className="palq"
          role="combobox"
          aria-expanded={flat.length > 0}
          aria-controls={listId}
          aria-activedescendant={index >= 0 ? optionId(index) : undefined}
          aria-autocomplete="list"
          aria-label="Search"
          placeholder="Search items, IDs, labels or views…"
          autoComplete="off"
          value={query}
          onChange={(e) => {
            setHi(0);
            onQueryChange(e.target.value);
          }}
          onKeyDown={onKeyDown}
        />
        <div className="res" id={listId} role="listbox" aria-label="Results">
          {visible.map((g, gi) => (
            <div key={g.label} role="group" aria-label={g.label}>
              <div className="grp" aria-hidden="true">
                {g.label}
              </div>
              {g.options.map((o, oi) => {
                const mine = starts[gi]! + oi;
                return (
                  <div
                    key={o.key}
                    id={optionId(mine)}
                    role="option"
                    aria-selected={mine === index}
                    onMouseMove={() => setHi(mine)}
                    onClick={() => choose(o)}
                  >
                    <span className="grow">{o.label}</span>
                    {o.archived && <span className="chip c-gray">Archived</span>}
                    {o.meta}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        {status && <div className="pad muted">{status}</div>}
        <div className="pad src palfoot">↑↓ to move · Enter to open · Esc to close</div>
      </div>
    </div>
  );
  return typeof document === 'undefined' ? node : createPortal(node, document.body);
}

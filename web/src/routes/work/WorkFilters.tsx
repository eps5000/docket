import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import {
  DEFAULT_WORK_FILTER,
  WORK_CHECK_FILTERS,
  WORK_QUICK_FILTERS,
  WORK_SHOW_FILTERS,
  isDefaultWorkFilter,
  toggleWorkFilter,
  type EpicCard,
  type WorkCheck,
  type WorkFilter,
  type WorkResponse,
  type WorkShow,
} from '@docket/shared';
import { Button, FilterChip, Icon } from '../../components/kit';
import { useShell } from '../../app/ShellState';
import { useBootstrap } from '../../app/useBootstrap';

type Counts = WorkResponse['filter_counts'] | undefined;

/** The Filters menu's entries: the checks it lists now, then the two shows. */
export function menuEntries(filter: WorkFilter, counts: Counts) {
  const archivedAny = (counts?.archived ?? 0) > 0 || filter.has.includes('archived');
  return {
    checks: WORK_CHECK_FILTERS.filter(
      (c) => c.menu === 'always' || (c.menu === 'when-any' && archivedAny),
    ),
    shows: WORK_SHOW_FILTERS,
  };
}

/** The pills: every ticked check (URL-only ones included) and show, in menu order. */
export function activePills(filter: WorkFilter) {
  return [
    ...WORK_CHECK_FILTERS.filter((c) => filter.has.includes(c.key)).map((c) => ({
      key: c.key as WorkCheck | WorkShow,
      label: c.label,
    })),
    ...WORK_SHOW_FILTERS.filter((s) => filter.show.includes(s.key)).map((s) => ({
      key: s.key as WorkCheck | WorkShow,
      label: s.label,
    })),
  ];
}

/**
 * The filter row (UI_SPEC §6.2; B43): Epic select, Label select, the quick
 * filters (Active, Blocked, In progress) as chips with counts, the *Filters*
 * menu (checkboxes), a removable pill per ticked filter, and *Clear*.
 */
export function WorkFilters({
  filter,
  epic,
  label,
  epics,
  counts,
  onChange,
  onFilter,
}: {
  filter: WorkFilter;
  epic?: string;
  label?: string;
  epics: readonly EpicCard[];
  counts: Counts;
  onChange: (patch: Record<string, string | undefined>) => void;
  onFilter: (f: WorkFilter) => void;
}) {
  const { scope } = useShell();
  const boot = useBootstrap();
  const epicId = useId();
  const labelId = useId();
  const labels = (boot.data?.labels ?? []).filter((l) => scope === 'all' || l.project === scope);
  const pills = activePills(filter);
  return (
    <div className="filters" data-work-filters="">
      <label className="sr" htmlFor={epicId}>
        Epic
      </label>
      <select id={epicId} value={epic ?? ''} onChange={(e) => onChange({ epic: e.target.value })}>
        <option value="">All epics</option>
        {epics.map((e) => (
          <option key={e.id} value={e.id}>
            {e.title}
          </option>
        ))}
        {epic && !epics.some((e) => e.id === epic) && <option value={epic}>{epic}</option>}
      </select>
      <label className="sr" htmlFor={labelId}>
        Label
      </label>
      <select
        id={labelId}
        value={label ?? ''}
        onChange={(e) => onChange({ label: e.target.value })}
      >
        <option value="">All labels</option>
        {labels.map((l) => (
          <option key={`${l.project}:${l.name}`} value={l.name}>
            # {l.name}
          </option>
        ))}
        {label && !labels.some((l) => l.name === label) && <option value={label}># {label}</option>}
      </select>
      <span role="group" aria-label="Quick filters" className="row wrap" style={{ gap: 6 }}>
        {WORK_QUICK_FILTERS.map((q) => (
          <FilterChip
            key={q.key}
            label={q.label}
            count={counts?.quick[q.key]}
            pressed={filter.quick === q.key}
            title={`Agent query: ${q.query}`}
            onClick={() => onFilter({ ...filter, quick: q.key })}
          />
        ))}
      </span>
      <FiltersMenu filter={filter} counts={counts} onFilter={onFilter} />
      {pills.length > 0 && (
        <span role="group" aria-label="Active filters" className="row wrap" style={{ gap: 6 }}>
          {pills.map((p) => (
            <button
              key={p.key}
              type="button"
              className="chip c-info fchip"
              data-pill={p.key}
              aria-label={`Remove the filter: ${p.label}`}
              title={`Remove: ${p.label}`}
              onClick={() => onFilter(toggleWorkFilter(filter, p.key))}
            >
              {p.label}
              <span aria-hidden="true" className="fchip-x">
                ×
              </span>
            </button>
          ))}
        </span>
      )}
      {!isDefaultWorkFilter(filter) && (
        <Button
          variant="ghost"
          size="sm"
          title="Back to Active, with nothing ticked"
          onClick={() => onFilter(DEFAULT_WORK_FILTER)}
        >
          Clear
        </Button>
      )}
    </div>
  );
}

/**
 * The *Filters* menu button (ARIA menu button): `aria-haspopup="menu"`, a
 * `menu` of `menuitemcheckbox`es. Enter, Space or Down opens it on the first
 * entry (Up: the last); Up, Down, Home and End move; Enter or Space ticks and
 * keeps it open; Escape closes it and returns to the button; Tab closes it.
 * A badge counts the ticked entries.
 */
export function FiltersMenu({
  filter,
  counts,
  onFilter,
}: {
  filter: WorkFilter;
  counts: Counts;
  onFilter: (f: WorkFilter) => void;
}) {
  const [open, setOpen] = useState<false | 'first' | 'last'>(false);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const { checks, shows } = menuEntries(filter, counts);
  const ticked = filter.has.length + filter.show.length;

  useEffect(() => {
    if (!open) return;
    const entries = menu.current?.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]');
    (open === 'last' ? entries?.[entries.length - 1] : entries?.[0])?.focus();
    const onDown = (e: MouseEvent) => {
      if (!menu.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node))
        setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const close = (focusButton = true) => {
    setOpen(false);
    if (focusButton) button.current?.focus();
  };
  const onButtonKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setOpen(e.key === 'ArrowUp' ? 'last' : 'first');
    }
  };
  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const entries = Array.from(
      menu.current?.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]') ?? [],
    );
    const i = entries.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      entries[(i + 1) % entries.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      entries[(i - 1 + entries.length) % entries.length]?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      entries[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      entries[entries.length - 1]?.focus();
    } else if (e.key === 'Tab') {
      close(false);
    }
  };
  const entry = (key: WorkCheck | WorkShow, text: string, checked: boolean, count?: number) => (
    <button
      key={key}
      type="button"
      role="menuitemcheckbox"
      aria-checked={checked}
      tabIndex={-1}
      data-entry={key}
      onClick={() => onFilter(toggleWorkFilter(filter, key))}
    >
      <span className="fbox" aria-hidden="true">
        {checked && <Icon name="check" small />}
      </span>
      <span className="grow">{text}</span>
      {count !== undefined && <span className="fcount">{count}</span>}
    </button>
  );

  return (
    <span className="fmenuwrap">
      <button
        ref={button}
        type="button"
        className="fchip fmenubtn"
        aria-haspopup="menu"
        aria-expanded={!!open}
        aria-controls={open ? menuId : undefined}
        title="More filters: for you, reviews, live runs, problems, done and canceled"
        onClick={() => (open ? close(false) : setOpen('first'))}
        onKeyDown={onButtonKey}
      >
        Filters{' '}
        {ticked > 0 && (
          <span className="fbadge">
            {ticked}
            <span className="sr"> on</span>
          </span>
        )}
        <Icon name="chev" small />
      </button>
      {open && (
        <div
          ref={menu}
          id={menuId}
          className="fmenu"
          role="menu"
          aria-label="Filters"
          onKeyDown={onMenuKey}
        >
          {checks.map((c) => entry(c.key, c.label, filter.has.includes(c.key), counts?.has[c.key]))}
          <div role="separator" className="fmenusep" />
          {shows.map((s) =>
            entry(s.key, s.label, filter.show.includes(s.key), counts?.show[s.key]),
          )}
        </div>
      )}
    </span>
  );
}

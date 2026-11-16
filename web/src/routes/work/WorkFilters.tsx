import { useId } from 'react';
import { FILTERS, type EpicCard, type UI_FILTER_KEYS, type WorkResponse } from '@tasklite/shared';
import { FilterChip } from '../../components/kit';
import { useShell } from '../../app/ShellState';
import { useBootstrap } from '../../app/useBootstrap';

type UiFilter = (typeof UI_FILTER_KEYS)[number];

/** Not chips, but applicable from the URL; shown as an active chip then (UI_SPEC §6.2). */
const URL_ONLY: readonly UiFilter[] = ['planning', 'ready_to_start'];

/** The chips to show: hide URL-only filters unless active, and Archived unless something is archived or it's active. */
export function visibleChips(filter: UiFilter, counts: WorkResponse['filter_counts'] | undefined) {
  return FILTERS.filter((f) => f.ui)
    .map((f) => f as (typeof FILTERS)[number] & { key: UiFilter })
    .filter((f) => {
      if (f.key === filter) return true;
      if (URL_ONLY.includes(f.key)) return false;
      if (f.key === 'archived') return (counts?.archived ?? 0) > 0;
      return true;
    });
}

/**
 * The filter row (UI_SPEC §6.2): Epic select, Label select, and saved-filter
 * chips with counts, each titled "Agent query: <query>" (BUILD_SPEC §13).
 */
export function WorkFilters({
  filter,
  epic,
  label,
  epics,
  counts,
  onChange,
}: {
  filter: UiFilter;
  epic?: string;
  label?: string;
  epics: readonly EpicCard[];
  counts: WorkResponse['filter_counts'] | undefined;
  onChange: (patch: Record<string, string | undefined>) => void;
}) {
  const { scope } = useShell();
  const boot = useBootstrap();
  const epicId = useId();
  const labelId = useId();
  const labels = (boot.data?.labels ?? []).filter((l) => scope === 'all' || l.project === scope);
  return (
    <div className="filters">
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
      <span role="group" aria-label="Saved filters" className="row wrap" style={{ gap: 6 }}>
        {visibleChips(filter, counts).map((f) => (
          <FilterChip
            key={f.key}
            label={f.label}
            count={counts?.[f.key]}
            pressed={filter === f.key}
            title={f.query ? `Agent query: ${f.query}` : undefined}
            onClick={() => onChange({ filter: f.key })}
          />
        ))}
      </span>
    </div>
  );
}

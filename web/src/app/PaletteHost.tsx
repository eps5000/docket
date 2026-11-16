import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { CommandPalette, StatusChip, isNotBuilt, type PaletteGroup } from '../components/kit';
import { queryKeys } from '../lib/api';
import { paths } from '../lib/paths';
import { apiClient } from './queryClient';
import { useShell } from './ShellState';

/** The "Go to" views (UI_SPEC §6.9). */
export const GO_TO_VIEWS = [
  { key: 'needs-you', label: 'Needs you', path: paths.needsYou() },
  { key: 'work', label: 'Work', path: paths.work() },
  { key: 'timeline', label: 'Timeline (Work)', path: paths.work({ layout: 'timeline' }) },
  { key: 'agents', label: 'Agents', path: paths.agents() },
  { key: 'settings', label: 'Settings: projects and connections', path: paths.settings() },
] as const;

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/**
 * The command palette (`Ctrl K`, `/`, or the header Search). Item and label
 * results come from `GET /api/search` (US2 T084 fills it); "Go to" is local.
 */
export function PaletteHost() {
  const { paletteOpen, setPaletteOpen } = useShell();
  if (!paletteOpen) return null;
  return <Palette onClose={() => setPaletteOpen(false)} />;
}

function Palette({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const term = useDebounced(q.trim(), 150);
  const search = useQuery({
    queryKey: queryKeys.search(term),
    queryFn: () => apiClient['search.get']({ query: { q: term } }),
    enabled: term.length > 0,
  });
  const lower = q.trim().toLowerCase();
  const groups: PaletteGroup[] = [
    {
      label: 'Work items',
      options: (search.data?.items ?? []).map((i) => ({
        key: `item:${i.id}`,
        label: (
          <span className="row" style={{ gap: 10 }}>
            <span className="mono muted" style={{ width: 64 }}>
              {i.id}
            </span>
            <span className="grow one">{i.title}</span>
          </span>
        ),
        meta: (
          <>
            {i.jira_key && <span className="src mono">{i.jira_key}</span>}
            <span className="src">{i.project}</span>
            <StatusChip status={i.status} />
          </>
        ),
        archived: i.archived,
        onSelect: () => navigate(paths.item(i.id)),
      })),
    },
    {
      label: 'Labels',
      options: (search.data?.labels ?? []).map((l) => ({
        key: `label:${l.project}:${l.name}`,
        label: `# ${l.name}`,
        meta: <span className="src">{l.project}</span>,
        onSelect: () => navigate(paths.label(l.project, l.name)),
      })),
    },
    {
      label: 'Go to',
      options: GO_TO_VIEWS.filter((v) => !lower || v.label.toLowerCase().includes(lower)).map(
        (v) => ({ key: `view:${v.key}`, label: v.label, onSelect: () => navigate(v.path) }),
      ),
    },
  ];
  const total = groups.reduce((n, g) => n + g.options.length, 0);
  const status =
    term && search.isError
      ? isNotBuilt(search.error)
        ? 'Item and label search isn’t built yet.'
        : `Search failed: ${(search.error as Error).message}`
      : total === 0
        ? 'No matches.'
        : undefined;
  return (
    <CommandPalette
      query={q}
      onQueryChange={setQ}
      groups={groups}
      onClose={onClose}
      status={status}
    />
  );
}

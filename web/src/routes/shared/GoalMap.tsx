import { useQuery } from '@tanstack/react-query';
import { useId, useMemo } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router';
import {
  STATUS_LABELS,
  type CriticalNextReason,
  type CriticalPathResponse,
  type LinkEdge,
} from '@docket/shared';
import { Button, Callout, Chip, Skeleton, type ChipKind } from '../../components/kit';
import { ProgressMap, type CriticalOverlay, type MapItem } from '../../components/ProgressMap';
import { apiClient } from '../../app/queryClient';
import { QueryState } from '../../app/QueryState';
import { HelpLink } from '../../help/HelpLink';
import { queryKeys } from '../../lib/api';
import { plural } from '../../lib/format';
import { paths } from '../../lib/paths';

/** The reason as a short label. Always words, never colour alone. */
export const NEXT_REASON: Record<CriticalNextReason, { label: string; kind: ChipKind }> = {
  startable: { label: 'Ready to start', kind: 'ok' },
  unowned: { label: 'Nobody owns it', kind: 'warn' },
  active: { label: 'An agent has it', kind: 'info' },
  parked: { label: 'Parked', kind: 'warn' },
  waiting_on_owner: { label: 'Waiting on you', kind: 'warn' },
  waiting_merge: { label: 'Waiting to merge', kind: 'info' },
  canceled: { label: 'Canceled blocker', kind: 'bad' },
  cycle: { label: 'Blocker loop', kind: 'bad' },
};

/**
 * What the map needs to show a chain. Chain tickets the view doesn't include
 * are added to the map as outside cards, so the whole chain is always visible.
 */
export function criticalOverlay(
  data: CriticalPathResponse | undefined,
  items: readonly MapItem[],
  links: readonly LinkEdge[],
): CriticalOverlay | null {
  if (!data || data.chain.length === 0) return null;
  const inView = new Set(items.map((i) => i.id));
  const known = new Set(links.map((l) => l.link_id));
  return {
    steps: new Map(data.chain.map((s, i) => [s.item.id, i + 1])),
    total: data.chain.length,
    next: data.next?.id ?? null,
    linkIds: new Set(data.links.map((l) => l.link_id)),
    extras: data.chain.map((s) => s.item).filter((i) => !inView.has(i.id)),
    links: [...links, ...data.links.filter((l) => !known.has(l.link_id))],
  };
}

/** The chain's words: the ticket to move next and why, then the chain as an ordered list. */
function ChainSummary({ data }: { data: CriticalPathResponse }) {
  const { goal, next, chain } = data;
  if (data.state === 'finished') {
    return <p className="src">{goal.id} is finished. Nothing is holding it up.</p>;
  }
  if (!next) return <p className="src">Nothing open is left in {goal.id}.</p>;
  const first = chain[0]!.item;
  const reason = NEXT_REASON[next.reason];
  return (
    <>
      <p className="cp-next" data-critical-next={next.id} data-critical-reason={next.reason}>
        <b>Move next:</b>{' '}
        <Link className="mono" to={paths.item(next.id)}>
          {next.id}
        </Link>{' '}
        {first.title} <Chip kind={reason.kind}>{reason.label}</Chip>
        <span className="cp-why">{next.why}</span>
      </p>
      <p className="src">
        {data.state === 'clear'
          ? `Nothing open blocks ${goal.id}.`
          : `The longest chain is ${plural(chain.length, 'ticket')}. ${plural(
              data.open_blockers,
              'open blocker',
            )} in all hold up ${goal.id}.`}
      </p>
      {data.cycles.map((c) => (
        <Callout key={c.join()} tone="bad" className="mb">
          {c.join(', ')} block each other, so none of them can finish until one link is removed.
        </Callout>
      ))}
      <details className="cp-list">
        <summary>The chain as a list ({plural(chain.length, 'ticket')})</summary>
        <ol aria-label={`Chain holding up ${goal.id}, first ticket to move first`}>
          {chain.map(({ item, in_cycle }) => (
            <li key={item.id}>
              <Link className="mono" to={paths.item(item.id)}>
                {item.id}
              </Link>{' '}
              {item.title}{' '}
              <span className="muted">
                · {STATUS_LABELS[item.status]}
                {in_cycle ? ' · in a blocker loop' : ''}
                {item.id === next.id ? ' · move this next' : ''}
              </span>
            </li>
          ))}
        </ol>
      </details>
    </>
  );
}

/**
 * The progress map with a goal (owner decision 48; UI_SPEC §6.3.4). Choosing a
 * ticket or epic highlights the longest chain of open blockers to it, mutes the
 * rest and names the one ticket to move next. `?goal=` holds the choice.
 */
export function GoalMap({
  items,
  outside,
  links,
  outsideTitle,
  home,
  goals,
}: {
  items: readonly MapItem[];
  outside: readonly MapItem[];
  links: readonly LinkEdge[];
  outsideTitle: string;
  home?: { project: string } | null;
  /** Epics or other goals to offer besides the tickets on the map. */
  goals?: readonly { id: string; title: string }[];
}) {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const selectId = useId();
  const goal = params.get('goal');
  const query = useQuery({
    queryKey: queryKeys.criticalPath(goal ?? ''),
    queryFn: () => apiClient['items.criticalPath']({ params: { id: goal! } }),
    enabled: !!goal,
  });
  const overlay = useMemo(
    () => (goal ? criticalOverlay(query.data, items, links) : null),
    [goal, query.data, items, links],
  );
  const options = useMemo(() => {
    const out = new Map<string, string>();
    for (const g of goals ?? []) out.set(g.id, g.title);
    for (const i of items) {
      if (i.status !== 'done' && i.status !== 'canceled') out.set(i.id, i.title);
    }
    return [...out].sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }));
  }, [goals, items]);

  const choose = (id: string) => {
    const next = new URLSearchParams(params);
    if (id) next.set('goal', id);
    else next.delete('goal');
    setParams(next, { replace: true, state: location.state as unknown });
  };
  const listed = !goal || options.some(([id]) => id === goal);

  return (
    <>
      <div className="cp-panel" data-critical-path="">
        <div className="cp-head">
          <label htmlFor={selectId}>What’s holding up</label>
          <select id={selectId} value={goal ?? ''} onChange={(e) => choose(e.target.value)}>
            <option value="">Choose a goal…</option>
            {!listed && goal && <option value={goal}>{query.data?.goal.title ?? goal}</option>}
            {options.map(([id, title]) => (
              <option key={id} value={id}>
                {id} · {title.length > 60 ? `${title.slice(0, 59)}…` : title}
              </option>
            ))}
          </select>
          {goal && (
            <Button size="sm" onClick={() => choose('')}>
              Clear goal
            </Button>
          )}
          <HelpLink anchor="map.criticalPath" />
        </div>
        {goal && (
          <QueryState query={query} skeleton={<Skeleton lines={2} label="Finding the chain" />}>
            {(d) => <ChainSummary data={d} />}
          </QueryState>
        )}
      </div>
      <ProgressMap
        items={items}
        outside={outside}
        links={overlay?.links ?? links}
        outsideTitle={outsideTitle}
        home={home}
        critical={overlay}
      />
    </>
  );
}

import { useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import type { ItemDetailResponse, LinkEdge, LinkRef } from '@docket/shared';
import { Button, Callout, Card, EmptyState } from '../../components/kit';
import {
  MapCard,
  cyclePath,
  cyclesIn,
  impliedOnMap,
  layoutMap,
  readHideImplied,
  throughText,
  type MapItem,
} from '../../components/ProgressMap';
import { apiClient } from '../../app/queryClient';
import { queryKeys } from '../../lib/api';
import { paths } from '../../lib/paths';
import { runOwnerMutation, showToast } from '../../lib/undo';
import { HelpLink } from '../../help/HelpLink';

/**
 * Dependencies (ticket; UI_SPEC §6.3, §6.3.3): a plain card with "Waits on n
 * · unblocks n", the 1-hop view (map cards), the cycle callout with
 * *Remove "A blocks B"* per cycle link, a canceled blocker's *Remove link*,
 * "Relates to", and *See it on the epic map →*.
 *
 * A done blocker that still blocks says what it waits for ("done · waiting
 * for merge"), with the link's rule in `title`. The merge is agent-reported
 * in V1, and the title says so (Principle III).
 *
 * Decision 60: every dependency stays listed; one the epic map hides as
 * implied gets a quiet "Also implied through GF-2".
 */
export function DependenciesTab({ data }: { data: ItemDetailResponse }) {
  const { item } = data;
  const waits = item.links.blocked_by;
  const unblocks = item.links.blocks;
  const cards = new Map(data.outside.map((o) => [o.id, o as MapItem]));
  const cycles = cyclesIn(data.links).filter((c) => c.includes(item.id));
  const canceled = waits.filter((l) => l.status === 'canceled');
  const implied = useEpicMapImplied(item.epic);
  const mark = (l: LinkRef) =>
    l.project !== item.project
      ? { label: `${l.project} ↗` }
      : item.epic && cards.get(l.id)?.epic !== item.epic
        ? { label: 'other epic ↗' }
        : null;

  const node = (l: LinkRef, blocker: boolean) => {
    const through = implied?.get(l.link_id);
    if (!through) return nodeCard(l, blocker);
    return (
      <div key={l.link_id} data-implied={l.id}>
        {nodeCard(l, blocker)}
        <div
          className="src pm-impliednote"
          title="The epic map hides this arrow: a chain of other links already connects these tickets."
        >
          Also implied through {throughText(through)}
        </div>
      </div>
    );
  };
  const nodeCard = (l: LinkRef, blocker: boolean) => {
    const card = cards.get(l.id);
    if (!card) {
      return (
        <Link key={l.link_id} to={paths.item(l.id)} className="pm-node">
          <span className="mono muted">{l.id}</span> <span className="pm-title">{l.title}</span>
        </Link>
      );
    }
    return (
      <MapCard
        key={l.link_id}
        item={card}
        outside={mark(l)}
        waiting={blocker ? waitingOf(l) : null}
      />
    );
  };

  return (
    <Card padded data-section="deps">
      <div className="withhelp wh-h3">
        <h3>
          Waits on {waits.length} · unblocks {unblocks.length}
        </h3>
        <HelpLink anchor="item.dependencies" />
      </div>
      {cycles.map((c) => (
        <CycleCallout key={c.join()} itemId={item.id} component={c} links={data.links} />
      ))}
      {canceled.map((l) => (
        <Callout key={l.link_id} tone="bad" className="mb">
          <div>
            Blocked by canceled {l.id}. A canceled blocker never clears on its own; remove the link
            or reopen {l.id}.
          </div>
          <div className="row wrap" style={{ marginTop: 6 }}>
            <RemoveLink
              itemId={item.id}
              link={{ link_id: l.link_id, from: l.id, to: item.id }}
              success={`Removed “${l.id} blocks ${item.id}”.`}
            />
          </div>
        </Callout>
      ))}
      {waits.length === 0 && unblocks.length === 0 ? (
        <EmptyState text="No blocking links." />
      ) : (
        <div className="pm-hop" data-hop="">
          {waits.length > 0 && (
            <>
              <div className="src">Waits on</div>
              {waits.map((l) => node(l, true))}
              <div className="arrow" aria-hidden="true">
                ↓
              </div>
            </>
          )}
          <MapCard item={item} current />
          {unblocks.length > 0 && (
            <>
              <div className="arrow" aria-hidden="true">
                ↓
              </div>
              <div className="src">Then unblocks</div>
              {unblocks.map((l) => node(l, false))}
            </>
          )}
        </div>
      )}
      {item.links.relates.length > 0 && (
        <div className="src" style={{ marginTop: 8 }}>
          Relates to (doesn’t block):{' '}
          {item.links.relates.map((l, n) => (
            <span key={l.link_id}>
              {n > 0 && ', '}
              <Link to={paths.item(l.id)} className="mono">
                {l.id}
              </Link>
            </span>
          ))}
        </div>
      )}
      {item.epic && (
        <Link className="btn ghost sm seemap" to={paths.item(item.epic, 'map')}>
          See it on the epic map →
        </Link>
      )}
      {waits.length > 0 && (
        <Link className="btn ghost sm seemap" to={paths.criticalPath(item.id, item.epic)}>
          See what’s holding this up →
        </Link>
      )}
    </Card>
  );
}

/** "done · waiting for merge" on a done blocker that still blocks (UI_SPEC §6.3.3). */
export function waitingOf(l: LinkRef): { label: string; title: string } | null {
  if (l.cleared !== false || l.status !== 'done') return null;
  if (l.waiting_for === 'merge') {
    return {
      label: 'waiting for merge',
      title: `This link needs ${l.id}'s PR merged (reported by the agent).`,
    };
  }
  if (l.waiting_for === 'verification') {
    return {
      label: 'waiting for your verification',
      title: `This link needs ${l.id} verified by you: every human review item approved, none deferred.`,
    };
  }
  return null;
}

function CycleCallout({
  itemId,
  component,
  links,
}: {
  itemId: string;
  component: string[];
  links: readonly LinkEdge[];
}) {
  const members = new Set(component);
  const path = cyclePath(component, links);
  const inCycle = links.filter(
    (l) => l.type === 'blocks' && members.has(l.from) && members.has(l.to),
  );
  return (
    <Callout tone="bad" className="mb">
      <div data-cycle={component.join(' ')}>
        {itemId} is in a dependency cycle: {path.join(' → ')}. None of them can start until one link
        is removed.
      </div>
      <div className="row wrap" style={{ marginTop: 6, gap: 6 }}>
        {inCycle.map((l) => (
          <RemoveLink
            key={l.link_id}
            itemId={itemId}
            link={l}
            label={`Remove “${l.from} blocks ${l.to}”`}
            success={`Removed “${l.from} blocks ${l.to}”. Cycle resolved.`}
          />
        ))}
      </div>
    </Callout>
  );
}

function RemoveLink({
  itemId,
  link,
  label = 'Remove link',
  success,
}: {
  itemId: string;
  link: { link_id: string; from: string; to: string };
  label?: string;
  success: string;
}) {
  const qc = useQueryClient();
  const remove = async () => {
    try {
      await runOwnerMutation(
        () => apiClient['links.delete']({ params: { linkId: link.link_id } }),
        { success, refetch: [queryKeys.item(itemId)] },
      );
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Couldn’t remove the link. Try again.');
    }
    await qc.invalidateQueries({ queryKey: queryKeys.all });
  };
  return (
    <Button size="sm" variant="danger-text" onClick={() => void remove()}>
      {label}
    </Button>
  );
}

/**
 * The links the epic's map hides as implied (decision 60), worked out from the
 * epic's own map data with the map's own code; null without an epic, while it
 * loads, or when this viewer shows implied links.
 */
function useEpicMapImplied(epic: string | null): Map<string, string[]> | null {
  const on = readHideImplied();
  const query = useQuery({
    queryKey: queryKeys.item(epic ?? ''),
    queryFn: () => apiClient['items.get']({ params: { id: epic! } }),
    enabled: on && epic !== null,
  });
  const data = query.data;
  return useMemo(
    () => (on && data ? impliedOnMap(layoutMap(data.children, data.outside, data.links)) : null),
    [on, data],
  );
}

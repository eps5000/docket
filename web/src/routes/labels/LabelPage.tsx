import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import type { LabelPageResponse, LinkEdge } from '@docket/shared';
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  Skeleton,
  StatusChip,
  TypeIcon,
} from '../../components/kit';
import { apiClient } from '../../app/queryClient';
import { useBreadcrumb } from '../../app/ShellState';
import { queryKeys } from '../../lib/api';
import { formatDay, isoTitle, plural } from '../../lib/format';
import { paths } from '../../lib/paths';
import { runOwnerMutation, showToast } from '../../lib/undo';
import { Markdown } from '../shared/Markdown';
import { ProgressMapShell } from '../shared/ProgressMapShell';
import { DecisionsPanel } from '../shared/DecisionsPanel';
import '../screens.css';

/**
 * The label page (`/labels/:project/:name`, UI_SPEC §6.5): header row with
 * *Show on the board* and *Move N to Ready*; then Brief, Progress across
 * epics, By epic, and Decisions. US7 (T127) fills it, with *Move N to
 * Ready* (undoable); US5 (B12) fills Decisions, which load on their own so
 * they show even before the rest of the page.
 */
export function LabelPage() {
  const { project = '', name = '' } = useParams();
  const queryClient = useQueryClient();
  const [moving, setMoving] = useState(false);
  const query = useQuery({
    queryKey: queryKeys.label(project, name),
    queryFn: () => apiClient['labels.get']({ params: { project, name } }),
  });
  useBreadcrumb({
    crumbs: [
      { kind: 'link', text: 'Work', to: paths.work() },
      { kind: 'current', text: `#${name}` },
    ],
  });
  const data = query.data;
  const moveToReady = async (n: number) => {
    setMoving(true);
    try {
      const res = await runOwnerMutation(
        () => apiClient['labels.moveToReady']({ params: { project, name } }),
        { success: (r) => `Moved ${plural(r.moved.length, 'item')} with #${name} to Ready.` },
      );
      if (res) await queryClient.invalidateQueries({ queryKey: queryKeys.all });
    } catch (err) {
      showToast(
        err instanceof Error && err.message
          ? err.message
          : `Couldn’t move ${n} to Ready. Try again.`,
      );
    } finally {
      setMoving(false);
    }
  };
  return (
    <div className="labelpage">
      <div className="row wrap headrow">
        <h1>
          <span className="muted">#</span>
          {name}{' '}
          {data && (
            <span className="src" style={{ fontWeight: 400 }}>
              {project} · {data.counts.done}/{data.counts.total} done
            </span>
          )}
        </h1>
        <span className="row">
          <Link className="btn sm" to={paths.work({ label: name })}>
            Show on the board
          </Link>
          {data && data.counts.planning > 0 && (
            <Button
              size="sm"
              variant="primary"
              icon="promote"
              disabled={moving}
              onClick={() => void moveToReady(data.counts.planning)}
            >
              Move {data.counts.planning} to Ready
            </Button>
          )}
        </span>
      </div>
      <div className="stack1">
        {query.isError ? (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        ) : !data ? (
          <div className="card pad">
            <Skeleton lines={4} label="Loading the label" />
          </div>
        ) : (
          <LabelBody data={data} />
        )}
        <LabelDecisions project={project} name={name} />
      </div>
    </div>
  );
}

/** Decisions: the label's own records (UI_SPEC §6.5, §6.3.5). */
function LabelDecisions({ project, name }: { project: string; name: string }) {
  const q = { project, scope_kind: 'label' as const, scope_id: name, include_inactive: true };
  const query = useQuery({
    queryKey: queryKeys.decisions(q),
    queryFn: () => apiClient['decisions.list']({ query: q }),
  });
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  if (!query.data)
    return (
      <div className="card pad">
        <Skeleton lines={2} label="Loading decisions" />
      </div>
    );
  return <DecisionsPanel place={{ kind: 'label', project, name }} records={query.data.items} />;
}

/** The label page has no links of its own; one stable array keeps the map from re-measuring. */
const NO_LINKS: readonly LinkEdge[] = [];

function LabelBody({ data }: { data: LabelPageResponse }) {
  const all = useMemo(() => data.by_epic.flatMap((g) => g.items), [data]);
  return (
    <div className="stack1">
      <Card padded data-card="brief">
        <h3>Brief</h3>
        {data.label.brief_md ? (
          <>
            <Markdown text={data.label.brief_md} />
            {data.label.brief_by && data.label.brief_at && (
              <div className="src" title={isoTitle(data.label.brief_at)}>
                written by {data.label.brief_by} · {formatDay(data.label.brief_at)}
              </div>
            )}
          </>
        ) : (
          <EmptyState text="No brief. Add one if this label is an initiative with shared decisions." />
        )}
      </Card>
      <Card padded data-card="progress">
        <h3>Progress across epics</h3>
        {all.length === 0 ? (
          <EmptyState text="Nothing has this label." />
        ) : (
          <ProgressMapShell items={all} links={NO_LINKS} outsideTitle="Without this label" />
        )}
      </Card>
      <Card padded data-card="by-epic">
        <h3>By epic</h3>
        {data.by_epic.length === 0 ? (
          <EmptyState text="Nothing has this label." />
        ) : (
          data.by_epic.map((g) => (
            <div key={g.epic?.id ?? 'none'}>
              <div className="src" style={{ marginTop: 12, fontWeight: 650 }}>
                {g.epic ? `◆ ${g.epic.title}` : 'No epic'} · {g.done}/{g.total}
              </div>
              {g.items.map((i) => (
                <div className="lrow" key={i.id}>
                  <TypeIcon type={i.type} />
                  <Link className="mono" to={paths.item(i.id)}>
                    {i.id}
                  </Link>
                  <span className="grow one">{i.title}</span>
                  <StatusChip status={i.status} />
                </div>
              ))}
            </div>
          ))
        )}
      </Card>
    </div>
  );
}
// b65 proof

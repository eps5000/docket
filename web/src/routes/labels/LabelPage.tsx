import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import type { LabelPageResponse } from '@tasklite/shared';
import {
  Button,
  Card,
  DecisionRow,
  EmptyState,
  ErrorState,
  Skeleton,
  StatusChip,
  TypeIcon,
} from '../../components/kit';
import { apiClient } from '../../app/queryClient';
import { useBreadcrumb } from '../../app/ShellState';
import { queryKeys } from '../../lib/api';
import { paths } from '../../lib/paths';
import { ProgressMapShell } from '../shared/ProgressMapShell';
import '../screens.css';

/**
 * The label page (`/labels/:project/:name`, UI_SPEC §6.5): header row with
 * *Show on the board* and *Move N to Ready*; then Brief, Progress across
 * epics, By epic, and Decisions. US7 fills it.
 */
export function LabelPage() {
  const { project = '', name = '' } = useParams();
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
            <Button size="sm" variant="primary" icon="promote" disabled title="Lands with US7">
              Move {data.counts.planning} to Ready
            </Button>
          )}
        </span>
      </div>
      {query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : !data ? (
        <div className="card pad">
          <Skeleton lines={4} label="Loading the label" />
        </div>
      ) : (
        <LabelBody data={data} />
      )}
    </div>
  );
}

function LabelBody({ data }: { data: LabelPageResponse }) {
  const all = data.by_epic.flatMap((g) => g.items);
  return (
    <div className="stack1">
      <Card padded data-card="brief">
        <h3>Brief</h3>
        {data.label.brief_md ? (
          <div className="prose">{data.label.brief_md}</div>
        ) : (
          <EmptyState text="No brief. Add one if this label is an initiative with shared decisions." />
        )}
      </Card>
      <Card padded data-card="progress">
        <h3>Progress across epics</h3>
        {all.length === 0 ? (
          <EmptyState text="Nothing has this label." />
        ) : (
          <ProgressMapShell items={all} links={[]} outsideTitle="Without this label" />
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
      <Card padded data-card="decisions">
        <h3>Decisions</h3>
        {data.decisions.length === 0 ? (
          <EmptyState text="No decisions recorded. Agents record conventions and choices here; yours are authoritative." />
        ) : (
          data.decisions.map((d) => <DecisionRow key={d.id} record={d} canAct={false} />)
        )}
      </Card>
    </div>
  );
}

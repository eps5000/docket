import { useQuery } from '@tanstack/react-query';
import { Link, useParams, useSearchParams } from 'react-router';
import type { ReviewResponse } from '@tasklite/shared';
import { Button, Card, CardHeader, EmptyState, ErrorState, Skeleton } from '../../components/kit';
import { apiClient } from '../../app/queryClient';
import { useBreadcrumb } from '../../app/ShellState';
import { queryKeys } from '../../lib/api';
import { paths } from '../../lib/paths';
import '../screens.css';

/**
 * The human review packet (`/review/:id?round=`, UI_SPEC §6.4): three
 * columns `230px | 1fr | 300px` (queue · packet · decision), and at ≤ 1180px
 * the decision panel moves under the queue. Not in the sidebar; Needs you
 * stays the active nav item. US3 fills each column.
 */
export function PacketScreen() {
  const { id = '' } = useParams();
  const [params] = useSearchParams();
  const roundParam = Number(params.get('round'));
  const round = Number.isInteger(roundParam) && roundParam > 0 ? roundParam : undefined;
  const query = useQuery({
    queryKey: queryKeys.review(id, round),
    queryFn: () => apiClient['review.get']({ params: { id }, query: { round } }),
  });
  useBreadcrumb({
    crumbs: [
      { kind: 'link', text: 'Needs you', to: paths.needsYou() },
      { kind: 'current', text: `Human review · ${id}` },
    ],
  });
  const data = query.data;
  return (
    <div className="review">
      <h1>Human review</h1>
      <div className="rv" data-layout="packet">
        <PacketQueue data={data} loading={query.isPending} />
        <Card className="packet" data-column="packet">
          {query.isError ? (
            <div className="pad">
              <ErrorState error={query.error} onRetry={() => void query.refetch()} />
            </div>
          ) : !data ? (
            <div className="pad">
              <Skeleton lines={6} label="Loading the packet" />
            </div>
          ) : (
            <PacketBody data={data} />
          )}
        </Card>
        <DecisionPanel data={data} />
      </div>
    </div>
  );
}

/** Left: "Ready for you · N" packet buttons. Empty: "Nothing else is waiting on you." */
function PacketQueue({ data, loading }: { data?: ReviewResponse; loading: boolean }) {
  const queue = data?.queue ?? [];
  return (
    <Card className="rvq" data-column="queue">
      <CardHeader title={`Ready for you · ${queue.length}`} />
      {loading ? (
        <div className="pad">
          <Skeleton lines={2} label="Loading the queue" />
        </div>
      ) : queue.length === 0 ? (
        <EmptyState text="Nothing else is waiting on you." />
      ) : (
        queue.map((q) => (
          <Link key={q.item_id} className="rvqitem" to={paths.review(q.item_id)}>
            <span className="mono">{q.item_id}</span>
            <span style={{ fontWeight: 600 }}>{q.title}</span>
            <span className="src">about {q.estimate}</span>
          </Link>
        ))
      )}
    </Card>
  );
}

/** Middle: header, round buttons, then What you're verifying · How to verify · Already checked · Known gaps · Attachments. */
function PacketBody({ data }: { data: ReviewResponse }) {
  const p = data.packet;
  return (
    <>
      <div className="vers">
        <b>
          <Link to={paths.item(data.item.id)} className="mono">
            {data.item.id}
          </Link>{' '}
          {data.item.title}
        </b>
        <span className="src" style={{ marginLeft: 'auto' }}>
          {p.created_by} · <span className="mono">{p.display_id}</span> · about {p.estimate}
        </span>
      </div>
      <div className="doc">
        <section>
          <h2>What you’re verifying</h2>
          {p.items.map((it, n) => (
            <div className="hritem" key={it.hr_item_id}>
              <div style={{ fontWeight: 600 }}>
                {n + 1}. {it.text}
              </div>
            </div>
          ))}
        </section>
      </div>
    </>
  );
}

/** Right: "Your decision · round n", the outcome-named primary button and the callout. */
function DecisionPanel({ data }: { data?: ReviewResponse }) {
  const items = data?.packet.items ?? [];
  return (
    <div className="stack" data-column="decision">
      <Card padded>
        <h3>Your decision{data ? ` · round ${data.packet.round}` : ''}</h3>
        <div className="src">0 of {items.length} items decided</div>
        <Button variant="primary" className="wide" disabled>
          Decide every item first
        </Button>
      </Card>
    </div>
  );
}

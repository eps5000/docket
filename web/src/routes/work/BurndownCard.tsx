import { useQuery } from '@tanstack/react-query';
import { Card, CardHeader, EmptyState, Skeleton } from '../../components/kit';
import { apiClient } from '../../app/queryClient';
import { QueryState } from '../../app/QueryState';
import { useShell } from '../../app/ShellState';
import { queryKeys } from '../../lib/api';

/**
 * Remaining effort (UI_SPEC §9.1): the burn-down card, scoped by the same
 * Epic and Label filters. US8 fills the chart, the forecast line and *Show
 * as table*.
 */
export function BurndownCard({ epic, label }: { epic?: string; label?: string }) {
  const { scope } = useShell();
  const query = useQuery({
    queryKey: queryKeys.burndown({ scope, epic, label }),
    queryFn: () => apiClient['burndown.get']({ query: { scope, epic, label } }),
  });
  return (
    <Card data-card="burndown">
      <CardHeader
        title="Remaining effort"
        extra={
          query.data && (
            <span className="src">
              {query.data.open_effort} pts open · {query.data.not_estimated} not estimated · last 4
              weeks
            </span>
          )
        }
      />
      <div className="pad" style={{ paddingTop: 0 }}>
        <QueryState
          query={query}
          skeleton={<Skeleton lines={1} tall={1} label="Loading burn-down" />}
        >
          {(d) =>
            d.series.length === 0 || d.open_effort === 0 ? (
              <EmptyState text="No estimated work in this view. Agents set effort with update_item." />
            ) : (
              <div className="src">
                {d.forecast.available
                  ? `Forecast: P50 ${d.forecast.p50} – P85 ${d.forecast.p85}`
                  : d.forecast.reason}
              </div>
            )
          }
        </QueryState>
      </div>
    </Card>
  );
}

import { useQuery } from '@tanstack/react-query';
import type { OverviewWindow } from '@docket/shared';
import { Card, CardHeader } from '../../components/kit';
import { apiClient } from '../../app/queryClient';
import { HelpLink } from '../../help/HelpLink';
import { queryKeys } from '../../lib/api';
import { CostLine, TokenKinds } from '../usage/UsageParts';
import { allTokens, formatTokens } from '../usage/usageText';
import { WINDOW_WORDS } from './overviewWindow';

const REFRESH_MS = 60_000;

/**
 * Token use for the window (decision 48; UI_SPEC §6.1c): the four kinds, how much
 * is linked to tickets, overhead, not linked, and the labelled estimate. With
 * the source off, or before it answers, nothing renders.
 */
export function UsageCard({ scope, window }: { scope: string; window: OverviewWindow }) {
  const query = { scope, window };
  const { data } = useQuery({
    queryKey: queryKeys.usage(query),
    queryFn: () => apiClient['usage.get']({ query }),
    refetchInterval: REFRESH_MS,
  });
  if (data?.enabled !== true) return null;
  const empty = data.total.turns === 0;
  return (
    <Card data-card="token-use" className="ov-usage">
      <CardHeader
        title={`Token use · last ${WINDOW_WORDS[window]}`}
        extra={<HelpLink anchor="overview.token-use" />}
      />
      <div className="usage-body">
        {empty ? (
          <p className="src">No token use recorded in this window.</p>
        ) : (
          <>
            <TokenKinds tokens={data.total.tokens} />
            <ul className="usage-split" data-usage-split>
              <li>
                <b>{data.linked_pct ?? 0}%</b> linked to tickets
              </li>
              <li>
                <b>{formatTokens(allTokens(data.overhead.tokens))}</b> project overhead
              </li>
              <li>
                <b>{formatTokens(allTokens(data.unlinked.tokens))}</b> not linked to a ticket
              </li>
            </ul>
            <CostLine cost={data.total.cost} asOf={data.prices_as_of} />
          </>
        )}
      </div>
    </Card>
  );
}

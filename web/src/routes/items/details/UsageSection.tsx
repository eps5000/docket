import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import type { ItemDetailResponse, UsageClient } from '@docket/shared';
import { Section } from '../../../components/kit';
import { apiClient } from '../../../app/queryClient';
import { HelpLink } from '../../../help/HelpLink';
import { queryKeys } from '../../../lib/api';
import { formatStamp, plural } from '../../../lib/format';
import { paths } from '../../../lib/paths';
import { CostLine, TokenKinds, TokenTable } from '../../usage/UsageParts';
import { formatTokens } from '../../usage/usageText';

const CLIENT_NAMES: Record<UsageClient, string> = { 'claude-code': 'Claude Code', codex: 'Codex' };

/**
 * Token use (decision 48; UI_SPEC §6.1c): by kind, model and session; an epic
 * adds up its tickets. With the source off, or before it answers, nothing renders.
 */
export function UsageSection({ data }: { data: ItemDetailResponse }) {
  const id = data.item.id;
  const { data: usage } = useQuery({
    queryKey: queryKeys.usageItem(id),
    queryFn: () => apiClient['usage.item']({ params: { id } }),
  });
  if (usage?.enabled !== true) return null;
  const { tokens } = usage.total;
  const empty = usage.total.turns === 0;
  return (
    <Section
      sectionKey="token-use"
      title="Token use"
      summary={
        empty
          ? 'none recorded'
          : `${formatTokens(tokens.fresh_input)} new input · ${formatTokens(tokens.cached_input)} cache reads`
      }
      extraHead={<HelpLink anchor="item.token-use" />}
    >
      {empty ? (
        <p className="src">
          {usage.rollup
            ? 'No token use is linked to this epic or its tickets yet.'
            : 'No token use is linked to this ticket yet.'}
        </p>
      ) : (
        <div data-usage-item={id}>
          {usage.rollup && <p className="src">This epic and its tickets, added up.</p>}
          <TokenKinds tokens={tokens} />
          <p className="src">
            {plural(usage.total.sessions, 'session')} · {plural(usage.total.turns, 'response')}
          </p>
          <CostLine cost={usage.total.cost} asOf={usage.prices_as_of} />
          {usage.rollup && usage.children.length > 0 && (
            <>
              <h4 className="usage-sub">By ticket</h4>
              <TokenTable
                caption="Token use by ticket"
                first="Ticket"
                rows={usage.children.map((c) => ({
                  key: c.id,
                  title: `${c.id} ${c.title}`,
                  label: (
                    <Link to={paths.item(c.id)}>
                      <span className="mono">{c.id}</span> {c.title}
                    </Link>
                  ),
                  tokens: c.tokens,
                  cost: c.cost,
                }))}
              />
            </>
          )}
          <h4 className="usage-sub">By model</h4>
          <TokenTable
            caption="Token use by model"
            first="Model"
            rows={usage.models.map((m) => ({
              key: m.model ?? 'unknown',
              label: m.model ?? 'Unknown model',
              tokens: m.tokens,
              cost: m.cost,
            }))}
          />
          <h4 className="usage-sub">By session</h4>
          <TokenTable
            caption="Token use by session"
            first="Session"
            rows={usage.sessions.rows.map((s) => ({
              key: `${s.client}:${s.session_id}`,
              title: `${s.session_id}, ${plural(s.turns, 'response')}, last active ${formatStamp(s.last_at)}`,
              label: `${CLIENT_NAMES[s.client]} · ${formatStamp(s.last_at)}`,
              tokens: s.tokens,
              cost: s.cost,
            }))}
          />
          {usage.sessions.count > usage.sessions.rows.length && (
            <p className="src">
              Showing the latest {usage.sessions.rows.length} of {usage.sessions.count} sessions.
            </p>
          )}
        </div>
      )}
    </Section>
  );
}

import type { ReactNode } from 'react';
import type { UsageCost, UsageTokens } from '@docket/shared';
import {
  allTokens,
  costCell,
  ESTIMATE_NOTE,
  formatTokens,
  formatUsd,
  shareText,
  SUBSCRIPTION_NOTE,
  TOKEN_KINDS,
  unpricedText,
} from './usageText';
import './usage.css';

/** The four token kinds side by side, each with its share, so cache reads can't hide. */
export function TokenKinds({ tokens }: { tokens: UsageTokens }) {
  const whole = allTokens(tokens);
  return (
    <dl className="usage-kinds" data-usage-kinds>
      {TOKEN_KINDS.map((k) => (
        <div key={k.key} title={k.help} data-usage-kind={k.key}>
          <dt>{k.label}</dt>
          <dd>
            <span className="usage-n">{formatTokens(tokens[k.key])}</span>{' '}
            <span className="src">{shareText(tokens[k.key], whole)}</span>
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** The estimate, labelled as one, or "Cost not available". Never a bare dollar figure. */
export function CostLine({ cost, asOf }: { cost: UsageCost; asOf: string }) {
  const left = unpricedText(cost);
  return (
    <div className="usage-cost" data-usage-cost>
      {cost.usd === null ? (
        <p>
          <b>Cost not available.</b> {left}
        </p>
      ) : (
        <p>
          <b>{formatUsd(cost.usd)}</b> API-equivalent estimate.{left ? ` ${left}` : ''}
        </p>
      )}
      <p className="src">
        {ESTIMATE_NOTE} from {asOf}. {SUBSCRIPTION_NOTE}
      </p>
    </div>
  );
}

export interface TokenRow {
  key: string;
  label: ReactNode;
  title?: string;
  tokens: UsageTokens;
  cost: UsageCost;
}

/** One row per model, session or ticket, with every kind in its own column. */
export function TokenTable({
  caption,
  first,
  rows,
}: {
  caption: string;
  first: string;
  rows: readonly TokenRow[];
}) {
  return (
    <div className="tablewrap usage-table" tabIndex={0} role="region" aria-label={caption}>
      <table>
        <caption className="sr">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">{first}</th>
            {TOKEN_KINDS.map((k) => (
              <th key={k.key} scope="col" className="num" title={k.help}>
                {k.label}
              </th>
            ))}
            <th scope="col" className="num" title="API-equivalent estimate">
              Estimate
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <th scope="row" title={r.title}>
                {r.label}
              </th>
              {TOKEN_KINDS.map((k) => (
                <td key={k.key} className="num">
                  {formatTokens(r.tokens[k.key])}
                </td>
              ))}
              <td className="num">{costCell(r.cost)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

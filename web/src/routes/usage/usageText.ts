import type { UsageCost, UsageTokens } from '@docket/shared';

/** The four kinds, always shown apart: most tokens are usually cheap cache reads. */
export const TOKEN_KINDS: readonly { key: keyof UsageTokens; label: string; help: string }[] = [
  { key: 'fresh_input', label: 'New input', help: 'Input the model read at the full price' },
  {
    key: 'cached_input',
    label: 'Cache reads',
    help: 'Input reused from the cache, at a low price',
  },
  { key: 'cache_write', label: 'Cache writes', help: 'Input stored in the cache for reuse' },
  { key: 'output', label: 'Output', help: 'What the model wrote' },
];

export const allTokens = (t: UsageTokens) =>
  t.fresh_input + t.cached_input + t.cache_write + t.output;

/** "950", "12.3K", "4.5M", "1.2B". */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  const [value, unit] =
    n < 999_500 ? [n / 1000, 'K'] : n < 999_500_000 ? [n / 1e6, 'M'] : [n / 1e9, 'B'];
  return `${value >= 100 ? Math.round(value) : Number(value.toFixed(1))}${unit}`;
}

/** "$3.42", "under $0.01", "$1,204". */
export function formatUsd(usd: number): string {
  if (usd === 0) return '$0';
  if (usd < 0.01) return 'under $0.01';
  if (usd >= 1000) return `$${Math.round(usd).toLocaleString('en-US')}`;
  return `$${usd.toFixed(2)}`;
}

/** A share of all tokens: "97%", or "under 1%" rather than a misleading 0. */
export function shareText(part: number, whole: number): string {
  if (whole <= 0 || part <= 0) return '0%';
  const pct = (part / whole) * 100;
  return pct < 1 ? 'under 1%' : `${Math.round(pct)}%`;
}

/** A table cell: the estimate, or the words for no price. */
export const costCell = (cost: UsageCost) =>
  cost.usd === null ? 'Not available' : formatUsd(cost.usd);

/** The line under an estimate about what it leaves out; null when nothing. */
export function unpricedText(cost: UsageCost): string | null {
  if (cost.unpriced_tokens === 0) return null;
  const tokens = `${formatTokens(cost.unpriced_tokens)} tokens`;
  if (cost.unpriced_models.length > 0) {
    return `${tokens} have no sourced price (${cost.unpriced_models.join(', ')}), so they aren’t in this estimate.`;
  }
  return `${tokens} have no sourced price, so they aren’t in this estimate.`;
}

export const ESTIMATE_NOTE =
  'Tokens are measured. Dollars are an API-equivalent estimate at list prices';
export const SUBSCRIPTION_NOTE = 'A subscription plan may cost less.';

/** The Settings note, in the owner's words (decision 48). */
export const USAGE_SOURCE_TITLE = 'Measure token use from local agent logs';
export const USAGE_SOURCE_NOTE =
  'Turn this on for more accurate token use per ticket and epic. To do this, a helper on this computer needs access to your local Codex and Claude Code session logs, which include your conversations with those agents. Docket doesn’t use that content. The helper keeps only token counts, model, session ID, time and working folder, and nothing else is stored or sent. Turn this off at any time to stop reading the logs.';
export const USAGE_SOURCE_OFF_NOTE =
  'Turning this off stops reading the logs on the helper’s next cycle and does nothing else. Counts already collected stay in Docket, hidden, until you turn this back on or delete their project.';

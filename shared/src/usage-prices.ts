/**
 * API list prices for the token-use estimate (owner decision 48; B63;
 * BUILD_SPEC §5.31). Tokens are measured. Dollars are an **API-equivalent
 * estimate** from this table: what the same tokens would cost at list price.
 * A subscription plan may cost less.
 *
 * Rules for this file:
 * - Every number is copied from the page in `source`, on `USAGE_PRICES_AS_OF`.
 *   Never add a price from memory or by analogy.
 * - A model that isn't here shows its tokens and "cost not available".
 * - `null` means the page lists no price for that token type, or the logs can't
 *   say which of its prices applies. Those tokens stay out of the estimate and
 *   the UI says so.
 * - OpenAI lists 30-minute and 12-hour cache write prices, and Codex logs don't
 *   say which applied, so OpenAI cache writes are `null`.
 *
 * All prices are US dollars per million tokens, standard tier.
 */

export const USAGE_PRICES_AS_OF = '2026-11-23';

export const ANTHROPIC_PRICING_URL = 'https://platform.claude.com/docs/en/about-claude/pricing';
export const OPENAI_PRICING_URL = 'https://developers.openai.com/api/docs/pricing';

export interface TokenRates {
  input: number;
  /** A cache hit. */
  cached: number | null;
  /** A cache write at the default lifetime (Anthropic: 5 minutes). */
  write: number | null;
  /** A one-hour cache write (Anthropic only). */
  write_1h: number | null;
  output: number;
}

export interface ModelPrice extends TokenRates {
  source: string;
  /** Higher prices for a request whose prompt is over `over` tokens, cached ones included. */
  long_context?: { over: number; rates: TokenRates };
}

/** The prompt lengths where a listed model's price changes. */
export const LONG_CONTEXT_THRESHOLDS = [100_000, 272_000] as const;

const claude = (
  input: number,
  write: number,
  write_1h: number,
  cached: number,
  output: number,
): TokenRates => ({ input, cached, write, write_1h, output });

const anthropic = (rates: TokenRates, long?: ModelPrice['long_context']): ModelPrice => ({
  ...rates,
  source: ANTHROPIC_PRICING_URL,
  ...(long ? { long_context: long } : {}),
});

const gpt = (input: number, cached: number | null, output: number): TokenRates => ({
  input,
  cached,
  write: null,
  write_1h: null,
  output,
});

const openai = (rates: TokenRates, long?: TokenRates): ModelPrice => ({
  ...rates,
  source: OPENAI_PRICING_URL,
  ...(long ? { long_context: { over: 272_000, rates: long } } : {}),
});

const FABLE_5_2 = anthropic(claude(8, 10, 16, 0.2, 40));
const FABLE_5_1 = anthropic(claude(10, 12.5, 20, 0.25, 50));
const FABLE_5 = anthropic(claude(10, 12.5, 20, 1, 50));
const OPUS_5 = anthropic(claude(5, 6.25, 10, 0.5, 25));
const OPUS_4_1 = anthropic(claude(15, 18.75, 30, 1.5, 75));
const SONNET_4 = anthropic(claude(3, 3.75, 6, 0.3, 15));

/** By exact API model ID. A dated ID is listed as itself; nothing is matched by prefix. */
export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  'claude-fable-5-2': FABLE_5_2,
  'claude-mythos-5-2': FABLE_5_2,
  'claude-fable-5-1': FABLE_5_1,
  'claude-mythos-5-1': FABLE_5_1,
  'claude-fable-5': FABLE_5,
  'claude-mythos-5': FABLE_5,
  'claude-opus-5-5': anthropic(claude(4, 5, 8, 0.2, 20)),
  'claude-opus-5': OPUS_5,
  'claude-opus-4-8': OPUS_5,
  'claude-opus-4-7': OPUS_5,
  'claude-opus-4-6': OPUS_5,
  'claude-opus-4-5': OPUS_5,
  'claude-opus-4-5-20251101': OPUS_5,
  'claude-opus-4-1-20250805': OPUS_4_1,
  'claude-opus-4-20250514': OPUS_4_1,
  'claude-sonnet-5-5': anthropic(claude(2, 2.5, 4, 0.1, 10)),
  'claude-sonnet-5': anthropic(claude(2, 2.5, 4, 0.2, 10)),
  'claude-sonnet-4-6': SONNET_4,
  'claude-sonnet-4-5': SONNET_4,
  'claude-sonnet-4-5-20250929': SONNET_4,
  'claude-sonnet-4-20250514': SONNET_4,
  'claude-haiku-5-5': anthropic(claude(0.1, 0.125, 0.2, 0.01, 0.5), {
    over: 100_000,
    rates: claude(0.5, 0.625, 1, 0.05, 2.5),
  }),
  'claude-haiku-4-5-20251001': anthropic(claude(1, 1.25, 2, 0.1, 5)),

  'gpt-6.2-astra': openai(gpt(8, 0.4, 40), gpt(16, 0.8, 60)),
  'gpt-6.2-sol': openai(gpt(2, 0.1, 10), gpt(4, 0.2, 15)),
  'gpt-6-astra': openai(gpt(10, 1, 50), gpt(20, 2, 75)),
  'gpt-6.1-sol': openai(gpt(2, 0.1, 10), gpt(4, 0.2, 15)),
  'gpt-6.1-terra': openai(gpt(1, 0.05, 5), gpt(2, 0.1, 7.5)),
  'gpt-6-luna': openai(gpt(0.1, 0.01, 0.5), gpt(0.2, 0.02, 0.75)),
  'gpt-6-sol': openai(gpt(2, 0.2, 10), gpt(4, 0.4, 15)),
  // The page marks gpt-5.6-sol's price as promotional until 2026-11-30.
  'gpt-5.6-sol': openai(gpt(4, 0.4, 20), gpt(8, 0.8, 30)),
  'gpt-5.6-terra': openai(gpt(2, 0.2, 12), gpt(4, 0.4, 18)),
  'gpt-5.6-luna': openai(gpt(0.2, 0.02, 1.2), gpt(0.4, 0.04, 1.8)),
  'gpt-5.5': openai(gpt(5, 0.5, 30), gpt(10, 1, 45)),
  'gpt-5.5-pro': openai(gpt(30, null, 180), gpt(60, null, 270)),
  'gpt-5.4': openai(gpt(2.5, 0.25, 15), gpt(5, 0.5, 22.5)),
  'gpt-5.4-pro': openai(gpt(30, null, 180), gpt(60, null, 270)),
  'gpt-5.4-mini': openai(gpt(0.75, 0.075, 4.5)),
  'gpt-5.4-nano': openai(gpt(0.2, 0.02, 1.25)),
  'gpt-5.3-codex': openai(gpt(1.75, 0.175, 14)),
  'gpt-5.2': openai(gpt(1.75, 0.175, 14)),
  'gpt-5.2-pro': openai(gpt(21, null, 168)),
  'gpt-5.1': openai(gpt(1.25, 0.125, 10)),
  'gpt-5': openai(gpt(1.25, 0.125, 10)),
  'gpt-5-mini': openai(gpt(0.25, 0.025, 2)),
  'gpt-5-nano': openai(gpt(0.05, 0.005, 0.4)),
  'gpt-5-pro': openai(gpt(15, null, 120)),
};

/** Own-property lookup, so a model called `constructor` has no price. */
export function modelPrice(model: string | null | undefined): ModelPrice | null {
  if (!model || !Object.hasOwn(MODEL_PRICES, model)) return null;
  return MODEL_PRICES[model]!;
}

export interface TokenCounts {
  fresh_input: number;
  cached_input: number;
  /** All cache writes, including `cache_write_1h`. */
  cache_write: number;
  /** The part of `cache_write` with a one-hour lifetime. */
  cache_write_1h: number;
  output: number;
}

export interface CostEstimate {
  /** Null when none of these tokens could be priced. */
  usd: number | null;
  /** Tokens with no sourced price, which the estimate leaves out. */
  unpriced_tokens: number;
}

/**
 * The API-equivalent estimate for some tokens of one model. `promptTokens` is
 * the prompt length of the requests they came from (or any length in the same
 * price tier), so a model's long-context price applies above `long_context.over`.
 */
export function estimateCost(
  model: string | null | undefined,
  tokens: TokenCounts,
  promptTokens = 0,
): CostEstimate {
  const all = tokens.fresh_input + tokens.cached_input + tokens.cache_write + tokens.output;
  const price = modelPrice(model);
  if (!price) return { usd: null, unpriced_tokens: all };
  const rates: TokenRates =
    price.long_context && promptTokens > price.long_context.over ? price.long_context.rates : price;
  const parts: [number, number | null][] = [
    [tokens.fresh_input, rates.input],
    [tokens.cached_input, rates.cached],
    [tokens.cache_write - tokens.cache_write_1h, rates.write],
    [tokens.cache_write_1h, rates.write_1h],
    [tokens.output, rates.output],
  ];
  let usd = 0;
  let unpriced = 0;
  let priced = 0;
  for (const [count, rate] of parts) {
    if (count <= 0) continue;
    if (rate === null) {
      unpriced += count;
    } else {
      usd += (count * rate) / 1_000_000;
      priced += count;
    }
  }
  if (priced === 0 && unpriced > 0) return { usd: null, unpriced_tokens: unpriced };
  return { usd, unpriced_tokens: unpriced };
}

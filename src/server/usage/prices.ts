/**
 * API list prices, per million tokens, for pricing the usage ledger.
 *
 * Transcripts carry tokens and never dollars, so cost is ours to compute. It is
 * an ESTIMATE at list price: these runs bill against the Pro/Max subscription,
 * and the UI labels the figure that way.
 *
 * Cache writes are priced by TTL — 1.25x input for 5 minutes, 2x for one hour —
 * and Claude Code writes mostly 1-hour cache, so collapsing the two would
 * under-price nearly every session. Cache reads are 0.1x input except where a
 * model publishes its own rate.
 *
 * Verified 2026-09-24 against a real `claude -p` envelope: the ledger's figure
 * for a Haiku session matched `total_cost_usd` to the last digit. Source:
 * Anthropic's published pricing. Update the table when a model ships; an id not
 * listed here prices as unknown (null), never as free.
 */

export interface ModelRates {
  input: number;
  output: number;
  /** Per-MTok cache-read rate, when the model publishes one other than 0.1x input. */
  cacheRead?: number;
  /** Multiplier for `speed: "fast"` responses. */
  fast?: number;
}

/** Keyed by the model id's family prefix; dated snapshots match by prefix. */
const RATES: Record<string, ModelRates> = {
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-mythos-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-fable-5': { input: 10, output: 50, cacheRead: 1 },
  'claude-mythos-5': { input: 10, output: 50, cacheRead: 1 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, fast: 2 },
  'claude-opus-5': { input: 5, output: 25, fast: 2 },
  'claude-opus-4-8': { input: 5, output: 25, fast: 2 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};

/** Longest prefix first, so `claude-opus-5-5` is never priced as `claude-opus-5`. */
const PREFIXES = Object.keys(RATES).sort((a, b) => b.length - a.length);

export function ratesFor(model: string): ModelRates | null {
  const id = model.toLowerCase();
  const prefix = PREFIXES.find((p) => id === p || id.startsWith(`${p}-`));
  return prefix ? RATES[prefix] : null;
}

export interface PricedTokens {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
}

/** List-price cost of one bucket of tokens, or null for a model we cannot price. */
export function priceTokens(model: string, t: PricedTokens, speed?: string | null): number | null {
  const rates = ratesFor(model);
  if (!rates) return null;
  const read = rates.cacheRead ?? rates.input * 0.1;
  const perMTok =
    t.inputTokens * rates.input +
    t.outputTokens * rates.output +
    t.cacheReadTokens * read +
    t.cacheWrite5mTokens * rates.input * 1.25 +
    t.cacheWrite1hTokens * rates.input * 2;
  const multiplier = speed === 'fast' ? (rates.fast ?? 1) : 1;
  return (perMTok / 1_000_000) * multiplier;
}

import { formatCost, formatTokens } from './format.js';

/**
 * Usage figures as the workspace shows them: the project total chip beside a
 * project's heading, and its tooltip. From the transcript usage ledger
 * (server `usage/`), never a run's own envelope.
 */

/** Mirrors Usage in src/server/usage/types.ts. */
export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  runCount: number;
  /** Some tokens came from a model the server's price table does not know. */
  unpriced?: boolean;
}

/** Mirrors ProjectUsage in src/server/usage/store.ts. */
export interface ProjectUsage {
  total: UsageTotals;
  pipeline: UsageTotals;
  background: UsageTotals;
  sessions: UsageTotals;
}

/** Anything to show: tokens can be spent outside any agent run (a terminal session). */
export function hasSpend(usage: UsageTotals): boolean {
  return (
    usage.runCount > 0 ||
    usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheCreationTokens > 0
  );
}

/**
 * The headline figure for something that spent: its cost, or "—" when every
 * token came from a model the server cannot price. `formatCost(0)` would read
 * "$0.00" there, claiming free what is merely unknown; the tooltip says why.
 */
export function formatUsageCost(usage: UsageTotals): string {
  return usage.unpriced && usage.costUsd === 0 ? '—' : formatCost(usage.costUsd);
}

/**
 * Says "est." and names list price on purpose: these runs bill against the
 * Pro/Max subscription, so the figure is what the tokens would cost at API
 * rates, not a charge anyone made.
 */
function spendSummary(usage: UsageTotals): string {
  const cached = usage.cacheReadTokens + usage.cacheCreationTokens;
  return (
    `est. ${formatCost(usage.costUsd)} at API list price · ` +
    `in ${formatTokens(usage.inputTokens)} · out ${formatTokens(usage.outputTokens)} · ` +
    `cached ${formatTokens(cached)}` +
    (usage.unpriced ? ' · some tokens are from a model with no known price' : '')
  );
}

/** The project total's breakdown: who spent it (factory and old pipeline runs, sessions, background runs). */
export function projectUsageTooltip(usage: ProjectUsage): string {
  const part = (label: string, u: UsageTotals) => `${label} ${formatCost(u.costUsd)}`;
  return (
    `${spendSummary(usage.total)}\n` +
    [
      part('factory', usage.pipeline),
      part('sessions', usage.sessions),
      part('background (session log, migration, QA drafts)', usage.background),
    ].join(' · ')
  );
}

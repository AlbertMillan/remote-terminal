import type { PlanUsageSnapshot, WindowReading } from '../usage/plan-limits.js';

/**
 * The factory's dispatch limits (project/code-factory.md, the defaults table).
 * Parallelism is capped by review capacity and plan usage, not CPU. These are
 * the Settings → Factory defaults; the panel itself is f-o5veqv.
 */
export interface FactoryLimits {
  /** Units running at once, across every project (they share one plan's limits). */
  seats: number;
  /** Units running at once in one project. */
  seatsPerProject: number;
  /** Stop dispatching while this many units wait for the user. */
  pauseWhenParked: number;
  /** No new units once the 5-hour window reaches this percentage. */
  fiveHourCapPct: number;
  /** No new units once the weekly window reaches this percentage. */
  weeklyCapPct: number;
  /**
   * Park a unit once its runs have processed this many tokens (input, output,
   * cache writes and cache reads together, from the usage ledger).
   */
  runawayTokens: number;
}

export const DEFAULT_FACTORY_LIMITS: FactoryLimits = {
  seats: 3,
  seatsPerProject: 2,
  pauseWhenParked: 3,
  fiveHourCapPct: 80,
  weeklyCapPct: 90,
  runawayTokens: 3_000_000,
};

/** A window's reading that still applies: one whose reset has passed says nothing about now. */
function live(w: WindowReading | null, now: number): WindowReading | null {
  return w && w.resetsAt * 1000 > now ? w : null;
}

/**
 * Why the plan's usage stops new work, or null when it does not. No reading at
 * all (no status line set up yet) does not block: the cap is a brake on known
 * spend, and refusing everything until the chip is configured would make the
 * factory unusable on a fresh install.
 */
export function planCapReason(snapshot: PlanUsageSnapshot | null, limits: FactoryLimits, now = Date.now()): string | null {
  const five = live(snapshot?.fiveHour ?? null, now);
  if (five && five.usedPercentage >= limits.fiveHourCapPct) {
    return `5-hour usage at ${Math.round(five.usedPercentage)}% (cap ${limits.fiveHourCapPct}%)`;
  }
  const week = live(snapshot?.sevenDay ?? null, now);
  if (week && week.usedPercentage >= limits.weeklyCapPct) {
    return `weekly usage at ${Math.round(week.usedPercentage)}% (cap ${limits.weeklyCapPct}%)`;
  }
  return null;
}

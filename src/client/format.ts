/**
 * Small display formatters shared across views. One copy each, so a job card,
 * the plan chip and the project list can't round the same number differently.
 */

/** Whole minutes since `iso`, or null for a missing or unparsable timestamp. */
function minutesSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  return Math.floor(Math.max(0, Date.now() - then) / 60000);
}

/** "just now", "5m ago", "3h ago", "2d ago", "4mo ago", "1y ago"; '' when unknown. */
export function timeAgo(iso: string | null | undefined): string {
  const mins = minutesSince(iso);
  if (mins === null) return '';
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

/** Compact age for dense rows: "5m", "3h", "2d"; '' when unknown. */
export function shortAge(iso: string | null | undefined): string {
  const mins = minutesSince(iso);
  if (mins === null) return '';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

/** "950", "12.4k", "18k", "3.1M", "24M": token counts at a glance. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`;
}

/** "$0.00", "<$0.01", "$1.50". */
export function formatCost(usd: number): string {
  if (usd <= 0) return '$0.00';
  if (usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}

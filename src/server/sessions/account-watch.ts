import { preflight, type PreflightResult } from '../accounts.js';
import { createLogger } from '../utils/logger.js';

/**
 * A `/login` inside a running session can't be prevented (docs/accounts.md): it
 * swaps the login of the account's whole folder under every session using it.
 * So the identity is re-read — on a timer, and whenever a session's
 * claude-session hook reports in — and a running session whose account no
 * longer holds its expected login is flagged: a badge on its row (kept current
 * by `session.accountWarnings`) and, the first time, a notification.
 */

const logger = createLogger('account-watch');

const POLL_MS = 60_000;

/** Session id → why its account is no longer the expected login. */
let warnings = new Map<string, string>();

/** The current warning for a session, or null. */
export function accountWarningFor(sessionId: string): string | null {
  return warnings.get(sessionId) ?? null;
}

export interface WatchedSession {
  id: string;
  name: string;
  account: string;
}

export interface AccountCheck {
  /** Every running session's warning, by session id. */
  warnings: Record<string, string>;
  /** Sessions newly flagged by this check: the ones to notify about. */
  flagged: { id: string; name: string; detail: string }[];
  /** Whether `warnings` differs from the previous check's. */
  changed: boolean;
}

/**
 * The last preflight per account, and when it ran. The plan-usage relay asks on
 * every status line render of every session (docs/plan-usage.md), so it reads
 * this instead of re-reading `.claude.json` per post; a watch tick refreshes it.
 */
const logins = new Map<string, { at: number; result: PreflightResult | null }>();

/**
 * Whether the account's folder holds its expected login, at most `POLL_MS` old:
 * the watch's own reading when it has one that fresh, else a preflight now
 * (cached in turn). Null for an account that can't be checked (unknown).
 */
export function accountLogin(
  account: string,
  now = Date.now(),
  check: (account: string) => PreflightResult = preflight
): PreflightResult | null {
  const cached = logins.get(account);
  if (cached && now - cached.at < POLL_MS) return cached.result;
  let result: PreflightResult | null;
  try {
    result = check(account);
  } catch {
    result = null;
  }
  logins.set(account, { at: now, result });
  return result;
}

/** One check over the running sessions. Each account's folder is read once. */
export function checkSessionAccounts(
  sessions: WatchedSession[],
  check: (account: string) => PreflightResult = preflight,
  now = Date.now()
): AccountCheck {
  const byAccount = new Map<string, PreflightResult | null>();
  const next = new Map<string, string>();
  const flagged: AccountCheck['flagged'] = [];
  for (const s of sessions) {
    if (!byAccount.has(s.account)) {
      try {
        byAccount.set(s.account, check(s.account));
      } catch (error) {
        // An account since removed from the config: nothing to compare against.
        logger.warn({ account: s.account, error }, 'account-watch: could not check an account');
        byAccount.set(s.account, null);
      }
      logins.set(s.account, { at: now, result: byAccount.get(s.account) ?? null });
    }
    const result = byAccount.get(s.account);
    if (result && !result.ok && result.reason === 'unreadable') {
      // Caught mid-write, with no earlier reading to fall back on: no news either way.
      const previous = warnings.get(s.id);
      if (previous) next.set(s.id, previous);
      continue;
    }
    if (!result || result.ok) continue;
    next.set(s.id, result.message);
    if (warnings.get(s.id) !== result.message) flagged.push({ id: s.id, name: s.name, detail: result.message });
  }
  const changed = next.size !== warnings.size || [...next].some(([id, m]) => warnings.get(id) !== m);
  warnings = next;
  return { warnings: Object.fromEntries(next), flagged, changed };
}

let timer: NodeJS.Timeout | null = null;
let tick: (() => void) | null = null;

/**
 * Check every `POLL_MS`, and on `recheckAccounts()`. `onChange` gets every
 * warning whenever the set changes; `onFlag` once per newly flagged session.
 */
export function startAccountWatch(
  sessions: () => WatchedSession[],
  onChange: (warnings: Record<string, string>) => void,
  onFlag: (session: { id: string; name: string; detail: string }) => void
): void {
  tick = () => {
    try {
      const result = checkSessionAccounts(sessions());
      if (result.changed) onChange(result.warnings);
      for (const f of result.flagged) {
        logger.warn({ sessionId: f.id, detail: f.detail }, 'account-watch: a running session is on the wrong login');
        onFlag(f);
      }
    } catch (error) {
      logger.warn({ error }, 'account-watch: check failed');
    }
  };
  tick();
  timer = setInterval(tick, POLL_MS);
  timer.unref?.();
}

/** Check now: a session's hook just reported in, possibly right after a `/login`. */
export function recheckAccounts(): void {
  tick?.();
}

export function stopAccountWatch(): void {
  if (timer) clearInterval(timer);
  timer = null;
  tick = null;
  warnings = new Map();
  logins.clear();
}

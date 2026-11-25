import { spawn } from 'child_process';
import { homedir } from 'os';
import { accountEnv, accountNames } from '../accounts.js';
import { getConfig } from '../config.js';
import { createLogger } from '../utils/logger.js';

/**
 * When each account's claude.ai login ends (project/login-expiry.md). preflight()
 * only checks WHO is logged in (`oauthAccount` in `.claude.json`); a folder whose
 * credentials expired or were removed still passes it. So `claude auth status`
 * is run under each account's own env, its answer cached, and served with plan usage.
 *
 * The check runs in the background: a request never waits for it, it serves the
 * last answer and starts a refresh when that answer is old. A failed run (spawn
 * error, non-zero exit, output that isn't the JSON we expect) keeps the last
 * answer. A flaky CLI must never be reported as "logged out".
 */

const logger = createLogger('login-status');

/** How old an answer may get before the next read refreshes it. */
const FRESH_MS = 15 * 60_000;
/** Shorter while the login is gone or about to end, so a renewal shows within a minute. */
const FRESH_URGENT_MS = 60_000;
const RUN_TIMEOUT_MS = 20_000;
const DAY_MS = 24 * 3600_000;

/** What `claude auth status` says about one folder's login. */
export interface AuthStatus {
  loggedIn: boolean;
  /** ISO time the login ends; null when logged out or not reported. */
  loginExpiresAt: string | null;
}

export type LoginState = 'ok' | 'ending' | 'ends-today' | 'logged-out' | 'unknown';

/** As served in `AccountPlanUsage.login`. */
export interface LoginInfo {
  state: LoginState;
  endsAt: string | null;
}

/** ≤ 7 days left: amber. Under a day, or already past: red. */
export function loginState(status: AuthStatus | null, now: number): LoginInfo {
  if (!status) return { state: 'unknown', endsAt: null };
  if (!status.loggedIn) return { state: 'logged-out', endsAt: null };
  const ends = status.loginExpiresAt ? Date.parse(status.loginExpiresAt) : NaN;
  if (!Number.isFinite(ends)) return { state: 'ok', endsAt: null };
  const left = ends - now;
  const endsAt = new Date(ends).toISOString();
  if (left <= 0) return { state: 'logged-out', endsAt };
  if (left < DAY_MS) return { state: 'ends-today', endsAt };
  if (left <= 7 * DAY_MS) return { state: 'ending', endsAt };
  return { state: 'ok', endsAt };
}

/** The JSON `claude auth status` prints, or null for anything else. */
export function parseAuthStatus(stdout: string): AuthStatus | null {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const raw = JSON.parse(stdout.slice(start, end + 1)) as { loggedIn?: unknown; loginExpiresAt?: unknown };
    if (typeof raw.loggedIn !== 'boolean') return null;
    return {
      loggedIn: raw.loggedIn,
      loginExpiresAt: typeof raw.loginExpiresAt === 'string' ? raw.loginExpiresAt : null,
    };
  } catch {
    return null;
  }
}

export type AuthStatusRunner = (account: string) => Promise<AuthStatus | null>;

/**
 * `claude auth status` under the account's env: its CLAUDE_CONFIG_DIR, and no
 * inherited token or API key, which would answer for whoever owns them.
 */
const spawnAuthStatus: AuthStatusRunner = (account) =>
  new Promise((resolve) => {
    let stdout = '';
    let settled = false;
    const done = (status: AuthStatus | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(status);
    };
    let child: ReturnType<typeof spawn>;
    try {
      // shell:true resolves `claude`/`claude.cmd` from PATH on Windows; the args are fixed.
      child = spawn(getConfig().projectLog.claudeCommand, ['auth', 'status'], {
        cwd: homedir(),
        shell: true,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
        env: accountEnv(process.env, account) as NodeJS.ProcessEnv,
      });
    } catch (err) {
      logger.warn({ account, err }, 'login-status: could not start claude auth status');
      done(null);
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      logger.warn({ account }, 'login-status: claude auth status timed out');
      done(null);
    }, RUN_TIMEOUT_MS);
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < 64 * 1024) stdout += chunk.toString();
    });
    child.on('error', (err) => {
      logger.warn({ account, err }, 'login-status: claude auth status failed');
      done(null);
    });
    // Logged out exits non-zero with the same JSON on some versions: the JSON decides.
    child.on('close', () => done(parseAuthStatus(stdout)));
  });

// Never spawn the real CLI under vitest: tests inject their own runner.
let runner: AuthStatusRunner = process.env.VITEST ? async () => null : spawnAuthStatus;

/** For tests. */
export function setAuthStatusRunner(next: AuthStatusRunner): void {
  runner = next;
}

interface Entry {
  /** The last answer a run gave; kept through failed runs. */
  status: AuthStatus | null;
  /** When `status` was last refreshed (or a run last failed: no retry storm). */
  at: number;
  running: Promise<void> | null;
}

const entries = new Map<string, Entry>();

/** For tests. */
export function clearLoginStatus(): void {
  entries.clear();
}

/** Run the check now (unless one is running); resolves once it settled. */
export function refreshLoginStatus(account: string, now = Date.now()): Promise<void> {
  const entry = entries.get(account) ?? { status: null, at: 0, running: null };
  entries.set(account, entry);
  if (entry.running) return entry.running;
  entry.running = runner(account)
    .then((status) => {
      if (status) entry.status = status;
      else logger.debug({ account }, 'login-status: no answer, keeping the last one');
    })
    .catch((err) => logger.warn({ account, err }, 'login-status: check failed'))
    .finally(() => {
      entry.at = now;
      entry.running = null;
    });
  return entry.running;
}

/**
 * The account's login as last checked, starting a background refresh when that
 * check is old. `unknown` until the first check answers.
 */
export function accountLoginInfo(account: string, now = Date.now()): LoginInfo {
  const entry = entries.get(account);
  const info = loginState(entry?.status ?? null, now);
  const fresh = info.state === 'ok' ? FRESH_MS : FRESH_URGENT_MS;
  if (!entry || (!entry.running && now - entry.at >= fresh)) void refreshLoginStatus(account, now);
  return info;
}

/** Check every account once, at boot, so the chip has an answer on first load. */
export function primeLoginStatus(): void {
  for (const account of accountNames()) void refreshLoginStatus(account);
}

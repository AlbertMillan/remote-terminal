import type { FastifyInstance } from 'fastify';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  discardHeld,
  getHeld,
  getRelaySeenAt,
  getSnapshot,
  recordReading,
  type Verdict,
  type WindowReading,
} from './plan-limits.js';
import {
  accountForConfigDir,
  accountNames,
  defaultAccount,
  isAccount,
  planLabel,
  projectAccount,
  projectsDir,
  readIdentity,
  settingsPath,
} from '../accounts.js';
import { accountLogin, accountWarningFor } from '../sessions/account-watch.js';
import { getSession } from '../db/queries.js';
import { usageByAccount, type AccountUsage } from './store.js';

/**
 * The status line script, found by walking up from this module: it sits at
 * `<repo>/scripts/statusline.mjs`, and this file runs from `src/server/usage`
 * under tsx but from `dist/server` once bundled. Null if it cannot be found.
 */
function findStatuslineScript(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, 'scripts', 'statusline.mjs');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * The `statusLine.command` to put in each account's settings.json. Forward slashes:
 * Claude Code runs the command through bash on Windows too, where a backslash
 * path is an escape sequence waiting to happen.
 */
export function statuslineCommand(): string | null {
  // Worked out once: the script does not move while the server runs, and the
  // chip asks on every poll from every open browser.
  if (cachedCommand === undefined) {
    const script = findStatuslineScript();
    cachedCommand = script ? `node "${script.replace(/\\/g, '/')}"` : null;
  }
  return cachedCommand;
}

let cachedCommand: string | null | undefined;

/** A status line payload is a few KB; anything far larger is not one. */
const BODY_LIMIT = 64 * 1024;

/** The account a session row runs under, or null for an id that names no session. */
function sessionAccount(id: string): string | null {
  try {
    const account = getSession(id)?.account;
    return isAccount(account) ? account : null;
  } catch {
    return null; // no database (yet): treated as no session
  }
}

/**
 * Whose a relay post is, and whether it can be trusted as that login's
 * (docs/plan-usage.md). The account: the session row's when `session_id` names
 * a claude-remote session, else the account on `config_dir`. Nothing in the
 * body is a credential — the endpoint is unauthenticated on the tailnet — so an
 * id naming no session is simply absent, and an id only picks an account that
 * is then verified like any other.
 *
 * Verified: the account's folder holds its expected login now (account-watch's
 * cached preflight, never one per post) and, for a session, account-watch has
 * not flagged it — a `claude` started before a `/login` swap keeps the old login.
 */
export function classifyRelayPost(body: unknown, now = Date.now()): { account: string | null; verdict: Verdict } {
  const b = (body && typeof body === 'object' ? body : {}) as { config_dir?: unknown; session_id?: unknown };
  const sessionId = typeof b.session_id === 'string' && b.session_id.length <= 128 ? b.session_id : null;
  const fromSession = sessionId ? sessionAccount(sessionId) : null;
  const account = fromSession ?? accountForConfigDir(typeof b.config_dir === 'string' ? b.config_dir : null);
  if (!account) return { account: null, verdict: { verified: false, reason: 'unknown-folder' } };
  const login = accountLogin(account, now);
  if (!login) return { account, verdict: { verified: false, reason: 'no-login' } };
  if (!login.ok) {
    const reason = login.reason === 'mismatch' || login.reason === 'org-settings' ? 'login-mismatch' : 'no-login';
    return { account, verdict: { verified: false, reason } };
  }
  if (fromSession && accountWarningFor(sessionId!)) return { account, verdict: { verified: false, reason: 'session-flagged' } };
  const loginUuid = login.found.accountUuid ?? login.found.organizationUuid;
  return loginUuid ? { account, verdict: { verified: true, loginUuid } } : { account, verdict: { verified: false, reason: 'no-login' } };
}

/** A window's ledger usage, and from when it is counted. */
export interface WindowTokens extends AccountUsage {
  since: string;
  /** True when `since` is the login's creation, later than the window's start. */
  sinceLogin: boolean;
}

/** A window as served: without the `loginUuid` it was verified for, which identifies the login. */
export type PublicWindow = Omit<WindowReading, 'loginUuid'>;

function publicWindow(w: WindowReading | null): PublicWindow | null {
  if (!w) return null;
  return { usedPercentage: w.usedPercentage, resetsAt: w.resetsAt, observedAt: w.observedAt };
}

/** One account in `GET /api/plan-usage`. */
export interface AccountPlanUsage {
  account: string;
  /** "Max 5x", "Team", or null when the credentials file says nothing. */
  plan: string | null;
  /** Whether the account's folder holds its expected login right now. */
  verified: boolean;
  snapshot: { fiveHour: PublicWindow | null; sevenDay: PublicWindow | null } | null;
  relaySeenAt: string | null;
  /** Readings held back for it (docs/plan-usage.md). */
  held: number;
  /** claude-remote sessions running under it. */
  running: number;
  /** Ledger usage per open window; null without a snapshot to take windows from. */
  tokens: { fiveHour: WindowTokens | null; sevenDay: WindowTokens | null } | null;
  /** True for the account the current project's jobs run under (projectAccount). */
  jobs: boolean;
  setup: { command: string | null; settingsPath: string };
}

const WINDOW_S = { fiveHour: 5 * 3600, sevenDay: 7 * 24 * 3600 } as const;

/** The login's creation time (ISO), or null: where "this week" starts for a login younger than the week. */
function loginCreatedAt(account: string): string | null {
  try {
    const raw = readIdentity(account)?.accountCreatedAt;
    const ms = raw ? Date.parse(raw) : NaN;
    return Number.isNaN(ms) ? null : new Date(ms).toISOString();
  } catch {
    return null;
  }
}

function windowTokens(account: string, reading: WindowReading | null, length: number, now: number): WindowTokens | null {
  if (!reading || reading.resetsAt * 1000 <= now) return null; // closed: nothing current to count
  const start = new Date((reading.resetsAt - length) * 1000).toISOString();
  const created = loginCreatedAt(account);
  const sinceLogin = created !== null && created > start;
  const since = sinceLogin ? created : start;
  const usage = usageByAccount(account, since, projectsDir(account));
  return usage ? { ...usage, since, sinceLogin } : null;
}

/**
 * Every configured account's plan usage, for the chip and the usage page. Only
 * labels and figures: the credentials file gives `plan` and nothing else, and
 * no login identity is included (the route is unauthenticated, like
 * `/api/accounts`).
 */
export function planUsageSummary(
  running: { account: string }[],
  cwd: string | undefined,
  now = Date.now()
): AccountPlanUsage[] {
  const jobsAccount = projectAccount(cwd);
  return accountNames().map((account) => {
    const snapshot = getSnapshot(account);
    return {
      account,
      plan: planLabel(account),
      verified: accountLogin(account, now)?.ok === true,
      snapshot: snapshot && { fiveHour: publicWindow(snapshot.fiveHour), sevenDay: publicWindow(snapshot.sevenDay) },
      relaySeenAt: getRelaySeenAt(account),
      held: getHeld(account).length,
      running: running.filter((s) => s.account === account).length,
      tokens: snapshot
        ? {
            fiveHour: windowTokens(account, snapshot.fiveHour, WINDOW_S.fiveHour, now),
            sevenDay: windowTokens(account, snapshot.sevenDay, WINDOW_S.sevenDay, now),
          }
        : null,
      jobs: account === jobsAccount,
      setup: { command: statuslineCommand(), settingsPath: settingsPath(account) },
    };
  });
}

export interface PlanUsageRouteDeps {
  /** Running claude-remote sessions (`getRunningSessions`), for each account's count. */
  runningSessions?: () => { account: string }[];
}

export function registerPlanUsageRoutes(app: FastifyInstance, deps: PlanUsageRouteDeps = {}): void {
  // The relay: scripts/statusline.mjs posts `{ rate_limits }` on every status
  // line render. A post with no usable limits is normal (before a session's
  // first response, or on a plan without limits); it still counts as contact,
  // which is how the chip knows the relay is installed.
  //
  // Each login has its own limits: the script sends its claude-remote session
  // (`session_id`) and CLAUDE_CONFIG_DIR (`config_dir`, empty for the default
  // ~/.claude), and the reading is kept under that account only once verified
  // as its login (classifyRelayPost); anything else is held back.
  app.post('/api/plan-usage', { bodyLimit: BODY_LIMIT }, async (request) => {
    const { account, verdict } = classifyRelayPost(request.body);
    const carried = recordReading(request.body, account, verdict);
    return { stored: carried && verdict.verified, held: carried && !verdict.verified, account };
  });

  // Readings held back (docs/plan-usage.md), for the usage page.
  app.get('/api/plan-usage/held', async () => ({ held: getHeld() }));

  // Drop one held-back reading (`{ id }`) or all of an account's (`{ account }`;
  // null for a folder no account uses). Only ever removes diagnostics.
  app.post('/api/plan-usage/held/discard', async (request, reply) => {
    const body = (request.body ?? {}) as { id?: unknown; account?: unknown };
    if (typeof body.id === 'string') return { discarded: discardHeld({ id: body.id }) };
    if (body.account === null || isAccount(body.account)) return { discarded: discardHeld({ account: body.account }) };
    return reply.code(400).send({ error: 'Pass { id } or { account }' });
  });

  // Every account (the chip shows them all). `?account=` names the attached
  // session's, marked `attached`; `?cwd=` its folder, which says whose login the
  // project's jobs run under. The top-level account/snapshot/relaySeenAt/setup
  // are the attached (else default) account's, so a tab from before still renders.
  app.get<{ Querystring: { account?: string; cwd?: string } }>('/api/plan-usage', async (request) => {
    const asked = request.query?.account;
    const attached = isAccount(asked) ? asked : undefined;
    const cwd = typeof request.query?.cwd === 'string' && request.query.cwd ? request.query.cwd : undefined;
    const accounts = planUsageSummary(deps.runningSessions?.() ?? [], cwd);
    const legacy = accounts.find((a) => a.account === (attached ?? defaultAccount())) ?? accounts[0];
    return {
      ...(attached ? { attached } : {}),
      accounts,
      account: legacy?.account,
      snapshot: legacy?.snapshot ?? null,
      relaySeenAt: legacy?.relaySeenAt ?? null,
      setup: legacy?.setup ?? { command: statuslineCommand() },
    };
  });
}

import { existsSync, readdirSync, readFileSync, statSync, unlinkSync } from 'fs';
import { homedir } from 'os';
import { dirname, isAbsolute, join, resolve } from 'path';
import { accountConfigProblems, getConfig, type AccountConfig } from './config.js';
import { DEFAULT_ACCOUNT, DEFAULT_ACCOUNTS } from './account-defaults.js';
import { isDescendantOf, loadRegistry, type RegistryProject } from './projects/registry.js';
import { pathKey } from './utils/paths.js';
import { tryGetTranscriptPath } from './sessions/transcript.js';

/**
 * Claude logins (docs/accounts.md). An account is one Claude Code config folder
 * and the identity expected to be logged in there; every session runs under one.
 * Projects, branches and worktrees stay account-neutral.
 */

/** A start named an account the config doesn't define. */
export class UnknownAccountError extends Error {
  constructor(readonly account: string) {
    super(`Unknown account "${account}" (known: ${accountNames().join(', ')})`);
    this.name = 'UnknownAccountError';
  }
}

/**
 * The configured accounts. A config without any (tests' mocks, or an empty
 * `accounts: {}`, which accountProblems reports at boot) gets the defaults.
 */
export function accountConfigs(): Record<string, AccountConfig> {
  const accounts = getConfig().accounts;
  return accounts && Object.keys(accounts).length > 0 ? accounts : DEFAULT_ACCOUNTS;
}

export function accountNames(): string[] {
  return Object.keys(accountConfigs());
}

export function isAccount(name: unknown): name is string {
  return typeof name === 'string' && Object.prototype.hasOwnProperty.call(accountConfigs(), name);
}

/** The account a session gets when nothing names one. */
export function defaultAccount(): string {
  const configured = getConfig().defaultAccount;
  return isAccount(configured) ? configured : isAccount(DEFAULT_ACCOUNT) ? DEFAULT_ACCOUNT : accountNames()[0];
}

/**
 * The account a project's sessions default to: `account` on the most specific
 * projects.json entry that is `cwd` or contains it. A shortcut only — a start
 * that names an account wins. Unknown names are ignored, not fatal.
 */
export function projectDefaultAccount(cwd: string | undefined, registered?: RegistryProject[]): string | null {
  return projectAccountEntry(cwd, registered)?.account ?? null;
}

/**
 * The projects.json entry projectDefaultAccount reads its answer from — `cwd`'s
 * own, or a parent's (the header shows that one as inherited). `registered`
 * saves re-reading the file when the caller has it.
 */
export function projectAccountEntry(
  cwd: string | undefined,
  registered?: RegistryProject[]
): { cwd: string; account: string } | null {
  if (!cwd) return null;
  let projects = registered;
  if (!projects) {
    try {
      projects = loadRegistry().projects;
    } catch {
      return null; // no data folder configured yet: there is no project default to find
    }
  }
  let best: { cwd: string; account: string } | null = null;
  for (const project of projects) {
    if (!isAccount(project.account)) continue;
    const covers = pathKey(project.cwd) === pathKey(cwd) || isDescendantOf(cwd, project.cwd);
    if (covers && (!best || pathKey(project.cwd).length > pathKey(best.cwd).length)) {
      best = { cwd: project.cwd, account: project.account };
    }
  }
  return best;
}

/**
 * The account a new session starts under: the one its start names, else its
 * project's default, else the configured default. Throws UnknownAccountError
 * for a named account that doesn't exist, rather than quietly using another.
 */
export function resolveStartAccount(requested: string | null | undefined, cwd?: string): string {
  if (requested !== undefined && requested !== null && requested !== '') {
    if (!isAccount(requested)) throw new UnknownAccountError(String(requested));
    return requested;
  }
  return projectDefaultAccount(cwd) ?? defaultAccount();
}

/**
 * The account work with no session of its own runs under — a job's stages, the
 * session-log generator's backfills: its project's default, else the configured one.
 */
export function projectAccount(cwd: string | undefined): string {
  return projectDefaultAccount(cwd) ?? defaultAccount();
}

/** `~` / `~/x` resolved against the home folder; anything else made absolute. */
export function expandHome(path: string, home: string = homedir()): string {
  if (path === '~') return home;
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(home, path.slice(2));
  return isAbsolute(path) ? resolve(path) : resolve(home, path);
}

/**
 * Everything wrong with the account config: the shape (`accountConfigProblems`)
 * plus a configDir that neither exists as a folder nor could be created (its
 * parent is missing). Logged at boot; each bad account refuses its own launches.
 */
export function accountProblems(home: string = homedir()): string[] {
  // The accounts as written, so an empty `accounts: {}` is named rather than hidden by the defaults.
  const problems = accountConfigProblems({
    accounts: getConfig().accounts ?? accountConfigs(),
    defaultAccount: getConfig().defaultAccount ?? DEFAULT_ACCOUNT,
  });
  for (const [name, account] of Object.entries(accountConfigs())) {
    if (typeof account?.configDir !== 'string' || !account.configDir.trim()) continue;
    const dir = expandHome(account.configDir, home);
    if (existsSync(dir)) {
      if (!statSync(dir).isDirectory()) problems.push(`accounts.${name}: configDir ${dir} is not a folder`);
    } else if (!existsSync(dirname(dir))) {
      problems.push(`accounts.${name}: configDir ${dir} does not exist and its parent is missing`);
    }
  }
  return problems;
}

// --- Per-account paths -----------------------------------------------------
//
// Every Claude Code path claude-remote reads goes through these: a session's own
// data uses its account, a scan covers every account. A hardcoded `~/.claude`
// reads the work login's folder for a personal session.

/** The account's Claude Code config folder (its `CLAUDE_CONFIG_DIR`). Throws for an unknown account. */
export function configDir(account: string, home: string = homedir()): string {
  if (!isAccount(account)) throw new UnknownAccountError(account);
  return expandHome(accountConfigs()[account].configDir, home);
}

/** `<configDir>/projects`: the account's transcripts and per-project auto-memory. */
export function projectsDir(account: string, home?: string): string {
  return join(configDir(account, home), 'projects');
}

/** `<configDir>/sessions`: Claude Code's live registry of running sessions (claude-registry.ts). */
export function sessionsDir(account: string, home?: string): string {
  return join(configDir(account, home), 'sessions');
}

/** `<configDir>/skills`: user-scope skills. */
export function skillsDir(account: string, home?: string): string {
  return join(configDir(account, home), 'skills');
}

/** `<configDir>/commands`: user-scope slash commands. */
export function commandsDir(account: string, home?: string): string {
  return join(configDir(account, home), 'commands');
}

/** `<configDir>/settings.json`: hooks, statusLine. */
export function settingsPath(account: string, home?: string): string {
  return join(configDir(account, home), 'settings.json');
}

/** `<configDir>/.credentials.json`: the login's OAuth tokens (plan usage reads it). */
export function credentialsPath(account: string, home?: string): string {
  return join(configDir(account, home), '.credentials.json');
}

/**
 * The login's plan as a label ("Max 5x", "Team"), from its credentials file's
 * `claudeAiOauth.subscriptionType` and `rateLimitTier` — the only two fields
 * read. That file holds the login's OAuth tokens: nothing else of it is kept,
 * returned or logged. Null when either is missing or unreadable.
 *
 * Only the label is cached, by the file's mtime and size: the chip asks on every
 * poll, and re-parsing the file each time would put its tokens in memory as often.
 */
export function planLabel(account: string, home?: string): string | null {
  const path = credentialsPath(account, home);
  let stat;
  try {
    stat = statSync(path);
  } catch {
    planLabels.delete(path);
    return null;
  }
  const cached = planLabels.get(path);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.label;
  let type: unknown;
  let tier: unknown;
  try {
    const oauth = (JSON.parse(readFileSync(path, 'utf-8')) as { claudeAiOauth?: Record<string, unknown> })?.claudeAiOauth;
    type = oauth?.subscriptionType;
    tier = oauth?.rateLimitTier;
  } catch {
    return cached?.label ?? null; // caught mid-write: the last label still holds
  }
  let label: string | null = null;
  if (typeof type === 'string' && /^[a-z0-9_-]{1,40}$/i.test(type)) {
    const multiple = typeof tier === 'string' ? /(\d+)x\b/i.exec(tier)?.[1] : undefined;
    const name = type.charAt(0).toUpperCase() + type.slice(1).toLowerCase();
    label = multiple ? `${name} ${multiple}x` : name;
  }
  planLabels.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, label });
  return label;
}

/** planLabel's labels by credentials path. Labels only — never anything else from the file. */
const planLabels = new Map<string, { mtimeMs: number; size: number; label: string | null }>();

/** Each distinct value of `perAccount` over every account, in config order. Two accounts on one folder count once. */
function distinctPaths(perAccount: (account: string) => string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const account of accountNames()) {
    const path = perAccount(account);
    const key = pathKey(path);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(path);
  }
  return out;
}

/** Every account's projects folder: what a scan of transcripts covers. */
export function allProjectsDirs(home?: string): string[] {
  return distinctPaths((a) => projectsDir(a, home));
}

/** Every account's skills folder: the repo's skills are installed into each. */
export function allSkillsDirs(home?: string): string[] {
  return distinctPaths((a) => skillsDir(a, home));
}

/** Every account's live-session registry folder. */
export function allSessionsDirs(home?: string): string[] {
  return distinctPaths((a) => sessionsDir(a, home));
}

/**
 * A conversation's transcript, looked for in `preferred`'s folder first, then in
 * every other account's. Null when no account has it.
 */
export function findTranscript(
  cwd: string,
  claudeSessionId: string,
  preferred?: string | null,
  home?: string
): { path: string; account: string } | null {
  const order = isAccount(preferred) ? [preferred, ...accountNames().filter((a) => a !== preferred)] : accountNames();
  for (const account of order) {
    const path = tryGetTranscriptPath(projectsDir(account, home), cwd, claudeSessionId);
    if (path) return { path, account };
  }
  return null;
}

/** True when the account's folder is Claude Code's default, `~/.claude`. */
export function isDefaultConfigDir(account: string, home: string = homedir()): boolean {
  return pathKey(configDir(account, home)) === pathKey(join(home, '.claude'));
}

/**
 * The account's global config file: login (`oauthAccount`), folder trust, user- and
 * local-scope MCP servers. Inside a custom `CLAUDE_CONFIG_DIR`, but `~/.claude.json`
 * — beside the folder — for the default `~/.claude`, which is therefore launched
 * without `CLAUDE_CONFIG_DIR` (sessionAccountEnv) so Claude Code reads that same file.
 */
export function claudeJsonPath(account: string, home: string = homedir()): string {
  return isDefaultConfigDir(account, home) ? join(home, '.claude.json') : join(configDir(account, home), '.claude.json');
}

// --- Launch: environment, identity, preflight --------------------------------

/**
 * Inherited variables that override a config folder's login or settings: an API
 * key or OAuth token logs `claude` in as whoever owns it, and the telemetry
 * switches report to whatever collector they name. Every launch drops them
 * (plus every `OTEL_*`), so the account's folder alone decides.
 */
export const STRIPPED_LAUNCH_ENV = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_ENABLE_TELEMETRY',
] as const;

function stripped(key: string): boolean {
  const upper = key.toUpperCase();
  return (STRIPPED_LAUNCH_ENV as readonly string[]).includes(upper) || upper.startsWith('OTEL_') || upper === 'CLAUDE_CONFIG_DIR';
}

/**
 * `env` as a launch under `account` gets it: the auth/telemetry overrides gone and
 * `CLAUDE_CONFIG_DIR` set to the account's folder — or removed for the default
 * `~/.claude`, so Claude Code keeps reading `~/.claude.json` (claudeJsonPath).
 * Keys are matched case-insensitively (Windows env). Never mutates its input.
 */
export function accountEnv<T extends Record<string, string | undefined>>(
  env: T,
  account: string,
  home?: string
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) if (!stripped(key)) out[key] = value;
  if (!isDefaultConfigDir(account, home)) out.CLAUDE_CONFIG_DIR = configDir(account, home);
  return out;
}

/** Who is logged in to a config folder: its `.claude.json` `oauthAccount`. */
export interface Identity {
  accountUuid?: string;
  organizationUuid?: string;
  emailAddress?: string;
  organizationName?: string;
  /** When the login was created (ISO): the usage ledger's cut-off for transcripts moved into its folder. */
  accountCreatedAt?: string;
}

/**
 * `.claude.json` exists but could not be parsed. Claude Code rewrites it in place
 * (not via rename), so a read can land mid-write: that is not a logout, and must
 * neither refuse a launch as `no-login` nor flag every running session.
 */
export class IdentityUnreadableError extends Error {
  constructor(readonly path: string) {
    super(`Could not read ${path} (Claude Code may be writing it): try again`);
    this.name = 'IdentityUnreadableError';
  }
}

/**
 * Last good reading per `.claude.json`, keyed by its mtime and size: every launch,
 * hook call and watch tick asks, and the file is often hundreds of KB (project
 * history) for a few fields.
 */
const identityCache = new Map<string, { mtimeMs: number; size: number; identity: Identity | null }>();

/** Forget cached logins (tests that rewrite a `.claude.json` faster than its mtime moves). */
export function clearIdentityCache(): void {
  identityCache.clear();
}

/** How often a parse is retried at once before falling back to the last good reading. */
const READ_ATTEMPTS = 3;

/**
 * The account's login, or null when nobody is logged in there (no file, or no
 * `oauthAccount` in it). A file caught mid-write gives the last good reading of it;
 * with none, IdentityUnreadableError.
 */
export function readIdentity(account: string, home?: string): Identity | null {
  const path = claudeJsonPath(account, home);
  const cached = identityCache.get(path);
  for (let attempt = 0; attempt < READ_ATTEMPTS; attempt++) {
    let stat;
    try {
      stat = statSync(path);
    } catch {
      identityCache.delete(path);
      return null; // no file: nobody has logged in there
    }
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.identity;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf-8'));
    } catch {
      continue; // caught mid-write: look again
    }
    const identity = identityOf(parsed);
    identityCache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, identity });
    return identity;
  }
  if (cached) return cached.identity;
  throw new IdentityUnreadableError(path);
}

function identityOf(parsed: unknown): Identity | null {
  const oauth = (parsed as { oauthAccount?: unknown } | null)?.oauthAccount;
  if (!oauth || typeof oauth !== 'object') return null;
  const o = oauth as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  const identity: Identity = {
    accountUuid: str(o.accountUuid),
    organizationUuid: str(o.organizationUuid),
    emailAddress: str(o.emailAddress),
    organizationName: str(o.organizationName),
    accountCreatedAt: str(o.accountCreatedAt),
  };
  return identity.accountUuid || identity.organizationUuid ? identity : null;
}

/** `remote-settings*.json` in the account's folder: settings an org login pushed there. */
export function remoteSettingsFiles(account: string, home?: string): string[] {
  const dir = configDir(account, home);
  try {
    return readdirSync(dir)
      .filter((f) => /^remote-settings.*\.json$/i.test(f))
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}

export type RefusalReason = 'no-expected-identity' | 'unreadable' | 'no-login' | 'mismatch' | 'org-settings';

export interface PreflightRefusal {
  ok: false;
  account: string;
  configDir: string;
  reason: RefusalReason;
  /** Who is logged in there, or null for nobody. */
  found: Identity | null;
  expected: { accountUuid?: string; organizationUuid?: string };
  /** For `org-settings`: the files an org login left behind (Clean up deletes them). */
  remoteSettings?: string[];
  message: string;
}

export type PreflightResult = { ok: true; account: string; configDir: string; found: Identity } | PreflightRefusal;

function describe(identity: Identity | null): string {
  if (!identity) return 'nobody';
  const who = identity.emailAddress ?? identity.accountUuid ?? 'an unknown login';
  return identity.organizationName ? `${who} (${identity.organizationName})` : who;
}

/**
 * Whether `found` is the login the account expects (its configured accountUuid
 * and/or organizationUuid). False for an account that expects nothing: there is
 * no expected login to be.
 */
export function isExpectedLogin(account: string, found: Identity | null): boolean {
  const cfg = isAccount(account) ? accountConfigs()[account] : undefined;
  if (!found || !cfg || (!cfg.accountUuid && !cfg.organizationUuid)) return false;
  return (
    (!cfg.accountUuid || found.accountUuid === cfg.accountUuid) &&
    (!cfg.organizationUuid || found.organizationUuid === cfg.organizationUuid)
  );
}

/**
 * When the account's expected login was created (ISO, normalised), or null —
 * nobody there, another login there (a `/login` swap: its creation date says
 * nothing about this account), no date recorded, or the file caught mid-write
 * with no earlier reading. Where "this account's" usage can start.
 */
export function expectedLoginCreatedAt(account: string, home?: string): string | null {
  let found: Identity | null;
  try {
    found = readIdentity(account, home);
  } catch {
    return null;
  }
  if (!isExpectedLogin(account, found)) return null;
  const ms = found?.accountCreatedAt ? Date.parse(found.accountCreatedAt) : NaN;
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/**
 * Is the expected login in the account's folder? Run before every launch: a
 * mismatch or no login refuses it. An account that expects no organization
 * (personal) is also refused while `remote-settings*.json` sits in its folder —
 * an org login happened there, and its pushed settings (telemetry) still apply.
 */
export function preflight(account: string, home?: string): PreflightResult {
  const dir = configDir(account, home);
  const cfg = accountConfigs()[account];
  const expected = {
    ...(cfg.accountUuid ? { accountUuid: cfg.accountUuid } : {}),
    ...(cfg.organizationUuid ? { organizationUuid: cfg.organizationUuid } : {}),
  };
  let found: Identity | null = null;
  let unreadable: IdentityUnreadableError | null = null;
  try {
    found = readIdentity(account, home);
  } catch (error) {
    if (!(error instanceof IdentityUnreadableError)) throw error;
    unreadable = error;
  }
  const refuse = (reason: RefusalReason, message: string, extra: Partial<PreflightRefusal> = {}): PreflightRefusal => ({
    ok: false,
    account,
    configDir: dir,
    reason,
    found,
    expected,
    message,
    ...extra,
  });

  if (!expected.accountUuid && !expected.organizationUuid) {
    return refuse(
      'no-expected-identity',
      `Account "${account}" has no expected identity: set accountUuid or organizationUuid for it in config.json (docs/accounts.md)`
    );
  }
  if (unreadable) return refuse('unreadable', `Account "${account}": ${unreadable.message}`);
  if (!found) return refuse('no-login', `Nobody is logged in to account "${account}" (${dir}): log in there first`);
  if (!isExpectedLogin(account, found)) {
    const want = expected.accountUuid ? `account ${expected.accountUuid}` : `organization ${expected.organizationUuid}`;
    return refuse('mismatch', `Account "${account}" (${dir}) is logged in as ${describe(found)}, but expects ${want}`);
  }
  if (!expected.organizationUuid) {
    const files = remoteSettingsFiles(account, home);
    if (files.length > 0) {
      return refuse(
        'org-settings',
        `Account "${account}" (${dir}) holds org-pushed settings (${files.map((f) => f.slice(dir.length + 1)).join(', ')}): ` +
          'an organization login happened there. Clean up, then log in again.',
        { remoteSettings: files }
      );
    }
  }
  return { ok: true, account, configDir: dir, found };
}

/** A launch refused by preflight. Carries the refusal, for the Log in / Clean up dialog. */
export class AccountRefusedError extends Error {
  readonly status = 409;
  constructor(readonly refusal: PreflightRefusal) {
    super(refusal.message);
    this.name = 'AccountRefusedError';
  }
}

/** Throw AccountRefusedError unless the account's folder holds its expected login. */
export function assertAccountReady(account: string, home?: string): void {
  const result = preflight(account, home);
  if (!result.ok) throw new AccountRefusedError(result);
}

/**
 * Clean up: delete the org-pushed `remote-settings*.json` from an account that
 * expects no organization, before its Log in session (`/logout`, then `/login`
 * with the right login). Refused for an org account: those files are its own.
 * Returns the files deleted.
 */
export function cleanupAccount(account: string, home?: string): string[] {
  if (!isAccount(account)) throw new UnknownAccountError(account);
  if (accountConfigs()[account].organizationUuid) {
    throw new Error(`Account "${account}" is an organization login: its remote settings are its own`);
  }
  const deleted: string[] = [];
  for (const file of remoteSettingsFiles(account, home)) {
    unlinkSync(file);
    deleted.push(file);
  }
  return deleted;
}

/**
 * The account whose folder is `dir` — a `CLAUDE_CONFIG_DIR` as a process saw it.
 * Empty means Claude Code's default `~/.claude`. Null when no account uses it.
 */
export function accountForConfigDir(dir: string | null | undefined, home: string = homedir()): string | null {
  const target = pathKey(dir ? expandHome(dir, home) : join(home, '.claude'));
  return accountNames().find((a) => pathKey(configDir(a, home)) === target) ?? null;
}

/**
 * What of claude-remote's setup the account's settings.json lacks: the
 * claude-session hook (Fork, Resume, the session log), the notification hooks,
 * the plan-usage status line. Read-only; scripts/install-account-setup.mjs copies
 * them over from an account that has them (docs/accounts.md).
 */
export function accountSetupMissing(account: string, home?: string): string[] {
  let settings: { hooks?: Record<string, unknown>; statusLine?: { command?: unknown } } = {};
  try {
    settings = JSON.parse(readFileSync(settingsPath(account, home), 'utf-8'));
  } catch {
    // No settings yet: everything is missing.
  }
  const commands = (event: string): string[] => {
    const groups = settings.hooks?.[event];
    if (!Array.isArray(groups)) return [];
    return groups.flatMap((g: { hooks?: { command?: unknown }[] }) =>
      Array.isArray(g?.hooks) ? g.hooks.map((h) => (typeof h?.command === 'string' ? h.command : '')) : []
    );
  };
  const has = (event: string, route: string) => commands(event).some((c) => c.includes('CLAUDE_REMOTE_SESSION_ID') && c.includes(route));
  const missing: string[] = [];
  if (!has('SessionStart', '/claude-session')) missing.push('SessionStart claude-session hook');
  if (!has('Stop', '/api/notify/')) missing.push('Stop notification hook');
  if (!has('Notification', '/api/notify/')) missing.push('Notification hook');
  const statusLine = settings.statusLine?.command;
  if (typeof statusLine !== 'string' || !statusLine.includes('statusline.mjs')) missing.push('plan-usage statusLine');
  return missing;
}

/**
 * `GET /api/accounts`: what the Account picker needs, and nothing about where the
 * logins live. That route is unauthenticated on `0.0.0.0` like the rest of `/api/*`,
 * so it names no folder, identity or email.
 */
export function accountsSummary(home?: string): {
  defaultAccount: string;
  accounts: { name: string; ready: boolean; setupMissing: string[] }[];
} {
  return {
    defaultAccount: defaultAccount(),
    accounts: accountNames().map((name) => ({
      name,
      ready: preflight(name, home).ok,
      setupMissing: accountSetupMissing(name, home),
    })),
  };
}

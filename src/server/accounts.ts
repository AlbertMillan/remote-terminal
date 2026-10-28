import { existsSync, readdirSync, readFileSync, statSync, unlinkSync } from 'fs';
import { homedir } from 'os';
import { dirname, isAbsolute, join, resolve } from 'path';
import { accountConfigProblems, getConfig, type AccountConfig } from './config.js';
import { DEFAULT_ACCOUNT, DEFAULT_ACCOUNTS } from './account-defaults.js';
import { isDescendantOf, loadRegistry } from './projects/registry.js';
import { isInside, pathKey } from './utils/paths.js';
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

/** The configured accounts. A config without any (tests' mocks) gets the defaults. */
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
export function projectDefaultAccount(cwd: string | undefined): string | null {
  if (!cwd) return null;
  let projects;
  try {
    projects = loadRegistry().projects;
  } catch {
    return null; // no data folder configured yet: there is no project default to find
  }
  let best: { cwd: string; account: string } | null = null;
  for (const project of projects) {
    if (!isAccount(project.account)) continue;
    const covers = pathKey(project.cwd) === pathKey(cwd) || isDescendantOf(cwd, project.cwd);
    if (covers && (!best || pathKey(project.cwd).length > pathKey(best.cwd).length)) {
      best = { cwd: project.cwd, account: project.account };
    }
  }
  return best?.account ?? null;
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
  const problems = accountConfigProblems({ accounts: accountConfigs(), defaultAccount: getConfig().defaultAccount ?? DEFAULT_ACCOUNT });
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

/** Every account's live-session registry folder. */
export function allSessionsDirs(home?: string): string[] {
  return distinctPaths((a) => sessionsDir(a, home));
}

/**
 * The account a transcript belongs to: the one whose projects folder holds it.
 * `usage_files` needs no account column because of this. Null for a path in
 * no account's folder.
 */
export function accountForTranscriptPath(path: string, home?: string): string | null {
  return accountNames().find((account) => isInside(projectsDir(account, home), path)) ?? null;
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
}

/** The account's login, or null when nobody is logged in there (or the file is unreadable). */
export function readIdentity(account: string, home?: string): Identity | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(claudeJsonPath(account, home), 'utf-8'));
  } catch {
    return null;
  }
  const oauth = (parsed as { oauthAccount?: unknown } | null)?.oauthAccount;
  if (!oauth || typeof oauth !== 'object') return null;
  const o = oauth as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  const identity: Identity = {
    accountUuid: str(o.accountUuid),
    organizationUuid: str(o.organizationUuid),
    emailAddress: str(o.emailAddress),
    organizationName: str(o.organizationName),
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

export type RefusalReason = 'no-expected-identity' | 'no-login' | 'mismatch' | 'org-settings';

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
  const found = readIdentity(account, home);
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
  if (!found) return refuse('no-login', `Nobody is logged in to account "${account}" (${dir}): log in there first`);
  const matches =
    (!expected.accountUuid || found.accountUuid === expected.accountUuid) &&
    (!expected.organizationUuid || found.organizationUuid === expected.organizationUuid);
  if (!matches) {
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

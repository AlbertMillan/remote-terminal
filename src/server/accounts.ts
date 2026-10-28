import { existsSync, statSync } from 'fs';
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

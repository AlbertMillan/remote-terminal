import { existsSync, statSync } from 'fs';
import { homedir } from 'os';
import { dirname, isAbsolute, join, resolve } from 'path';
import { accountConfigProblems, getConfig, type AccountConfig } from './config.js';
import { DEFAULT_ACCOUNT, DEFAULT_ACCOUNTS } from './account-defaults.js';
import { isDescendantOf, loadRegistry } from './projects/registry.js';
import { pathKey } from './sessions/project-discovery.js';

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

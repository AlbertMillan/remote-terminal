// claude-remote's Claude accounts as the scripts see them (docs/accounts.md): the
// same defaults and `~` expansion as src/server/account-defaults.ts and accounts.ts.
// The server can't import this (its typecheck covers src/ only), so
// tests/account-setup.test.ts holds the two copies equal. Cross-platform Node.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

/**
 * The accounts (and default) a config without its own gets. No expected identity
 * until the user sets one: preflight refuses such an account rather than launching
 * under whatever login its folder happens to hold.
 */
export const DEFAULT_ACCOUNTS = {
  personal: { configDir: '~/.claude-personal' },
  work: { configDir: '~/.claude' },
};
export const DEFAULT_ACCOUNT = 'personal';

/** `~` / `~/x` resolved against the home folder; anything else made absolute against it. */
export function expandHome(path, home = homedir()) {
  if (path === '~') return home;
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(home, path.slice(2));
  return isAbsolute(path) ? resolve(path) : resolve(home, path);
}

/**
 * The accounts in claude-remote's config.json (CLAUDE_REMOTE_CONFIG, else
 * ~/.claude-remote/config.json): as written, or the defaults when it has none —
 * an empty `accounts: {}` included, as the server does.
 */
export function configuredAccounts(configPath = process.env.CLAUDE_REMOTE_CONFIG || join(homedir(), '.claude-remote', 'config.json')) {
  let accounts = null;
  try {
    accounts = JSON.parse(readFileSync(configPath, 'utf-8')).accounts ?? null;
  } catch {
    // No config, or unreadable: the defaults.
  }
  return accounts && typeof accounts === 'object' && Object.keys(accounts).length > 0 ? accounts : DEFAULT_ACCOUNTS;
}

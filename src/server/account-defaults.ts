import type { AccountConfig } from './config.js';

/**
 * The accounts (and default) a config without its own gets. Its own module so
 * accounts.ts still has them when a test mocks config.js. The scripts' copy is
 * scripts/claude-accounts.mjs; a test keeps the two equal.
 *
 * No expected identity until the user sets one: preflight refuses such an
 * account rather than launching under whatever login its folder happens to hold.
 */
export const DEFAULT_ACCOUNTS: Record<string, AccountConfig> = {
  personal: { configDir: '~/.claude-personal' },
  work: { configDir: '~/.claude' },
};
export const DEFAULT_ACCOUNT = 'personal';

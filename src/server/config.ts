import { existsSync, readFileSync, renameSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { createLogger } from './utils/logger.js';
import { DEFAULT_ACCOUNT, DEFAULT_ACCOUNTS } from './account-defaults.js';

const logger = createLogger('config');

export interface Config {
  server: {
    port: number;
    host: string;
    hostname?: string; // Tailscale hostname for HTTPS certs
    /**
     * Extra dotted names the server may be reached by (e.g. `pc.home.lan`). IP literals,
     * single-label names, localhost and `*.ts.net` need no entry. → host-check.ts
     */
    allowedHosts?: string[];
  };
  tls: {
    enabled: boolean;
    certPath?: string;
    keyPath?: string;
  };
  sessions: {
    maxSessions: number;
    defaultShell?: string;
    idleTimeoutMinutes: number; // 0 = never
    /**
     * Where a session with no folder opens, and what Tab fills in the New Session dialog.
     * `~`-relative or absolute; a missing folder falls back to the home folder
     * (sessions/folder-picker.ts).
     */
    defaultCwd?: string;
    /**
     * Copy every live Claude registry entry into every other account's folder, so
     * `ListAgents`/`SendMessage` reach sessions on another login. Off unless `true`: a
     * message is processed and kept by the account that receives it
     * (sessions/registry-mirror.ts, docs/accounts.md).
     */
    crossAccountMessaging?: boolean;
  };
  auth: {
    enabled: boolean;
    allowedUsers: string[]; // Tailscale login names
  };
  persistence: {
    scrollbackLines: number;
    dataDir: string;
  };
  projectLog: {
    enabled: boolean; // master toggle; when false the whole feature is inert
    fileName: string; // per-project log file, at repo root
    editPlanFiles: boolean; // also tick completed checkboxes in plan/design docs
    planGlobs: string[]; // globs used to locate plan/design docs
    maxConcurrent: number; // max simultaneous `claude -p` generation runs
    timeoutMs: number; // kill a generation run after this long
    minTurnsToLog: number; // tiebreaker floor on transcript user-turns
    claudeCommand: string; // executable used for headless generation
  };
  jobs: {
    // Kill a pipeline stage's `claude -p` run after this long.
    //
    // Deliberately NOT projectLog.timeoutMs, which the stages used to borrow. That
    // budget sizes the session-log generator — one transcript in, one entry out. A
    // stage reads a whole repo and authors a spec, an implementation or a review, and
    // under the 180s log budget was being killed with finished work in hand.
    stageTimeoutMs: number;
  };
  agentSessions: {
    // Sessions one main session may have started and still live, through the
    // agent-sessions API (docs/session-orchestration.md). Checked before
    // sessions.maxSessions, which still applies.
    maxPerParent: number;
  };
  /**
   * Claude logins, by name (docs/accounts.md). Each is one Claude Code config
   * folder (`CLAUDE_CONFIG_DIR`) and the identity expected to be logged in there:
   * exactly one of `accountUuid` / `organizationUuid`. Every session runs under one.
   */
  accounts: Record<string, AccountConfig>;
  /** The account a new session gets when neither its start nor its project names one. */
  defaultAccount: string;
}

export interface AccountConfig {
  /** `~`-relative or absolute; resolved by accounts.ts. */
  configDir: string;
  /** The personal login's `oauthAccount.accountUuid`. */
  accountUuid?: string;
  /** The org login's `oauthAccount.organizationUuid`. */
  organizationUuid?: string;
}

const defaultConfig: Config = {
  server: {
    port: 4220,
    host: '0.0.0.0',
  },
  tls: {
    enabled: false,
  },
  sessions: {
    maxSessions: 30,
    idleTimeoutMinutes: 0,
    defaultCwd: '~/NodeProjects',
  },
  auth: {
    enabled: false,
    allowedUsers: [],
  },
  persistence: {
    scrollbackLines: 10000,
    dataDir: join(homedir(), '.claude-remote'),
  },
  projectLog: {
    enabled: false,
    fileName: 'SESSION-LOG.md',
    editPlanFiles: true,
    planGlobs: ['*plan*.md', '*design*.md', 'docs/**/*.md'],
    maxConcurrent: 1,
    timeoutMs: 180000,
    minTurnsToLog: 2,
    claudeCommand: 'claude',
  },
  jobs: {
    stageTimeoutMs: 1_200_000, // 20 minutes
  },
  agentSessions: {
    maxPerParent: 5,
  },
  accounts: DEFAULT_ACCOUNTS,
  defaultAccount: DEFAULT_ACCOUNT,
};

let currentConfig: Config = { ...defaultConfig };

export function getConfigPath(): string {
  return process.env.CLAUDE_REMOTE_CONFIG || join(homedir(), '.claude-remote', 'config.json');
}

export function loadConfig(): Config {
  const configPath = getConfigPath();

  if (existsSync(configPath)) {
    try {
      const content = readFileSync(configPath, 'utf-8');
      const loaded = JSON.parse(content);
      currentConfig = deepMerge(defaultConfig, loaded);
      // Accounts are taken as written: merging would keep a default account the
      // user deleted, and sessions could still be started under it.
      if (loaded && typeof loaded.accounts === 'object' && loaded.accounts !== null) {
        currentConfig.accounts = loaded.accounts;
      }
      currentConfig.sessions = checkedSection('sessions', currentConfig.sessions, configPath);
      currentConfig.agentSessions = checkedSection('agentSessions', currentConfig.agentSessions, configPath);
      logger.info({ path: configPath }, 'Loaded configuration');
    } catch (error) {
      logger.error({ error, path: configPath }, 'Failed to load config, using defaults');
      currentConfig = { ...defaultConfig };
    }
  } else {
    logger.info('No config file found, using defaults');
    currentConfig = { ...defaultConfig };
  }

  // Ensure data directory exists
  if (!existsSync(currentConfig.persistence.dataDir)) {
    mkdirSync(currentConfig.persistence.dataDir, { recursive: true });
  }

  return currentConfig;
}

/**
 * The limits Settings edits, each described once: the loader, setServerSettings and the
 * route (server-settings.ts) all read this, so a new limit is one entry here plus its field
 * in the client (session-limit-setting.ts).
 *
 * - `range` is what Settings accepts. A limit written into config.json by hand isn't held
 *   to its max, only to `loadMin`.
 * - `loadMin` is the smallest value a loaded config keeps; below it, or not a whole number,
 *   the default is used. A string would turn a limit off (`count >= "abc"` is never true).
 *   maxSessions keeps 1, as 0 would refuse every session; maxPerParent keeps 0, which means
 *   no session may start others.
 */
export const LIMIT_SETTINGS = {
  maxSessions: { section: 'sessions', range: { min: 1, max: 100 }, loadMin: 1, label: 'The session limit' },
  maxPerParent: {
    section: 'agentSessions',
    range: { min: 0, max: 20 },
    loadMin: 0,
    label: 'The started-session limit',
  },
} as const;

export type LimitKey = keyof typeof LIMIT_SETTINGS;
type LimitSection = (typeof LIMIT_SETTINGS)[LimitKey]['section'];

/**
 * The on/off settings Settings edits, beside the limits. Only `true` turns one on: a
 * hand-written `"yes"` or `1` leaves it off.
 */
export const FLAG_SETTINGS = {
  crossAccountMessaging: { section: 'sessions', label: 'Cross-account messaging' },
} as const;

export type FlagKey = keyof typeof FLAG_SETTINGS;

/** The settings the Settings modal writes into config.json. */
export type ServerSettingsPatch = Partial<Record<LimitKey, number>> & Partial<Record<FlagKey, boolean>>;

export const MAX_SESSIONS_RANGE = LIMIT_SETTINGS.maxSessions.range;
export const MAX_PER_PARENT_RANGE = LIMIT_SETTINGS.maxPerParent.range;

const LIMIT_KEYS = Object.keys(LIMIT_SETTINGS) as LimitKey[];
const FLAG_KEYS = Object.keys(FLAG_SETTINGS) as FlagKey[];

function sectionOf(key: LimitKey | FlagKey): 'sessions' | 'agentSessions' {
  return key in LIMIT_SETTINGS ? LIMIT_SETTINGS[key as LimitKey].section : FLAG_SETTINGS[key as FlagKey].section;
}

/** A config section as loaded, with each unusable limit in it replaced by its default. */
function checkedSection<S extends LimitSection>(section: S, value: unknown, configPath: string): Config[S] {
  if (!isPlainObject(value)) {
    logger.warn({ path: configPath, [section]: value }, `${section} is not an object; using its defaults`);
    return { ...defaultConfig[section] };
  }
  let checked = value as Record<string, unknown>;
  for (const key of LIMIT_KEYS) {
    const { section: owner, loadMin } = LIMIT_SETTINGS[key];
    if (owner !== section) continue;
    const limit = checked[key];
    if (typeof limit === 'number' && Number.isInteger(limit) && limit >= loadMin) continue;
    const fallback = (defaultConfig[section] as Record<string, unknown>)[key];
    logger.warn(
      { path: configPath, [key]: limit, default: fallback },
      `${section}.${key} is not a whole number of ${loadMin} or more; using the default`
    );
    checked = { ...checked, [key]: fallback };
  }
  return checked as unknown as Config[S];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Change the session limits (effective for the next session opened or started) and flags
 * (read where they act: cross-account messaging at the next registry poll).
 *
 * Patches only the given keys in the file as it is on disk rather than writing out the
 * merged config: that would pin every default into the user's file, and a later change to
 * a default would never reach them. An unparseable file throws instead of being
 * replaced, or a typo would cost the user their accounts.
 */
export function setServerSettings(patch: ServerSettingsPatch): void {
  const configPath = getConfigPath();
  const onDisk: unknown = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf-8')) : {};
  if (!isPlainObject(onDisk)) {
    throw new Error(`${configPath} does not hold a JSON object`);
  }
  // A section that isn't an object (an array, a number): loadConfig ignores it too, so
  // start it afresh.
  // Patched into `next`, not `onDisk`: two limits in one section must both land.
  const next: Record<string, unknown> = { ...onDisk };
  const changed = [...LIMIT_KEYS, ...FLAG_KEYS].filter((key) => patch[key] !== undefined);
  for (const key of changed) {
    const section = sectionOf(key);
    const current = isPlainObject(next[section]) ? next[section] : {};
    next[section] = { ...current, [key]: patch[key] };
  }

  mkdirSync(dirname(configPath), { recursive: true });
  // Through a temp file: a crash mid-write must not leave a truncated config.
  const tempPath = `${configPath}.tmp`;
  try {
    writeFileSync(tempPath, JSON.stringify(next, null, 2) + '\n');
    renameSync(tempPath, configPath);
  } catch (error) {
    // Best-effort: the original error is the one worth reporting.
    try { rmSync(tempPath, { force: true }); } catch { /* left for the next save to overwrite */ }
    throw error;
  }

  // New objects: a section may still be defaultConfig's own, shared by reference.
  const updated: Record<string, unknown> = { ...currentConfig };
  for (const key of changed) {
    const section = sectionOf(key);
    updated[section] = { ...(updated[section] as object), [key]: patch[key] };
  }
  currentConfig = updated as unknown as Config;
  logger.info({ path: configPath, ...patch }, 'Saved server settings');
}

export function getConfig(): Config {
  return currentConfig;
}

/**
 * What is wrong with `config.accounts`, one line each; empty when nothing is.
 * Logged at boot rather than thrown: a bad account refuses its own launches
 * (accounts.ts preflight), and must not take every other session down with it.
 */
export function accountConfigProblems(config: Pick<Config, 'accounts' | 'defaultAccount'>): string[] {
  const problems: string[] = [];
  const accounts = config.accounts ?? {};
  if (Object.keys(accounts).length === 0) {
    // accounts.ts falls back to the built-in defaults rather than having no account at all.
    return ['accounts is empty: the built-in defaults (personal, work) are used instead; define your accounts (docs/accounts.md)'];
  }
  for (const [name, account] of Object.entries(accounts)) {
    if (!account || typeof account.configDir !== 'string' || !account.configDir.trim()) {
      problems.push(`accounts.${name}: configDir is required`);
      continue;
    }
    const ids = [account.accountUuid, account.organizationUuid].filter((v) => typeof v === 'string' && v.trim());
    if (ids.length !== 1) {
      problems.push(`accounts.${name}: set exactly one of accountUuid / organizationUuid (has ${ids.length})`);
    }
  }
  if (!Object.prototype.hasOwnProperty.call(accounts, config.defaultAccount)) {
    problems.push(`defaultAccount "${config.defaultAccount}" is not one of accounts`);
  }
  return problems;
}

function deepMerge<T extends object>(target: T, source: Partial<T>): T {
  const result = { ...target };

  for (const key in source) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      const sourceValue = source[key];
      const targetValue = target[key];

      if (
        sourceValue !== null &&
        typeof sourceValue === 'object' &&
        !Array.isArray(sourceValue) &&
        targetValue !== null &&
        typeof targetValue === 'object' &&
        !Array.isArray(targetValue)
      ) {
        (result as Record<string, unknown>)[key] = deepMerge(
          targetValue as object,
          sourceValue as object
        );
      } else if (sourceValue !== undefined) {
        (result as Record<string, unknown>)[key] = sourceValue;
      }
    }
  }

  return result;
}

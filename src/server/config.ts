import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { createLogger } from './utils/logger.js';

const logger = createLogger('config');

export interface Config {
  server: {
    port: number;
    host: string;
    hostname?: string; // Tailscale hostname for HTTPS certs
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
  };
  auth: {
    enabled: boolean;
    allowedUsers: string[]; // Tailscale login names
  };
  persistence: {
    scrollbackLines: number;
    dataDir: string;
  };
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
    maxSessions: 10,
    idleTimeoutMinutes: 0,
  },
  auth: {
    enabled: false,
    allowedUsers: [],
  },
  persistence: {
    scrollbackLines: 10000,
    dataDir: join(homedir(), '.claude-remote'),
  },
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

export function saveConfig(config: Config): void {
  const configPath = getConfigPath();
  const dir = dirname(configPath);

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(configPath, JSON.stringify(config, null, 2));
  currentConfig = config;
  logger.info({ path: configPath }, 'Saved configuration');
}

export function getConfig(): Config {
  return currentConfig;
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

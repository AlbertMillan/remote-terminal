import { readdirSync, statSync, openSync, readSync, closeSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createLogger } from '../utils/logger.js';
import { getRecentCwds } from '../db/queries.js';

const logger = createLogger('recent-paths');

export interface RecentPath {
  /** The working directory a Claude Code session ran in. */
  cwd: string;
  /** Epoch millis of the most recent activity at this path. */
  lastUsed: number;
}

// How long a scan result stays fresh. The directory scan is cheap but not free,
// and the new-session modal can be opened repeatedly in quick succession.
const CACHE_TTL_MS = 30_000;
// Upper bound on results returned to the client.
const MAX_RESULTS = 15;
// Cap how much of a transcript we read while hunting for the `cwd` field.
const HEAD_READ_BYTES = 64 * 1024;

let cache: { paths: RecentPath[]; expiresAt: number } | null = null;

/** Read up to the first HEAD_READ_BYTES of a file as utf8 (best-effort). */
function readHead(filePath: string): string {
  const fd = openSync(filePath, 'r');
  try {
    const buf = Buffer.allocUnsafe(HEAD_READ_BYTES);
    const bytesRead = readSync(fd, buf, 0, HEAD_READ_BYTES, 0);
    return buf.toString('utf8', 0, bytesRead);
  } finally {
    closeSync(fd);
  }
}

/** Extract the `cwd` field from the first transcript line that carries one. */
function extractCwd(filePath: string): string | null {
  try {
    const head = readHead(filePath);
    for (const line of head.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed) as { cwd?: unknown };
        if (typeof entry.cwd === 'string' && entry.cwd.length > 0) {
          return entry.cwd;
        }
      } catch {
        // Partial last line (truncated by HEAD_READ_BYTES) or non-JSON — skip.
      }
    }
  } catch (error) {
    logger.debug({ error, filePath }, 'Failed to read transcript head');
  }
  return null;
}

/**
 * Scan Claude Code's project transcripts for the directories sessions ran in,
 * one representative (newest) transcript per project folder.
 */
function scanClaudeProjects(): RecentPath[] {
  const projectsDir = join(homedir(), '.claude', 'projects');
  const results: RecentPath[] = [];

  let entries;
  try {
    entries = readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    // No Claude projects directory yet — nothing to suggest from this source.
    return results;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(projectsDir, entry.name);

    // Find the most-recently-modified transcript in this project folder.
    let newestFile: string | null = null;
    let newestMtime = 0;
    try {
      for (const file of readdirSync(dir)) {
        if (!file.endsWith('.jsonl')) continue;
        const full = join(dir, file);
        const mtime = statSync(full).mtimeMs;
        if (mtime > newestMtime) {
          newestMtime = mtime;
          newestFile = full;
        }
      }
    } catch {
      continue;
    }
    if (!newestFile) continue;

    const cwd = extractCwd(newestFile);
    if (cwd) {
      results.push({ cwd, lastUsed: newestMtime });
    }
  }

  return results;
}

/** Normalize a path for dedup comparison (case-insensitive on Windows). */
function normalize(cwd: string): string {
  const trimmed = cwd.replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed;
}

/**
 * Recent distinct working directories where Claude Code sessions ran, newest
 * first. Merges Claude Code's transcript history with this server's own
 * session DB. Results are cached for CACHE_TTL_MS.
 */
export function getRecentPaths(): RecentPath[] {
  if (cache && cache.expiresAt > Date.now()) {
    return cache.paths;
  }

  const merged = new Map<string, RecentPath>();
  const consider = (cwd: string, lastUsed: number) => {
    const key = normalize(cwd);
    const existing = merged.get(key);
    if (!existing || lastUsed > existing.lastUsed) {
      merged.set(key, { cwd, lastUsed });
    }
  };

  for (const p of scanClaudeProjects()) {
    consider(p.cwd, p.lastUsed);
  }

  try {
    for (const row of getRecentCwds()) {
      const ms = new Date(row.lastAccessedAt).getTime();
      consider(row.cwd, Number.isNaN(ms) ? 0 : ms);
    }
  } catch (error) {
    logger.debug({ error }, 'Failed to read recent cwds from DB');
  }

  const paths = [...merged.values()]
    .sort((a, b) => b.lastUsed - a.lastUsed)
    .slice(0, MAX_RESULTS);

  cache = { paths, expiresAt: Date.now() + CACHE_TTL_MS };
  return paths;
}

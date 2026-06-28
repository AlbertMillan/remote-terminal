import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'fs';
import { basename, join } from 'path';
import { homedir } from 'os';
import { getConfig } from '../config.js';
import { createLogger } from '../utils/logger.js';
import { getRecentCwds } from '../db/queries.js';
import { parseLogEntries, parsePhasesBlock, type LogEntryMeta, type ParsedLogEntry, type PhaseGroup } from './session-log-format.js';

const logger = createLogger('project-discovery');

const MAX_TRANSCRIPTS_PER_PROJECT = 5;
const FIRST_CHUNK_BYTES = 65536;

export interface DiscoveredProject {
  cwd: string; // real working directory (display + generation target)
  name: string; // basename of cwd
  hasLog: boolean; // SESSION-LOG.md present at cwd root
  lastActivity: string | null; // ISO timestamp of most recent transcript / DB access
  transcriptCount: number;
  transcriptPaths: string[]; // absolute paths, newest first, capped
}

/** Normalize a path for case/separator-insensitive dedup keys (Windows-friendly). */
export function pathKey(p: string): string {
  return p.replace(/[\\/]+/g, '\\').replace(/\\+$/, '').toLowerCase();
}

/**
 * Read the first JSONL line that carries a `cwd` field (Claude Code records the
 * real working directory on each transcript line). Returns null if none found in
 * the first chunk. Reads only the head of the file to stay cheap on big logs.
 */
function readTranscriptCwd(file: string): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(file, 'r');
    const buf = Buffer.alloc(FIRST_CHUNK_BYTES);
    const bytes = readSync(fd, buf, 0, buf.length, 0);
    const text = buf.toString('utf8', 0, bytes);
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed) as { cwd?: unknown };
        if (typeof obj.cwd === 'string' && obj.cwd.length > 0) return obj.cwd;
      } catch {
        // partial/truncated final line in the chunk — ignore
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

interface Accum {
  cwd: string;
  transcripts: { path: string; mtimeMs: number }[];
  lastActivityMs: number;
}

const CACHE_TTL_MS = 5000;
let cache: { at: number; projects: DiscoveredProject[] } | null = null;

/**
 * Enumerate known projects from two sources, unified by working directory:
 *  - every project dir under ~/.claude/projects (real cwd decoded from a
 *    transcript line, since the slugified dir name is lossy), and
 *  - distinct cwds recorded in the sessions DB.
 *
 * Cached for a few seconds because the scan is fully synchronous fs IO and the
 * dashboard may poll it. Pass { force: true } to bypass the cache.
 */
export function discoverProjects(opts?: { force?: boolean }): DiscoveredProject[] {
  const now = Date.now();
  if (!opts?.force && cache && now - cache.at < CACHE_TTL_MS) {
    return cache.projects;
  }
  const projects = scanProjects();
  cache = { at: now, projects };
  return projects;
}

function scanProjects(): DiscoveredProject[] {
  const byKey = new Map<string, Accum>();

  // Source 1: ~/.claude/projects/*
  const projectsDir = join(homedir(), '.claude', 'projects');
  try {
    for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(projectsDir, entry.name);
      let jsonls: { path: string; mtimeMs: number }[];
      try {
        jsonls = readdirSync(dir)
          .filter((f) => f.endsWith('.jsonl'))
          .map((f) => {
            const path = join(dir, f);
            return { path, mtimeMs: statSync(path).mtimeMs };
          });
      } catch {
        continue;
      }
      if (jsonls.length === 0) continue;
      jsonls.sort((a, b) => b.mtimeMs - a.mtimeMs);

      // Decode the real cwd from the newest readable transcript.
      let cwd: string | null = null;
      for (const j of jsonls) {
        cwd = readTranscriptCwd(j.path);
        if (cwd) break;
      }
      if (!cwd) continue;

      const key = pathKey(cwd);
      const existing = byKey.get(key);
      const lastActivityMs = jsonls[0].mtimeMs;
      if (existing) {
        existing.transcripts.push(...jsonls);
        existing.lastActivityMs = Math.max(existing.lastActivityMs, lastActivityMs);
      } else {
        byKey.set(key, { cwd, transcripts: [...jsonls], lastActivityMs });
      }
    }
  } catch {
    logger.debug({ projectsDir }, 'project-discovery: projects dir not readable');
  }

  // Source 2: distinct cwds from the sessions DB (covers projects that may not
  // have a transcript dir, and supplies DB last-access times).
  try {
    for (const { cwd, lastAccessedAt } of getRecentCwds(200)) {
      if (!cwd) continue;
      const key = pathKey(cwd);
      const ms = Date.parse(lastAccessedAt);
      const existing = byKey.get(key);
      if (existing) {
        if (!Number.isNaN(ms)) existing.lastActivityMs = Math.max(existing.lastActivityMs, ms);
      } else {
        byKey.set(key, { cwd, transcripts: [], lastActivityMs: Number.isNaN(ms) ? 0 : ms });
      }
    }
  } catch {
    // DB not available — fall back to transcript-only discovery
  }

  const fileName = getConfig().projectLog.fileName;
  const projects: DiscoveredProject[] = [];
  for (const acc of byKey.values()) {
    acc.transcripts.sort((a, b) => b.mtimeMs - a.mtimeMs);
    projects.push({
      cwd: acc.cwd,
      name: basename(acc.cwd) || acc.cwd,
      hasLog: existsSync(join(acc.cwd, fileName)),
      lastActivity: acc.lastActivityMs > 0 ? new Date(acc.lastActivityMs).toISOString() : null,
      transcriptCount: acc.transcripts.length,
      transcriptPaths: acc.transcripts.slice(0, MAX_TRANSCRIPTS_PER_PROJECT).map((t) => t.path),
    });
  }

  // Most recently active first.
  projects.sort((a, b) => (b.lastActivity || '').localeCompare(a.lastActivity || ''));
  return projects;
}

/** Find a discovered project by working directory (case/separator-insensitive). */
export function findProjectByCwd(cwd: string): DiscoveredProject | undefined {
  const key = pathKey(cwd);
  return discoverProjects().find((p) => pathKey(p.cwd) === key);
}

export interface ProjectBoardItem {
  cwd: string;
  name: string;
  hasLog: boolean;
  lastActivity: string | null;
  transcriptCount: number;
  entries: ParsedLogEntry[]; // parsed SESSION-LOG.md entries, newest first ([] if no log)
  latest: LogEntryMeta | null; // marker of the newest entry, for at-a-glance status
  phaseGroups: PhaseGroup[]; // normalized plan stages, grouped by track ([] if none)
}

/**
 * Discovery enriched with each project's parsed SESSION-LOG.md — the payload the
 * dashboard renders. Log files are small, so reading them all per request is
 * cheap; an unreadable/missing log yields empty entries/phases.
 */
export function getProjectBoard(): ProjectBoardItem[] {
  const fileName = getConfig().projectLog.fileName;
  return discoverProjects().map((p) => {
    let entries: ParsedLogEntry[] = [];
    let phaseGroups: PhaseGroup[] = [];
    // Recompute hasLog fresh rather than trusting the (cached) discovery flag —
    // a log created moments ago (e.g. a just-finished backfill) must show up on
    // the very next poll, not after the discovery cache TTL expires.
    let hasLog = false;
    try {
      const md = readFileSync(join(p.cwd, fileName), 'utf-8');
      hasLog = true;
      entries = parseLogEntries(md);
      phaseGroups = parsePhasesBlock(md);
    } catch {
      // missing/unreadable log — no entries/phases
    }
    return {
      cwd: p.cwd,
      name: p.name,
      hasLog,
      lastActivity: p.lastActivity,
      transcriptCount: p.transcriptCount,
      entries,
      latest: entries[0]?.meta ?? null,
      phaseGroups,
    };
  });
}

import { readdirSync, statSync } from 'fs';
import { homedir } from 'os';
import { basename, join } from 'path';
import { createLogger } from '../utils/logger.js';
import { discoverProjects, pathKey } from '../sessions/project-discovery.js';
import { decodeProjectSlugs } from './slug-decode.js';
import { worktreeRoot } from '../jobs/worktree.js';
import { loadRegistry, rollUpProjects, type Registry, type RegistryProject } from './registry.js';
import { capabilitiesFor, detectVcs, type VcsCapabilities } from './vcs.js';
import { hasProjectDoc, readProjectDoc } from './project-store.js';
import { allFeatures, featuresOf, type Feature, type FeatureStatus } from './project-doc-format.js';
import { listTrackBranches, type TrackBranch } from './track-branches.js';

const logger = createLogger('project-workspace');

export interface FeatureCounts {
  total: number;
  done: number;
  in_progress: number;
  pending: number;
  blocked: number;
}

export interface WorkspaceTrack {
  name: string;
  features: Feature[];
  /** The track's branch while it is being implemented; null once landed or never branched. */
  branch: { name: string; worktreePath: string; baseBranch: string } | null;
}

export interface WorkspaceProject {
  cwd: string;
  name: string;
  /** Discovered directories folded into this one by the roll-up rules. */
  nested: string[];
  /** True when the project is explicitly listed in projects.json. */
  registered: boolean;
  vcs: VcsCapabilities;

  hasDoc: boolean;
  /** Content fingerprint of PROJECT.md; echo back on writes for the 409 check. */
  revision: string;
  docPath: string;

  status: string | null; // frontmatter status (idea/active/paused/shipped…)
  verify: string[]; // declared QA commands
  tracks: WorkspaceTrack[];
  counts: FeatureCounts;

  // Carried over from transcript/DB discovery so the board can still sort by
  // recency for projects that have no PROJECT.md yet.
  lastActivity: string | null;
  /**
   * Directory mtime — a weaker signal used to order projects whose transcripts
   * were deleted (most of them), kept separate from lastActivity so the UI
   * never presents "the folder changed" as "a session ran here".
   */
  lastModified: string | null;
  transcriptCount: number;
}

/**
 * Job worktrees are not projects.
 *
 * Pipeline stages run `claude -p` with the worktree as cwd, which makes Claude
 * Code create a transcript directory for it — so without this filter every job
 * would add a bogus project named after its own id to the board.
 */
function isJobWorktree(path: string): boolean {
  const root = pathKey(worktreeRoot());
  const key = pathKey(path);
  return key === root || key.startsWith(root + SEP);
}

/**
 * A project's not-yet-landed track branches by track name. Never throws: the
 * board must still render when the database is unavailable.
 */
function activeBranchesOf(cwd: string): Map<string, TrackBranch> {
  try {
    return new Map(
      listTrackBranches(cwd)
        .filter((b) => b.landedAt === null)
        .map((b) => [b.trackName, b])
    );
  } catch (error) {
    logger.warn({ error, cwd }, 'workspace: could not read track branches');
    return new Map();
  }
}

/** The separator pathKey() normalizes every path to. */
const SEP = '\\';

/** Dedupe paths case/separator-insensitively, keeping the first spelling seen. */
function dedupeByKey(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of paths) {
    const key = pathKey(p);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

/**
 * Working directories recovered from ~/.claude/projects directory names —
 * projects whose transcripts were deleted, which discoverProjects() cannot see.
 *
 * Cached on the same short TTL as discoverProjects(): each decode walks the
 * filesystem segment by segment (~100 readdir calls across a machine's slugs)
 * and this sits on the board's poll path.
 */
const SLUG_CACHE_TTL_MS = 5000;
let slugCache: { at: number; cwds: string[] } | null = null;

function recoverCwdsFromSlugs(): string[] {
  const now = Date.now();
  if (slugCache && now - slugCache.at < SLUG_CACHE_TTL_MS) return slugCache.cwds;

  const projectsDir = join(homedir(), '.claude', 'projects');
  let cwds: string[] = [];
  try {
    const slugs = readdirSync(projectsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    cwds = decodeProjectSlugs(slugs);
  } catch {
    cwds = [];
  }
  slugCache = { at: now, cwds };
  return cwds;
}

/** Drop the slug cache, for tests and for callers that just changed the tree. */
export function invalidateSlugCache(): void {
  slugCache = null;
}

/** Directory mtime as an ISO string, or null when unreadable. */
function dirModifiedAt(dir: string): string | null {
  try {
    return new Date(statSync(dir).mtimeMs).toISOString();
  } catch {
    return null;
  }
}

function countFeatures(features: Feature[]): FeatureCounts {
  const counts: FeatureCounts = { total: 0, done: 0, in_progress: 0, pending: 0, blocked: 0 };
  for (const f of features) {
    counts.total++;
    counts[f.status as FeatureStatus]++;
  }
  return counts;
}

/**
 * Assemble the project board.
 *
 * Discovery over-counts (one Unity project appears five times); the registry's
 * roll-up rules fold those into canonical projects, and anything unmatched stays
 * standalone — nothing is ever hidden from this board.
 *
 * PROJECT.md is re-read from disk on every call and must stay that way: it is a
 * human-owned file that agents and editors also write, so a cached parse goes
 * stale.
 */
export function getWorkspaceBoard(registry: Registry = loadRegistry()): WorkspaceProject[] {
  const discovered = discoverProjects();
  const byKey = new Map(discovered.map((p) => [pathKey(p.cwd), p]));

  const registeredKeys = new Set(registry.projects.map((p) => pathKey(p.cwd)));
  const docOverrides = new Map(
    registry.projects.filter((p) => p.doc).map((p) => [pathKey(p.cwd), p.doc as string])
  );
  const nameOverrides = new Map(
    registry.projects.filter((p) => p.name).map((p) => [pathKey(p.cwd), p.name as string])
  );

  // A registered project with no discovered directory still belongs on the
  // board — that is how a project you have never opened in Claude Code, or one
  // added by hand, becomes visible. Slug recovery covers the opposite gap:
  // discovery needs a transcript to learn a project's real cwd, but most
  // transcript directories outlive their transcripts, which would silently drop
  // those projects.
  const cwds = dedupeByKey([
    ...discovered.map((p) => p.cwd),
    ...registry.projects.map((p) => p.cwd),
    ...recoverCwdsFromSlugs(),
  ]).filter((cwd) => !isJobWorktree(cwd));

  const rolled = rollUpProjects(cwds, registry);
  const board: WorkspaceProject[] = [];

  for (const { cwd, nested } of rolled) {
    const key = pathKey(cwd);
    const entry: RegistryProject = {
      cwd,
      ...(docOverrides.has(key) ? { doc: docOverrides.get(key) } : {}),
    };

    let state;
    try {
      state = readProjectDoc(entry);
    } catch (error) {
      // A project whose doc can't be read must still appear, just empty.
      logger.warn({ error, cwd }, 'workspace: could not read project doc');
      state = null;
    }

    const active = activeBranchesOf(cwd);
    const tracks: WorkspaceTrack[] = state
      ? state.doc.tracks.map((t) => {
          const b = active.get(t.name);
          return {
            name: t.name,
            features: featuresOf(t),
            branch: b ? { name: b.branch, worktreePath: b.worktreePath, baseBranch: b.baseBranch } : null,
          };
        })
      : [];

    // Aggregate recency across the project and everything rolled into it, so a
    // Unity project worked on only in a nested Assets dir still reads as active.
    const members = [cwd, ...nested];
    let lastActivity: string | null = null;
    let transcriptCount = 0;
    for (const member of members) {
      const d = byKey.get(pathKey(member));
      if (!d) continue;
      transcriptCount += d.transcriptCount;
      if (d.lastActivity && (!lastActivity || d.lastActivity > lastActivity)) {
        lastActivity = d.lastActivity;
      }
    }

    const vcsKind = detectVcs(cwd);

    board.push({
      cwd,
      name: nameOverrides.get(key) || basename(cwd) || cwd,
      nested,
      registered: registeredKeys.has(key),
      vcs: capabilitiesFor(vcsKind),
      hasDoc: state?.exists ?? hasProjectDoc(entry),
      revision: state?.revision ?? 'absent',
      docPath: state?.path ?? '',
      status: state?.doc.frontmatter.status ?? null,
      verify: state?.doc.frontmatter.verify ?? [],
      tracks,
      counts: countFeatures(state ? allFeatures(state.doc) : []),
      lastActivity,
      lastModified: dirModifiedAt(cwd),
      transcriptCount,
    });
  }

  // Most recently active first. Projects whose transcripts are gone fall back
  // to directory mtime so they interleave sensibly instead of clumping at the
  // bottom in arbitrary order.
  const rank = (p: WorkspaceProject): string => p.lastActivity || p.lastModified || '';
  board.sort((a, b) => rank(b).localeCompare(rank(a)));
  return board;
}

/**
 * Resolve a cwd from a request to a registry entry, or null if not on the board.
 *
 * Pass `board` when the caller has already built one: otherwise a single
 * request that both resolves a project and returns the board pays for two full
 * discovery passes.
 */
export function findWorkspaceProject(
  cwd: string,
  board?: WorkspaceProject[]
): RegistryProject | null {
  const registry = loadRegistry();
  const key = pathKey(cwd);

  const registered = registry.projects.find((p) => pathKey(p.cwd) === key);
  if (registered) return registered;

  // Not explicitly registered — accept it only if it is actually on the board,
  // so a request can never point the store at an arbitrary directory.
  const onBoard = (board ?? getWorkspaceBoard(registry)).find((p) => pathKey(p.cwd) === key);
  return onBoard ? { cwd: onBoard.cwd } : null;
}

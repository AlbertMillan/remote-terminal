import { existsSync, readdirSync, statSync } from 'fs';
import { homedir } from 'os';
import { basename, join } from 'path';
import { createLogger } from '../utils/logger.js';
import { sessionsInWorktree } from '../utils/paths.js';
import { discoverProjects, pathKey } from '../sessions/project-discovery.js';
import { decodeProjectSlugs } from './slug-decode.js';
import { worktreeRoot } from '../jobs/worktree.js';
import { loadRegistry, rollUpProjects, type Registry, type RegistryProject } from './registry.js';
import { capabilitiesFor, detectVcs, type VcsCapabilities } from './vcs.js';
import { hasProjectDoc, readProjectDoc } from './project-store.js';
import { featuresOf, type Feature, type FeatureStatus } from './project-doc-format.js';
import { planCopies, type PlanCopy } from './project-plan.js';

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
  /**
   * Content fingerprint of the file this track's lines live in: the
   * worktree's PROJECT.md for a branched track, null for main's (use the
   * project's `revision`). Echo it back on writes to this track's features.
   */
  revision: string | null;
  /**
   * Feature lines main's PROJECT.md has for this branched track that its
   * worktree lacks ("both copies": written on main after branching). A line
   * both copies share is not counted: after a failed move main's lines are
   * the worktree's, and the badge would claim lines that add nothing. Move
   * into branch takes them over; Land would merge them anyway.
   */
  alsoOnMain: number;
  /** Branched, but its worktree's PROJECT.md has no section for it (shown empty, never from main). */
  planMissing: boolean;
  /** Branched, but the worktree folder itself is gone. Open session re-creates it from the branch. */
  worktreeMissing: boolean;
  /**
   * Running sessions whose cwd is inside the track's worktree: what Land will
   * close, counted as Delete's `sessionsToClose` is. 0 when not branched.
   */
  openSessions: number;
  /**
   * Commits on the base branch this branched track lacks, and the paths
   * merging them in would conflict on (plan files excluded; null when the dry
   * run couldn't be made). Filled after the board is built (addBehindMain in
   * track-branches.ts); 0 and [] until then, and for unbranched tracks.
   */
  behind: number;
  wouldConflict: string[] | null;
}

export interface WorkspaceProject {
  cwd: string;
  name: string;
  /** Discovered directories folded into this one by the roll-up rules. */
  nested: string[];
  /** True when the project is explicitly listed in projects.json. */
  registered: boolean;
  /** Starred in the sidebar (projects.json `favorites`). */
  favorite: boolean;
  vcs: VcsCapabilities;

  hasDoc: boolean;
  /** Content fingerprint of PROJECT.md; echo back on writes for the 409 check. */
  revision: string;
  docPath: string;

  status: string | null; // frontmatter status (idea/active/paused/shipped…)
  verify: string[]; // declared QA commands
  tracks: WorkspaceTrack[];
  /**
   * Unlanded track branches whose heading is gone from PROJECT.md (renamed or
   * removed by hand). Shown so they can be deleted rather than left behind.
   */
  orphanBranches: { trackName: string; branch: string; worktreePath: string }[];
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
 * A project's in-progress track copies by track name. Never throws: the board
 * must still render when the database is unavailable.
 */
function activeCopiesOf(entry: RegistryProject): Map<string, PlanCopy> {
  try {
    return new Map(planCopies(entry).map((c) => [c.branch.trackName, c]));
  } catch (error) {
    logger.warn({ error, cwd: entry.cwd }, 'workspace: could not read track branches');
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

/** Which projects the board lists, before any of their docs are read. */
function rollUpBoard(discovered: string[], registry: Registry) {
  const cwds = dedupeByKey([
    ...discovered,
    ...registry.projects.map((p) => p.cwd),
    ...recoverCwdsFromSlugs(),
  ]).filter((cwd) => !isJobWorktree(cwd));
  return rollUpProjects(cwds, registry);
}

/**
 * The cwds getWorkspaceBoard() would list, without parsing any PROJECT.md or
 * probing VCS — a membership check must not pay for the whole board.
 */
export function listBoardCwds(registry: Registry = loadRegistry()): string[] {
  return rollUpBoard(
    discoverProjects().map((p) => p.cwd),
    registry
  ).map((p) => p.cwd);
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
export interface BoardOptions {
  registry?: Registry;
  /** Running sessions (`getRunningSessions`), for each branched track's `openSessions`. */
  runningSessions?: { cwd: string }[];
}

export function getWorkspaceBoard(options: BoardOptions = {}): WorkspaceProject[] {
  const registry = options.registry ?? loadRegistry();
  const runningSessions = options.runningSessions ?? [];
  const discovered = discoverProjects();
  const byKey = new Map(discovered.map((p) => [pathKey(p.cwd), p]));

  const registeredKeys = new Set(registry.projects.map((p) => pathKey(p.cwd)));
  const favoriteKeys = new Set(registry.favorites.map(pathKey));
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
  const rolled = rollUpBoard(discovered.map((p) => p.cwd), registry);
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

    // A branched track's lines live in its worktree (docs/track-branches.md):
    // the board shows that copy, in main's position when main still has the
    // heading, after main's tracks otherwise.
    const active = activeCopiesOf(entry);
    const toTrack = (name: string, mainFeatures: Feature[] | null): WorkspaceTrack => {
      const c = active.get(name);
      if (!c) {
        return {
          name,
          features: mainFeatures ?? [],
          branch: null,
          revision: null,
          alsoOnMain: 0,
          planMissing: false,
          worktreeMissing: false,
          openSessions: 0,
          behind: 0,
          wouldConflict: [],
        };
      }
      const b = c.branch;
      const features = c.track ? featuresOf(c.track) : [];
      const inWorktree = new Set(features.map((f) => f.id));
      return {
        name,
        features,
        branch: { name: b.branch, worktreePath: b.worktreePath, baseBranch: b.baseBranch },
        revision: c.state.revision,
        alsoOnMain: (mainFeatures ?? []).filter((f) => !inWorktree.has(f.id)).length,
        planMissing: c.track === null,
        worktreeMissing: !existsSync(b.worktreePath),
        openSessions: sessionsInWorktree(runningSessions, b.worktreePath).length,
        behind: 0,
        wouldConflict: [],
      };
    };
    const tracks: WorkspaceTrack[] = state ? state.doc.tracks.map((t) => toTrack(t.name, featuresOf(t))) : [];
    for (const [name, c] of active) {
      if (c.track && !tracks.some((t) => t.name === name)) tracks.push(toTrack(name, null));
    }

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
      favorite: favoriteKeys.has(key),
      vcs: capabilitiesFor(vcsKind),
      hasDoc: state?.exists ?? hasProjectDoc(entry),
      revision: state?.revision ?? 'absent',
      docPath: state?.path ?? '',
      status: state?.doc.frontmatter.status ?? null,
      verify: state?.doc.frontmatter.verify ?? [],
      tracks,
      orphanBranches: [...active.values()]
        .map((c) => c.branch)
        .filter((b) => !tracks.some((t) => t.name === b.trackName))
        .map((b) => ({ trackName: b.trackName, branch: b.branch, worktreePath: b.worktreePath })),
      counts: countFeatures(tracks.flatMap((t) => t.features)),
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
  const cwds = board ? board.map((p) => p.cwd) : listBoardCwds(registry);
  const onBoard = cwds.find((c) => pathKey(c) === key);
  return onBoard ? { cwd: onBoard } : null;
}

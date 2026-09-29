import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { getConfig } from '../config.js';
import { createLogger } from '../utils/logger.js';
import { pathKey } from '../sessions/project-discovery.js';

const logger = createLogger('project-registry');

/**
 * User-owned registry of project structure. The server stores PATHS ONLY — all
 * project content lives in the repo's own markdown — so this file stays small
 * enough to hand-edit, which is the point: it is where the nested-directory
 * layout is declared.
 *
 * Discovery (~/.claude/projects/*) reports every directory Claude Code has ever
 * run in, which over-counts badly: one Unity project shows up as five entries
 * (its nested Assets/Scripts subdirs each get their own transcript dir). The
 * roll-up rules here fold those back into the project they belong to.
 */
export interface RegistryProject {
  cwd: string;
  /** Path to the canonical index, relative to cwd. Defaults to PROJECT.md. */
  doc?: string;
  /** Override the display name (defaults to the directory basename). */
  name?: string;
}

export interface Registry {
  projects: RegistryProject[];
  /**
   * Roots whose immediate children are each a SEPARATE project rather than
   * nested dirs of the root — the exception to prefix roll-up. `ideas/` is the
   * motivating case: ideas/atlas and ideas/noesis are unrelated projects that
   * merely share a parent folder.
   */
  splitChildren: string[];
  /**
   * Projects starred in the sidebar, pinned above the rest. Kept here rather
   * than in the browser so every device sees the same list.
   */
  favorites: string[];
}

const DEFAULT_DOC = 'PROJECT.md';

function emptyRegistry(): Registry {
  return { projects: [], splitChildren: [], favorites: [] };
}

export function getRegistryPath(): string {
  return join(getConfig().persistence.dataDir, 'projects.json');
}

/**
 * Load the registry. A missing file is a valid empty registry (the feature is
 * additive), and a malformed one degrades to empty with a warning rather than
 * taking the board down — the file is hand-editable, so bad JSON is expected
 * to happen eventually.
 */
export function loadRegistry(): Registry {
  const path = getRegistryPath();
  if (!existsSync(path)) return emptyRegistry();
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    return normalizeRegistry(parsed);
  } catch (error) {
    logger.warn({ error, path }, 'registry: unreadable or malformed, treating as empty');
    return emptyRegistry();
  }
}

/** Coerce arbitrary parsed JSON into a valid Registry, dropping junk entries. */
export function normalizeRegistry(raw: unknown): Registry {
  if (!raw || typeof raw !== 'object') return emptyRegistry();
  const obj = raw as Record<string, unknown>;

  const projects: RegistryProject[] = [];
  if (Array.isArray(obj.projects)) {
    for (const entry of obj.projects) {
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as Record<string, unknown>;
      if (typeof e.cwd !== 'string' || !e.cwd.trim()) continue;
      projects.push({
        cwd: e.cwd,
        ...(typeof e.doc === 'string' && e.doc ? { doc: e.doc } : {}),
        ...(typeof e.name === 'string' && e.name ? { name: e.name } : {}),
      });
    }
  }

  const paths = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && !!s.trim()) : [];

  return { projects, splitChildren: paths(obj.splitChildren), favorites: paths(obj.favorites) };
}

export function saveRegistry(registry: Registry): void {
  const path = getRegistryPath();
  writeFileAtomic(path, `${JSON.stringify(registry, null, 2)}\n`);
  logger.info({ path, projects: registry.projects.length }, 'registry: saved');
}

/**
 * Write via a temp file and rename, so a crash mid-write never leaves a
 * truncated projects.json — loadRegistry() would read that as empty, and the
 * next write would save the empty registry over the user's layout.
 */
function writeFileAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

/** projects.json exists but is not a JSON object, so it must not be rewritten. */
export class RegistryUnreadableError extends Error {
  constructor(readonly path: string) {
    super(`${path} is not valid JSON — fix it by hand before changing favourites`);
    this.name = 'RegistryUnreadableError';
  }
}

/**
 * Star or unstar a project, returning the new favourites.
 *
 * Edits the parsed file in place rather than round-tripping it through
 * normalizeRegistry(): loadRegistry() reads a malformed file as EMPTY, and
 * normalizing drops keys and entries it doesn't recognise, so either would let
 * one click on a star erase a hand-edited layout. An unparseable file throws
 * instead of being overwritten.
 *
 * Matched by pathKey so a favourite saved as `c:\foo` is still found (and
 * removed) when the board reports `C:\foo`. `isOnBoard`, when given, prunes
 * favourites whose project has gone — nothing in the UI could unstar them.
 */
export function setFavorite(
  cwd: string,
  favorite: boolean,
  isOnBoard?: (cwd: string) => boolean
): string[] {
  const path = getRegistryPath();
  let raw: Record<string, unknown> = {};
  if (existsSync(path)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf-8'));
    } catch {
      throw new RegistryUnreadableError(path);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new RegistryUnreadableError(path);
    }
    raw = parsed as Record<string, unknown>;
  }

  const key = pathKey(cwd);
  const rest = normalizeRegistry(raw).favorites.filter(
    (f) => pathKey(f) !== key && (!isOnBoard || isOnBoard(f))
  );
  const favorites = favorite ? [...rest, cwd] : rest;
  raw.favorites = favorites;
  writeFileAtomic(path, `${JSON.stringify(raw, null, 2)}\n`);
  logger.info({ path, cwd, favorite }, 'registry: favourite saved');
  return favorites;
}

/** Absolute path to a project's canonical index document. */
export function docPathFor(project: RegistryProject): string {
  return join(project.cwd, project.doc || DEFAULT_DOC);
}

// --- Roll-up ---------------------------------------------------------------

/** The separator pathKey() normalizes every path to. */
const SEP = '\\';

/**
 * True when `child` lies strictly inside `parent`. Uses pathKey so Windows
 * case and separator differences never cause a miss, and requires a separator
 * at the boundary so "foo-bar" is not treated as a child of "foo".
 */
export function isDescendantOf(child: string, parent: string): boolean {
  const c = pathKey(child);
  const p = pathKey(parent);
  return c !== p && c.startsWith(p + SEP);
}

/** Depth of a path in separator-normalized terms, for "most specific wins". */
function depth(p: string): number {
  return pathKey(p).split(SEP).length;
}

export interface RolledUpProject {
  cwd: string; // the parent/canonical project directory
  /** Discovered directories folded into this project (excludes cwd itself). */
  nested: string[];
}

/**
 * Fold discovered directories into canonical projects.
 *
 * A directory rolls up into the DEEPEST registered project (or split-child
 * root) that contains it, so a registered inner project always beats an outer
 * one. Immediate children of a `splitChildren` root become projects in their
 * own right; anything deeper than that rolls up into the child, not the root.
 *
 * Unmatched directories remain standalone projects — nothing is ever hidden.
 */
export function rollUpProjects(discoveredCwds: string[], registry: Registry): RolledUpProject[] {
  // Roots that own their descendants, deepest first so the most specific wins.
  const anchors: string[] = [...registry.projects.map((p) => p.cwd)];

  // Each immediate child of a split root is its own anchor.
  for (const root of registry.splitChildren) {
    for (const cwd of discoveredCwds) {
      if (!isDescendantOf(cwd, root)) continue;
      const rel = pathKey(cwd).slice(pathKey(root).length + 1);
      const immediate = rel.split(SEP)[0];
      if (!immediate) continue;
      const childPath = join(root, immediate);
      if (!anchors.some((a) => pathKey(a) === pathKey(childPath))) anchors.push(childPath);
    }
  }

  anchors.sort((a, b) => depth(b) - depth(a));

  const byAnchor = new Map<string, RolledUpProject>();
  const standalone: RolledUpProject[] = [];

  for (const cwd of discoveredCwds) {
    const anchor = anchors.find((a) => pathKey(a) === pathKey(cwd) || isDescendantOf(cwd, a));
    if (!anchor) {
      standalone.push({ cwd, nested: [] });
      continue;
    }
    const key = pathKey(anchor);
    let entry = byAnchor.get(key);
    if (!entry) {
      entry = { cwd: anchor, nested: [] };
      byAnchor.set(key, entry);
    }
    if (pathKey(cwd) !== key) entry.nested.push(cwd);
  }

  // A split-child root that is itself registered keeps its own entry, but an
  // anchor with no discovered directory at all contributes nothing.
  return [...byAnchor.values(), ...standalone];
}

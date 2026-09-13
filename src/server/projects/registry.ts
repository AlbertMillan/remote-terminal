import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
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
}

const DEFAULT_DOC = 'PROJECT.md';

function emptyRegistry(): Registry {
  return { projects: [], splitChildren: [] };
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

  const splitChildren = Array.isArray(obj.splitChildren)
    ? obj.splitChildren.filter((s): s is string => typeof s === 'string' && !!s.trim())
    : [];

  return { projects, splitChildren };
}

export function saveRegistry(registry: Registry): void {
  const path = getRegistryPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(registry, null, 2)}\n`);
  logger.info({ path, projects: registry.projects.length }, 'registry: saved');
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

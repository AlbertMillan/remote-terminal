import { readdirSync } from 'fs';
import { join } from 'path';

/**
 * Recover a real working directory from a ~/.claude/projects/<slug> directory
 * name.
 *
 * The slug is lossy — separators, `:`, `_` and spaces all become `-`, so
 * "NodeProjects-ideas-atlas" could be ".../ideas/atlas" or ".../ideas-atlas".
 * Reading `cwd` out of a transcript (project-discovery.ts) is exact but only
 * works while a transcript exists, and most directories outlive theirs.
 *
 * So the ambiguity is resolved against the filesystem: walk the slug segment by
 * segment, accepting only a directory that exists, treating `-`, `_` and spaces
 * as interchangeable. What the filesystem cannot settle takes the first
 * consistent match.
 */

/**
 * `-`, `_` and spaces all slugify to `-`, so compare them as equivalent.
 * Boundary separators are trimmed because a leading underscore ("_Revamp")
 * slugifies to a doubled hyphen whose empty token is dropped during splitting.
 */
function normalizeSegment(s: string): string {
  return s
    .toLowerCase()
    .replace(/[-_ ]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

type DirLister = (dir: string) => string[];

function defaultLister(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * Split a slug into its drive root and remaining tokens.
 * "C--Users-Albert-NodeProjects-ideas" -> { root: "C:\", tokens: [Users, Albert, ...] }
 * Returns null for anything that isn't a Windows-style drive slug.
 */
function splitSlug(slug: string): { root: string; tokens: string[] } | null {
  const m = slug.match(/^([A-Za-z])--(.*)$/);
  if (!m) return null;
  const [, drive, rest] = m;
  const tokens = rest.split('-').filter((t) => t.length > 0);
  if (tokens.length === 0) return null;
  return { root: `${drive.toUpperCase()}:\\`, tokens };
}

/**
 * A directory's children keyed by normalizeSegment(), keeping the first name in
 * listing order for each key: the match the old `entries.find()` picked.
 */
type DirIndex = (dir: string) => Map<string, string>;

/**
 * One index shared by every slug in a pass. Normalizing is the cost: a slug
 * walk tries up to one candidate per token run against every child, and Temp
 * alone holds thousands of directories, so normalizing per comparison ran
 * millions of regexes. Here each child is normalized once per pass.
 */
function indexer(lister: DirLister): DirIndex {
  const cache = new Map<string, Map<string, string>>();
  return (dir) => {
    let index = cache.get(dir);
    if (!index) {
      index = new Map();
      for (const name of lister(dir)) {
        const key = normalizeSegment(name);
        if (!index.has(key)) index.set(key, name);
      }
      cache.set(dir, index);
    }
    return index;
  };
}

/**
 * Decode a slug to an existing absolute path, or null when no directory on disk
 * matches it (the project was moved or deleted).
 *
 * `lister` is injectable so the resolution logic can be tested without touching
 * the real filesystem.
 */
export function decodeProjectSlug(slug: string, lister: DirLister = defaultLister): string | null {
  return decodeWith(slug, indexer(lister));
}

function decodeWith(slug: string, index: DirIndex): string | null {
  const split = splitSlug(slug);
  if (!split) return null;
  const { root, tokens } = split;

  // Bound the search so a pathological slug can't fan out indefinitely.
  let steps = 0;
  const MAX_STEPS = 10000;

  const walk = (i: number, current: string): string | null => {
    if (i >= tokens.length) return current;
    if (++steps > MAX_STEPS) return null;

    const children = index(current);
    // Try the longest token run first: a directory whose own name contains a
    // hyphen ("rent-seeker") should win over splitting it into two levels that
    // happen to both exist.
    for (let take = tokens.length - i; take >= 1; take--) {
      const match = children.get(normalizeSegment(tokens.slice(i, i + take).join('-')));
      if (!match) continue;
      const next = walk(i + take, join(current, match));
      if (next) return next;
    }
    return null;
  };

  return walk(0, root);
}

/**
 * Decode every slug under a ~/.claude/projects directory, dropping the ones
 * whose directory no longer exists on disk. Listings are shared across the
 * slugs, which mostly walk the same parents.
 */
export function decodeProjectSlugs(slugs: string[], lister: DirLister = defaultLister): string[] {
  const index = indexer(lister);
  const out: string[] = [];
  for (const slug of slugs) {
    const decoded = decodeWith(slug, index);
    if (decoded) out.push(decoded);
  }
  return out;
}

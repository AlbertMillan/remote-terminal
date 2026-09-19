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
 * Decode a slug to an existing absolute path, or null when no directory on disk
 * matches it (the project was moved or deleted).
 *
 * `lister` is injectable so the resolution logic can be tested without touching
 * the real filesystem.
 */
export function decodeProjectSlug(slug: string, lister: DirLister = defaultLister): string | null {
  const split = splitSlug(slug);
  if (!split) return null;
  const { root, tokens } = split;

  // Cache listings: one slug walk revisits the same parent directories often.
  const cache = new Map<string, string[]>();
  const list = (dir: string): string[] => {
    let entries = cache.get(dir);
    if (!entries) {
      entries = lister(dir);
      cache.set(dir, entries);
    }
    return entries;
  };

  // Bound the search so a pathological slug can't fan out indefinitely.
  let steps = 0;
  const MAX_STEPS = 10000;

  const walk = (index: number, current: string): string | null => {
    if (index >= tokens.length) return current;
    if (++steps > MAX_STEPS) return null;

    const entries = list(current);
    // Try the longest token run first: a directory whose own name contains a
    // hyphen ("rent-seeker") should win over splitting it into two levels that
    // happen to both exist.
    for (let take = tokens.length - index; take >= 1; take--) {
      const candidate = normalizeSegment(tokens.slice(index, index + take).join('-'));
      const match = entries.find((e) => normalizeSegment(e) === candidate);
      if (!match) continue;
      const next = walk(index + take, join(current, match));
      if (next) return next;
    }
    return null;
  };

  return walk(0, root);
}

/**
 * Decode every slug under a ~/.claude/projects directory, dropping the ones
 * whose directory no longer exists on disk.
 */
export function decodeProjectSlugs(slugs: string[], lister: DirLister = defaultLister): string[] {
  const out: string[] = [];
  for (const slug of slugs) {
    const decoded = decodeProjectSlug(slug, lister);
    if (decoded) out.push(decoded);
  }
  return out;
}

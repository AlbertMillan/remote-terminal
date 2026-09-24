import { isAbsolute, relative, resolve } from 'path';

/**
 * True when `p` is `root` or somewhere below it. Lexical only — callers that
 * read or write through the result must also resolve symlinks (see
 * `resolveInWorktree()` in jobs/docs.ts), or a link inside can point outside.
 */
export function isInside(root: string, p: string): boolean {
  const rel = relative(resolve(root), resolve(p));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

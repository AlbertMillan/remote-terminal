import { existsSync, realpathSync } from 'fs';
import { isAbsolute, resolve } from 'path';
import { relativeInside } from '../utils/paths.js';

/**
 * Resolve a caller-supplied path inside a worktree (or any checkout), or null.
 *
 * The path is untrusted input, the same stance history-delete.ts takes towards
 * marker text. Symlinks are resolved before the containment check, so a link
 * inside the worktree cannot be used to read the rest of the disk.
 */
export function resolveInWorktree(worktreePath: string, rel: string): string | null {
  if (!rel || isAbsolute(rel) || rel.includes('\0')) return null;
  const abs = resolve(worktreePath, rel);
  if (!contains(worktreePath, abs)) return null;
  try {
    // realpath throws for a path that does not exist yet, which is not a
    // containment failure: the caller reports it as "missing" instead.
    if (!existsSync(abs)) return abs;
    const real = realpathSync(abs);
    const realRoot = realpathSync(worktreePath);
    if (!contains(realRoot, real)) return null;
    return real;
  } catch {
    return null;
  }
}

function contains(root: string, target: string): boolean {
  return !!relativeInside(root, target);
}

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

/**
 * The cwd the claude-session hook may record for a session, or undefined to keep `stored`.
 * A folder **below** the stored one is refused: older hooks send `$PWD`, which is wherever
 * Claude last `cd`'d, and recording it moves the session into a subfolder, where its relative
 * file links stop resolving and Resume looks for the transcript under the wrong project.
 * Any other folder (a project moved, a session that never had one) is recorded.
 */
export function hookCwdToStore(stored: string | null | undefined, reported: string | undefined): string | undefined {
  if (!reported) return undefined;
  if (stored && isInside(stored, reported) && pathKey(stored) !== pathKey(reported)) return undefined;
  return reported;
}

/** Normalize a path for case/separator-insensitive dedup keys (Windows-friendly). */
export function pathKey(p: string): string {
  return p.replace(/[\\/]+/g, '\\').replace(/\\+$/, '').toLowerCase();
}

/**
 * The sessions whose cwd is the worktree or below it. Land closes these,
 * Delete track closes and counts them, and the board counts them for the Land
 * confirm — one function, so the three can't disagree about which sessions
 * a worktree has. Pass running sessions only (`getRunningSessions`) — except
 * for deleting the rows once the worktree is gone (`deleteSessionsIn`), which
 * takes them all.
 */
export function sessionsInWorktree<T extends { cwd: string }>(sessions: T[], worktreePath: string): T[] {
  return sessions.filter((s) => isInside(worktreePath, s.cwd));
}

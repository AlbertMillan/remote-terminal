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

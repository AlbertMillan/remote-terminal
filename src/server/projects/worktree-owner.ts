import { trackBranchForPath } from './track-store.js';

export interface WorktreeOwner {
  /** The project's main checkout, from the record — never guessed from the path. */
  projectCwd: string;
  kind: 'track';
  /** The worktree's branch as recorded (`track/…`). */
  branch: string;
  worktreePath: string;
}

/**
 * Which track worktree `cwd` sits in, from the `track_branches` records. Null
 * for a path no record owns — the main checkout, an unrelated folder, or a
 * worktree nothing records — which callers treat as a plain project directory.
 */
export function worktreeOwner(cwd: string): WorktreeOwner | null {
  const track = trackBranchForPath(cwd);
  if (track) {
    return { projectCwd: track.projectCwd, kind: 'track', branch: track.branch, worktreePath: track.worktreePath };
  }
  return null;
}

/**
 * The folder whose project settings (its default account) apply to `cwd`: the
 * owning project's main checkout for a track worktree, else `cwd` itself.
 * Worktrees live under `~/.claude-remote/worktrees`, outside every project, so
 * without this a track session would skip its project's account.
 */
export function projectCwdFor(cwd: string | undefined): string | undefined {
  if (!cwd) return cwd;
  return worktreeOwner(cwd)?.projectCwd ?? cwd;
}

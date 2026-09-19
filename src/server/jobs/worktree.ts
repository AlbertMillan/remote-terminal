import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { getConfig } from '../config.js';
import { createLogger } from '../utils/logger.js';
import { git, isGitRepo } from '../agent/claude-run.js';
import { detectVcs } from '../projects/vcs.js';

const logger = createLogger('worktree');

/**
 * Isolated working copies for pipeline jobs.
 *
 * Each job gets its own `git worktree` on its own branch, so a background run
 * never touches the tree you are editing by hand and several jobs can be in
 * flight without colliding. The worktree is retained while a job is parked —
 * possibly for days — because that is what makes "take over this conversation"
 * still work when you come back to it.
 */

export class WorktreeError extends Error {
  constructor(
    message: string,
    readonly status = 400
  ) {
    super(message);
    this.name = 'WorktreeError';
  }
}

/** Where job worktrees live: outside the project, so they never get committed. */
export function worktreeRoot(): string {
  return join(getConfig().persistence.dataDir, 'worktrees');
}

export function worktreePathFor(jobId: string): string {
  return join(worktreeRoot(), jobId);
}

/** Branch name for a job. Short id keeps it readable in `git branch`. */
export function branchNameFor(jobId: string, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `job/${slug || 'feature'}-${jobId.slice(0, 8)}`;
}

/**
 * Ensure `cwd` is a git repository, initialising one if the project has no VCS
 * at all.
 *
 * Projects with no repo still get the full pipeline — they just never push,
 * because there is nowhere to push to. Initialising gives the job something to
 * branch from and, more importantly, makes its work revertible: without a repo
 * there is no way to undo what a run did.
 *
 * Refuses to touch a Plastic SCM workspace: laying git over it would leave two
 * systems tracking one tree.
 */
export async function ensureGitRepo(cwd: string): Promise<{ initialised: boolean }> {
  const kind = detectVcs(cwd);
  if (kind === 'plastic') {
    throw new WorktreeError('Plastic SCM workspaces are not supported for dispatch yet.');
  }
  if (await isGitRepo(cwd)) return { initialised: false };

  logger.info({ cwd }, 'worktree: initialising git repo for a project with no VCS');
  if ((await git(cwd, ['init'])) === null) {
    throw new WorktreeError(`Could not run 'git init' in ${cwd}`, 500);
  }
  // A worktree needs a commit to branch from, so make the initial one. `git add
  // -A` here is the user's own project content, which is exactly what should be
  // under version control from now on.
  await git(cwd, ['add', '-A']);
  const committed = await git(cwd, [
    '-c',
    'user.name=claude-remote',
    '-c',
    'user.email=claude-remote@localhost',
    'commit',
    '-m',
    'Initial commit (created by claude-remote to enable job isolation)',
    '--no-verify',
  ]);
  if (committed === null) {
    // An empty directory has nothing to commit; make an empty root commit so
    // the repo still has a HEAD to branch from.
    await git(cwd, [
      '-c',
      'user.name=claude-remote',
      '-c',
      'user.email=claude-remote@localhost',
      'commit',
      '--allow-empty',
      '-m',
      'Initial commit (created by claude-remote to enable job isolation)',
      '--no-verify',
    ]);
  }
  return { initialised: true };
}

/** The repo's current branch, used as the base and merge target. */
export async function currentBranch(cwd: string): Promise<string | null> {
  const out = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const name = out?.trim();
  return name && name !== 'HEAD' ? name : null;
}

/** True when the repo has a remote configured, so a push is meaningful. */
export async function hasRemote(cwd: string): Promise<boolean> {
  const out = await git(cwd, ['remote']);
  return !!out?.trim();
}

export interface CreatedWorktree {
  path: string;
  branch: string;
  baseBranch: string;
  /** True when the project had no VCS and one was created for this job. */
  initialisedRepo: boolean;
}

/**
 * Create a worktree for a job on a fresh branch off the project's current
 * branch. Idempotent: an existing worktree at the path is reused, so a restart
 * mid-job doesn't strand it.
 */
export async function createWorktree(
  cwd: string,
  jobId: string,
  title: string
): Promise<CreatedWorktree> {
  const { initialised } = await ensureGitRepo(cwd);
  const base = (await currentBranch(cwd)) || 'main';
  const branch = branchNameFor(jobId, title);
  const path = worktreePathFor(jobId);

  if (existsSync(path)) {
    logger.info({ jobId, path }, 'worktree: reusing existing worktree');
    return { path, branch, baseBranch: base, initialisedRepo: initialised };
  }

  mkdirSync(worktreeRoot(), { recursive: true });
  const out = await git(cwd, ['worktree', 'add', '-b', branch, path, base]);
  if (out === null) {
    // Most likely the branch already exists (a retried job); attach to it.
    const retry = await git(cwd, ['worktree', 'add', path, branch]);
    if (retry === null) {
      throw new WorktreeError(`Could not create a worktree for job ${jobId}`, 500);
    }
  }

  logger.info({ jobId, path, branch, base }, 'worktree: created');
  return { path, branch, baseBranch: base, initialisedRepo: initialised };
}

/**
 * Remove a job's worktree and, optionally, its branch.
 *
 * Always non-throwing: teardown runs in `finally` paths where a failure must
 * not mask the original outcome. Returns what it managed to clean up.
 */
export async function removeWorktree(
  cwd: string,
  jobId: string,
  options: { deleteBranch?: string | null } = {}
): Promise<{ removed: boolean; branchDeleted: boolean }> {
  const path = worktreePathFor(jobId);
  let removed = false;
  let branchDeleted = false;

  try {
    if (existsSync(path)) {
      // --force: the worktree may hold uncommitted scratch from a failed stage.
      const out = await git(cwd, ['worktree', 'remove', '--force', path]);
      removed = out !== null;
      if (!removed) {
        // git refused (corrupt registration); drop the directory and prune.
        rmSync(path, { recursive: true, force: true });
        await git(cwd, ['worktree', 'prune']);
        removed = !existsSync(path);
      }
    } else {
      await git(cwd, ['worktree', 'prune']);
      removed = true;
    }

    if (options.deleteBranch) {
      branchDeleted = (await git(cwd, ['branch', '-D', options.deleteBranch])) !== null;
    }
  } catch (error) {
    logger.warn({ error, jobId, path }, 'worktree: teardown failed');
  }

  logger.info({ jobId, removed, branchDeleted }, 'worktree: torn down');
  return { removed, branchDeleted };
}

/** Paths git currently reports as registered worktrees, for reconciliation. */
export async function listWorktrees(cwd: string): Promise<string[]> {
  const out = await git(cwd, ['worktree', 'list', '--porcelain']);
  if (!out) return [];
  return out
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice('worktree '.length).trim());
}

/** Commit everything in a worktree. Returns false when there was nothing to commit. */
export async function commitAll(worktreePath: string, message: string): Promise<boolean> {
  await git(worktreePath, ['add', '-A']);
  const out = await git(worktreePath, [
    '-c',
    'user.name=claude-remote',
    '-c',
    'user.email=claude-remote@localhost',
    'commit',
    '-m',
    message,
    '--no-verify',
  ]);
  return out !== null;
}

/** The diff a reviewer would look at: the job branch against its base. */
export async function diffAgainst(worktreePath: string, baseBranch: string): Promise<string> {
  const out = await git(worktreePath, ['diff', `${baseBranch}...HEAD`]);
  if (out && out.trim()) return out;
  // Nothing committed yet — show the working tree instead so an in-progress
  // stage is still inspectable.
  return (await git(worktreePath, ['diff', 'HEAD'])) || '';
}

/** One file this job's branch changed, as the document list reports it. */
export interface ChangedFile {
  path: string;
  status: 'added' | 'edited' | 'deleted' | 'renamed';
  insertions: number;
  deletions: number;
}

const NAME_STATUS: Record<string, ChangedFile['status']> = {
  A: 'added',
  M: 'edited',
  D: 'deleted',
  R: 'renamed',
  C: 'added',
};

/**
 * Per-file breakdown of the job branch, for the document list.
 *
 * Falls back to the working tree exactly as `diffAgainst` does. The two are
 * shown side by side on the same card, so a mid-stage job whose diff pane has
 * content must not have an empty document list beside it.
 */
export async function diffNumstat(
  worktreePath: string,
  baseBranch: string
): Promise<ChangedFile[]> {
  const read = async (...range: string[]): Promise<ChangedFile[]> => {
    const numstat = (await git(worktreePath, ['diff', '--numstat', ...range])) || '';
    if (!numstat.trim()) return [];
    const names = (await git(worktreePath, ['diff', '--name-status', ...range])) || '';

    const statuses = new Map<string, ChangedFile['status']>();
    for (const line of names.split('\n')) {
      const parts = line.split('\t');
      if (parts.length < 2) continue;
      // A rename is "R096\told\tnew" — the last field is always the path now.
      const code = parts[0].trim().charAt(0);
      statuses.set(parts[parts.length - 1], NAME_STATUS[code] ?? 'edited');
    }

    const files: ChangedFile[] = [];
    for (const line of numstat.split('\n')) {
      const parts = line.split('\t');
      if (parts.length < 3) continue;
      const path = parts[parts.length - 1];
      files.push({
        path,
        status: statuses.get(path) ?? 'edited',
        // "-" for a binary file; reported as zero rather than NaN.
        insertions: Number(parts[0]) || 0,
        deletions: Number(parts[1]) || 0,
      });
    }
    return files;
  };

  const committed = await read(`${baseBranch}...HEAD`);
  return committed.length > 0 ? committed : read('HEAD');
}

/** Every markdown file in the worktree, tracked or newly written but not ignored. */
export async function listMarkdown(worktreePath: string): Promise<string[]> {
  const out =
    (await git(worktreePath, [
      'ls-files',
      '--cached',
      '--others',
      '--exclude-standard',
      '--',
      '*.md',
      '*.markdown',
    ])) || '';
  // --cached and --others can name the same path; git does not dedupe for us.
  return [...new Set(out.split('\n').map((l) => l.trim()).filter(Boolean))];
}

/** This job's diff for one file. Empty when the file is new and uncommitted. */
export async function fileDiff(
  worktreePath: string,
  baseBranch: string,
  path: string
): Promise<string> {
  const out = await git(worktreePath, ['diff', `${baseBranch}...HEAD`, '--', path]);
  if (out && out.trim()) return out;
  return (await git(worktreePath, ['diff', 'HEAD', '--', path])) || '';
}

/** Short stat summary of the job branch, for the board. */
export async function diffStat(
  worktreePath: string,
  baseBranch: string
): Promise<{ files: number; insertions: number; deletions: number }> {
  const out = (await git(worktreePath, ['diff', '--shortstat', `${baseBranch}...HEAD`])) || '';
  const files = Number(out.match(/(\d+) files? changed/)?.[1] ?? 0);
  const insertions = Number(out.match(/(\d+) insertions?/)?.[1] ?? 0);
  const deletions = Number(out.match(/(\d+) deletions?/)?.[1] ?? 0);
  return { files, insertions, deletions };
}

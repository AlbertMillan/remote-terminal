import { execFile } from 'child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'fs';
import { lstat, readdir, rm, unlink } from 'fs/promises';
import { dirname, join } from 'path';
import { promisify } from 'util';
import { getConfig } from '../config.js';
import { createLogger } from '../utils/logger.js';
import { git, isGitRepo } from '../agent/claude-run.js';
import { detectVcs } from '../projects/vcs.js';

const logger = createLogger('worktree');
const execFileAsync = promisify(execFile);

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
 * Ensure `cwd` is a git repository, initialising one if the project has no VCS.
 *
 * A project with no repo still gets the full pipeline and simply never pushes.
 * Initialising is what makes a run's work revertible at all. A Plastic SCM
 * workspace is refused: git over it would leave two systems tracking one tree.
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
 * Where a worktree goes and what it branches from, when not a job's defaults.
 *
 * A job inside a track branches from the track's branch rather than the
 * project's current one; a track's own worktree has its own path and name.
 */
export interface WorktreeTarget {
  base?: string;
  path?: string;
  branch?: string;
}

/**
 * Create a worktree for a job on a fresh branch off the project's current
 * branch (or `target.base`). Idempotent: an existing worktree at the path is
 * reused, so a restart mid-job doesn't strand it.
 */
export async function createWorktree(
  cwd: string,
  jobId: string,
  title: string,
  target: WorktreeTarget = {}
): Promise<CreatedWorktree> {
  const { initialised } = await ensureGitRepo(cwd);
  const base = target.base || (await currentBranch(cwd)) || 'main';
  const branch = target.branch || branchNameFor(jobId, title);
  const path = target.path || worktreePathFor(jobId);

  if (existsSync(path)) {
    logger.info({ jobId, path }, 'worktree: reusing existing worktree');
    return { path, branch, baseBranch: base, initialisedRepo: initialised };
  }

  mkdirSync(dirname(path), { recursive: true });
  // An existing branch (a retried job, a re-attached track) is checked out as
  // it is; only a missing one is created. Knowing which up front is what lets
  // a failure delete exactly the branch this call made and nothing else.
  const existed = await branchExists(cwd, branch);
  // core.longpaths: a deep file in the checkout otherwise fails it half-way on
  // Windows. It does not lift git's own limit on the worktree's path.
  const added = await gitWithStderr(cwd, [
    '-c',
    'core.longpaths=true',
    'worktree',
    'add',
    ...(existed ? [path, branch] : ['-b', branch, path, base]),
  ]);
  if (!added.ok) {
    // Leave nothing behind: a failed add can still create the branch (and,
    // past the admin-dir check, a partial checkout). Left there, every retry
    // adds another branch, and a folder someone later installs into keeps
    // its node_modules on disk with nothing recording it.
    rmSync(path, { recursive: true, force: true });
    await git(cwd, ['worktree', 'prune']);
    const leaked = !existed && (await branchExists(cwd, branch));
    if (leaked) await git(cwd, ['branch', '-D', branch]);
    logger.warn({ jobId, cwd, path, branch, stderr: added.stderr, branchDeleted: leaked }, 'worktree: add failed');
    throw new WorktreeError(describeAddFailure(path, added.stderr), 500);
  }

  logger.info({ jobId, path, branch, base }, 'worktree: created');
  return { path, branch, baseBranch: base, initialisedRepo: initialised };
}

async function branchExists(cwd: string, branch: string): Promise<boolean> {
  return (await git(cwd, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`])) !== null;
}

/** git, keeping stderr: a failed `worktree add` is only explainable by what git said. */
async function gitWithStderr(cwd: string, args: string[]): Promise<{ ok: boolean; stderr: string }> {
  try {
    await execFileAsync('git', args, { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    return { ok: true, stderr: '' };
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr;
    return { ok: false, stderr: (stderr || (error as Error).message || '').trim() };
  }
}

/**
 * The message for a failed `worktree add`. Git on Windows (2.39) refuses a
 * worktree whose own path passes about 210 characters ("'$GIT_DIR' too big"),
 * whatever core.longpaths says; the project's depth doesn't matter. Worktrees
 * live under `persistence.dataDir`, so that is the setting to point at, and
 * saying so beats a bare "could not create".
 */
function describeAddFailure(path: string, stderr: string): string {
  if (/GIT_DIR' too big|Filename too long|path too long/i.test(stderr)) {
    return (
      `Could not create a worktree: its path is ${path.length} characters, too long for git on Windows ` +
      `(${stderr}). Keep it under about 210 — worktrees live under ${worktreeRoot()}, so set ` +
      '`persistence.dataDir` in config.json to a shallower folder.'
    );
  }
  return `Could not create a worktree at ${path}${stderr ? `: ${stderr}` : ''}`;
}

export interface TeardownResult {
  removed: boolean;
  branchDeleted: boolean;
  /**
   * Links (or unreadable entries that might hide one) still in the worktree.
   * Non-empty means git never ran: the worktree is still registered and on
   * disk, and the caller must keep its record so the teardown can run again.
   */
  linksLeft: string[];
}

/**
 * Remove a job's worktree and, optionally, its branch.
 *
 * Always non-throwing: teardown runs in `finally` paths where a failure must
 * not mask the original outcome. Returns what it managed to clean up.
 *
 * Every filesystem step is async: this runs on the server's event loop, and a
 * synchronous rmSync of a real node_modules (~12k files) froze every live
 * terminal for 1.7s.
 */
export async function removeWorktree(
  cwd: string,
  jobId: string,
  options: { deleteBranch?: string | null; path?: string } = {}
): Promise<TeardownResult> {
  const path = options.path || worktreePathFor(jobId);
  let removed = false;
  let branchDeleted = false;
  let linksLeft: string[] = [];

  // Each step runs whatever the one before it did. On Windows a process whose
  // cwd is the folder — the session-log run that a closing session starts
  // there, typically — makes its rmdir fail with EBUSY. That once threw past
  // the branch deletion too, leaking a branch per Land on top of the folder.
  if (existsSync(path)) {
    // Links first. Git for Windows (2.39) deletes *through* a junction: a
    // node_modules junction to the main checkout's copy emptied it. Node's
    // rm and unlink remove the link itself. Clearing node_modules also
    // spares git deleting thousands of files one by one.
    await removeNodeModules(path);
    linksLeft = await unlinkLinks(path);
    if (linksLeft.length > 0) {
      // Never hand git a tree that still holds a link. The worktree stays
      // registered; the caller keeps its record so the teardown can run again.
      logger.warn(
        { jobId, path, linksLeft },
        'worktree: a link could not be removed — left in place, not deleted through it'
      );
    } else {
      // --force: the worktree may hold uncommitted scratch from a failed stage.
      // git deregisters the worktree even when it cannot delete the folder.
      removed = (await git(cwd, ['worktree', 'remove', '--force', path])) !== null;
      if (!removed) removed = await removeFolder(path);
    }
  } else {
    removed = true;
  }
  await git(cwd, ['worktree', 'prune']);

  if (options.deleteBranch) {
    // "Gone", not "deleted by this call": a Delete track re-run after a busy
    // folder finds the branch already deleted, and must not keep its row.
    branchDeleted =
      (await git(cwd, ['branch', '-D', options.deleteBranch])) !== null ||
      !(await branchExists(cwd, options.deleteBranch));
  }
  if (!removed && linksLeft.length === 0) {
    logger.warn({ jobId, path }, 'worktree: folder is busy — removal retried in the background');
    retryFolderRemoval(path);
  }

  logger.info({ jobId, removed, branchDeleted }, 'worktree: torn down');
  return { removed, branchDeleted, linksLeft };
}

/** How a teardown that left links says so, for Land, Cancel and Discard to report. */
export function describeLinksLeft(path: string, linksLeft: string[]): string {
  return (
    `The worktree at ${path} still holds a link that could not be removed (${linksLeft.join(', ')}), ` +
    'so it was left in place rather than deleted through it. Remove the link, then try again.'
  );
}

/** Remove a worktree's node_modules: a junction goes, its target stays. Never throws. */
async function removeNodeModules(path: string): Promise<void> {
  try {
    await rm(join(path, 'node_modules'), { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  } catch (error) {
    logger.warn({ path, code: (error as NodeJS.ErrnoException).code }, 'worktree: node_modules removal failed');
  }
}

/**
 * Unlink every symlink and junction under `root`, `.git` excepted, without
 * descending into any. Returns what is still there afterwards: links that
 * would not unlink, and any folder or entry that could not be read — it
 * might hold a link, so it fails closed rather than letting git near it.
 * Never throws.
 */
export async function unlinkLinks(root: string): Promise<string[]> {
  const left: string[] = [];
  const gone = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT';
  const walk = async (dir: string): Promise<void> => {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (error) {
      if (!gone(error)) left.push(dir);
      return;
    }
    for (const name of names) {
      if (name === '.git') continue;
      const entry = join(dir, name);
      let stat;
      try {
        stat = await lstat(entry);
      } catch (error) {
        if (!gone(error)) left.push(entry);
        continue;
      }
      if (stat.isSymbolicLink()) {
        // lstat reports a junction as a symbolic link too; unlink removes
        // either without touching the target.
        try {
          await unlink(entry);
          logger.info({ link: entry }, 'worktree: unlinked before removal');
        } catch (error) {
          logger.warn({ link: entry, code: (error as NodeJS.ErrnoException).code }, 'worktree: could not unlink');
          left.push(entry);
        }
      } else if (stat.isDirectory()) {
        await walk(entry);
      }
    }
  };
  await walk(root);
  return left;
}

/** Delete a folder; false when it is still there (on Windows: held open). Never throws. */
async function removeFolder(path: string): Promise<boolean> {
  try {
    await rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  } catch (error) {
    logger.debug({ path, code: (error as NodeJS.ErrnoException).code }, 'worktree: folder removal failed');
  }
  return !existsSync(path);
}

/** removeFolder for the boot sweep, which runs before the server takes connections. */
function removeFolderSync(path: string): boolean {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  } catch (error) {
    logger.debug({ path, code: (error as NodeJS.ErrnoException).code }, 'worktree: folder removal failed');
  }
  return !existsSync(path);
}

/**
 * A former worktree folder git has already deregistered, so nothing else
 * would ever delete it. Only ever such a folder: one whose `.git` link is
 * gone, which git removes first. A worktree re-created at the same path in
 * the meantime has one, and is left alone.
 */
function isDeregistered(path: string): boolean {
  return existsSync(path) && !existsSync(join(path, '.git'));
}

// Every 15s for 10 minutes: past projectLog.timeoutMs (180s), the longest a
// session-log run can hold the folder before it is killed.
const RETRY_EVERY_MS = 15_000;
const RETRY_ATTEMPTS = 40;
const retrying = new Set<string>();

function retryFolderRemoval(path: string, attempt = 1): void {
  if (attempt === 1 && retrying.has(path)) return;
  retrying.add(path);
  const timer = setTimeout(async () => {
    if (!isDeregistered(path) || (await removeFolder(path))) {
      retrying.delete(path);
      logger.info({ path, attempt }, 'worktree: leftover folder removed');
    } else if (attempt < RETRY_ATTEMPTS) {
      retryFolderRemoval(path, attempt + 1);
    } else {
      retrying.delete(path);
      logger.warn({ path }, 'worktree: leftover folder still busy — the boot sweep will take it');
    }
  }, RETRY_EVERY_MS);
  timer.unref(); // never keeps the process (or a test run) alive
}

/**
 * At server start, delete folders under the worktree root that a teardown
 * left behind: no longer git worktrees (no `.git` link) and holding nothing
 * but empty folders and session-log stubs — the file a session-log run
 * writes into the folder it was holding — plus, at the top, `node_modules`,
 * which an install leaves and a busy teardown can fail to finish. Anything
 * else found there is logged and left alone: it could be someone's work.
 */
export function sweepLeftoverWorktrees(sessionLogName: string): string[] {
  const swept: string[] = [];
  const root = worktreeRoot();
  const candidates = (dir: string): string[] => {
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !(dir === root && e.name === 'tracks'))
        .map((e) => join(dir, e.name));
    } catch {
      return [];
    }
  };
  for (const path of [...candidates(root), ...candidates(join(root, 'tracks'))]) {
    if (!isDeregistered(path)) continue;
    if (!onlyStubs(path, sessionLogName, true)) {
      logger.warn({ path }, 'worktree sweep: unrecognised leftover folder, left in place');
      continue;
    }
    // On its own first, as the teardown does: rmSync never follows a junction.
    // Synchronous is fine here: this runs before the server takes connections.
    try {
      rmSync(join(path, 'node_modules'), { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    } catch (error) {
      logger.warn({ path, code: (error as NodeJS.ErrnoException).code }, 'worktree sweep: node_modules removal failed');
    }
    if (removeFolderSync(path)) swept.push(path);
  }
  if (swept.length > 0) logger.info({ swept }, 'worktree sweep: removed leftover folders');
  return swept;
}

function onlyStubs(dir: string, sessionLogName: string, top = false): boolean {
  try {
    return readdirSync(dir, { withFileTypes: true }).every((e) =>
      top && e.name === 'node_modules'
        ? true
        : e.isDirectory()
          ? onlyStubs(join(dir, e.name), sessionLogName)
          : e.name === sessionLogName
    );
  } catch {
    return false;
  }
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

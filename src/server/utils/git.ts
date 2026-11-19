import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * The one place claude-remote runs git. Every helper here is non-throwing:
 * a missing git, a non-repo folder and a failed command are all valid states
 * its callers branch on.
 */

/**
 * `-c` flags for commits claude-remote makes itself (merges, ticks, lands,
 * deletes), so they work on a machine with no git identity configured and are
 * recognisable in the log. Spread before the subcommand: `git(cwd, [...COMMIT_IDENTITY, 'commit', …])`.
 */
export const COMMIT_IDENTITY = [
  '-c',
  'user.name=claude-remote',
  '-c',
  'user.email=claude-remote@localhost',
];

export interface GitResult {
  ok: boolean;
  stdout: string;
  /** Trimmed; on a spawn failure (no git) the error's message instead. */
  stderr: string;
  /** Exit code, or null when git never ran. */
  code: number | null;
}

export interface GitOptions {
  /** Extra environment on top of the server's (e.g. `GIT_INDEX_FILE`). */
  env?: Record<string, string>;
}

/** git with everything it said, for callers that read stderr or a non-zero exit's stdout. */
export async function runGit(cwd: string, args: string[], opts: GitOptions = {}): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      ...(opts.env ? { env: { ...process.env, ...opts.env } } : {}),
    });
    return { ok: true, stdout, stderr: stderr.trim(), code: 0 };
  } catch (error) {
    const e = error as { code?: unknown; stdout?: unknown; stderr?: unknown; message?: string };
    return {
      ok: false,
      stdout: typeof e.stdout === 'string' ? e.stdout : '',
      stderr: ((typeof e.stderr === 'string' && e.stderr) || e.message || '').trim(),
      code: typeof e.code === 'number' ? e.code : null,
    };
  }
}

/** git's stdout, or null when it failed. */
export async function git(cwd: string, args: string[], opts: GitOptions = {}): Promise<string | null> {
  const result = await runGit(cwd, args, opts);
  return result.ok ? result.stdout : null;
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  const out = await git(cwd, ['rev-parse', '--is-inside-work-tree']);
  return out?.trim() === 'true';
}

/** The repo's current branch, or null when detached or unreadable. */
export async function currentBranch(cwd: string): Promise<string | null> {
  const out = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const name = out?.trim();
  return name && name !== 'HEAD' ? name : null;
}

/**
 * What HEAD is on when it is not `expected` (`"HEAD"` when detached), or null
 * when it is. Merging a job and landing a track both refuse to run off the
 * branch they were cut from; each words its own refusal.
 */
export async function offBranch(cwd: string, expected: string): Promise<string | null> {
  const current = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']))?.trim();
  return current === expected ? null : (current ?? 'an unreadable branch');
}

/** True when the repo has a remote configured, so a push is meaningful. */
export async function hasRemote(cwd: string): Promise<boolean> {
  const out = await git(cwd, ['remote']);
  return !!out?.trim();
}

export interface GitStatusEntry {
  path: string;
  /** Porcelain X column: what is staged. ' ' when nothing, '?' for untracked. */
  staged: string;
  untracked: boolean;
}

/** `git status --porcelain`, one entry per path; null when not a repo / git unavailable. */
export async function gitStatusEntries(
  cwd: string,
  opts: { allUntracked?: boolean } = {}
): Promise<GitStatusEntry[] | null> {
  // By default git collapses a new directory to one `?? dir/` entry. Callers
  // that match individual files (attribution, Delete track, plan moves) need every file.
  const out = await git(cwd, [
    'status',
    '--porcelain',
    ...(opts.allUntracked ? ['--untracked-files=all'] : []),
  ]);
  if (out === null) return null;
  const entries: GitStatusEntry[] = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    let p = line.slice(3).trim();
    const arrow = p.indexOf(' -> '); // rename: keep the new path
    if (arrow !== -1) p = p.slice(arrow + 4);
    if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1); // git quotes odd paths
    entries.push({ path: p, staged: line[0], untracked: line.startsWith('??') });
  }
  return entries;
}

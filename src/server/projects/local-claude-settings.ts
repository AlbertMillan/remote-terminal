import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { isAbsolute, join, resolve } from 'path';
import { git } from '../agent/claude-run.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('local-claude-settings');

/** Posix form: what git check-ignore and info/exclude take. */
export const LOCAL_SETTINGS = '.claude/settings.local.json';

/**
 * Give a track worktree the main checkout's `.claude/settings.local.json`
 * (project/unattended-started-sessions.md).
 *
 * The file is gitignored, so a worktree never gets it, and without it every
 * session there asks again for what the user already approved in the main
 * checkout (`enableAllProjectMcpServers`, the permission allowlist).
 *
 *  - A copy, never a link: `git worktree remove` on Windows deletes through a
 *    link and would take the main checkout's file with it.
 *  - Never overwrites: the worktree's sessions may have added approvals.
 *  - Never committed: if git does not ignore the path, it goes into the shared
 *    `info/exclude` first, or the next `commitAll` puts it on the branch. With
 *    no way to ignore it, there is no copy.
 *
 * Never throws: a missing copy only means the session asks, as before.
 * Returns whether it copied.
 */
export async function ensureLocalClaudeSettings(projectCwd: string, worktreePath: string): Promise<boolean> {
  const source = join(projectCwd, '.claude', 'settings.local.json');
  const target = join(worktreePath, '.claude', 'settings.local.json');
  try {
    if (!existsSync(source) || existsSync(target) || !existsSync(worktreePath)) return false;
    if (!(await isIgnored(worktreePath)) && !(await addToExclude(worktreePath))) {
      logger.warn({ worktreePath }, 'local settings: could not ignore the path, not copying');
      return false;
    }
    mkdirSync(join(worktreePath, '.claude'), { recursive: true });
    copyFileSync(source, target);
    logger.info({ projectCwd, worktreePath }, 'local settings: copied into the worktree');
    return true;
  } catch (error) {
    logger.warn({ worktreePath, error: (error as Error).message }, 'local settings: copy failed');
    return false;
  }
}

async function isIgnored(cwd: string): Promise<boolean> {
  // Prints the path and exits 0 when ignored; exits 1 (null here) when not.
  const out = await git(cwd, ['check-ignore', '--', LOCAL_SETTINGS]);
  return !!out?.trim();
}

/** Add the path to the repository's shared info/exclude, then confirm git now ignores it. */
async function addToExclude(cwd: string): Promise<boolean> {
  const out = (await git(cwd, ['rev-parse', '--git-common-dir']))?.trim();
  if (!out) return false;
  const commonDir = isAbsolute(out) ? out : resolve(cwd, out);
  const infoDir = join(commonDir, 'info');
  const exclude = join(infoDir, 'exclude');
  mkdirSync(infoDir, { recursive: true });
  const current = existsSync(exclude) ? readFileSync(exclude, 'utf-8') : '';
  const lead = current && !current.endsWith('\n') ? '\n' : '';
  appendFileSync(exclude, `${lead}/${LOCAL_SETTINGS}\n`, 'utf-8');
  return isIgnored(cwd);
}

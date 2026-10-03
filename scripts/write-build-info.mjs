// Stamps dist/ with what it was built from, so the running server can tell
// when the build on disk is newer than itself, or behind the source
// (src/server/server-restart.ts, "build" in /api/server/status).
//
// Plain Node, run last by `npm run build`: no shell commands, so it runs the
// same on Windows. git is called directly (execFileSync, no shell); without it
// the stamp still gets written, with a null sha, and the server reports the
// build state as unknown rather than failing the build.

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * What a build reads. Must equal BUILD_INPUTS in src/server/server-restart.ts,
 * which diffs these paths (tests/server-restart.test.ts checks the two match).
 */
export const BUILD_INPUTS = ['src', 'package.json', 'package-lock.json', 'tsconfig*.json', 'scripts/copy-client-assets.mjs'];

function git(root, args, env) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf-8',
    windowsHide: true,
    // Piped, not inherited: `add -A` warns per file about line endings.
    stdio: ['ignore', 'pipe', 'pipe'],
    env: env ? { ...process.env, ...env } : process.env,
  }).trim();
}

/**
 * The tree of the working copy as built: HEAD plus every uncommitted and
 * untracked (not ignored) change. A build compiles the working tree, not HEAD,
 * so a build made before its edits were committed must not read as behind
 * once they are; the server diffs this tree, not the sha, against HEAD.
 *
 * Written through a throwaway index (GIT_INDEX_FILE), seeded from the real one
 * so unchanged files aren't rehashed: whatever the user has staged is never
 * touched. Returns null when git can't do it.
 */
export function workingTreeId(root) {
  const scratch = mkdtempSync(join(tmpdir(), 'cr-build-info-'));
  try {
    const index = join(scratch, 'index');
    const realIndex = resolve(root, git(root, ['rev-parse', '--git-path', 'index']));
    const env = { GIT_INDEX_FILE: index };
    if (existsSync(realIndex)) copyFileSync(realIndex, index);
    else git(root, ['read-tree', 'HEAD'], env);
    git(root, ['add', '-A', '--', '.'], env);
    return git(root, ['write-tree'], env) || null;
  } catch {
    return null;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** The stamp for a build of `root` made now. */
export function buildInfo(root) {
  let sha = null;
  try {
    sha = git(root, ['rev-parse', 'HEAD']) || null;
  } catch {
    console.warn('write-build-info: not a git checkout (or no git) — the build state will show as unknown');
  }
  return { sha, inputsTree: sha ? workingTreeId(root) : null, builtAt: new Date().toISOString() };
}

// Run as a script (not imported by a test): stamp this checkout's dist/.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const out = join(root, 'dist', 'build-info.json');
  const info = buildInfo(root);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(info, null, 2) + '\n');
  console.log(`wrote ${out} (${info.sha ? info.sha.slice(0, 8) : 'no sha'})`);
}

// Stamps dist/ with the commit it was built from, so the running server can
// tell when the build on disk is newer than itself, or behind the source
// (src/server/server-restart.ts, "build" in /api/server/status).
//
// Plain Node, run last by `npm run build`: no shell commands, so it runs the
// same on Windows. git is called directly (execFileSync, no shell); without it
// the stamp still gets written, with a null sha, and the server reports the
// build state as unknown rather than failing the build.

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist', 'build-info.json');

let sha = null;
try {
  sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf-8', windowsHide: true }).trim() || null;
} catch {
  console.warn('write-build-info: not a git checkout (or no git) — the build state will show as unknown');
}

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ sha, builtAt: new Date().toISOString() }, null, 2) + '\n');
console.log(`wrote ${out} (${sha ? sha.slice(0, 8) : 'no sha'})`);

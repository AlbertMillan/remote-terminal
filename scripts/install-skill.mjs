// Install (or refresh) the repo's Claude Code skills into each Claude account's skills
// folder: skills/<name>/ -> <account configDir>/skills/<name>/ (docs/accounts.md).
// Cross-platform Node, no shell commands. Re-run after a skill changes; it reports
// which ones were out of date.
//
//   npm run install-skill              # every skill, into every account in config.json
//   node scripts/install-skill.mjs --dest <dir> [--dest <dir>]...   # these skills folders
//
// With no --dest it reads `accounts` from claude-remote's config.json
// (CLAUDE_REMOTE_CONFIG, else ~/.claude-remote/config.json); without any there, the
// two default accounts' folders, ~/.claude-personal and ~/.claude.
import { cpSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configuredAccounts, expandHome } from './claude-accounts.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcRoot = join(root, 'skills');

const args = process.argv.slice(2);
const dests = args.flatMap((a, i) => (a === '--dest' && args[i + 1] ? [args[i + 1]] : []));

/** Every account's skills folder, from claude-remote's config. */
function accountSkillDirs() {
  const dirs = Object.values(configuredAccounts())
    .map((a) => (a && typeof a.configDir === 'string' ? join(expandHome(a.configDir), 'skills') : null))
    .filter(Boolean);
  return [...new Set(dirs)];
}

function sameTree(a, b) {
  if (!existsSync(b)) return false;
  for (const entry of readdirSync(a)) {
    const pa = join(a, entry);
    const pb = join(b, entry);
    if (statSync(pa).isDirectory()) {
      if (!sameTree(pa, pb)) return false;
    } else if (!existsSync(pb) || !readFileSync(pa).equals(readFileSync(pb))) {
      return false;
    }
  }
  return true;
}

const skills = readdirSync(srcRoot).filter((name) => existsSync(join(srcRoot, name, 'SKILL.md')));
for (const destRoot of dests.length > 0 ? dests : accountSkillDirs()) {
  for (const name of skills) {
    const src = join(srcRoot, name);
    const dest = join(destRoot, name);
    if (sameTree(src, dest)) {
      console.log(`${name}: up to date (${dest})`);
      continue;
    }
    const existed = existsSync(dest);
    cpSync(src, dest, { recursive: true });
    console.log(`${name}: ${existed ? 'updated' : 'installed'} -> ${dest}`);
  }
}

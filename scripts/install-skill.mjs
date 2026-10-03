// Install (or refresh) the repo's Claude Code skills into the user's skills folder:
// skills/<name>/ -> ~/.claude/skills/<name>/. Cross-platform Node, no shell commands.
// Re-run after a skill changes; it reports which ones were out of date.
//
//   npm run install-skill              # every skill under skills/
//   node scripts/install-skill.mjs --dest <dir>   # another skills folder (tests)
import { cpSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcRoot = join(root, 'skills');

const args = process.argv.slice(2);
const destFlag = args.indexOf('--dest');
const destRoot = destFlag >= 0 && args[destFlag + 1] ? args[destFlag + 1] : join(homedir(), '.claude', 'skills');

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

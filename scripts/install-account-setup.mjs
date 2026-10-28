// Copy claude-remote's hooks and status line from one Claude account's settings.json
// into another's (docs/accounts.md): the claude-session hook (Fork, Resume, the
// session log), the notification hooks, and the plan-usage status line. Each
// account's `claude` reads only its own folder, so a new account has none of them.
// Cross-platform Node, no shell commands.
//
//   node scripts/install-account-setup.mjs --from ~/.claude/settings.json --to ~/.claude-personal/settings.json [--dry-run]
//
// Only claude-remote's own entries are copied: hooks whose command names
// CLAUDE_REMOTE_SESSION_ID, and a statusLine running statusline.mjs. The target's
// other settings and hooks are kept as they are, an entry it already has is not
// added twice, and a status line of its own is never replaced (it is reported).
// The target's previous content is kept beside it as settings.json.bak.
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const USAGE = 'usage: node scripts/install-account-setup.mjs --from <settings.json> --to <settings.json> [--dry-run]';

function expandHome(p) {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2));
  return resolve(p);
}

/** True for a hook group (`{ matcher?, hooks: [...] }`) any of whose commands is claude-remote's. */
export function isClaudeRemoteHook(group) {
  return Array.isArray(group?.hooks) && group.hooks.some((h) => typeof h?.command === 'string' && h.command.includes('CLAUDE_REMOTE_SESSION_ID'));
}

export function isClaudeRemoteStatusLine(statusLine) {
  return typeof statusLine?.command === 'string' && statusLine.command.includes('statusline.mjs');
}

/**
 * `target` with `source`'s claude-remote hooks and status line merged in. Pure.
 * Returns the merged settings and what changed, for the report.
 */
export function mergeSetup(source, target) {
  const merged = structuredClone(target ?? {});
  const added = [];
  const skipped = [];
  for (const [event, groups] of Object.entries(source?.hooks ?? {})) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups.filter(isClaudeRemoteHook)) {
      merged.hooks ??= {};
      merged.hooks[event] ??= [];
      const key = JSON.stringify(group);
      if (merged.hooks[event].some((g) => JSON.stringify(g) === key)) continue;
      merged.hooks[event].push(structuredClone(group));
      added.push(`hooks.${event}${group.matcher ? ` (${group.matcher})` : ''}`);
    }
  }
  if (isClaudeRemoteStatusLine(source?.statusLine)) {
    if (!merged.statusLine) {
      merged.statusLine = structuredClone(source.statusLine);
      added.push('statusLine');
    } else if (JSON.stringify(merged.statusLine) !== JSON.stringify(source.statusLine)) {
      skipped.push('statusLine (the target has its own: have it pipe stdin to statusline.mjs, docs/plan-usage.md)');
    }
  }
  return { merged, added, skipped };
}

function readJson(path, required) {
  if (!existsSync(path)) {
    if (required) throw new Error(`${path} does not exist`);
    return {};
  }
  return JSON.parse(readFileSync(path, 'utf-8'));
}

export function main(argv = process.argv.slice(2), log = (s) => console.log(s)) {
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const from = flag('--from');
  const to = flag('--to');
  if (!from || !to) {
    log(USAGE);
    return 2;
  }
  const source = expandHome(from);
  const target = expandHome(to);
  const { merged, added, skipped } = mergeSetup(readJson(source, true), readJson(target, false));
  for (const s of skipped) log(`skipped: ${s}`);
  if (added.length === 0) {
    log(`${target}: already set up`);
    return 0;
  }
  log(`${argv.includes('--dry-run') ? 'would add' : 'added'} to ${target}: ${added.join(', ')}`);
  if (argv.includes('--dry-run')) return 0;
  mkdirSync(dirname(target), { recursive: true });
  if (existsSync(target)) copyFileSync(target, `${target}.bak`);
  writeFileSync(`${target}.tmp`, `${JSON.stringify(merged, null, 2)}\n`);
  renameSync(`${target}.tmp`, target);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error?.message ?? String(error));
    process.exitCode = 1;
  }
}

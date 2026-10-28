// Move the transcripts of claude-remote's session rows into the folder of the
// account each row runs under (f-ilxxdj, project/accounts.md). Migration
// 019_session_account made every session from before accounts `personal`, but
// those sessions ran on the work login, so their transcripts sit in
// `~/.claude/projects`, and a revive or Resume runs `claude --resume` in
// `~/.claude-personal`, which doesn't have them. Cross-platform Node.
//
//   node scripts/move-session-transcripts.mjs [--account personal] [--also <claudeSessionId>]... [--canary <claudeSessionId>] [--dry-run]
//
// Moves `<id>.jsonl` and its `<id>/` folder (subagents) into the same project
// folder under the account's `projects/`, and repoints `usage_files.path` so the
// ledger keeps each file's attribution and offset. Transcripts of sessions
// claude-remote never ran stay where they are (`--also` adds one by id), and so
// does per-project auto-memory (`<slug>/memory/`): the work sessions share it.
//
// Canary first: earlier turns carry signed thinking blocks, and the API may refuse
// them under another account. One moved transcript is resumed (forked, so the
// conversation itself gains no turn) under the account's login; if that fails it
// is moved back and nothing else moves. Safe to run while the server is up: a
// transcript a running `claude` holds open fails to move and is reported.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { configuredAccounts, expandHome } from './claude-accounts.mjs';

const USAGE =
  'usage: node scripts/move-session-transcripts.mjs [--account personal] [--also <claudeSessionId>]... [--canary <claudeSessionId>] [--dry-run]';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Inherited variables that override a folder's login or settings (accounts.ts STRIPPED_LAUNCH_ENV). */
const STRIPPED = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_ENABLE_TELEMETRY'];

/** `env` as a launch under the folder `configDir` gets it (accounts.ts accountEnv). */
export function launchEnv(env, configDir, home = homedir()) {
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    const upper = key.toUpperCase();
    if (STRIPPED.includes(upper) || upper.startsWith('OTEL_') || upper === 'CLAUDE_CONFIG_DIR') continue;
    out[key] = value;
  }
  if (configDir.toLowerCase() !== join(home, '.claude').toLowerCase()) out.CLAUDE_CONFIG_DIR = configDir;
  return out;
}

/**
 * Why the account's folder can't take a launch (accounts.ts preflight), or null:
 * someone other than the expected login, or org-pushed settings in a personal folder.
 */
export function refusal(account, cfg, home = homedir()) {
  const dir = expandHome(cfg.configDir, home);
  const claudeJson = dir.toLowerCase() === join(home, '.claude').toLowerCase() ? join(home, '.claude.json') : join(dir, '.claude.json');
  let found = null;
  try {
    found = JSON.parse(readFileSync(claudeJson, 'utf-8')).oauthAccount ?? null;
  } catch {
    // No file or unreadable: nobody to compare.
  }
  if (!cfg.accountUuid && !cfg.organizationUuid) return `account "${account}" has no expected identity in config.json`;
  if (!found) return `nobody is logged in to account "${account}" (${dir})`;
  if ((cfg.accountUuid && found.accountUuid !== cfg.accountUuid) || (cfg.organizationUuid && found.organizationUuid !== cfg.organizationUuid)) {
    return `account "${account}" (${dir}) is logged in as ${found.emailAddress ?? found.accountUuid}, not its expected login`;
  }
  if (!cfg.organizationUuid) {
    const pushed = readdirSync(dir).filter((f) => /^remote-settings.*\.json$/i.test(f));
    if (pushed.length > 0) return `account "${account}" (${dir}) holds org-pushed settings (${pushed.join(', ')})`;
  }
  return null;
}

/** The transcript `<id>.jsonl` in any project folder of `projectsDir`, or null. */
function findIn(projectsDir, id) {
  let folders;
  try {
    folders = readdirSync(projectsDir);
  } catch {
    return null;
  }
  for (const folder of folders) {
    const file = join(projectsDir, folder, `${id}.jsonl`);
    if (existsSync(file)) return { folder, file };
  }
  return null;
}

/** The working folder a transcript was recorded in (its first `cwd`), for an id no row names. */
function firstCwd(file) {
  for (const line of readFileSync(file, 'utf-8').split('\n')) {
    try {
      const cwd = JSON.parse(line).cwd;
      if (typeof cwd === 'string' && cwd) return cwd;
    } catch {
      // A partial line: keep looking.
    }
  }
  return null;
}

/**
 * What to move: each id's transcript, found in another account's folder, with
 * where it goes in `target`'s. Ids already there, or found nowhere, are reported.
 */
export function planMoves(ids, target, accounts, home = homedir()) {
  const targetProjects = join(expandHome(accounts[target].configDir, home), 'projects');
  const others = Object.keys(accounts)
    .filter((a) => a !== target)
    .map((a) => join(expandHome(accounts[a].configDir, home), 'projects'));
  const moves = [];
  const skipped = [];
  for (const { id, cwd } of ids) {
    if (findIn(targetProjects, id)) {
      skipped.push({ id, reason: 'already there' });
      continue;
    }
    const from = others.map((p) => ({ projects: p, hit: findIn(p, id) })).find((x) => x.hit);
    if (!from) {
      skipped.push({ id, reason: 'no transcript in any account' });
      continue;
    }
    const fromDir = join(from.projects, from.hit.folder);
    const toDir = join(targetProjects, from.hit.folder);
    moves.push({ id, cwd: cwd ?? firstCwd(from.hit.file), fromDir, toDir, size: statSync(from.hit.file).size });
  }
  return { moves, skipped };
}

/** Rename `<id>.jsonl` and `<id>/` from one project folder to the other. */
function moveFiles(id, fromDir, toDir) {
  mkdirSync(toDir, { recursive: true });
  renameSync(join(fromDir, `${id}.jsonl`), join(toDir, `${id}.jsonl`));
  if (existsSync(join(fromDir, id))) {
    try {
      renameSync(join(fromDir, id), join(toDir, id));
    } catch (error) {
      // Keep the pair together: a resume reads the subagent folder beside the transcript.
      renameSync(join(toDir, `${id}.jsonl`), join(fromDir, `${id}.jsonl`));
      throw error;
    }
  }
}

/**
 * Repoint `usage_files` rows of the moved transcript and its subagent files. A row
 * the ledger already wrote for the new path is dropped first: the old one keeps
 * the attribution and offset, and `usage_messages` dedupes by message id anyway.
 */
export function repointUsage(db, id, fromDir, toDir) {
  const rows = db
    .prepare('SELECT path FROM usage_files WHERE path = ? OR substr(path, 1, ?) = ?')
    .all(join(fromDir, `${id}.jsonl`), join(fromDir, id).length + 1, join(fromDir, id) + sep);
  const del = db.prepare('DELETE FROM usage_files WHERE path = ?');
  const update = db.prepare('UPDATE usage_files SET path = ? WHERE path = ?');
  db.transaction(() => {
    for (const { path } of rows) {
      const next = toDir + path.slice(fromDir.length);
      del.run(next);
      update.run(next, path);
    }
  })();
  return rows.length;
}

/**
 * Resume `id` under the folder `configDir`, forked, and report whether the API
 * took it. The fork's own transcript is deleted after.
 */
export function resumeCanary({ id, cwd, configDir }) {
  const result = spawnSync('claude', ['-p', '--resume', id, '--fork-session', '--output-format', 'json'], {
    cwd,
    env: launchEnv(process.env, configDir),
    input: 'Reply with only: OK',
    encoding: 'utf-8',
    shell: process.platform === 'win32',
    windowsHide: true,
    timeout: 300_000,
  });
  let envelope = null;
  try {
    envelope = JSON.parse(result.stdout.trim().split('\n').pop());
  } catch {
    // Not JSON: the error text says why.
  }
  if (envelope?.session_id && UUID.test(envelope.session_id)) {
    const fork = findIn(join(configDir, 'projects'), envelope.session_id);
    if (fork) {
      rmSync(fork.file, { force: true });
      rmSync(join(configDir, 'projects', fork.folder, envelope.session_id), { recursive: true, force: true });
    }
  }
  const ok = result.status === 0 && envelope && !envelope.is_error;
  const detail = ok ? envelope.result : (envelope?.result ?? result.stderr ?? result.error?.message ?? '').toString().trim().slice(0, 500);
  return { ok: !!ok, detail };
}

function openDatabase(dataDir) {
  const require = createRequire(import.meta.url);
  const Database = require('better-sqlite3');
  const db = new Database(join(dataDir, 'sessions.db'));
  db.pragma('busy_timeout = 10000');
  return db;
}

function dataDirFrom(configPath) {
  try {
    const dir = JSON.parse(readFileSync(configPath, 'utf-8')).persistence?.dataDir;
    if (typeof dir === 'string' && dir) return expandHome(dir);
  } catch {
    // No config: the default.
  }
  return join(homedir(), '.claude-remote');
}

export function main(argv = process.argv.slice(2), deps = {}) {
  const log = deps.log ?? ((s) => console.log(s));
  const home = deps.home ?? homedir();
  const configPath = deps.configPath ?? (process.env.CLAUDE_REMOTE_CONFIG || join(homedir(), '.claude-remote', 'config.json'));
  const canaryRun = deps.resumeCanary ?? resumeCanary;
  const values = (name) => argv.flatMap((a, i) => (a === name && argv[i + 1] ? [argv[i + 1]] : []));
  if (argv.includes('--help')) {
    log(USAGE);
    return 0;
  }
  const accounts = configuredAccounts(configPath);
  const target = values('--account')[0] ?? 'personal';
  if (!accounts[target]) {
    log(`no account "${target}" in ${configPath}`);
    return 2;
  }
  const also = values('--also');
  const bad = [...also, ...values('--canary')].find((id) => !UUID.test(id));
  if (bad) {
    log(`not a session id: ${bad}`);
    return 2;
  }
  const dryRun = argv.includes('--dry-run');

  const db = deps.db ?? openDatabase(deps.dataDir ?? dataDirFrom(configPath));
  try {
    const rows = db
      .prepare('SELECT DISTINCT claude_session_id AS id, cwd FROM sessions WHERE account = ? AND claude_session_id IS NOT NULL')
      .all(target);
    const ids = [...rows, ...also.filter((id) => !rows.some((r) => r.id === id)).map((id) => ({ id, cwd: null }))];
    const { moves, skipped } = planMoves(ids, target, accounts, home);
    for (const s of skipped) log(`skip ${s.id}: ${s.reason}`);
    for (const m of moves) log(`${dryRun ? 'would move' : 'move'} ${m.id} (${Math.round(m.size / 1024)} KB): ${m.fromDir} -> ${m.toDir}`);
    if (moves.length === 0 || dryRun) return 0;

    const reason = refusal(target, accounts[target], home);
    if (reason) {
      log(`refused: ${reason}. Log in there first; nothing moved.`);
      return 1;
    }

    // Canary: the named one, else the smallest whose folder still exists (a resume runs there).
    const wanted = values('--canary')[0];
    const canary = wanted
      ? moves.find((m) => m.id === wanted)
      : [...moves].filter((m) => m.cwd && existsSync(m.cwd)).sort((a, b) => a.size - b.size)[0];
    if (!canary) {
      log(wanted ? `--canary ${wanted} is not among the moves` : 'no transcript to try first: none has a working folder that still exists. Name one with --canary.');
      return 1;
    }
    moveFiles(canary.id, canary.fromDir, canary.toDir);
    log(`canary: resuming ${canary.id} under "${target}"...`);
    const check = canaryRun({ id: canary.id, cwd: canary.cwd ?? home, configDir: expandHome(accounts[target].configDir, home) });
    if (!check.ok) {
      moveFiles(canary.id, canary.toDir, canary.fromDir);
      log(`canary failed, moved it back; nothing else moved: ${check.detail}`);
      return 1;
    }
    log(`canary ok: ${check.detail}`);

    let moved = 0;
    const failed = [];
    for (const m of moves) {
      try {
        if (m !== canary) moveFiles(m.id, m.fromDir, m.toDir);
        const repointed = repointUsage(db, m.id, m.fromDir, m.toDir);
        moved++;
        log(`moved ${m.id} (${repointed} usage rows repointed)`);
      } catch (error) {
        failed.push(m.id);
        log(`could not move ${m.id}: ${error?.code ?? ''} ${error?.message ?? error}`);
      }
    }
    log(`${moved} moved${failed.length ? `, ${failed.length} failed (a running claude may hold them; rerun once it exits)` : ''}`);
    return failed.length ? 1 : 0;
  } finally {
    if (!deps.db) db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error?.message ?? String(error));
    process.exitCode = 1;
  }
}

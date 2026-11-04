import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { createLogger } from '../utils/logger.js';
import { trackBranchContaining } from '../projects/track-store.js';
import { UNSAFE_IN_QUOTES } from '../utils/shell-quote.js';
import { pathKey } from './project-discovery.js';
import { mcpConfigPathFor, peerNotesDirFor, peerSettingsPathFor } from './prompt-file.js';
import { claudeJsonPath, defaultAccount } from '../accounts.js';

/**
 * How a started session's `claude` is launched, every time it is launched: at start, on
 * revive, and on a history Resume of its transcript (project/lean-started-sessions.md).
 *
 * A started session loads no MCP servers (`--strict-mcp-config`), only the ones its start
 * opted in by name. The user's full roster is ~21k tokens of every call's prompt, re-read on
 * every turn, and started sessions don't use it. Skills and built-in tools are left alone.
 *
 * `mcpServers` null is the full profile (every session the user opens); `[]` is no MCP.
 * `access` `read` is a read-only peer beside its track's builder (project/builder-critic-pairs.md).
 */
export interface LaunchProfile {
  permissionMode: string | null;
  mcpServers: string[] | null;
  access?: string | null;
}

const logger = createLogger('launch-profile');

export const MAX_MCP_SERVERS = 8;
const MCP_NAME = /^[\w.-]{1,64}$/;

type ServerConfig = Record<string, unknown>;

function readJson(path: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function serversOf(value: unknown): Record<string, ServerConfig> {
  if (!value || typeof value !== 'object') return {};
  const out: Record<string, ServerConfig> = {};
  for (const [name, cfg] of Object.entries(value as Record<string, unknown>)) {
    if (cfg && typeof cfg === 'object') out[name] = cfg as ServerConfig;
  }
  return out;
}

function ancestors(dir: string): string[] {
  const out: string[] = [];
  for (let d = dir; ; d = dirname(d)) {
    out.push(d);
    if (dirname(d) === d) return out;
  }
}

/**
 * Every MCP server the user's Claude config defines that a session in `cwd` can be given by
 * name, in Claude Code's precedence: local scope (the account's `.claude.json` `projects[<dir>]`, for the
 * cwd and the project it belongs to), then the nearest `.mcp.json`, then user scope. Plugin
 * servers and claude.ai connectors aren't in these files and never appear.
 *
 * `.mcp.json` is looked for up from the project's main checkout **and** up from the cwd, the
 * cwd's own folders nearest. A start checks names against the main checkout, before the
 * worktree exists, and the launch reads them from the worktree, whose parents differ and which
 * never gets a gitignored or uncommitted `.mcp.json`. Walking both makes every name the check
 * passes one the launch finds.
 */
export function availableMcpServers(cwd: string, claudeJsonFile: string = claudeJsonPath(defaultAccount())): Map<string, ServerConfig> {
  let projectCwd = cwd;
  try {
    projectCwd = trackBranchContaining(cwd)?.projectCwd ?? cwd;
  } catch (error) {
    // Only the local-scope lookup needs it; the cwd's own entry still counts.
    logger.warn({ cwd, error }, 'Could not map the cwd to its project for local-scope MCP servers');
  }
  const claudeJson = readJson(claudeJsonFile) ?? {};
  const layers: Record<string, ServerConfig>[] = [serversOf(claudeJson.mcpServers)];
  // Farthest first, so the nearer file wins. A folder both chains share is read once, in the
  // project's chain: read again after the project's own folder, it would override it.
  const projectChain = ancestors(projectCwd).reverse();
  const seen = new Set(projectChain.map(pathKey));
  const cwdOnly = ancestors(cwd).reverse().filter((d) => !seen.has(pathKey(d)));
  for (const dir of [...projectChain, ...cwdOnly]) {
    layers.push(serversOf(readJson(join(dir, '.mcp.json'))?.mcpServers));
  }
  const projects = (claudeJson.projects ?? {}) as Record<string, { mcpServers?: unknown }>;
  const wanted = new Set([pathKey(projectCwd), pathKey(cwd)]);
  for (const [dir, entry] of Object.entries(projects)) {
    if (wanted.has(pathKey(dir))) layers.push(serversOf(entry?.mcpServers));
  }
  // Later layers win: user < .mcp.json (farthest first) < local.
  const merged = new Map<string, ServerConfig>();
  for (const layer of layers) for (const [name, cfg] of Object.entries(layer)) merged.set(name, cfg);
  return merged;
}

/** The opt-in list from a request body: `[]` when absent, an error message when malformed. */
export function parseMcpServers(value: unknown): string[] | string {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return 'mcpServers must be an array of server names';
  const names = [...new Set(value.map((v) => (typeof v === 'string' ? v.trim() : v)))];
  if (names.some((n) => typeof n !== 'string' || !MCP_NAME.test(n))) {
    return 'mcpServers must be MCP server names (letters, digits, ".", "_", "-")';
  }
  if (names.length > MAX_MCP_SERVERS) return `At most ${MAX_MCP_SERVERS} mcpServers`;
  return names as string[];
}

// The modes a start accepts that are typed as a flag (sessions-api.ts PERMISSION_MODES, less
// `manual`). The value reaches a shell line from the DB on revive and Resume, so anything else
// is typed as no flag rather than as text.
const TYPED_MODES = new Set(['auto', 'acceptEdits', 'plan']);

/** `--permission-mode <mode> `, or nothing for the default (`manual`; older rows say `default`). */
export function permissionModeFlag(mode: string | null | undefined): string {
  if (!mode || mode === 'manual' || mode === 'default') return '';
  if (!TYPED_MODES.has(mode)) {
    logger.warn({ mode }, 'Unknown stored permission mode; launching in the default mode');
    return '';
  }
  return `--permission-mode ${mode} `;
}

/**
 * Write the opted-in servers' current config to `<dataDir>/mcp/<id>.json` and return its path
 * (forward slashes) and the servers written. Rewritten at every launch, so an edited key or
 * command applies; a server since removed from the config is left out. Never in the worktree
 * (`commitAll` would sweep its keys onto the branch), nor in the prompt folder (`--add-dir`
 * lets the session read that without asking).
 */
export function writeMcpConfig(
  sessionId: string,
  cwd: string,
  names: string[],
  claudeJsonFile?: string
): { path: string; written: string[] } {
  const available = availableMcpServers(cwd, claudeJsonFile);
  const mcpServers: Record<string, ServerConfig> = {};
  for (const name of names) {
    const cfg = available.get(name);
    if (cfg) mcpServers[name] = cfg;
    else logger.warn({ sessionId, name }, 'Opted-in MCP server is no longer in the Claude config; leaving it out');
  }
  const path = mcpConfigPathFor(sessionId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ mcpServers }, null, 2), 'utf-8');
  return { path: path.replace(/\\/g, '/'), written: Object.keys(mcpServers) };
}

/**
 * An absolute path as a Claude Code permission rule path: `//` then the path, the drive
 * letter as a folder (`C:\x` → `//c/x`). Checked 2026-11-04 with Claude Code 2.1.318 on
 * Windows: `//c/…` and `//C/…` match, `//C:/…` and `/c/…` don't, and the rule is ignored
 * without a word. A network path (`\\server\share`) throws: its rule form is unknown, and a
 * rule that silently matches nothing would leave the peer able to edit.
 */
export function permissionRulePath(path: string): string {
  const slashed = path.replace(/\\/g, '/').replace(/\/+$/, '');
  if (slashed.startsWith('//')) throw new Error(`${path} is a network path, which no permission rule is known to match`);
  const drive = /^([A-Za-z]):(\/.*)?$/.exec(slashed);
  if (drive) return `//${drive[1].toLowerCase()}${drive[2] ?? ''}`;
  if (!slashed.startsWith('/')) throw new Error(`${path} is not an absolute path`);
  return `/${slashed}`;
}

/**
 * The `--settings` a read-only peer launches with: no file edit in `denied` (its worktree and
 * the project's main checkout), edits allowed in its notes folder. Only `Edit(path)` rules are
 * matched by file checks (Claude Code warns that `Write(path)` is not), and they cover Write
 * and NotebookEdit too. "Nothing but the notes folder" can't be written as rules, since a deny
 * always beats an allow, so every other path rests on the header's rule.
 */
export function peerSettings(denied: string[], notesDir: string | null): { permissions: { deny: string[]; allow: string[] } } {
  return {
    permissions: {
      deny: [...new Set(denied.map((d) => `Edit(${permissionRulePath(d)}/**)`))],
      allow: notesDir ? [`Edit(${permissionRulePath(notesDir)}/**)`] : [],
    },
  };
}

// Gathering references and looking at images must never stall an unattended peer.
const PEER_ALLOWED_TOOLS = 'WebFetch WebSearch Read';
// A peer whose settings couldn't be written still launches read-only, without its notes.
const PEER_FALLBACK = '--disallowedTools Edit Write NotebookEdit ';

/**
 * Where a read-only peer in `cwd` may not write, and its track's notes folder (forward
 * slashes; null for a cwd in no unlanded track, so a Resume of a landed track's peer never
 * recreates deleted notes). The one source of the folder: the start's header and result
 * print what the launch granted.
 */
export function peerPaths(cwd: string): { denied: string[]; notesDir: string | null } {
  const branch = trackBranchContaining(cwd);
  if (!branch || branch.landedAt !== null) return { denied: [cwd], notesDir: null };
  return {
    denied: [branch.worktreePath, branch.projectCwd],
    notesDir: peerNotesDirFor(branch.id).replace(/\\/g, '/'),
  };
}

/**
 * A read-only peer's flags: its `--settings` (written to `<dataDir>/peer-settings/<id>.json`
 * at every launch), the tools it may use without asking, and `--add-dir` for its track's
 * notes folder, created here. When the settings or a path can't be used, every file-editing
 * tool is disallowed instead: the peer loses its notes, never its read-only. Returns the
 * notes folder it granted, or null.
 */
function readOnlyFlags(sessionId: string, cwd: string): { flags: string; notesDir: string | null } {
  let denied = [cwd];
  let notesDir: string | null = null;
  try {
    ({ denied, notesDir } = peerPaths(cwd));
    if (notesDir) {
      if (UNSAFE_IN_QUOTES.test(notesDir)) throw new Error(`${notesDir} has a character no shell quotes safely`);
      mkdirSync(notesDir, { recursive: true });
    }
  } catch (error) {
    logger.warn({ sessionId, cwd, error }, 'Could not find or create the peer notes folder');
    notesDir = null;
  }
  const allowed = `--allowedTools ${PEER_ALLOWED_TOOLS} `;
  try {
    const path = peerSettingsPathFor(sessionId);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(peerSettings(denied, notesDir), null, 2), 'utf-8');
    const settings = path.replace(/\\/g, '/');
    if (UNSAFE_IN_QUOTES.test(settings)) throw new Error(`${settings} has a character no shell quotes safely`);
    const notes = notesDir ? `--add-dir "${notesDir}" ` : '';
    return { flags: `--settings "${settings}" ${allowed}${notes}`, notesDir };
  } catch (error) {
    logger.error({ sessionId, error }, 'Could not write the peer settings; launching with every file edit disallowed');
    return { flags: `${PEER_FALLBACK}${allowed}`, notesDir: null };
  }
}

export interface LaunchFlags {
  /** The flags after `claude`, ending in a space when non-empty. */
  flags: string;
  /** The MCP servers this launch actually loads: null is the full roster. */
  mcpServers: string[] | null;
  /** A read-only peer's notes folder, as granted by `--add-dir` (forward slashes); null otherwise. */
  notesDir?: string | null;
}

/**
 * The flags for a launch with this profile: the permission mode, then `--strict-mcp-config` and
 * the scoped `--mcp-config`, then a read-only peer's flags (readOnlyFlags). A full profile
 * gives only the mode (and the peer's flags). A config file that can't be
 * written or quoted safely drops the opt-ins rather than the launch: the session still starts
 * lean, without those servers. `mcpServers` says what it got, so a caller can tell.
 */
export function launchFlags(
  sessionId: string,
  cwd: string,
  profile: LaunchProfile,
  /** The session's account's `.claude.json` (accounts.ts claudeJsonPath), whose servers it may load. */
  claudeJsonFile?: string
): LaunchFlags {
  const mode = permissionModeFlag(profile.permissionMode);
  const peer = profile.access === 'read' ? readOnlyFlags(sessionId, cwd) : null;
  const access = peer?.flags ?? '';
  const notesDir = peer?.notesDir ?? null;
  if (!profile.mcpServers) return { flags: `${mode}${access}`, mcpServers: null, ...(peer ? { notesDir } : {}) };
  let scoped = '';
  let loaded: string[] = [];
  if (profile.mcpServers.length > 0) {
    try {
      const { path, written } = writeMcpConfig(sessionId, cwd, profile.mcpServers, claudeJsonFile);
      if (UNSAFE_IN_QUOTES.test(path)) throw new Error(`${path} has a character no shell quotes safely`);
      if (written.length > 0) {
        scoped = `--mcp-config "${path}" `;
        loaded = written;
      }
    } catch (error) {
      logger.error({ sessionId, error }, 'Could not write the scoped MCP config; launching with no MCP servers');
    }
  }
  return { flags: `${mode}--strict-mcp-config ${scoped}${access}`, mcpServers: loaded, ...(peer ? { notesDir } : {}) };
}


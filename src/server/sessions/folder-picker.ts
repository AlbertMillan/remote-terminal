import { execFile } from 'child_process';
import { existsSync, statSync } from 'fs';
import { mkdir, readdir, realpath, stat, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path';
import { promisify } from 'util';
import { getConfig } from '../config.js';
import { expandHome } from '../accounts.js';
import { isInside, pathKey } from '../utils/paths.js';
import { createLogger } from '../utils/logger.js';
import { emptyFrontmatter, renderProjectDoc } from '../projects/project-doc-format.js';
import { loadRegistry } from '../projects/registry.js';
import { discoverProjects } from './project-discovery.js';
import { getRecentPaths } from './recent-paths.js';

const logger = createLogger('folder-picker');
const execFileAsync = promisify(execFile);

/**
 * The New Session dialog's Working Directory field: complete a typed path, search known
 * projects, and create a folder that doesn't exist yet. → project/new-session-folder-picker.md
 *
 * The field is typed by whoever reaches the server, so every path is untrusted. A path is
 * judged in this order, and the order matters:
 *  1. its text, before any filesystem call (`checkPathText`): a UNC path (`\\host\share`)
 *     reaching `stat` or `realpath` makes Windows offer the user's NTLM hash to that host;
 *  2. an existing folder then simply opens, wherever it is (a track worktree under
 *     `~/.claude-remote`, `~/.claude`, another drive): the rules below are for CREATING;
 *  3. a folder to create must be inside the home folder and not under a hidden or AppData
 *     folder (`checkLexically`: tool config, never a project);
 *  4. links resolved: the deepest existing folder, after `realpath`, must still be inside
 *     the real home folder, or a junction under `~` would put the new folder anywhere;
 *  5. creating only ever adds the missing levels.
 * Listing a folder's contents (completion) follows the creating rules too. Anyone who reaches
 * the server can already open a shell, so these rules guard against mistakes and path
 * tricks, not against the user.
 */

/** Longer than any real path; keeps a pathological query cheap. */
const MAX_INPUT_CHARS = 500;
/** One folder's listing, and a search's projects: more than a dropdown can show. */
const MAX_FOLDER_ITEMS = 50;
const MAX_PROJECT_ITEMS = 20;
/** A name Windows refuses for a folder, or one it silently changes (trailing dot or space). */
const INVALID_SEGMENT = /[<>:"|?*]|[. ]$/;
const hasControlChar = (s: string): boolean => [...s].some((ch) => ch.charCodeAt(0) < 32);
const RESERVED_SEGMENT = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

export type FolderVerdict =
  /** The field is empty: the session opens in the default folder. */
  | { kind: 'empty'; path: string; display: string }
  | { kind: 'exists'; path: string; display: string; project: string | null }
  /** `create` are the folder names to make, outermost first, below `existing`. */
  | { kind: 'creatable'; path: string; display: string; existing: string; create: string[] }
  | { kind: 'refused'; reason: string };

export interface FolderItem {
  path: string;
  /** `~/…` inside the home folder, else the path itself. */
  display: string;
  name: string;
  git: boolean;
  projectDoc: boolean;
  /** A session ran here recently (ranked first). */
  recent: boolean;
}

export interface FolderCompletion {
  mode: 'path' | 'search';
  items: FolderItem[];
  /** Search mode: a new folder named after the query, in the default folder. */
  newFolder: { path: string; display: string } | null;
  verdict: FolderVerdict;
  home: string;
  defaultDisplay: string;
}

export interface CreateFolderOptions {
  git: boolean;
  projectDoc: boolean;
}

export class FolderRefusedError extends Error {}

/** The folder an empty field means: `sessions.defaultCwd`, or the home folder if that is missing. */
export function defaultCwd(home: string = homedir()): string {
  const configured = getConfig().sessions?.defaultCwd;
  if (typeof configured === 'string' && configured.trim()) {
    const dir = expandHome(configured.trim(), home);
    try {
      if (statSync(dir).isDirectory()) return dir;
    } catch {
      // Missing: fall through to the home folder.
    }
  }
  return home;
}

/** `~/…` for a path inside the home folder, with forward slashes; anything else as it is. */
export function displayPath(path: string, home: string = homedir()): string {
  if (!isInside(home, path)) return path;
  const rel = relative(home, path);
  return rel ? `~/${rel.split(sep).join('/')}` : '~';
}

/**
 * What a typed Working Directory means as an absolute path: `~` is the home folder, a
 * relative path is under the default folder. Lexical only; used wherever the field's text
 * reaches the server (session.create, the track picker, the account label).
 */
export function resolveCwdInput(input: string, home: string = homedir()): string {
  const text = input.trim();
  if (text === '~' || text.startsWith('~/') || text.startsWith('~\\')) return expandHome(text, home);
  if (isAbsolute(text)) return resolve(text);
  return resolve(defaultCwd(home), text);
}

type PathCheck = { ok: true; path: string } | { ok: false; reason: string };

/** Step 1, for every path: the absolute path, or why it is refused. Touches no filesystem. */
export function checkPathText(input: string, home: string = homedir()): PathCheck {
  const text = input.trim();
  if (text.length > MAX_INPUT_CHARS) return { ok: false, reason: 'That path is too long.' };
  // Network and device paths (\\host\share, //host, \\?\C:) never reach the disk.
  if (/^[\\/]{2}/.test(text)) return { ok: false, reason: 'Network paths are not allowed.' };
  // `C:foo` is relative to that drive's current folder: never what the user means.
  if (/^[a-zA-Z]:(?![\\/])/.test(text) && text.length > 2) {
    return { ok: false, reason: 'Write the full path, like C:\\Users\\…' };
  }
  if (text.split(/[\\/]/).some((s) => s === '..')) return { ok: false, reason: 'Paths with ".." are not allowed.' };
  return { ok: true, path: resolveCwdInput(text, home) };
}

/** Steps 1 and 3, for a folder to create or list: inside the home folder, no tool config. */
export function checkLexically(input: string, home: string = homedir()): PathCheck {
  const text = checkPathText(input, home);
  if (!text.ok) return text;
  const path = text.path;
  if (!isInside(home, path)) {
    return { ok: false, reason: `Only folders inside your user folder (${home}) can be used here.` };
  }
  const below = relative(home, path).split(sep).filter(Boolean);
  for (const segment of below) {
    if (segment.startsWith('.') || segment.toLowerCase() === 'appdata') {
      return { ok: false, reason: `Folders under ${segment} hold app settings, not projects.` };
    }
    if (INVALID_SEGMENT.test(segment) || RESERVED_SEGMENT.test(segment) || hasControlChar(segment)) {
      return { ok: false, reason: `"${segment}" is not a valid folder name.` };
    }
  }
  return { ok: true, path };
}

async function isDir(path: string): Promise<boolean | null> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return null; // missing
  }
}

/** Step 3: `path`'s real location is inside the real home folder. */
async function realInsideHome(path: string, home: string): Promise<boolean> {
  try {
    return isInside(await realpath(home), await realpath(path));
  } catch {
    return false;
  }
}

function projectName(path: string): string | null {
  return existsSync(join(path, '.git')) || existsSync(join(path, 'PROJECT.md')) ? basename(path) : null;
}

/** Steps 1–4 for what the field holds. */
export async function checkFolder(input: string, home: string = homedir()): Promise<FolderVerdict> {
  if (!input.trim()) {
    const path = defaultCwd(home);
    return { kind: 'empty', path, display: displayPath(path, home) };
  }
  const text = checkPathText(input, home);
  if (!text.ok) return { kind: 'refused', reason: text.reason };
  // An existing folder opens wherever it is; the rules below are for creating one.
  const here = await isDir(text.path);
  if (here === true) {
    return { kind: 'exists', path: text.path, display: displayPath(text.path, home), project: projectName(text.path) };
  }
  if (here === false) return { kind: 'refused', reason: `${displayPath(text.path, home)} is a file, not a folder.` };

  const lexical = checkLexically(input, home);
  if (!lexical.ok) return { kind: 'refused', reason: lexical.reason };
  const path = lexical.path;

  // The deepest level that exists. The home folder itself does, so this ends there at worst.
  let existing = path;
  const create: string[] = [];
  for (;;) {
    const dir = await isDir(existing);
    if (dir === true) break;
    if (dir === false) return { kind: 'refused', reason: `${displayPath(existing, home)} is a file, not a folder.` };
    if (existing === home || dirname(existing) === existing) {
      return { kind: 'refused', reason: 'Your user folder could not be read.' };
    }
    create.unshift(basename(existing));
    existing = dirname(existing);
  }
  if (!(await realInsideHome(existing, home))) {
    return { kind: 'refused', reason: `${displayPath(existing, home)} links to a place outside your user folder.` };
  }
  // `create` is never empty: the path itself was missing above.
  return { kind: 'creatable', path, display: displayPath(path, home), existing, create };
}

/** Path mode: the query names a folder, not a project to search for. */
function isPathQuery(q: string): boolean {
  return /[\\/]/.test(q) || q.startsWith('~') || /^[a-zA-Z]:/.test(q);
}

async function folderItem(path: string, recent: Set<string>, home: string): Promise<FolderItem> {
  return {
    path,
    display: displayPath(path, home),
    name: basename(path),
    git: existsSync(join(path, '.git')),
    projectDoc: existsSync(join(path, 'PROJECT.md')),
    recent: recent.has(pathKey(path)),
  };
}

type Ranked = { name: string; recent: boolean };

/** Recently used before the rest, then by name. */
function byRecentThenName(a: Ranked, b: Ranked): number {
  if (a.recent !== b.recent) return a.recent ? -1 : 1;
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
}

/**
 * The folders inside `parent` a project could be: not hidden, not AppData, not a link
 * (where one leads is not a folder of the user's). Empty when `parent` breaks the rules.
 */
async function listChildFolders(parent: string, home: string): Promise<string[]> {
  if (!checkLexically(parent, home).ok) return [];
  if ((await isDir(parent)) !== true || !(await realInsideHome(parent, home))) return [];
  try {
    return (await readdir(parent, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && !e.isSymbolicLink())
      .map((e) => e.name)
      .filter((n) => !n.startsWith('.') && n.toLowerCase() !== 'appdata');
  } catch {
    return [];
  }
}

/** The folders inside the typed parent whose names start with what follows it. */
async function completePath(q: string, recent: Set<string>, home: string): Promise<FolderItem[]> {
  const cut = Math.max(q.lastIndexOf('/'), q.lastIndexOf('\\'));
  const parentText = cut === -1 ? q : q.slice(0, cut + 1);
  const prefix = (cut === -1 ? '' : q.slice(cut + 1)).toLowerCase();
  if (cut === -1 && q !== '~') return [];
  const parent = checkLexically(parentText === '~/' || parentText === '~\\' ? '~' : parentText, home);
  if (!parent.ok) return [];
  // Ranked and cut by name first: a folder's git/PROJECT.md flags cost two stats each, and
  // a big folder (Downloads) must not pay them for entries the dropdown never shows.
  const ranked: Ranked[] = (await listChildFolders(parent.path, home))
    .filter((n) => n.toLowerCase().startsWith(prefix))
    .map((name) => ({ name, recent: recent.has(pathKey(join(parent.path, name))) }))
    .sort(byRecentThenName)
    .slice(0, MAX_FOLDER_ITEMS);
  return Promise.all(ranked.map((r) => folderItem(join(parent.path, r.name), recent, home)));
}

/** The registry's folders, re-read at most every few seconds: the field asks per keystroke. */
const REGISTRY_TTL_MS = 5_000;
let registryCache: { cwds: string[]; expiresAt: number } | null = null;
function registryCwds(): string[] {
  if (registryCache && registryCache.expiresAt > Date.now()) return registryCache.cwds;
  let cwds: string[] = [];
  try {
    cwds = loadRegistry().projects.map((p) => p.cwd);
  } catch (error) {
    logger.debug({ error }, 'folder-picker: registry unreadable');
  }
  registryCache = { cwds, expiresAt: Date.now() + REGISTRY_TTL_MS };
  return cwds;
}

/** Every folder a session has run in or the workspace knows, newest use first. */
function knownProjects(): { path: string; lastUsed: number }[] {
  const seen = new Map<string, { path: string; lastUsed: number }>();
  const add = (path: string, lastUsed: number) => {
    const key = pathKey(path);
    const had = seen.get(key);
    if (!had || lastUsed > had.lastUsed) seen.set(key, { path, lastUsed });
  };
  try {
    for (const p of discoverProjects()) add(p.cwd, p.lastActivity ? Date.parse(p.lastActivity) || 0 : 0);
  } catch (error) {
    logger.debug({ error }, 'folder-picker: project discovery failed');
  }
  for (const cwd of registryCwds()) add(cwd, 0);
  for (const p of getRecentPaths()) add(p.cwd, p.lastUsed);
  return [...seen.values()].sort((a, b) => b.lastUsed - a.lastUsed);
}

/** The folders directly inside the default folder: projects no session has run in yet. */
async function defaultFolderChildren(home: string): Promise<string[]> {
  const parent = defaultCwd(home);
  return (await listChildFolders(parent, home)).map((n) => join(parent, n));
}

/**
 * Search mode: projects whose folder name holds the query. Known projects first, by last
 * use; then the default folder's other folders, by name.
 */
async function searchProjects(q: string, recent: Set<string>, home: string): Promise<FolderItem[]> {
  const needle = q.toLowerCase();
  const matches = (path: string) => basename(path).toLowerCase().includes(needle);
  const known = knownProjects()
    .map((p) => p.path)
    .filter((p) => matches(p) && existsSync(p));
  const seen = new Set(known.map(pathKey));
  const others = (await defaultFolderChildren(home))
    .filter((p) => matches(p) && !seen.has(pathKey(p)))
    .sort((a, b) => basename(a).localeCompare(basename(b), undefined, { sensitivity: 'base' }));
  return Promise.all(
    [...known, ...others].slice(0, MAX_PROJECT_ITEMS).map((p) => folderItem(p, recent, home))
  );
}

/** Everything the field's dropdown and hint show for `q`. */
export async function completeFolder(q: string, home: string = homedir()): Promise<FolderCompletion> {
  const text = q.trim().slice(0, MAX_INPUT_CHARS);
  const recent = new Set(getRecentPaths().map((p) => pathKey(p.cwd)));
  const verdict = await checkFolder(text, home);
  const defaultDisplay = displayPath(defaultCwd(home), home);
  const base = { verdict, home, defaultDisplay, newFolder: null };

  if (!text) {
    // Recent projects, so an empty field still offers somewhere to go.
    const items = await Promise.all(
      getRecentPaths()
        .filter((p) => existsSync(p.cwd))
        .slice(0, 8)
        .map((p) => folderItem(p.cwd, recent, home))
    );
    return { ...base, mode: 'search', items };
  }
  if (isPathQuery(text)) return { ...base, mode: 'path', items: await completePath(text, recent, home) };

  const items = await searchProjects(text, recent, home);
  // The query as a new folder in the default folder, offered only while none has that name.
  const newFolder =
    verdict.kind === 'creatable' ? { path: verdict.path, display: verdict.display } : null;
  return { ...base, mode: 'search', items, newFolder };
}

/**
 * Create the folder the field names (step 4), re-checking steps 1–3 here: the client's
 * earlier check is advisory. Only the missing levels are made; an existing folder is never
 * changed, and one that appeared since the check simply opens. Returns its path.
 */
export async function createFolder(
  input: string,
  options: CreateFolderOptions,
  home: string = homedir()
): Promise<string> {
  const verdict = await checkFolder(input, home);
  if (verdict.kind === 'refused') throw new FolderRefusedError(verdict.reason);
  if (verdict.kind !== 'creatable') return verdict.path;

  await mkdir(verdict.path, { recursive: true });
  // A link swapped in between the check and mkdir would have put the folder elsewhere.
  if (!(await realInsideHome(verdict.path, home))) {
    throw new FolderRefusedError(`${verdict.display} links to a place outside your user folder.`);
  }
  logger.info({ path: verdict.path, created: verdict.create }, 'folder-picker: created folder');

  if (options.git) {
    try {
      await execFileAsync('git', ['init'], { cwd: verdict.path, windowsHide: true });
    } catch (error) {
      // The folder is made; a missing git must not cost the session.
      logger.warn({ error, path: verdict.path }, 'folder-picker: git init failed');
    }
  }
  if (options.projectDoc) {
    const doc = renderProjectDoc({
      frontmatter: { ...emptyFrontmatter(), name: basename(verdict.path), status: 'active' },
      tracks: [],
      preamble: [],
    });
    // `wx`: never over a file, though the folder was just made.
    await writeFile(join(verdict.path, 'PROJECT.md'), doc, { flag: 'wx' }).catch((error) =>
      logger.warn({ error, path: verdict.path }, 'folder-picker: PROJECT.md not written')
    );
  }
  return verdict.path;
}

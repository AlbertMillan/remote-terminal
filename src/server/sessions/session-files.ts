import { open, realpath, stat, type FileHandle } from 'fs/promises';
import { basename, extname, isAbsolute, resolve } from 'path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { extractIpFromRequest, verifyTailscaleConnection } from '../auth/tailscale.js';
import { getSession as getSessionFromDb } from '../db/queries.js';
import { isInside, pathKey } from '../utils/paths.js';
import { findTranscript } from '../accounts.js';
import { readTranscriptCwd } from '../projects/project-discovery.js';
import { createLogger } from '../utils/logger.js';
import { isSessionId, uploadDirFor } from './uploads.js';

const logger = createLogger('session-files');

/**
 * A file path printed in a session's terminal, opened from the browser: the client detects
 * path-like text, asks `…/files/check` which of its candidates are real files, underlines
 * only those, and a click opens `…/files/open` in a new tab. The file is read in place, never
 * copied; the browser shows what it can and downloads the rest. → project/clickable-file-paths.md
 *
 * The path comes from terminal text, so it is untrusted input: it resolves only inside the
 * session's cwd or its uploads folders, after symlinks and junctions are resolved, or a link
 * inside the cwd could read the rest of the disk.
 */

/** Longer than any real path; keeps a pathological line from costing a stat per character. */
const MAX_PATH_CHARS = 1024;
/** One check is one hovered line, which never holds this many paths. */
const MAX_CHECK_PATHS = 50;
/** `tailscale whois` spawns a process; a hover must not spawn one per line. */
const AUTH_CACHE_MS = 60_000;

/**
 * The folders a session's links may open files from: its cwd, the folder its conversation
 * started in (when known and different), and its uploads (pasted files). The first two are
 * also where relative paths resolve: Claude prints paths relative to its project folder,
 * and a session's stored cwd can sit below that (an old `$PWD` hook recorded Claude's `cd`).
 */
export function sessionRoots(sessionId: string, cwd: string, projectDir?: string | null): string[] {
  const extra = projectDir && pathKey(projectDir) !== pathKey(cwd) ? [projectDir] : [];
  return [cwd, ...extra, uploadDirFor(sessionId, 'uploads'), uploadDirFor(sessionId, 'images')];
}

/** How many leading `sessionRoots()` entries relative paths resolve against. */
export function relativeBaseCount(cwd: string, projectDir?: string | null): number {
  return projectDir && pathKey(projectDir) !== pathKey(cwd) ? 2 : 1;
}

/** A conversation's starting folder never changes; a miss is retried after this long. */
const PROJECT_DIR_MISS_MS = 60_000;

/** The folder a session's conversation started in, read from its transcript's head. */
function projectDirFromTranscript(session: { cwd: string; claudeSessionId?: string | null; account?: string | null }): string | null {
  if (!session.claudeSessionId) return null;
  const found = findTranscript(session.cwd, session.claudeSessionId, session.account);
  const dir = found ? readTranscriptCwd(found.path) : null;
  // Becomes a root that `realpath` touches: never a UNC/device path (NTLM), only an absolute one.
  return dir && isAbsolute(dir) && !/^[\\/]{2}/.test(dir) ? dir : null;
}

/**
 * The text as a terminal printed it, reduced to a path: surrounding quotes or brackets, a
 * `:line[:col]` or `(line,col)` suffix and trailing punctuation removed. Null when nothing
 * plausible is left.
 */
export function cleanLinkText(raw: string): string | null {
  let p = raw.trim();
  if (!p || p.length > MAX_PATH_CHARS || p.includes('\0')) return null;
  // The MSVC `(line,col)` form goes first, or its `)` is taken for a closing bracket.
  p = p.replace(/\(\d+(?:,\s*\d+)?\)[.,;:]*$/, '');
  p = p.replace(/^["'`([<]+/, '').replace(/["'`)\]>.,;:]+$/, '');
  p = p.replace(/(?<=\.\w+):\d+(?::\d+)?$/, '');
  return p || null;
}

/** The roots with symlinks and junctions resolved; a missing one (most uploads folders) is left out. */
export async function realRootsOf(roots: string[]): Promise<string[]> {
  const real = await Promise.all(roots.map((r) => realpath(r).catch(() => null)));
  return real.filter((r): r is string => r !== null);
}

/**
 * Resolves terminal text to a regular file inside one of `roots`, or null. Relative paths
 * resolve against the first root (the cwd). Pass `realRoots` (from `realRootsOf`) when
 * resolving many paths, so the roots are resolved once.
 *
 * Two checks, in this order:
 * - **Lexical, before any filesystem call.** Terminal text is untrusted: a printed
 *   `\\host\share\x.png` reaching `realpath` makes Windows open SMB to that host and offer the
 *   user's NTLM credentials, just because a line was hovered. Nothing outside the roots is
 *   ever touched, and UNC and device paths (`\\?\`, `\\.\`) are refused outright.
 * - **Real, after resolving links**, so a symlink or junction inside the cwd can't read the rest
 *   of the disk.
 */
export async function resolveSessionFile(
  roots: string[],
  raw: string,
  realRoots?: string[],
  /** Relative paths try the first this-many roots in order (`relativeBaseCount`). */
  relativeBases = 1
): Promise<string | null> {
  const p = cleanLinkText(raw);
  if (!p || roots.length === 0 || /^[\\/]{2}/.test(p)) return null;
  const real = realRoots ?? (await realRootsOf(roots));
  const bases = isAbsolute(p) ? [null] : roots.slice(0, Math.max(1, relativeBases));
  for (const base of bases) {
    const abs = base === null ? resolve(p) : resolve(base, p);
    // The real roots count lexically too: a path printed in its resolved form, while the cwd
    // was given through a junction, is still inside.
    if (![...roots, ...real].some((r) => isInside(r, abs))) continue;
    try {
      const target = await realpath(abs);
      if (!(await stat(target)).isFile()) continue;
      if (real.some((r) => isInside(r, target))) return target;
    } catch {
      // missing, unreadable, or a dangling link: try the next base
    }
  }
  return null;
}

type Disposition = 'inline' | 'attachment';

const INLINE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
};

/**
 * Shown as plain text in the tab. Never `.html`, `.htm` or `.svg`: those download, because
 * served from this origin a script inside them could call `/api/*` as the viewer.
 */
const TEXT_EXTENSIONS = new Set([
  '.md', '.markdown', '.txt', '.log', '.json', '.jsonl', '.csv', '.tsv', '.yaml', '.yml', '.toml',
  '.ini', '.cfg', '.conf', '.env', '.xml', '.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx', '.css',
  '.scss', '.py', '.cs', '.java', '.kt', '.kts', '.go', '.rs', '.c', '.h', '.cpp', '.hpp', '.sh',
  '.ps1', '.bat', '.cmd', '.sql', '.lua', '.rb', '.php', '.swift', '.gd', '.shader', '.hlsl',
  '.glsl', '.diff', '.patch', '.gitignore',
]);

export function servingFor(path: string): { type: string; disposition: Disposition } {
  const ext = extname(path).toLowerCase();
  const media = INLINE_TYPES[ext];
  if (media) return { type: media, disposition: 'inline' };
  if (TEXT_EXTENSIONS.has(ext)) return { type: 'text/plain; charset=utf-8', disposition: 'inline' };
  return { type: 'application/octet-stream', disposition: 'attachment' };
}

/** What a viewed page's own files are served as: pages, scripts and styles as themselves. */
const VIEW_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
};

/**
 * Serving on the view route. Pages, scripts and SVG are shown here only because every answer
 * of this route carries `viewCsp()`'s sandbox; `servingFor()` (the open route) never shows them.
 */
export function viewServingFor(path: string): { type: string; disposition: Disposition } {
  const type = VIEW_TYPES[extname(path).toLowerCase()];
  return type ? { type, disposition: 'inline' } : servingFor(path);
}

/** A Host header fit to go into a CSP source: name or IP, optional port, nothing else. */
export const VIEW_HOST = /^[A-Za-z0-9.-]+(?::\d{1,5})?$|^\[[0-9A-Fa-f:.]+\](?::\d{1,5})?$/;

/** The URL path of `abs` on the view route: each segment encoded, `\` as `/`. */
export function viewUrlPath(sessionId: string, abs: string): string {
  const segments = abs.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/');
  return `/api/sessions/${encodeURIComponent(sessionId)}/files/view/${segments.replace(/^\//, '%2F')}`;
}

/**
 * The policy on every view-route answer. `sandbox allow-scripts` without `allow-same-origin`
 * makes the page an opaque origin: its script runs (a viewer's buttons work) but can't read
 * this origin's storage or responses. Every fetch it may make is confined to this session's
 * view tree (a scheme-less host source with a path prefix), so it can't even send a request
 * to another `/api` route, and forms, frames and `<base>` are off.
 */
export function viewCsp(host: string, sessionId: string): string {
  const tree = `${host}/api/sessions/${encodeURIComponent(sessionId)}/files/view/`;
  return [
    'sandbox allow-scripts',
    "default-src 'none'",
    `script-src ${tree} 'unsafe-inline'`,
    `style-src ${tree} 'unsafe-inline'`,
    `img-src ${tree} data: blob:`,
    `media-src ${tree} data: blob:`,
    `font-src ${tree} data:`,
    `connect-src ${tree}`,
    "form-action 'none'",
    "frame-src 'none'",
    "base-uri 'none'",
  ].join('; ');
}

export interface SessionFileDeps {
  verify?: (ip: string) => Promise<unknown>;
  getSession?: (id: string) => { cwd: string; claudeSessionId?: string | null; account?: string | null } | null;
  /** The folder the session's conversation started in; the default reads its transcript. */
  projectDirOf?: (session: { cwd: string; claudeSessionId?: string | null; account?: string | null }) => string | null;
  now?: () => number;
}

/**
 * `POST /api/sessions/:id/files/check` `{ paths }` → `{ found }` (the paths, as sent, that
 * open a file), and `GET /api/sessions/:id/files/open?path=` streaming one file. Both need the
 * terminal's own Tailscale identity: the rest of `/api/*` is open on 0.0.0.0, and a route
 * that reads files must not be.
 */
export function registerSessionFileRoutes(app: FastifyInstance, deps: SessionFileDeps = {}): void {
  const verify = deps.verify ?? verifyTailscaleConnection;
  const getSession = deps.getSession ?? getSessionFromDb;
  const now = deps.now ?? Date.now;
  const verified = new Map<string, number>();

  async function authorized(request: FastifyRequest): Promise<boolean> {
    const ip = extractIpFromRequest(request);
    const until = verified.get(ip);
    if (until && until > now()) return true;
    if (!(await verify(ip))) return false;
    // Expired entries go when a new one is added, so the map holds only callers seen lately.
    for (const [seen, expiry] of verified) if (expiry <= now()) verified.delete(seen);
    verified.set(ip, now() + AUTH_CACHE_MS);
    return true;
  }

  const projectDirOf = deps.projectDirOf ?? projectDirFromTranscript;
  /** Per conversation: a hit is kept for good (a transcript's first cwd never changes). */
  const projectDirs = new Map<string, { dir: string | null; at: number }>();

  function projectDirFor(session: { cwd: string; claudeSessionId?: string | null; account?: string | null }): string | null {
    const key = session.claudeSessionId;
    if (!key) return null;
    const hit = projectDirs.get(key);
    if (hit && (hit.dir !== null || now() - hit.at < PROJECT_DIR_MISS_MS)) return hit.dir;
    let dir: string | null = null;
    try {
      dir = projectDirOf(session);
    } catch {
      /* unreadable transcript: links resolve against the cwd alone */
    }
    if (projectDirs.size > 500) projectDirs.clear();
    projectDirs.set(key, { dir, at: now() });
    return dir;
  }

  function rootsOf(id: string): { roots: string[]; bases: number } | null {
    if (!isSessionId(id)) return null;
    const session = getSession(id);
    if (!session?.cwd) return null;
    const projectDir = projectDirFor(session);
    return { roots: sessionRoots(id, session.cwd, projectDir), bases: relativeBaseCount(session.cwd, projectDir) };
  }

  app.post<{ Params: { id: string }; Body: { paths?: unknown } }>(
    '/api/sessions/:id/files/check',
    async (request, reply) => {
      if (!(await authorized(request))) return reply.status(403).send({ error: 'Not authorized' });
      const found = rootsOf(request.params.id);
      if (!found) return reply.status(404).send({ error: 'Session not found' });
      const { roots, bases } = found;
      const paths = request.body?.paths;
      if (!Array.isArray(paths) || paths.length > MAX_CHECK_PATHS || !paths.every((p) => typeof p === 'string')) {
        return reply.status(400).send({ error: `paths: up to ${MAX_CHECK_PATHS} strings` });
      }
      // Asynchronous: this thread also streams every terminal, and a slow drive must not stall them.
      const real = await realRootsOf(roots);
      const resolved = await Promise.all((paths as string[]).map((p) => resolveSessionFile(roots, p, real, bases)));
      return { found: (paths as string[]).filter((_, i) => resolved[i] !== null) };
    }
  );

  /** Streams `abs`; size and bytes come from one handle (see below). */
  async function sendFile(
    reply: FastifyReply,
    sessionId: string,
    abs: string,
    serving: { type: string; disposition: Disposition },
    csp: string | null,
    notFound: () => FastifyReply
  ): Promise<FastifyReply> {
    // Size and bytes come from one open handle: a file deleted or rewritten after the check
    // would otherwise answer 500, or send a Content-Length its stream doesn't match.
    let handle: FileHandle;
    let size: number;
    try {
      handle = await open(abs, 'r');
    } catch {
      return notFound();
    }
    try {
      size = (await handle.stat()).size;
    } catch {
      await handle.close().catch(() => undefined);
      return notFound();
    }

    const name = encodeURIComponent(basename(abs));
    reply
      .header('Content-Type', serving.type)
      .header('Content-Disposition', `${serving.disposition}; filename*=UTF-8''${name}`)
      .header('Content-Length', size)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Cache-Control', 'no-store');
    if (csp) reply.header('Content-Security-Policy', csp);
    logger.info({ sessionId, path: abs, disposition: serving.disposition }, 'Opening a session file');
    // `end` caps the stream at the size sent, should the file grow while it streams.
    return reply.send(handle.createReadStream({ start: 0, end: Math.max(size - 1, 0), autoClose: true }));
  }

  app.get<{ Params: { id: string }; Querystring: { path?: string } }>(
    '/api/sessions/:id/files/open',
    async (request, reply: FastifyReply) => {
      if (!(await authorized(request))) return reply.status(403).send({ error: 'Not authorized' });
      const found = rootsOf(request.params.id);
      const abs =
        found && request.query.path ? await resolveSessionFile(found.roots, request.query.path, undefined, found.bases) : null;
      // One answer for missing and outside: a probe learns nothing about the rest of the disk.
      const notFound = () => reply.status(404).send({ error: 'File not found' });
      if (!abs) return notFound();
      const serving = servingFor(abs);
      // Chrome's PDF viewer refuses to load in a sandboxed document; a PDF runs no script in
      // this origin anyway (the viewer is its own), so only it goes without.
      const csp = serving.type === 'application/pdf' ? null : 'sandbox';
      return sendFile(reply, request.params.id, abs, serving, csp, notFound);
    }
  );

  /**
   * `GET /api/sessions/:id/files/view/<path>`: a page (an `.html` link) shown in place, with
   * the path in the URL's own path so its relative links (`light_oak/living.png`) resolve to
   * sibling files through this same route and the same containment checks. A relative page
   * path is redirected to its absolute form first, so siblings resolve beside the file that
   * was found, never against another root.
   *
   * The page runs as an **opaque origin** (`sandbox allow-scripts`, no `allow-same-origin`):
   * its script can't read this origin's storage or any `/api` answer, and its fetches,
   * images and styles may only reach this session's view tree (`viewCsp`).
   */
  app.get<{ Params: { id: string; '*': string } }>(
    '/api/sessions/:id/files/view/*',
    async (request, reply: FastifyReply) => {
      if (!(await authorized(request))) return reply.status(403).send({ error: 'Not authorized' });
      const notFound = () => reply.status(404).send({ error: 'File not found' });
      const sessionId = request.params.id;
      const raw = request.params['*'] ?? '';
      const host = request.headers.host ?? '';
      if (!VIEW_HOST.test(host)) return reply.status(400).send({ error: 'Bad host' });
      const found = rootsOf(sessionId);
      const abs = found && raw ? await resolveSessionFile(found.roots, raw, undefined, found.bases) : null;
      if (!abs) return notFound();
      const p = cleanLinkText(raw) ?? '';
      if (!isAbsolute(p)) return reply.redirect(viewUrlPath(sessionId, abs), 302);
      const serving = viewServingFor(abs);
      const csp = serving.type === 'application/pdf' ? null : viewCsp(host, sessionId);
      return sendFile(reply, sessionId, abs, serving, csp, notFound);
    }
  );
}

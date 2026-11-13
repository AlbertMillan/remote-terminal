import { open, realpath, stat, type FileHandle } from 'fs/promises';
import { basename, extname, isAbsolute, resolve } from 'path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { extractIpFromRequest, verifyTailscaleConnection } from '../auth/tailscale.js';
import { getSession as getSessionFromDb } from '../db/queries.js';
import { isInside } from '../utils/paths.js';
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

/** The folders a session's links may open files from: its cwd and its uploads (pasted files). */
export function sessionRoots(sessionId: string, cwd: string): string[] {
  return [cwd, uploadDirFor(sessionId, 'uploads'), uploadDirFor(sessionId, 'images')];
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
  realRoots?: string[]
): Promise<string | null> {
  const p = cleanLinkText(raw);
  if (!p || roots.length === 0 || /^[\\/]{2}/.test(p)) return null;
  const abs = isAbsolute(p) ? resolve(p) : resolve(roots[0], p);
  const real = realRoots ?? (await realRootsOf(roots));
  // The real roots count lexically too: a path printed in its resolved form, while the cwd
  // was given through a junction, is still inside.
  if (![...roots, ...real].some((r) => isInside(r, abs))) return null;
  try {
    const target = await realpath(abs);
    if (!(await stat(target)).isFile()) return null;
    return real.some((r) => isInside(r, target)) ? target : null;
  } catch {
    return null; // missing, unreadable, or a dangling link
  }
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

export interface SessionFileDeps {
  verify?: (ip: string) => Promise<unknown>;
  getSession?: (id: string) => { cwd: string } | null;
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

  function rootsOf(id: string): string[] | null {
    if (!isSessionId(id)) return null;
    const session = getSession(id);
    return session?.cwd ? sessionRoots(id, session.cwd) : null;
  }

  app.post<{ Params: { id: string }; Body: { paths?: unknown } }>(
    '/api/sessions/:id/files/check',
    async (request, reply) => {
      if (!(await authorized(request))) return reply.status(403).send({ error: 'Not authorized' });
      const roots = rootsOf(request.params.id);
      if (!roots) return reply.status(404).send({ error: 'Session not found' });
      const paths = request.body?.paths;
      if (!Array.isArray(paths) || paths.length > MAX_CHECK_PATHS || !paths.every((p) => typeof p === 'string')) {
        return reply.status(400).send({ error: `paths: up to ${MAX_CHECK_PATHS} strings` });
      }
      // Asynchronous: this thread also streams every terminal, and a slow drive must not stall them.
      const real = await realRootsOf(roots);
      const resolved = await Promise.all((paths as string[]).map((p) => resolveSessionFile(roots, p, real)));
      return { found: (paths as string[]).filter((_, i) => resolved[i] !== null) };
    }
  );

  app.get<{ Params: { id: string }; Querystring: { path?: string } }>(
    '/api/sessions/:id/files/open',
    async (request, reply: FastifyReply) => {
      if (!(await authorized(request))) return reply.status(403).send({ error: 'Not authorized' });
      const roots = rootsOf(request.params.id);
      const abs = roots && request.query.path ? await resolveSessionFile(roots, request.query.path) : null;
      // One answer for missing and outside: a probe learns nothing about the rest of the disk.
      const notFound = () => reply.status(404).send({ error: 'File not found' });
      if (!abs) return notFound();

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

      const { type, disposition } = servingFor(abs);
      const name = encodeURIComponent(basename(abs));
      reply
        .header('Content-Type', type)
        .header('Content-Disposition', `${disposition}; filename*=UTF-8''${name}`)
        .header('Content-Length', size)
        .header('X-Content-Type-Options', 'nosniff')
        .header('Cache-Control', 'no-store');
      // Chrome's PDF viewer refuses to load in a sandboxed document; a PDF runs no script in
      // this origin anyway (the viewer is its own), so only it goes without.
      if (type !== 'application/pdf') reply.header('Content-Security-Policy', 'sandbox');
      logger.info({ sessionId: request.params.id, path: abs, disposition }, 'Opening a session file');
      // `end` caps the stream at the size sent, should the file grow while it streams.
      return reply.send(handle.createReadStream({ start: 0, end: Math.max(size - 1, 0), autoClose: true }));
    }
  );
}

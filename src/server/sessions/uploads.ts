import { readdirSync, rmSync, statSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { randomUUID } from 'crypto';
import { extname, join } from 'path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { getConfig } from '../config.js';
import { getSession as getSessionFromDb } from '../db/queries.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('uploads');

/**
 * Files dropped, pasted or shared into a session from another device (the web client's drop
 * and paste, the Android app's Attach key and share sheet). Claude Code runs on this PC, so
 * it cannot see a file on the client: the client uploads the file here and pastes the
 * returned path. Claude Code attaches a pasted image path as `[Image #N]`, and Claude opens
 * any other file with its Read tool. → project/file-uploads.md
 *
 * Under the data dir, never the session's cwd: in a worktree the next `commitAll` would
 * sweep the file into the track's branch. One folder per session, removed with it, and
 * swept at boot (`sweepUploads`): a terminated session keeps its row for revive, so without
 * the sweep its files would stay for as long as the row does.
 *
 * Each file gets its own `<stamp>-<uuid8>/` folder so it keeps its own (cleaned) name:
 * Claude reads `spec.pdf` far better than a random one, and two drops of `notes.md` never
 * collide.
 */

/** Phone screenshots and most PDFs fit; this leaves room without letting one request fill a disk. */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/** Uploads older than this are swept at boot, whichever session they belong to. */
export const UPLOAD_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Where uploads live. `images` is the root image pastes used before any file could be
 * uploaded; nothing is written there any more, but it is still swept and deleted, or files
 * pasted before the upgrade would outlive their session.
 */
const ROOTS = ['uploads', 'images'] as const;

export function uploadDirFor(sessionId: string, root: (typeof ROOTS)[number] = 'uploads'): string {
  return join(getConfig().persistence.dataDir, root, sessionId);
}

/** The file type from its signature, never the client's Content-Type; null when not an image Claude reads. */
export function sniffImage(data: Buffer): 'png' | 'jpg' | 'gif' | 'webp' | null {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpg';
  if (data.length >= 6 && /^GIF8[79]a$/.test(data.subarray(0, 6).toString('latin1'))) return 'gif';
  if (data.length >= 12 && data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
const MAX_NAME_CHARS = 100;

/**
 * A client-supplied file name made safe to create on Windows (and anywhere else): the last
 * path segment only, no control characters or `<>:"/\|?*`, no trailing dots or spaces, no
 * reserved device name, at most 100 characters with the extension kept. Never empty.
 */
export function safeFileName(name: string | undefined): string {
  let base = (name ?? '').split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  base = base.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '').replace(/[. ]+$/, '').trim();
  if (!base || /^\.+$/.test(base)) return 'file';
  const ext = extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;
  if (RESERVED.test(stem.split('.')[0] ?? '')) base = `_${base}`;
  if (base.length > MAX_NAME_CHARS) {
    // An extension that alone overruns the cap is not one worth keeping.
    const keep = ext.length < 20 ? ext : '';
    base = base.slice(0, MAX_NAME_CHARS - keep.length).replace(/[. ]+$/, '') + keep;
  }
  return base;
}

/**
 * The name to save under: the cleaned client name, with the extension set from the bytes
 * when they are an image, so Claude Code attaches it as an image whatever it was called.
 */
export function uploadFileName(name: string | undefined, data: Buffer): string {
  const safe = safeFileName(name);
  const image = sniffImage(data);
  if (!image) return safe;
  const ext = extname(safe).toLowerCase();
  const same = ext === `.${image}` || (image === 'jpg' && ext === '.jpeg');
  if (same) return safe;
  return `${ext ? safe.slice(0, -ext.length) : safe === 'file' ? 'image' : safe}.${image}`;
}

/**
 * Writes the file under its own folder in the session's; resolves to its absolute path.
 * Asynchronous: a 20 MB synchronous write would stall every terminal's output.
 */
export async function saveUpload(sessionId: string, data: Buffer, name: string): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = join(uploadDirFor(sessionId), `${stamp}-${randomUUID().slice(0, 8)}`);
  await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  await writeFile(path, data);
  return path;
}

/**
 * Boot sweep, over both roots: removes the folder of every session no longer in the
 * database, then every entry (an upload's folder, or a pre-upgrade image file) older than
 * `maxAgeMs`: an earlier paste was already read by the session it was for. Returns how many
 * session folders and entries it removed. Never throws: a busy file is left for the next boot.
 */
export function sweepUploads(
  sessionIds: Set<string>,
  now = Date.now(),
  maxAgeMs = UPLOAD_MAX_AGE_MS
): { folders: number; files: number } {
  const removed = { folders: 0, files: 0 };
  for (const rootName of ROOTS) {
    const root = join(getConfig().persistence.dataDir, rootName);
    let folders: string[];
    try {
      folders = readdirSync(root);
    } catch {
      continue; // nothing was ever uploaded there
    }
    for (const folder of folders) {
      const dir = join(root, folder);
      try {
        if (!sessionIds.has(folder)) {
          rmSync(dir, { recursive: true, force: true });
          removed.folders++;
          continue;
        }
        for (const entry of readdirSync(dir)) {
          const path = join(dir, entry);
          if (now - statSync(path).mtimeMs > maxAgeMs) {
            rmSync(path, { recursive: true, force: true });
            removed.files++;
          }
        }
      } catch (err) {
        logger.warn({ folder, err: (err as Error).message }, 'Could not sweep uploads');
      }
    }
  }
  if (removed.folders || removed.files) logger.info(removed, 'Swept uploads');
  return removed;
}

export function deleteUploads(sessionId: string): void {
  // Ids are server-generated UUIDs, but never let one walk out of its root.
  if (!/^[\w-]+$/.test(sessionId)) return;
  for (const root of ROOTS) {
    try {
      rmSync(uploadDirFor(sessionId, root), { recursive: true, force: true });
    } catch {
      /* most sessions never had one */
    }
  }
}

async function receive(
  sessionId: string,
  body: unknown,
  name: string | undefined,
  reply: FastifyReply,
  imagesOnly: boolean
): Promise<unknown> {
  if (!/^[\w-]+$/.test(sessionId) || !getSessionFromDb(sessionId)) return reply.status(404).send({ error: 'Session not found' });
  if (!Buffer.isBuffer(body) || body.length === 0) return reply.status(400).send({ error: 'Send the file as the body' });
  if (imagesOnly && !sniffImage(body)) return reply.status(415).send({ error: 'Not a PNG, JPEG, GIF or WebP image' });
  const fileName = uploadFileName(name, body);
  const path = await saveUpload(sessionId, body, fileName);
  logger.info({ sessionId, bytes: body.length, name: fileName }, 'Saved an upload');
  return { path };
}

/**
 * `POST /api/sessions/:id/files?name=<file name>`, the raw bytes as the body, any
 * Content-Type. Answers `{ path }`, for the client to paste. `POST …/images` is the route
 * image pastes used first; it stays, images only, for Android builds already installed.
 * Its own plugin scope, so the catch-all binary body parser applies to these routes only.
 */
export function registerUploadRoutes(app: FastifyInstance): void {
  void app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: MAX_UPLOAD_BYTES }, (_req, body, done) => done(null, body));
    scope.post<{ Params: { id: string }; Querystring: { name?: string }; Body: Buffer }>(
      '/api/sessions/:id/files',
      { bodyLimit: MAX_UPLOAD_BYTES },
      async (request, reply) => receive(request.params.id, request.body, request.query.name, reply, false)
    );
    scope.post<{ Params: { id: string }; Body: Buffer }>(
      '/api/sessions/:id/images',
      { bodyLimit: MAX_UPLOAD_BYTES },
      async (request, reply) => receive(request.params.id, request.body, undefined, reply, true)
    );
  });
}

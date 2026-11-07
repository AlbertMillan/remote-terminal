import { readdirSync, rmSync, statSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { randomUUID } from 'crypto';
import { join } from 'path';
import type { FastifyInstance } from 'fastify';
import { getConfig } from '../config.js';
import { getSession as getSessionFromDb } from '../db/queries.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('pasted-images');

/**
 * Images pasted or shared into a session from another device (the web client's paste, the
 * Android app's Image key and share sheet). Claude Code reads an image from the clipboard
 * of the machine it runs on, which a remote client cannot reach, so the client uploads the
 * image here and pastes the returned path: Claude Code attaches a pasted image path as
 * `[Image #N]`.
 *
 * Under the data dir, never the session's cwd: in a worktree the next `commitAll` would
 * sweep the image into the track's branch. One folder per session, removed with it, and
 * swept at boot (`sweepPastedImages`): a terminated session keeps its row for revive, so
 * without the sweep its images would stay for as long as the row does.
 */

/** Phone screenshots are a few MB; this leaves room without letting one request fill a disk. */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export function imageDirFor(sessionId: string): string {
  return join(getConfig().persistence.dataDir, 'images', sessionId);
}

/** The file type from its signature, never the client's Content-Type; null when not an image Claude reads. */
export function sniffImage(data: Buffer): 'png' | 'jpg' | 'gif' | 'webp' | null {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpg';
  if (data.length >= 6 && /^GIF8[79]a$/.test(data.subarray(0, 6).toString('latin1'))) return 'gif';
  if (data.length >= 12 && data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

/** Images older than this are swept at boot, whichever session they belong to. */
export const IMAGE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Writes the image under the session's folder with a server-chosen name; resolves to its
 * absolute path. Asynchronous: a 20 MB synchronous write would stall every terminal's output.
 */
export async function savePastedImage(sessionId: string, data: Buffer, ext: string): Promise<string> {
  const dir = imageDirFor(sessionId);
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const path = join(dir, `${stamp}-${randomUUID().slice(0, 8)}.${ext}`);
  await writeFile(path, data);
  return path;
}

/**
 * Boot sweep: removes the folder of every session no longer in the database, then every
 * image older than `maxAgeMs` (an earlier paste was already read by the session it was for).
 * Returns how many folders and files it removed. Never throws: a busy file is left for
 * the next boot.
 */
export function sweepPastedImages(
  sessionIds: Set<string>,
  now = Date.now(),
  maxAgeMs = IMAGE_MAX_AGE_MS
): { folders: number; files: number } {
  const root = join(getConfig().persistence.dataDir, 'images');
  const removed = { folders: 0, files: 0 };
  let folders: string[];
  try {
    folders = readdirSync(root);
  } catch {
    return removed; // no image was ever pasted
  }
  for (const folder of folders) {
    const dir = join(root, folder);
    try {
      if (!sessionIds.has(folder)) {
        rmSync(dir, { recursive: true, force: true });
        removed.folders++;
        continue;
      }
      for (const file of readdirSync(dir)) {
        const path = join(dir, file);
        if (now - statSync(path).mtimeMs > maxAgeMs) {
          rmSync(path, { force: true });
          removed.files++;
        }
      }
    } catch (err) {
      logger.warn({ folder, err: (err as Error).message }, 'Could not sweep pasted images');
    }
  }
  if (removed.folders || removed.files) logger.info(removed, 'Swept pasted images');
  return removed;
}

export function deletePastedImages(sessionId: string): void {
  // Ids are server-generated UUIDs, but never let one walk out of images/.
  if (!/^[\w-]+$/.test(sessionId)) return;
  try {
    rmSync(imageDirFor(sessionId), { recursive: true, force: true });
  } catch {
    /* most sessions never had one */
  }
}

/**
 * `POST /api/sessions/:id/images`, the raw image bytes as the body (`Content-Type: image/*`).
 * Answers `{ path }`, for the client to paste. Its own plugin scope, so the binary body
 * parser applies to this route only.
 */
export function registerPastedImageRoutes(app: FastifyInstance): void {
  void app.register(async (scope) => {
    scope.addContentTypeParser(/^image\//, { parseAs: 'buffer', bodyLimit: MAX_IMAGE_BYTES }, (_req, body, done) =>
      done(null, body)
    );
    scope.post<{ Params: { id: string }; Body: Buffer }>(
      '/api/sessions/:id/images',
      { bodyLimit: MAX_IMAGE_BYTES },
      async (request, reply) => {
        const { id } = request.params;
        if (!/^[\w-]+$/.test(id) || !getSessionFromDb(id)) return reply.status(404).send({ error: 'Session not found' });
        const body = request.body;
        if (!Buffer.isBuffer(body) || body.length === 0) return reply.status(400).send({ error: 'Send the image as the body' });
        const ext = sniffImage(body);
        if (!ext) return reply.status(415).send({ error: 'Not a PNG, JPEG, GIF or WebP image' });
        const path = await savePastedImage(id, body, ext);
        logger.info({ sessionId: id, bytes: body.length, ext }, 'Saved a pasted image');
        return { path };
      }
    );
  });
}

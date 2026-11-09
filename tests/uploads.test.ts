import { describe, it, expect, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'fs';
import { basename, dirname, join } from 'path';
import Fastify from 'fastify';

// The first Fastify app here is built cold; parallel suites pushed that past 5 s elsewhere.
vi.setConfig({ testTimeout: 30_000 });

const { dataDir } = await vi.hoisted(async () => {
  const { makeTmpDataDir } = await import('./helpers/tmp-data-dir.js');
  return { dataDir: makeTmpDataDir('uploads') };
});

vi.mock('../src/server/config.js', () => ({
  getConfig: () => ({ persistence: { dataDir } }),
}));
vi.mock('../src/server/utils/logger.js', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));
vi.mock('../src/server/db/queries.js', () => ({
  getSession: (id: string) => (id === 'sess-1' ? { id } : undefined),
}));

const { registerUploadRoutes, sniffImage, safeFileName, uploadFileName, deleteUploads, uploadDirFor, sweepUploads, UPLOAD_MAX_AGE_MS, MAX_UPLOAD_BYTES } =
  await import('../src/server/sessions/uploads.js');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 7)]);
const PDF = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n');

async function app() {
  const a = Fastify({ logger: false });
  registerUploadRoutes(a);
  // A JSON route beside it: the catch-all parser must not leak out of its scope.
  a.post('/api/echo', async (request) => request.body);
  await a.ready();
  return a;
}

type App = Awaited<ReturnType<typeof app>>;

function postFile(a: App, id: string, body: Buffer, name?: string, type = 'application/octet-stream') {
  const query = name === undefined ? '' : `?name=${encodeURIComponent(name)}`;
  return a.inject({ method: 'POST', url: `/api/sessions/${id}/files${query}`, headers: { 'content-type': type }, payload: body });
}

function postImage(a: App, id: string, body: Buffer, type = 'image/png') {
  return a.inject({ method: 'POST', url: `/api/sessions/${id}/images`, headers: { 'content-type': type }, payload: body });
}

describe('uploads', () => {
  it('saves any file under its own name, in its own folder in the session folder, and answers the path', async () => {
    const a = await app();
    const res = await postFile(a, 'sess-1', PDF, 'Q3 spec.pdf', 'application/pdf');
    expect(res.statusCode).toBe(200);
    const { path } = res.json() as { path: string };
    expect(basename(path)).toBe('Q3 spec.pdf');
    expect(dirname(dirname(path))).toBe(uploadDirFor('sess-1'));
    expect(readFileSync(path).equals(PDF)).toBe(true);

    const md = await postFile(a, 'sess-1', Buffer.from('# Notes\n'), 'notes.md', 'text/markdown');
    expect(basename((md.json() as { path: string }).path)).toBe('notes.md');
    await a.close();
  });

  it('keeps two uploads of the same name apart', async () => {
    const a = await app();
    const one = (await postFile(a, 'sess-1', PDF, 'a.pdf')).json() as { path: string };
    const two = (await postFile(a, 'sess-1', PDF, 'a.pdf')).json() as { path: string };
    expect(one.path).not.toBe(two.path);
    await a.close();
  });

  it('names an image from its bytes, so Claude Code attaches it as one', async () => {
    const a = await app();
    const shot = (await postFile(a, 'sess-1', PNG, 'Screenshot.png', 'image/png')).json() as { path: string };
    expect(basename(shot.path)).toBe('Screenshot.png');
    const misnamed = (await postFile(a, 'sess-1', PNG, 'photo.jpg')).json() as { path: string };
    expect(basename(misnamed.path)).toBe('photo.png');
    const unnamed = (await postFile(a, 'sess-1', PNG)).json() as { path: string };
    expect(basename(unnamed.path)).toBe('image.png');
    await a.close();
  });

  it('refuses an unknown session, an empty body and an oversized one', async () => {
    const a = await app();
    expect((await postFile(a, 'nope', PDF, 'a.pdf')).statusCode).toBe(404);
    expect((await postFile(a, '..%2F..%2Fetc', PDF, 'a.pdf')).statusCode).toBe(404);
    expect((await postFile(a, 'sess-1', Buffer.alloc(0), 'a.pdf')).statusCode).toBe(400);
    expect((await postFile(a, 'sess-1', Buffer.alloc(MAX_UPLOAD_BYTES + 1), 'big.bin')).statusCode).toBe(413);
    await a.close();
  });

  it('never writes outside its folder, whatever the name says', async () => {
    const a = await app();
    const res = (await postFile(a, 'sess-1', PDF, '..\\..\\..\\evil.pdf')).json() as { path: string };
    expect(basename(res.path)).toBe('evil.pdf');
    expect(dirname(dirname(res.path))).toBe(uploadDirFor('sess-1'));
    await a.close();
  });

  it('keeps the images route, images only, for app builds already installed', async () => {
    const a = await app();
    const res = await postImage(a, 'sess-1', PNG);
    expect(res.statusCode).toBe(200);
    expect(basename((res.json() as { path: string }).path)).toBe('image.png');
    expect((await postImage(a, 'sess-1', Buffer.from('<svg></svg>'), 'image/svg+xml')).statusCode).toBe(415);
    expect((await postImage(a, 'nope', PNG)).statusCode).toBe(404);
    await a.close();
  });

  it('leaves JSON routes alone', async () => {
    const a = await app();
    const res = await a.inject({ method: 'POST', url: '/api/echo', payload: { a: 1 } });
    expect(res.json()).toEqual({ a: 1 });
    await a.close();
  });

  it('sniffs each image type Claude reads', () => {
    expect(sniffImage(PNG)).toBe('png');
    expect(sniffImage(Buffer.from('GIF89a....'))).toBe('gif');
    expect(sniffImage(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('webp');
    expect(sniffImage(PDF)).toBeNull();
  });

  it('cleans a client file name into one Windows can create', () => {
    expect(safeFileName('spec.pdf')).toBe('spec.pdf');
    expect(safeFileName('C:\\Users\\x\\Downloads\\spec.pdf')).toBe('spec.pdf');
    expect(safeFileName('../../etc/passwd')).toBe('passwd');
    expect(safeFileName('a<b>c:d"e|f?g*h.txt')).toBe('abcdefgh.txt');
    expect(safeFileName('tab\there.md')).toBe('tabhere.md');
    expect(safeFileName('notes.md. . ')).toBe('notes.md');
    expect(safeFileName('CON.txt')).toBe('_CON.txt');
    expect(safeFileName('nul')).toBe('_nul');
    expect(safeFileName('console.log')).toBe('console.log');
    expect(safeFileName('')).toBe('file');
    expect(safeFileName(undefined)).toBe('file');
    expect(safeFileName('..')).toBe('file');
    const long = safeFileName(`${'x'.repeat(300)}.pdf`);
    expect(long).toHaveLength(100);
    expect(long.endsWith('.pdf')).toBe(true);
  });

  it('keeps a matching image extension, .jpeg included', () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    expect(uploadFileName('IMG_1.jpeg', jpeg)).toBe('IMG_1.jpeg');
    expect(uploadFileName('IMG_1.JPG', jpeg)).toBe('IMG_1.JPG');
    expect(uploadFileName('scan', jpeg)).toBe('scan.jpg');
    expect(uploadFileName('notes.md', Buffer.from('# hi'))).toBe('notes.md');
  });

  it('deletes the session folder in both roots, and never one outside them', async () => {
    const a = await app();
    await postFile(a, 'sess-1', PDF, 'a.pdf');
    mkdirSync(uploadDirFor('sess-1', 'images'), { recursive: true });
    writeFileSync(join(uploadDirFor('sess-1', 'images'), 'old.png'), PNG);
    deleteUploads('../');
    expect(existsSync(join(dataDir, 'uploads'))).toBe(true);
    deleteUploads('sess-1');
    expect(existsSync(uploadDirFor('sess-1'))).toBe(false);
    expect(existsSync(uploadDirFor('sess-1', 'images'))).toBe(false);
    await a.close();
  });

  it('sweeps at boot, in both roots: folders of sessions gone from the database, and uploads past the age limit', () => {
    const age = (path: string, ageMs: number) => {
      const when = (Date.now() - ageMs) / 1000;
      utimesSync(path, when, when);
      return path;
    };
    const upload = (session: string, folder: string, ageMs: number) => {
      const dir = join(uploadDirFor(session), folder);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'spec.pdf'), PDF);
      return age(dir, ageMs);
    };
    const oldImage = (session: string, file: string, ageMs: number) => {
      mkdirSync(uploadDirFor(session, 'images'), { recursive: true });
      const path = join(uploadDirFor(session, 'images'), file);
      writeFileSync(path, PNG);
      return age(path, ageMs);
    };
    const fresh = upload('kept', 'fresh', 1000);
    const stale = upload('kept', 'stale', UPLOAD_MAX_AGE_MS + 60_000);
    const freshImage = oldImage('kept', 'fresh.png', 1000);
    const staleImage = oldImage('kept', 'stale.png', UPLOAD_MAX_AGE_MS + 60_000);
    upload('gone', 'any', 1000);
    oldImage('gone-too', 'any.png', 1000);

    expect(sweepUploads(new Set(['kept', 'sess-1']))).toEqual({ folders: 2, files: 2 });
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(freshImage)).toBe(true);
    expect(existsSync(staleImage)).toBe(false);
    expect(existsSync(uploadDirFor('gone'))).toBe(false);
    expect(existsSync(uploadDirFor('gone-too', 'images'))).toBe(false);
  });
});

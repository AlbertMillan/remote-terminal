import { describe, it, expect, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import Fastify from 'fastify';

// The first Fastify app here is built cold; parallel suites pushed that past 5 s elsewhere.
vi.setConfig({ testTimeout: 30_000 });

const { dataDir } = await vi.hoisted(async () => {
  const { makeTmpDataDir } = await import('./helpers/tmp-data-dir.js');
  return { dataDir: makeTmpDataDir('pasted-images') };
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

const { registerPastedImageRoutes, sniffImage, deletePastedImages, imageDirFor, sweepPastedImages, IMAGE_MAX_AGE_MS, MAX_IMAGE_BYTES } = await import(
  '../src/server/sessions/pasted-images.js'
);

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 7)]);

async function app() {
  const a = Fastify({ logger: false });
  registerPastedImageRoutes(a);
  // A JSON route beside it: the image parser must not leak out of its scope.
  a.post('/api/echo', async (request) => request.body);
  await a.ready();
  return a;
}

function post(a: Awaited<ReturnType<typeof app>>, id: string, body: Buffer, type = 'image/png') {
  return a.inject({ method: 'POST', url: `/api/sessions/${id}/images`, headers: { 'content-type': type }, payload: body });
}

describe('pasted images', () => {
  it('saves the bytes under the data dir, in the session folder, and answers the path', async () => {
    const a = await app();
    const res = await post(a, 'sess-1', PNG);
    expect(res.statusCode).toBe(200);
    const { path } = res.json() as { path: string };
    expect(dirname(path)).toBe(join(dataDir, 'images', 'sess-1'));
    expect(path.endsWith('.png')).toBe(true);
    expect(readFileSync(path).equals(PNG)).toBe(true);
    await a.close();
  });

  it('names the type from the signature, not the Content-Type', async () => {
    const a = await app();
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    const res = await post(a, 'sess-1', jpeg, 'image/png');
    expect((res.json() as { path: string }).path.endsWith('.jpg')).toBe(true);
    await a.close();
  });

  it('refuses a body that is not an image, an unknown session and an oversized body', async () => {
    const a = await app();
    expect((await post(a, 'sess-1', Buffer.from('<svg></svg>'), 'image/svg+xml')).statusCode).toBe(415);
    expect((await post(a, 'nope', PNG)).statusCode).toBe(404);
    expect((await post(a, '..%2F..%2Fetc', PNG)).statusCode).toBe(404);
    expect((await post(a, 'sess-1', Buffer.alloc(MAX_IMAGE_BYTES + 1))).statusCode).toBe(413);
    await a.close();
  });

  it('leaves JSON routes alone', async () => {
    const a = await app();
    const res = await a.inject({ method: 'POST', url: '/api/echo', payload: { a: 1 } });
    expect(res.json()).toEqual({ a: 1 });
    await a.close();
  });

  it('sniffs each type Claude reads', () => {
    expect(sniffImage(PNG)).toBe('png');
    expect(sniffImage(Buffer.from('GIF89a....'))).toBe('gif');
    expect(sniffImage(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('webp');
    expect(sniffImage(Buffer.from('hello world!'))).toBeNull();
  });

  it('deletes the session folder, and never one outside images/', async () => {
    const a = await app();
    await post(a, 'sess-1', PNG);
    expect(existsSync(imageDirFor('sess-1'))).toBe(true);
    deletePastedImages('../');
    expect(existsSync(join(dataDir, 'images'))).toBe(true);
    deletePastedImages('sess-1');
    expect(existsSync(imageDirFor('sess-1'))).toBe(false);
    await a.close();
  });

  it('sweeps at boot: folders of sessions gone from the database, and images past the age limit', () => {
    const write = (session: string, file: string, ageMs: number) => {
      mkdirSync(imageDirFor(session), { recursive: true });
      const path = join(imageDirFor(session), file);
      writeFileSync(path, PNG);
      const when = (Date.now() - ageMs) / 1000;
      utimesSync(path, when, when);
      return path;
    };
    const fresh = write('kept', 'fresh.png', 1000);
    const stale = write('kept', 'stale.png', IMAGE_MAX_AGE_MS + 60_000);
    write('gone', 'any.png', 1000);

    expect(sweepPastedImages(new Set(['kept']))).toEqual({ folders: 1, files: 1 });
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(imageDirFor('gone'))).toBe(false);
  });
});

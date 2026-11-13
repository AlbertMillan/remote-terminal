import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify from 'fastify';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { realpath as realpathSpy } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  cleanLinkText,
  registerSessionFileRoutes,
  resolveSessionFile,
  servingFor,
} from '../src/server/sessions/session-files.js';

// A spy on realpath, to prove an outside path never reaches the filesystem.
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return { ...actual, realpath: vi.fn(actual.realpath) };
});

/**
 * A path printed in a terminal opens a file from the server's disk, reachable from the
 * tailnet: it must never resolve outside the session's folders. → project/clickable-file-paths.md
 */

let dir: string;
let cwd: string;
let uploads: string;
let outside: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cr-session-files-'));
  cwd = join(dir, 'project');
  uploads = join(dir, 'uploads');
  outside = join(dir, 'secret');
  mkdirSync(join(cwd, 'refs', 'brief'), { recursive: true });
  mkdirSync(uploads);
  mkdirSync(outside);
  writeFileSync(join(cwd, 'NUANCES.md'), '# nuances');
  writeFileSync(join(cwd, 'refs', 'brief', 'Reinhardt.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync(join(cwd, 'page.html'), '<script>fetch("/api/x")</script>');
  writeFileSync(join(uploads, 'shot.png'), 'png');
  writeFileSync(join(outside, 'key.txt'), 'secret');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('cleanLinkText', () => {
  it('drops quotes, brackets, locations and trailing punctuation', () => {
    expect(cleanLinkText('`NUANCES.md`')).toBe('NUANCES.md');
    expect(cleanLinkText('(refs/brief/Reinhardt.png).')).toBe('refs/brief/Reinhardt.png');
    expect(cleanLinkText('src/app.ts:12:3')).toBe('src/app.ts');
    expect(cleanLinkText('src/app.ts:12')).toBe('src/app.ts');
    expect(cleanLinkText('main.cpp(10,4)')).toBe('main.cpp');
    expect(cleanLinkText('C:\\x\\a.md,')).toBe('C:\\x\\a.md');
  });

  it('refuses empty, overlong and NUL text', () => {
    expect(cleanLinkText('  ')).toBeNull();
    expect(cleanLinkText('a'.repeat(2000))).toBeNull();
    expect(cleanLinkText('a\0b.md')).toBeNull();
  });
});

describe('resolveSessionFile', () => {
  const roots = () => [cwd, uploads];

  it('resolves relative paths against the cwd', async () => {
    expect(await resolveSessionFile(roots(), 'NUANCES.md')).toMatch(/NUANCES\.md$/);
    expect(await resolveSessionFile(roots(), 'refs/brief/Reinhardt.png:4')).toMatch(/Reinhardt\.png$/);
    expect(await resolveSessionFile(roots(), 'refs\\brief\\Reinhardt.png')).toMatch(/Reinhardt\.png$/);
  });

  it('takes absolute paths inside any root, the uploads folder included', async () => {
    expect(await resolveSessionFile(roots(), join(cwd, 'NUANCES.md'))).not.toBeNull();
    expect(await resolveSessionFile(roots(), join(uploads, 'shot.png'))).not.toBeNull();
  });

  it('refuses anything outside the roots', async () => {
    expect(await resolveSessionFile(roots(), join(outside, 'key.txt'))).toBeNull();
    expect(await resolveSessionFile(roots(), '../secret/key.txt')).toBeNull();
  });

  it('refuses a link inside the cwd that points outside', async () => {
    symlinkSync(outside, join(cwd, 'escape'), 'junction');
    expect(await resolveSessionFile(roots(), 'escape/key.txt')).toBeNull();
  });

  it('refuses UNC and device paths before touching the filesystem', async () => {
    // Reaching realpath, a UNC path would open SMB to that host and offer NTLM credentials.
    vi.mocked(realpathSpy).mockClear();
    for (const p of ['\\\\evil.example\\share\\x.png', '//evil.example/share/x.png', '\\\\?\\C:\\x.md', '\\\\.\\pipe\\x.md']) {
      expect(await resolveSessionFile(roots(), p, [cwd, uploads])).toBeNull();
    }
    expect(await resolveSessionFile(roots(), join(outside, 'key.txt'), [cwd, uploads])).toBeNull();
    expect(realpathSpy).not.toHaveBeenCalled();
  });

  it('takes a path printed in its resolved form when the cwd was given through a link', async () => {
    const alias = join(dir, 'alias');
    symlinkSync(cwd, alias, 'junction');
    expect(await resolveSessionFile([alias], join(cwd, 'NUANCES.md'))).not.toBeNull();
  });

  it('refuses folders and missing files', async () => {
    expect(await resolveSessionFile(roots(), 'refs/brief')).toBeNull();
    expect(await resolveSessionFile(roots(), 'missing.md')).toBeNull();
  });

  it('works when the cwd is itself reached through a link', async () => {
    const alias = join(dir, 'alias');
    symlinkSync(cwd, alias, 'junction');
    expect(await resolveSessionFile([alias], 'NUANCES.md')).not.toBeNull();
  });
});

describe('servingFor', () => {
  it('shows media and text in the tab, downloads the rest', () => {
    expect(servingFor('a.PNG')).toEqual({ type: 'image/png', disposition: 'inline' });
    expect(servingFor('a.pdf').disposition).toBe('inline');
    expect(servingFor('a.md')).toEqual({ type: 'text/plain; charset=utf-8', disposition: 'inline' });
    expect(servingFor('a.zip').disposition).toBe('attachment');
  });

  it('never shows html or svg inline: script in them would run as this origin', () => {
    expect(servingFor('a.html').disposition).toBe('attachment');
    expect(servingFor('a.htm').disposition).toBe('attachment');
    expect(servingFor('a.svg').disposition).toBe('attachment');
  });
});

describe('routes', () => {
  async function appWith(verify: (ip: string) => Promise<unknown> = async () => ({ userId: 'me' })) {
    const app = Fastify();
    registerSessionFileRoutes(app, {
      verify,
      getSession: (id) => (id === 's1' ? { cwd } : null),
    });
    await app.ready();
    return app;
  }

  it('answers which paths are files', async () => {
    const app = await appWith();
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/s1/files/check',
      payload: { paths: ['NUANCES.md', 'missing.md', join(outside, 'key.txt'), 'refs/brief/Reinhardt.png'] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ found: ['NUANCES.md', 'refs/brief/Reinhardt.png'] });
  });

  it('caps the batch and checks its shape', async () => {
    const app = await appWith();
    const many = await app.inject({
      method: 'POST',
      url: '/api/sessions/s1/files/check',
      payload: { paths: Array.from({ length: 51 }, (_, i) => `${i}.md`) },
    });
    expect(many.statusCode).toBe(400);
    const bad = await app.inject({ method: 'POST', url: '/api/sessions/s1/files/check', payload: { paths: [1] } });
    expect(bad.statusCode).toBe(400);
  });

  it('refuses an unverified caller on both routes', async () => {
    const app = await appWith(async () => null);
    const check = await app.inject({ method: 'POST', url: '/api/sessions/s1/files/check', payload: { paths: [] } });
    const open = await app.inject({ method: 'GET', url: '/api/sessions/s1/files/open?path=NUANCES.md' });
    expect(check.statusCode).toBe(403);
    expect(open.statusCode).toBe(403);
  });

  it('asks Tailscale once a minute per caller, not per request', async () => {
    let t = 0;
    const verify = vi.fn(async () => ({ userId: 'me' }));
    const app = Fastify();
    registerSessionFileRoutes(app, { verify, getSession: () => ({ cwd }), now: () => t });
    await app.ready();
    const check = () => app.inject({ method: 'POST', url: '/api/sessions/s1/files/check', payload: { paths: [] } });
    await check();
    await check();
    expect(verify).toHaveBeenCalledTimes(1);
    t = 61_000;
    await check();
    expect(verify).toHaveBeenCalledTimes(2);
  });

  it('serves a PDF without the sandbox, which would blank the viewer', async () => {
    writeFileSync(join(cwd, 'doc.pdf'), '%PDF-1.4');
    const res = await (await appWith()).inject({ method: 'GET', url: '/api/sessions/s1/files/open?path=doc.pdf' });
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-security-policy']).toBeUndefined();
    expect(res.headers['content-length']).toBe('8');
  });

  it('404s an unknown session', async () => {
    const app = await appWith();
    const res = await app.inject({ method: 'POST', url: '/api/sessions/nope/files/check', payload: { paths: [] } });
    expect(res.statusCode).toBe(404);
  });

  it('serves an image inline, sandboxed', async () => {
    const app = await appWith();
    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/s1/files/open?path=${encodeURIComponent('refs/brief/Reinhardt.png')}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['content-disposition']).toBe("inline; filename*=UTF-8''Reinhardt.png");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBe('sandbox');
    expect(res.rawPayload.length).toBe(4);
  });

  it('downloads html instead of rendering it', async () => {
    const app = await appWith();
    const res = await app.inject({ method: 'GET', url: '/api/sessions/s1/files/open?path=page.html' });
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.headers['content-disposition']).toMatch(/^attachment;/);
  });

  it('gives one answer for missing and outside', async () => {
    const app = await appWith();
    const missing = await app.inject({ method: 'GET', url: '/api/sessions/s1/files/open?path=missing.md' });
    const escaped = await app.inject({
      method: 'GET',
      url: `/api/sessions/s1/files/open?path=${encodeURIComponent(join(outside, 'key.txt'))}`,
    });
    expect(missing.statusCode).toBe(404);
    expect(escaped.statusCode).toBe(404);
    expect(escaped.body).toBe(missing.body);
  });
});

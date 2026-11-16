import { describe, it, expect, vi } from 'vitest';
import { fileOpenUrl, findPathCandidates, readLogicalLine, registerFileLinks, type LinkHost } from '../src/client/file-links.js';

/** Paths in terminal text become links only when the server says they are files. */

const texts = (line: string) => findPathCandidates(line).map((c) => c.text);

describe('findPathCandidates', () => {
  it('finds the paths in the screenshot', () => {
    expect(texts('The reviewer judged against NUANCES.md, which the builder wrote.')).toEqual(['NUANCES.md']);
    expect(texts('Put lineup.png next to refs/brief/Reinhardt.png and the gap is large.')).toEqual([
      'lineup.png',
      'refs/brief/Reinhardt.png',
    ]);
    expect(texts('(Meshy or Tripo, as in docs/ai-gamedev-pipeline.md) rather')).toEqual(['docs/ai-gamedev-pipeline.md']);
  });

  it('keeps Windows paths and line locations', () => {
    expect(texts('at C:\\Users\\me\\proj\\src\\app.ts:12:3 failed')).toEqual(['C:\\Users\\me\\proj\\src\\app.ts:12:3']);
    expect(texts('src/server/app.ts:40')).toEqual(['src/server/app.ts:40']);
  });

  it('reports where each one starts', () => {
    expect(findPathCandidates('see a/b.md')).toEqual([{ text: 'a/b.md', index: 4 }]);
  });

  it('skips URLs, versions and words without an extension', () => {
    expect(texts('docs at https://example.com/guide.html today')).toEqual([]);
    expect(texts('Claude Code 2.1.323 and node 22.12')).toEqual([]);
    expect(texts('the src/server folder')).toEqual([]);
    // `~` is never expanded by the server, so it is not part of a path here.
    expect(texts('~/.claude/settings.json')).toEqual([]);
  });

  it('caps the candidates per line', () => {
    expect(findPathCandidates(Array.from({ length: 30 }, (_, i) => `f${i}.md`).join(' '))).toHaveLength(10);
  });
});

/** A fake xterm buffer: one string per row, `wrapped` rows continuing the one before. */
function bufferOf(rows: { text: string; wrapped?: boolean }[], cols = 20) {
  return {
    length: rows.length,
    getLine(y: number) {
      const row = rows[y];
      if (!row) return undefined;
      const padded = row.text.padEnd(cols, ' ');
      return {
        isWrapped: !!row.wrapped,
        length: cols,
        getCell: (x: number) => ({ getChars: () => padded[x] ?? '', getWidth: () => 1 }),
      };
    },
  };
}

describe('readLogicalLine', () => {
  it('joins wrapped rows into one line, cells mapped back', () => {
    const buffer = bufferOf([{ text: 'see refs/brief/Reinh' }, { text: 'ardt.png ok', wrapped: true }]);
    const { text, cells } = readLogicalLine(buffer, 1);
    expect(text.trimEnd()).toBe('see refs/brief/Reinhardt.png ok');
    expect(cells[24]).toEqual({ x: 4, y: 1, width: 1 });
  });
});

describe('registerFileLinks', () => {
  function hostFor(rows: { text: string; wrapped?: boolean }[]) {
    let provider: Parameters<LinkHost['registerLinkProvider']>[0] | null = null;
    const host: LinkHost = {
      buffer: { active: bufferOf(rows) },
      registerLinkProvider: (p) => {
        provider = p;
        return { dispose: () => undefined };
      },
    };
    const linksAt = (y: number) =>
      new Promise<{ text: string; range: unknown }[] | undefined>((done) => provider!.provideLinks(y, done));
    return { host, linksAt };
  }

  it('links only what the server found, spanning a wrapped path', async () => {
    const { host, linksAt } = hostFor([{ text: 'see refs/brief/Reinh' }, { text: 'ardt.png ok.md', wrapped: true }]);
    const check = vi.fn(async (_id: string, paths: string[]) => paths.filter((p) => p.endsWith('.png')));
    registerFileLinks(host, { sessionId: () => 's1', check });

    const links = await linksAt(2);
    expect(links?.map((l) => l.text)).toEqual(['refs/brief/Reinhardt.png']);
    expect(links?.[0].range).toEqual({ start: { x: 5, y: 1 }, end: { x: 8, y: 2 } });
  });

  it('asks the server once per path while the answer is fresh', async () => {
    const { host, linksAt } = hostFor([{ text: 'a.md' }]);
    const check = vi.fn(async () => ['a.md']);
    let t = 0;
    registerFileLinks(host, { sessionId: () => 's1', check, now: () => t });
    await linksAt(1);
    await linksAt(1);
    expect(check).toHaveBeenCalledTimes(1);
    t = 31_000;
    await linksAt(1);
    expect(check).toHaveBeenCalledTimes(2);
  });

  it('opens the path as printed on click', async () => {
    const { host, linksAt } = hostFor([{ text: 'x a.md:3' }]);
    const open = vi.fn();
    registerFileLinks(host, { sessionId: () => 's1', check: async (_i, p) => p, open });
    const links = (await linksAt(1)) as unknown as { activate: (e: { preventDefault(): void }, t: string) => void }[];
    links[0].activate({ preventDefault: () => undefined }, 'a.md:3');
    expect(open).toHaveBeenCalledWith('s1', 'a.md:3');
  });

  it('makes no links, and no request, without a session', async () => {
    const { host, linksAt } = hostFor([{ text: 'a.md' }]);
    const check = vi.fn(async () => ['a.md']);
    registerFileLinks(host, { sessionId: () => null, check });
    expect(await linksAt(1)).toBeUndefined();
    expect(check).not.toHaveBeenCalled();
  });

  it('shares one request between lines asking about the same path at once', async () => {
    const { host, linksAt } = hostFor([{ text: 'a.md' }, { text: 'see a.md' }]);
    const check = vi.fn(async () => ['a.md']);
    registerFileLinks(host, { sessionId: () => 's1', check });
    const [one, two] = await Promise.all([linksAt(1), linksAt(2)]);
    expect(check).toHaveBeenCalledTimes(1);
    expect(one?.map((l) => l.text)).toEqual(['a.md']);
    expect(two?.map((l) => l.text)).toEqual(['a.md']);
  });

  it('drops an answer that lands after the session changed', async () => {
    const { host, linksAt } = hostFor([{ text: 'a.md' }]);
    let current = 's1';
    registerFileLinks(host, {
      sessionId: () => current,
      check: async (_id, paths) => {
        current = 's2'; // the PiP window switched while the check was in flight
        return paths;
      },
    });
    expect(await linksAt(1)).toBeUndefined();
  });

  it('makes no links when the check fails', async () => {
    const { host, linksAt } = hostFor([{ text: 'a.md' }]);
    registerFileLinks(host, { sessionId: () => 's1', check: async () => Promise.reject(new Error('down')) });
    expect(await linksAt(1)).toBeUndefined();
  });
});

describe('fileOpenUrl', () => {
  it('opens a page on the view route, its path in the URL path so relative links resolve', () => {
    expect(fileOpenUrl('s1', 'render/out/A3 zone/index.html')).toBe('/api/sessions/s1/files/view/render/out/A3%20zone/index.html');
    expect(fileOpenUrl('s1', String.raw`C:\work\site\page.HTM:12`)).toBe('/api/sessions/s1/files/view/C%3A/work/site/page.HTM');
    expect(fileOpenUrl('s1', '/home/me/page.html')).toBe('/api/sessions/s1/files/view/%2Fhome/me/page.html');
  });

  it('opens anything else on the open route', () => {
    expect(fileOpenUrl('s1', 'render/README.md')).toBe('/api/sessions/s1/files/open?path=render%2FREADME.md');
  });
});

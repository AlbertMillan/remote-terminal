import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  dragHasFiles,
  filesFromTransfer,
  MAX_UPLOAD_BYTES,
  pastedFilesText,
  uploadFailureMessage,
  uploadPastedFile,
  uploadPastedFiles,
} from '../src/client/pasted-file.js';

type Item = { kind: string; type: string; name?: string; dir?: boolean };

/** The parts of a DataTransfer filesFromTransfer reads. */
function transfer(items: Item[], files: { type: string; name: string }[] = []): DataTransfer {
  return {
    items: items.map((i) => ({
      kind: i.kind,
      type: i.type,
      getAsFile: () => ({ type: i.type, name: i.name ?? 'x' }) as unknown as File,
      webkitGetAsEntry: () => ({ isDirectory: !!i.dir }),
    })),
    files,
    types: items.some((i) => i.kind === 'file') ? ['Files'] : ['text/plain'],
  } as unknown as DataTransfer;
}

describe('pasted files (web client)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('takes every file in order, skips folders, and leaves a text paste to xterm', () => {
    expect(filesFromTransfer(transfer([{ kind: 'string', type: 'text/plain' }]))).toEqual([]);
    expect(filesFromTransfer(null)).toEqual([]);
    const taken = filesFromTransfer(
      transfer([
        { kind: 'string', type: 'text/plain' },
        { kind: 'file', type: 'application/pdf', name: 'spec.pdf' },
        { kind: 'file', type: '', name: 'photos', dir: true },
        { kind: 'file', type: 'text/markdown', name: 'notes.md' },
        { kind: 'file', type: 'image/png', name: 'shot.png' },
      ])
    );
    expect(taken.map((f) => f.name)).toEqual(['spec.pdf', 'notes.md', 'shot.png']);
    // No items API: the file list.
    expect(filesFromTransfer(transfer([], [{ type: 'application/pdf', name: 'a.pdf' }])).map((f) => f.name)).toEqual(['a.pdf']);
  });

  it('tells a file drag from a text drag', () => {
    expect(dragHasFiles(transfer([{ kind: 'file', type: '' }]))).toBe(true);
    expect(dragHasFiles(transfer([{ kind: 'string', type: 'text/plain' }]))).toBe(false);
    expect(dragHasFiles(null)).toBe(false);
  });

  it('pastes every path with a trailing space, quoted only when it holds one', () => {
    expect(pastedFilesText(['C:\\a\\.claude-remote\\uploads\\s\\1\\spec.pdf'])).toBe('C:\\a\\.claude-remote\\uploads\\s\\1\\spec.pdf ');
    expect(pastedFilesText(['C:\\u\\1\\Q3 spec.pdf', 'C:\\u\\2\\notes.md'])).toBe('"C:\\u\\1\\Q3 spec.pdf" C:\\u\\2\\notes.md ');
    expect(pastedFilesText([])).toBe('');
  });

  it('posts the raw bytes with the file name and resolves to the saved path, or throws the server error', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ path: '/data/uploads/s/1/Q3 spec.pdf' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const file = new File([new Uint8Array([1])], 'Q3 spec.pdf', { type: 'application/pdf' });
    await expect(uploadPastedFile('s 1', file)).resolves.toBe('/data/uploads/s/1/Q3 spec.pdf');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/sessions/s%201/files?name=Q3%20spec.pdf',
      expect.objectContaining({ method: 'POST', body: file, headers: { 'Content-Type': 'application/pdf' } })
    );

    const untyped = new File([new Uint8Array([1])], 'Makefile');
    await uploadPastedFile('s', untyped);
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/sessions/s/files?name=Makefile',
      expect.objectContaining({ headers: { 'Content-Type': 'application/octet-stream' } })
    );

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Session not found' }), { status: 404 })));
    await expect(uploadPastedFile('s', file)).rejects.toThrow('Session not found');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 413 })));
    await expect(uploadPastedFile('s', file)).rejects.toThrow('larger than 20 MB');
  });

  it('refuses a file over the cap before sending anything', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const big = new File([new Uint8Array(1)], 'video.mp4');
    Object.defineProperty(big, 'size', { value: MAX_UPLOAD_BYTES + 1 });
    await expect(uploadPastedFile('s', big)).rejects.toThrow('larger than 20 MB');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uploads in order, keeps going past a failure, and reports it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.includes('big.bin')
          ? new Response('', { status: 413 })
          : new Response(JSON.stringify({ path: `/u/${decodeURIComponent(url.split('name=')[1])}` }), { status: 200 })
      )
    );
    const f = (name: string) => new File([new Uint8Array([1])], name);
    const result = await uploadPastedFiles('s', [f('a.md'), f('big.bin'), f('b.pdf')]);
    expect(result.paths).toEqual(['/u/a.md', '/u/b.pdf']);
    expect(result.failures).toEqual([{ name: 'big.bin', error: 'larger than 20 MB' }]);
    expect(uploadFailureMessage(result.failures)).toBe('big.bin not attached: larger than 20 MB');
    expect(uploadFailureMessage([...result.failures, { name: 'c.zip', error: 'Session not found' }])).toBe(
      '2 files not attached: big.bin (larger than 20 MB), c.zip (Session not found)'
    );
  });
});

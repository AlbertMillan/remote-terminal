import { describe, it, expect, vi, afterEach } from 'vitest';
import { imageFromTransfer, pastedImageText, uploadPastedImage } from '../src/client/pasted-image.js';

/** The parts of a DataTransfer imageFromTransfer reads. */
function transfer(items: { kind: string; type: string }[], files: { type: string }[] = []): DataTransfer {
  return {
    items: items.map((i) => ({ ...i, getAsFile: () => ({ type: i.type, name: 'x' }) as unknown as File })),
    files,
  } as unknown as DataTransfer;
}

describe('pasted images (web client)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('takes the first image and leaves a text paste to xterm', () => {
    expect(imageFromTransfer(transfer([{ kind: 'string', type: 'text/plain' }]))).toBeNull();
    expect(imageFromTransfer(transfer([{ kind: 'string', type: 'text/plain' }, { kind: 'file', type: 'image/png' }]))?.type).toBe('image/png');
    expect(imageFromTransfer(transfer([], [{ type: 'application/pdf' }, { type: 'image/jpeg' }]))?.type).toBe('image/jpeg');
    expect(imageFromTransfer(null)).toBeNull();
  });

  it('pastes the path with a trailing space, quoted only when it holds one', () => {
    expect(pastedImageText('C:\\Users\\a\\.claude-remote\\images\\s\\1.png')).toBe('C:\\Users\\a\\.claude-remote\\images\\s\\1.png ');
    expect(pastedImageText('C:\\Users\\A B\\1.png')).toBe('"C:\\Users\\A B\\1.png" ');
  });

  it('posts the raw bytes and resolves to the saved path, or throws the server error', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ path: '/data/images/s/1.png' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const blob = new Blob([new Uint8Array([1])], { type: 'image/png' });
    await expect(uploadPastedImage('s 1', blob)).resolves.toBe('/data/images/s/1.png');
    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/s%201/images', expect.objectContaining({ method: 'POST', body: blob, headers: { 'Content-Type': 'image/png' } }));

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Not a PNG, JPEG, GIF or WebP image' }), { status: 415 })));
    await expect(uploadPastedImage('s', blob)).rejects.toThrow('Not a PNG');
  });
});

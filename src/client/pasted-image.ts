/**
 * An image pasted or dropped into the terminal. Claude Code reads an image from the
 * clipboard of the machine it runs on, which the browser cannot reach, so the image is
 * uploaded (`POST /api/sessions/:id/images`, sessions/pasted-images.ts) and its saved path is
 * pasted instead: Claude Code attaches a pasted image path as `[Image #N]`.
 */

/** The first image a paste or drop carries; null leaves the event to xterm (text). */
export function imageFromTransfer(data: DataTransfer | null): File | null {
  if (!data) return null;
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (file) return file;
    }
  }
  for (const file of Array.from(data.files ?? [])) {
    if (file.type.startsWith('image/')) return file;
  }
  return null;
}

/**
 * What to paste for a saved image: the path, quoted when it holds a space, and a trailing
 * space so the next word typed does not join it.
 */
export function pastedImageText(path: string): string {
  return `${/\s/.test(path) ? `"${path}"` : path} `;
}

/** Uploads the image to the session; resolves to its path on the server. */
export async function uploadPastedImage(sessionId: string, image: Blob): Promise<string> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/images`, {
    method: 'POST',
    // The server reads the type from the bytes; any image/* reaches its parser.
    headers: { 'Content-Type': image.type.startsWith('image/') ? image.type : 'image/png' },
    body: image,
  });
  const data = (await res.json().catch(() => ({}))) as { path?: string; error?: string };
  if (!res.ok || !data.path) throw new Error(data.error ?? `Image upload failed (HTTP ${res.status})`);
  return data.path;
}

import { failureMessage, requestJson } from './api.js';

/**
 * Files pasted or dropped into the terminal. Claude Code runs on the server's PC, which
 * cannot see a file on this device, so each file is uploaded (`POST /api/sessions/:id/files`,
 * sessions/uploads.ts) and its saved path is pasted instead: Claude Code attaches a pasted
 * image path as `[Image #N]`, and Claude opens any other file with its Read tool.
 */

/**
 * Every file a paste or drop carries, in order; folders are skipped (they cannot be read as
 * one body). Empty leaves the event to xterm (a text paste).
 */
export function filesFromTransfer(data: DataTransfer | null): File[] {
  if (!data) return [];
  const items = Array.from(data.items ?? []).filter((item) => item.kind === 'file');
  // `items` and `files` list the same files; `items` alone tells a folder apart.
  if (items.length) {
    const files: File[] = [];
    for (const item of items) {
      if (item.webkitGetAsEntry?.()?.isDirectory) continue;
      const file = item.getAsFile();
      if (file) files.push(file);
    }
    return files;
  }
  return Array.from(data.files ?? []);
}

/** Whether a drag carries files at all, before the drop says which (their names stay hidden until then). */
export function dragHasFiles(data: DataTransfer | null): boolean {
  return Array.from(data?.items ?? []).some((item) => item.kind === 'file') || Array.from(data?.types ?? []).includes('Files');
}

/**
 * What to paste for the saved files: each path quoted when it holds a space, in order,
 * with a trailing space so the next word typed does not join the last one.
 */
export function pastedFilesText(paths: string[]): string {
  return paths.map((path) => `${/\s/.test(path) ? `"${path}"` : path} `).join('');
}

/** The server's `MAX_UPLOAD_BYTES` (sessions/uploads.ts). */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/** Uploads one file to the session; resolves to its path on the server. */
export async function uploadPastedFile(sessionId: string, file: Blob, name = (file as File).name): Promise<string> {
  // Refused here, before any byte is sent: the server would cut an oversized body short,
  // and a browser often reports that as a bare network error rather than the 413.
  if (file.size > MAX_UPLOAD_BYTES) throw new Error('larger than 20 MB');
  const query = name ? `?name=${encodeURIComponent(name)}` : '';
  const result = await requestJson<{ path?: string }>(`/api/sessions/${encodeURIComponent(sessionId)}/files${query}`, {
    method: 'POST',
    // The server takes any type and reads an image's from its bytes.
    headers: { 'Content-Type': file.type || 'application/octet-stream' },
    body: file,
  });
  const path = result.data.path;
  if (!result.ok || !path) {
    if (result.status === 413) throw new Error('larger than 20 MB');
    throw new Error(failureMessage(result, 'upload failed'));
  }
  return path;
}

/**
 * Uploads the files one by one, in order, so the pasted paths follow the order they were
 * dropped in. A failure doesn't stop the rest: the paths that saved are returned with the
 * failures, for one paste and one toast.
 */
export async function uploadPastedFiles(
  sessionId: string,
  files: File[]
): Promise<{ paths: string[]; failures: { name: string; error: string }[] }> {
  const paths: string[] = [];
  const failures: { name: string; error: string }[] = [];
  for (const file of files) {
    try {
      paths.push(await uploadPastedFile(sessionId, file));
    } catch (error) {
      failures.push({ name: file.name || 'file', error: error instanceof Error ? error.message : 'upload failed' });
    }
  }
  return { paths, failures };
}

/** The toast for files that didn't upload: the one reason, or a count and the names. */
export function uploadFailureMessage(failures: { name: string; error: string }[]): string {
  if (failures.length === 1) return `${failures[0].name} not attached: ${failures[0].error}`;
  return `${failures.length} files not attached: ${failures.map((f) => `${f.name} (${f.error})`).join(', ')}`;
}

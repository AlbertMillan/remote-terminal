/**
 * Clickable file paths in the terminal. Claude Code prints file names as coloured text, not
 * links (no OSC 8 in our PTYs, and FORCE_HYPERLINK links markdown links only), so the paths
 * are found in the text, as VS Code's terminal does: candidates are picked out of a line
 * (wrapped rows joined), the server says which are real files in the session's folders, and
 * only those are underlined. A click opens the file in a new tab, served in place; the
 * browser shows what it can and the device opens the rest. → project/clickable-file-paths.md
 */

// The slice of xterm.js 5.3 this needs, structurally (xterm is loaded by script tag).
interface IBufferCell {
  getChars(): string;
  getWidth(): number;
}
interface IBufferLine {
  readonly isWrapped: boolean;
  readonly length: number;
  getCell(x: number): IBufferCell | undefined;
}
interface IBuffer {
  readonly length: number;
  getLine(y: number): IBufferLine | undefined;
}
interface IBufferRange {
  start: { x: number; y: number };
  end: { x: number; y: number };
}
interface ILink {
  range: IBufferRange;
  text: string;
  activate(event: MouseEvent, text: string): void;
}
export interface LinkHost {
  readonly buffer: { readonly active: IBuffer };
  registerLinkProvider(provider: {
    provideLinks(bufferLineNumber: number, callback: (links: ILink[] | undefined) => void): void;
  }): { dispose(): void };
}

export interface PathCandidate {
  /** The text as printed, a `:line[:col]` suffix included (the server strips it). */
  text: string;
  /** Offset of the first character in the line. */
  index: number;
}

/**
 * A run of characters a path is made of; a drive prefix only before a separator. No `~`: the
 * server never expands it, so a `~/…` path could only ever be asked about and refused.
 */
const PATH_RUN = /(?:[A-Za-z]:(?=[\\/]))?[\p{L}\p{N}_\-@+.\\/]+/gu;
/** The last segment must end in an extension holding a letter: `NUANCES.md`, not `2.1.323`. */
const HAS_EXTENSION = /\.[\p{L}\p{N}_-]*\p{L}[\p{L}\p{N}_-]*$/u;
const URL = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;
/** One hovered line is one request; a line of nothing but dotted words stays small. */
const MAX_CANDIDATES = 10;
const MAX_PATH_CHARS = 1024;
/** Rows of one wrapped line read at most; a longer one is cut there rather than walked. */
const MAX_WRAPPED_ROWS = 40;

/** The path-like words in one line of terminal text, URLs excluded. Pure, for the tests. */
export function findPathCandidates(line: string): PathCandidate[] {
  // URLs are blanked out (same length, so offsets hold): the web-links addon owns them.
  const text = line.replace(URL, (m) => ' '.repeat(m.length));
  const found: PathCandidate[] = [];
  for (const m of text.matchAll(PATH_RUN)) {
    let token = m[0].replace(/[.]+$/, '');
    if (token.length < 3 || token.length > MAX_PATH_CHARS) continue;
    const last = token.split(/[\\/]/).pop() ?? '';
    const ext = last.lastIndexOf('.');
    if (ext <= 0 || !HAS_EXTENSION.test(last) || last.length - ext > 13) continue;
    const index = m.index ?? 0;
    if (text[index - 1] === '~') continue; // `~/…`: the rest of it alone names another file

    // A `file.ts:12:3` location stays part of the link, so the whole thing is clickable.
    const suffix = /^:\d+(?::\d+)?/.exec(line.slice(index + token.length));
    if (suffix) token += suffix[0];
    found.push({ text: token, index });
    if (found.length >= MAX_CANDIDATES) break;
  }
  return found;
}

interface CellPos {
  x: number;
  y: number;
  width: number;
}

/**
 * The logical line holding buffer row `row` (0-based): its wrapped rows joined into one
 * string, with the cell each character code unit sits in, so a match maps back to cells
 * even past wide characters.
 */
export function readLogicalLine(buffer: IBuffer, row: number): { text: string; cells: CellPos[] } {
  let start = row;
  while (start > 0 && row - start < MAX_WRAPPED_ROWS && buffer.getLine(start)?.isWrapped) start--;
  let end = row;
  while (end - start < MAX_WRAPPED_ROWS && buffer.getLine(end + 1)?.isWrapped) end++;

  let text = '';
  const cells: CellPos[] = [];
  for (let y = start; y <= end; y++) {
    const line = buffer.getLine(y);
    if (!line) break;
    for (let x = 0; x < line.length; x++) {
      const cell = line.getCell(x);
      if (!cell) break;
      const width = cell.getWidth();
      if (width === 0) continue; // the second half of a wide character
      const chars = cell.getChars() || ' ';
      text += chars;
      for (let i = 0; i < chars.length; i++) cells.push({ x, y, width });
    }
  }
  return { text, cells };
}

export interface FileLinkOptions {
  /** The session the terminal shows now; no links without one. */
  sessionId: () => string | null;
  /** Which of `paths` open a file; the default asks the server. */
  check?: (sessionId: string, paths: string[]) => Promise<string[]>;
  /** Opens one; the default is a new tab on the server's file route. */
  open?: (sessionId: string, path: string) => void;
  now?: () => number;
}

/** A found or missing answer is reused this long: hovering back and forth asks once. */
const CHECK_TTL_MS = 30_000;
/** Answers kept per terminal; past this, expired ones go first, then the oldest. */
const MAX_CACHED = 500;

async function checkOnServer(sessionId: string, paths: string[]): Promise<string[]> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/files/check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paths }),
  });
  if (!res.ok) return [];
  const body = (await res.json()) as { found?: unknown };
  return Array.isArray(body.found) ? body.found.filter((p): p is string => typeof p === 'string') : [];
}

/**
 * Where a click on `path` goes. A page (`.html`) opens on the view route, with the path in the
 * URL's own path so its relative images and scripts resolve beside it (the server shows it
 * sandboxed); everything else on the open route.
 */
export function fileOpenUrl(sessionId: string, path: string): string {
  const session = encodeURIComponent(sessionId);
  const file = path.replace(/:\d+(?::\d+)?$/, '');
  if (/\.html?$/i.test(file)) {
    const segments = file.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/');
    return `/api/sessions/${session}/files/view/${segments.replace(/^\//, '%2F')}`;
  }
  return `/api/sessions/${session}/files/open?path=${encodeURIComponent(path)}`;
}

function openInTab(sessionId: string, path: string): void {
  window.open(fileOpenUrl(sessionId, path), '_blank', 'noopener');
}

/** Registers the provider on `terminal`; dispose the result (or the terminal) to remove it. */
export function registerFileLinks(terminal: LinkHost, options: FileLinkOptions): { dispose(): void } {
  const check = options.check ?? checkOnServer;
  const open = options.open ?? openInTab;
  const now = options.now ?? Date.now;
  const cache = new Map<string, { found: boolean; at: number }>();
  /** Checks in flight, per path: two lines naming the same file share one request. */
  const pending = new Map<string, Promise<void>>();

  function remember(k: string, found: boolean, at: number): void {
    cache.delete(k); // re-inserted last, so Map order stays oldest-first
    cache.set(k, { found, at });
    if (cache.size <= MAX_CACHED) return;
    for (const [old, hit] of cache) if (at - hit.at >= CHECK_TTL_MS) cache.delete(old);
    for (const old of cache.keys()) {
      if (cache.size <= MAX_CACHED) break;
      cache.delete(old);
    }
  }

  async function existing(sessionId: string, paths: string[]): Promise<Set<string>> {
    const key = (p: string) => `${sessionId}\0${p}`;
    const isFresh = (p: string) => {
      const hit = cache.get(key(p));
      return !!hit && now() - hit.at < CHECK_TTL_MS;
    };
    const unique = [...new Set(paths)];
    const unknown = unique.filter((p) => !isFresh(p) && !pending.has(key(p)));
    if (unknown.length > 0) {
      // A path is only asked about when no request has it, so this one owns its paths and
      // clears them when it lands.
      const request = (async () => {
        // Yield first, so the paths are in `pending` before they are cleared below, even when
        // `check` fails synchronously; cleared first, they would stay pending forever.
        await null;
        let found: string[] = [];
        try {
          found = await check(sessionId, unknown);
        } catch {
          /* offline or refused: no links, asked again after the TTL */
        }
        const at = now();
        for (const p of unknown) {
          remember(key(p), found.includes(p), at);
          pending.delete(key(p));
        }
      })();
      for (const p of unknown) pending.set(key(p), request);
    }
    await Promise.all(unique.map((p) => pending.get(key(p))));
    // Read the answer itself, not its freshness: one that just landed must count even if the
    // TTL ran out while it was in flight.
    return new Set(paths.filter((p) => cache.get(key(p))?.found));
  }

  return terminal.registerLinkProvider({
    provideLinks(bufferLineNumber, callback) {
      const sessionId = options.sessionId();
      const row = bufferLineNumber - 1;
      const { text, cells } = readLogicalLine(terminal.buffer.active, row);
      const candidates = sessionId ? findPathCandidates(text) : [];
      if (!sessionId || candidates.length === 0) {
        callback(undefined);
        return;
      }
      void existing(sessionId, candidates.map((c) => c.text)).then((found) => {
        // The PiP window switches sessions on one terminal: an answer for the one it showed
        // when asked must not put links on the next one's text.
        if (options.sessionId() !== sessionId) {
          callback(undefined);
          return;
        }
        const links: ILink[] = [];
        for (const c of candidates) {
          if (!found.has(c.text)) continue;
          const first = cells[c.index];
          const last = cells[c.index + c.text.length - 1];
          if (!first || !last) continue;
          // xterm asks per row: only links touching this one, or a wrapped path doubles up.
          if (row < first.y || row > last.y) continue;
          links.push({
            range: {
              start: { x: first.x + 1, y: first.y + 1 },
              end: { x: last.x + last.width, y: last.y + 1 },
            },
            text: c.text,
            activate: (event) => {
              event.preventDefault();
              open(sessionId, c.text);
            },
          });
        }
        callback(links.length > 0 ? links : undefined);
      });
    },
  });
}

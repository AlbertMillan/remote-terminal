import headless from '@xterm/headless';
import serialize from '@xterm/addon-serialize';
import { getConfig } from '../config.js';

/**
 * Marks a stored scrollback as a ScreenMirror snapshot. An OSC with an unknown number is
 * ignored by xterm.js (and by the app's emulator), so it is harmless if replayed as-is.
 * Rows persisted before this format are raw PTY bytes joined with '\n'.
 */
export const SNAPSHOT_MARKER = '\x1b]7713;cr-snapshot\x07';

/**
 * A stored scrollback as bytes to write into a terminal: a snapshot without its marker, or a
 * legacy raw log with the CRLF join it was always replayed with.
 */
export function storedToReplay(stored: string): string {
  if (!stored) return '';
  return stored.startsWith(SNAPSHOT_MARKER) ? stored.slice(SNAPSHOT_MARKER.length) : stored.replace(/\r?\n/g, '\r\n');
}

/**
 * A session's screen, kept by a headless xterm.js that sees every PTY byte and every resize
 * in the order they happened. Attach replays `snapshot()`, never the raw byte log.
 *
 * Why not the raw log: ConPTY output is absolute cursor moves and whole-screen repaints at
 * whatever size the PTY had then. Replayed in one go at the latest size, bytes drawn at
 * another width land in the wrong cells: Claude Code's tables and spinners pile up in the
 * history above the last attach.
 */
export class ScreenMirror {
  private readonly terminal: InstanceType<typeof headless.Terminal>;
  private readonly serializer: InstanceType<typeof serialize.SerializeAddon>;
  /** afterQueued() callbacks not yet run; dispose() runs them, since xterm then never will. */
  private waiting = new Set<() => void>();
  private disposed = false;

  constructor(cols: number, rows: number, scrollback?: number) {
    this.terminal = new headless.Terminal({
      cols,
      rows,
      scrollback: scrollback ?? getConfig().persistence.scrollbackLines,
      allowProposedApi: true,
      // Same as the browser terminal: ConPTY's bare LF means "down one row, same column".
      convertEol: false,
    });
    this.serializer = new serialize.SerializeAddon();
    this.terminal.loadAddon(this.serializer);
  }

  write(data: string): void {
    if (this.disposed || !data) return;
    try {
      this.terminal.write(data);
    } catch {
      // xterm throws past ~50 MB unparsed. Losing mirror bytes only blurs a later replay;
      // throwing here would cut the PTY's live output to every viewer.
    }
  }

  /**
   * Queued behind every write already made: xterm's resize() applies at once, and a resize
   * jumping ahead of bytes drawn at the old size would reflow them wrongly.
   */
  resize(cols: number, rows: number): void {
    this.afterQueued(() => {
      if (!this.disposed && (cols !== this.terminal.cols || rows !== this.terminal.rows)) {
        this.terminal.resize(cols, rows);
      }
    });
  }

  /** Seeds a stored scrollback drawn at `cols`x`rows`, then returns to the current size. */
  seed(stored: string, cols: number, rows: number): void {
    const content = storedToReplay(stored);
    if (!content) return;
    const current = { cols: this.terminal.cols, rows: this.terminal.rows };
    this.resize(cols, rows);
    this.write(content.endsWith('\n') ? content : `${content}\r\n`);
    this.resize(current.cols, current.rows);
  }

  /**
   * Runs `fn` once every write made before this call is applied, ignoring later ones -- so
   * it can't starve behind a session that never stops printing. A caller that starts
   * collecting live output in the same tick as this call, and snapshots inside `fn`, has
   * every byte exactly once: the earlier ones in the snapshot, the later ones collected.
   */
  afterQueued(fn: () => void): void {
    if (this.disposed) {
      fn();
      return;
    }
    this.waiting.add(fn);
    this.terminal.write('', () => {
      if (this.waiting.delete(fn)) fn();
    });
  }

  /**
   * afterQueued() as a promise, for callers about to persist. Gives up after `timeoutMs`:
   * a stop or shutdown must never hang on the mirror, and a snapshot a moment stale beats none.
   */
  caughtUp(timeoutMs = 2000): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      this.afterQueued(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /** The screen and scrollback as escape sequences, for a fresh terminal of this size. */
  snapshot(): string {
    if (this.disposed) return '';
    return this.serializer.serialize();
  }

  /** `snapshot()` tagged for storage; `seed()` recognises it. Empty for an empty screen. */
  persistable(): string {
    const snap = this.snapshot();
    return snap ? SNAPSHOT_MARKER + snap : '';
  }

  get cols(): number {
    return this.terminal.cols;
  }

  get rows(): number {
    return this.terminal.rows;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.terminal.dispose();
    const waiting = [...this.waiting];
    this.waiting.clear();
    for (const fn of waiting) fn();
  }
}

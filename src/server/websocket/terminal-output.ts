/**
 * One attached socket's terminal output: coalesced, held, and dropped-then-resynced when the
 * socket can't keep up.
 *
 * - **Coalesced.** PTY chunks arriving in one turn of the event loop go out as one
 *   `terminal.data`, not one JSON message each.
 * - **Held** (`hold()`/`release()`) while an attach waits for its snapshot: output from before
 *   is in the snapshot, output after goes out right behind it, none of it twice.
 * - **Backpressure.** `ws.send` never blocks; a phone on a weak link attached to a noisy build
 *   would otherwise make the server buffer that output without limit. Past `highWater` bytes
 *   unsent (or held) the output is dropped, and once the socket drains below `lowWater` the
 *   client gets a full reset (`ESC c`) followed by the mirror's current screen: what it
 *   missed is replaced, not replayed. Sent as ordinary `terminal.data`, so every client
 *   (browser, PiP, Android) handles it as it handles any output.
 */

import { CATCH_UP_RESET } from '../../shared/protocol.js';

/**
 * RIS: a full terminal reset, scrollback included, before the snapshot redraws it. Clients
 * recognise a catch-up by it (a viewer of another size replays the snapshot at the PTY's).
 */
export const RESET = CATCH_UP_RESET;

export interface OutputSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string): void;
}

export interface TerminalOutputOptions {
  socket: OutputSocket;
  /** `WebSocket.OPEN`. */
  openState: number;
  /** Serialises one batch of output for the wire. */
  encode: (data: string) => string;
  /** The session's current screen, once it holds every byte sent before this call (`withScrollback`). */
  snapshot: (fn: (screen: string) => void) => void;
  highWater?: number;
  lowWater?: number;
  /** How often a socket that fell behind is checked for having drained. */
  drainCheckMs?: number;
  /** Runs `fn` after the current turn; tests pass a synchronous one. */
  defer?: (fn: () => void) => void;
}

export const HIGH_WATER_BYTES = 4 * 1024 * 1024;
export const LOW_WATER_BYTES = 256 * 1024;
const DRAIN_CHECK_MS = 250;

export class TerminalOutput {
  private pending: string[] = [];
  private pendingBytes = 0;
  private scheduled = false;
  private holding = false;
  /** Output was dropped: the client needs a reset and the current screen. */
  private behind = false;
  private resyncing = false;
  private drainTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private readonly o: Required<Omit<TerminalOutputOptions, 'defer'>> & { defer: (fn: () => void) => void };

  constructor(options: TerminalOutputOptions) {
    this.o = {
      highWater: HIGH_WATER_BYTES,
      lowWater: LOW_WATER_BYTES,
      drainCheckMs: DRAIN_CHECK_MS,
      defer: setImmediate,
      ...options,
    };
  }

  /** One PTY chunk. */
  push(data: string): void {
    if (this.closed || this.behind) return;
    this.pending.push(data);
    this.pendingBytes += data.length;
    if (this.pendingBytes > this.o.highWater) {
      this.fallBehind();
      return;
    }
    if (this.holding || this.scheduled) return;
    this.scheduled = true;
    this.o.defer(() => {
      this.scheduled = false;
      this.flush();
    });
  }

  /** Sends what is queued now, e.g. before a `terminal.exit` that must come after it. */
  flush(): void {
    if (this.closed || this.holding || this.pending.length === 0) return;
    if (!this.isOpen()) {
      this.clearPending();
      return;
    }
    if (this.o.socket.bufferedAmount > this.o.highWater) {
      this.fallBehind();
      return;
    }
    const data = this.pending.join('');
    this.clearPending();
    this.o.socket.send(this.o.encode(data));
  }

  /** Holds output until `release()`: an attach is waiting for its snapshot. */
  hold(): void {
    this.holding = true;
  }

  /** Sends what was held (or, if too much was, resyncs). Call right after the snapshot went out. */
  release(): void {
    this.holding = false;
    if (this.behind) this.checkDrained();
    else this.flush();
  }

  close(): void {
    this.closed = true;
    this.clearPending();
    this.stopDrainTimer();
  }

  private isOpen(): boolean {
    return this.o.socket.readyState === this.o.openState;
  }

  private clearPending(): void {
    this.pending = [];
    this.pendingBytes = 0;
  }

  private fallBehind(): void {
    this.behind = true;
    this.clearPending();
    if (!this.drainTimer) {
      this.drainTimer = setInterval(() => this.checkDrained(), this.o.drainCheckMs);
      this.drainTimer.unref?.();
    }
  }

  private stopDrainTimer(): void {
    if (this.drainTimer) clearInterval(this.drainTimer);
    this.drainTimer = null;
  }

  private checkDrained(): void {
    if (this.closed || this.holding || this.resyncing || !this.behind) return;
    if (!this.isOpen()) {
      this.close();
      return;
    }
    if (this.o.socket.bufferedAmount > this.o.lowWater) return;
    this.stopDrainTimer();
    this.resync();
  }

  /** Reset and redraw from the mirror; output from here on is held until the screen is sent. */
  private resync(): void {
    this.behind = false;
    this.resyncing = true;
    this.holding = true;
    this.o.snapshot((screen) => {
      this.resyncing = false;
      if (this.closed) return;
      if (this.isOpen()) this.o.socket.send(this.o.encode(RESET + screen));
      this.release();
    });
  }
}

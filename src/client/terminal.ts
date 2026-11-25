import { dragHasFiles, filesFromTransfer } from './pasted-file.js';
import { registerFileLinks, type LinkHost } from './file-links.js';
import { isFilterShortcut } from './session-list-view.js';
import { resetWrapOnLineStart } from './wrap-reset.js';
import { attachTouchScroll } from './touch-scroll.js';

// Terminal management using xterm.js

// Type definitions for xterm.js loaded via script tags
interface ITerminalOptions {
  cursorBlink?: boolean;
  cursorStyle?: 'block' | 'underline' | 'bar';
  convertEol?: boolean;
  fontSize?: number;
  fontFamily?: string;
  lineHeight?: number;
  theme?: Record<string, string>;
}

interface ITerminal {
  cols: number;
  rows: number;
  open(container: HTMLElement): void;
  /** Parsed later, not in this call: `callback` runs once it is. */
  write(data: string, callback?: () => void): void;
  readonly buffer: { readonly active: { readonly baseY: number; readonly viewportY: number } };
  /** Sends `data` as typed input, bracketed when the program enabled bracketed paste. */
  paste(data: string): void;
  writeln(data: string): void;
  clear(): void;
  resize(cols: number, rows: number): void;
  focus(): void;
  dispose(): void;
  onData(callback: (data: string) => void): void;
  onResize(callback: (size: { cols: number; rows: number }) => void): void;
  loadAddon(addon: ITerminalAddon): void;
  attachCustomKeyEventHandler(handler: (e: KeyboardEvent) => boolean): void;
  scrollLines(amount: number): void;
  /** `mouseTrackingMode` is not `'none'` while the program asked for mouse reports. */
  readonly modes: { readonly mouseTrackingMode: 'none' | 'x10' | 'vt200' | 'drag' | 'any' };
  parser: {
    registerCsiHandler(id: { final: string }, handler: (params: (number | number[])[]) => boolean): unknown;
  };
}

interface ITerminalAddon {
  dispose?(): void;
}

interface IFitAddon extends ITerminalAddon {
  fit(): void;
}

interface ITerminalConstructor {
  new (options?: ITerminalOptions): ITerminal;
}

interface IFitAddonModule {
  FitAddon: new () => IFitAddon;
}

interface IWebLinksAddonModule {
  WebLinksAddon: new () => ITerminalAddon;
}

declare const Terminal: ITerminalConstructor;
declare const FitAddon: IFitAddonModule;
declare const WebLinksAddon: IWebLinksAddonModule;

export const TERMINAL_THEME: Record<string, string> = {
  background: '#16161e',
  foreground: '#c0caf5',
  cursor: '#c0caf5',
  cursorAccent: '#16161e',
  selectionBackground: '#33467c',
  selectionForeground: '#c0caf5',
  black: '#15161e',
  red: '#f7768e',
  green: '#9ece6a',
  yellow: '#e0af68',
  blue: '#7aa2f7',
  magenta: '#bb9af7',
  cyan: '#7dcfff',
  white: '#a9b1d6',
  brightBlack: '#414868',
  brightRed: '#f7768e',
  brightGreen: '#9ece6a',
  brightYellow: '#e0af68',
  brightBlue: '#7aa2f7',
  brightMagenta: '#bb9af7',
  brightCyan: '#7dcfff',
  brightWhite: '#c0caf5',
};

export interface TerminalOptions {
  container: HTMLElement;
  onData: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
  /** Files pasted or dropped onto the terminal, in order (pasted-file.ts); text pastes stay xterm's. */
  onFiles?: (files: File[]) => void;
  /** The session shown, for clickable file paths (file-links.ts); none without it. */
  sessionId?: string;
}

export class TerminalManager {
  private terminal: ITerminal | null = null;
  private fitAddon: IFitAddon | null = null;
  private container: HTMLElement | null = null;
  private onDataCallback: ((data: string) => void) | null = null;
  private onResizeCallback: ((cols: number, rows: number) => void) | null = null;
  private resizeObserver: ResizeObserver | null = null;
  /** A local reflow only (fitLocally): onResize is not reported, so the PTY keeps its size. */
  private silentResize = false;
  /** Removes the file paste/drop listeners with the terminal. */
  private fileListeners: AbortController | null = null;
  /** Removes the drag-to-scroll listeners (touch-scroll.ts) with the terminal. */
  private touchScroll: AbortController | null = null;
  private navigateSessionCallback: ((direction: 'prev' | 'next') => void) | null = null;
  private newSessionCallback: (() => void) | null = null;
  private findSessionCallback: (() => void) | null = null;
  private scrollbar: {
    track: HTMLElement;
    thumb: HTMLElement;
    viewport: HTMLElement;
    observer: MutationObserver;
    abortController: AbortController;
    update: () => void;
  } | null = null;

  setNavigateSessionCallback(callback: ((direction: 'prev' | 'next') => void) | null): void {
    this.navigateSessionCallback = callback;
  }

  setNewSessionCallback(callback: (() => void) | null): void {
    this.newSessionCallback = callback;
  }

  setFindSessionCallback(callback: (() => void) | null): void {
    this.findSessionCallback = callback;
  }

  initialize(options: TerminalOptions): void {
    // Dispose any existing terminal to prevent duplicate event handlers
    this.dispose();

    this.container = options.container;
    this.onDataCallback = options.onData;
    this.onResizeCallback = options.onResize;

    // Create terminal
    this.terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: 'block',
      // Never convertEol: ConPTY sends a bare LF to mean "down one row, same column" and
      // follows it with relative moves (CSI n C). Returning to column 0 there shifts every
      // later cell, and Claude Code's diff repaints leave stale text when scrolled up.
      // Replay is joined with \r\n server-side and notices convert their own newlines.
      convertEol: false,
      fontSize: 14,
      fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", Menlo, Monaco, "Courier New", monospace',
      lineHeight: 1.2,
      theme: TERMINAL_THEME,
    });
    // Or a resize glues a repainted row onto the line above it (see wrap-reset.ts).
    resetWrapOnLineStart(this.terminal);

    // Intercept Ctrl+Q / Ctrl+E for session navigation (prevent sending to PTY)
    this.terminal.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      if (e.type === 'keydown' && e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
        if (e.key === 'q' || e.key === 'Q') {
          if (this.navigateSessionCallback) this.navigateSessionCallback('prev');
          return false;
        }
        if (e.key === 'e' || e.key === 'E') {
          if (this.navigateSessionCallback) this.navigateSessionCallback('next');
          return false;
        }
      }
      if (e.type === 'keydown' && e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey) {
        if (e.key === 'n' || e.key === 'N') {
          if (this.newSessionCallback) this.newSessionCallback();
          return false;
        }
        if (isFilterShortcut(e)) {
          if (this.findSessionCallback) this.findSessionCallback();
          return false;
        }
      }
      return true;
    });

    // Load addons
    this.fitAddon = new FitAddon.FitAddon();
    this.terminal.loadAddon(this.fitAddon);

    const webLinksAddon = new WebLinksAddon.WebLinksAddon();
    this.terminal.loadAddon(webLinksAddon);

    // A terminal is built per attach, so its session never changes; the provider goes
    // with the terminal on dispose().
    const sessionId = options.sessionId ?? null;
    if (sessionId) registerFileLinks(this.terminal as unknown as LinkHost, { sessionId: () => sessionId });

    // Open terminal in container
    this.terminal.open(this.container);

    // Fit to container
    this.fit();

    // Set up custom scrollbar (native xterm scrollbar is behind canvas layer)
    this.setupScrollbar();

    this.setupTouchScroll();

    // Handle terminal input
    this.terminal.onData((data: string) => {
      if (this.onDataCallback) {
        this.onDataCallback(data);
      }
    });

    // Handle resize
    this.terminal.onResize(({ cols, rows }: { cols: number; rows: number }) => {
      if (this.onResizeCallback && !this.silentResize) {
        this.onResizeCallback(cols, rows);
      }
    });

    // A file paste or drop: taken in the capture phase, before xterm's textarea, which
    // would paste nothing (it reads text only).
    const onFiles = options.onFiles;
    if (onFiles) {
      this.fileListeners = new AbortController();
      const { signal } = this.fileListeners;
      const container = this.container;
      // An outline while files are dragged over the terminal: they will be attached there.
      const highlight = (on: boolean) => container.classList.toggle('file-drag-over', on);
      const take = (e: Event, data: DataTransfer | null) => {
        const files = filesFromTransfer(data);
        if (!files.length) return;
        e.preventDefault();
        e.stopPropagation();
        onFiles(files);
      };
      container.addEventListener('paste', (e) => take(e, e.clipboardData), { capture: true, signal });
      container.addEventListener('dragover', (e) => {
        if (!dragHasFiles(e.dataTransfer)) return;
        e.preventDefault();
        highlight(true);
      }, { signal });
      container.addEventListener('dragleave', (e) => {
        // Leaving one child for another fires this too; only leaving the terminal counts.
        if (!(e.relatedTarget instanceof Node) || !container.contains(e.relatedTarget)) highlight(false);
      }, { signal });
      container.addEventListener('drop', (e) => {
        highlight(false);
        take(e, e.dataTransfer);
      }, { capture: true, signal });
    }

    // Set up resize observer
    this.resizeObserver = new ResizeObserver(() => {
      this.fit();
    });
    this.resizeObserver.observe(this.container);

    // Focus terminal
    this.terminal.focus();
  }

  /**
   * xterm parses writes later, but applies resize() at once: whatever must follow the parse
   * (a fit after replaying a snapshot at another size) goes in `done`. It runs only if this
   * terminal is still the one on screen.
   */
  write(data: string, done?: () => void): void {
    const terminal = this.terminal;
    if (!terminal) return;
    if (!done) {
      terminal.write(data);
      return;
    }
    terminal.write(data, () => {
      if (this.terminal === terminal) done();
    });
  }

  /** How many rows the view is scrolled up from the bottom. */
  linesFromBottom(): number {
    const active = this.terminal?.buffer.active;
    return active ? Math.max(0, active.baseY - active.viewportY) : 0;
  }

  /** Scrolls the view `lines` rows up from where it is. */
  scrollUp(lines: number): void {
    if (lines > 0) this.terminal?.scrollLines(-lines);
  }

  /** fit() without telling the server: the PTY keeps the size another viewer gave it. */
  fitLocally(): void {
    this.silently(() => this.fit());
  }

  /** resize() without telling the server, as fitLocally(). */
  resizeLocally(cols: number, rows: number): void {
    this.silently(() => this.resize(cols, rows));
  }

  private silently(fn: () => void): void {
    this.silentResize = true;
    try {
      fn();
    } finally {
      this.silentResize = false;
    }
  }

  /** Pastes into the session as a user paste would (bracketed when Claude Code asked). */
  paste(data: string): void {
    this.terminal?.paste(data);
  }

  writeln(data: string): void {
    if (this.terminal) {
      this.terminal.writeln(data);
    }
  }

  clear(): void {
    if (this.terminal) {
      this.terminal.clear();
    }
  }

  resize(cols: number, rows: number): void {
    if (this.terminal) {
      this.terminal.resize(cols, rows);
    }
  }

  fit(): void {
    if (this.fitAddon && this.container) {
      try {
        this.fitAddon.fit();
      } catch {
        // Ignore fit errors during initialization
      }
    }
    this.scrollbar?.update();
  }

  private setupScrollbar(): void {
    if (!this.container) return;

    const viewport = this.container.querySelector('.xterm-viewport') as HTMLElement;
    const xtermEl = this.container.querySelector('.xterm') as HTMLElement;
    if (!viewport || !xtermEl) return;

    const track = document.createElement('div');
    track.className = 'terminal-scrollbar';

    const thumb = document.createElement('div');
    thumb.className = 'terminal-scrollbar-thumb';
    track.appendChild(thumb);

    xtermEl.appendChild(track);

    const ac = new AbortController();
    const signal = ac.signal;

    const update = () => {
      const { scrollHeight, clientHeight, scrollTop } = viewport;
      if (scrollHeight <= clientHeight) {
        track.style.display = 'none';
        return;
      }
      track.style.display = '';
      const trackH = track.clientHeight;
      const thumbH = Math.max(30, (clientHeight / scrollHeight) * trackH);
      const maxScroll = scrollHeight - clientHeight;
      const thumbTop = maxScroll > 0 ? (scrollTop / maxScroll) * (trackH - thumbH) : 0;
      thumb.style.height = `${thumbH}px`;
      thumb.style.transform = `translateY(${thumbTop}px)`;
    };

    viewport.addEventListener('scroll', update, { signal });

    // Watch scroll area height changes (new terminal output)
    const scrollArea = viewport.querySelector('.xterm-scroll-area');
    const observer = new MutationObserver(update);
    if (scrollArea) {
      observer.observe(scrollArea, { attributes: true, attributeFilter: ['style'] });
    }

    // Thumb drag
    thumb.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const startY = e.clientY;
      const startScrollTop = viewport.scrollTop;
      thumb.classList.add('active');
      document.body.style.userSelect = 'none';

      const onMove = (ev: MouseEvent) => {
        ev.preventDefault();
        const deltaY = ev.clientY - startY;
        const trackH = track.clientHeight;
        const thumbH = thumb.clientHeight;
        const scrollable = viewport.scrollHeight - viewport.clientHeight;
        const maxThumbMove = trackH - thumbH;
        if (maxThumbMove > 0) {
          viewport.scrollTop = startScrollTop + (deltaY / maxThumbMove) * scrollable;
        }
      };

      const onUp = () => {
        thumb.classList.remove('active');
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    }, { signal });

    // Track click to jump
    track.addEventListener('mousedown', (e) => {
      if (e.target === thumb) return;
      const rect = track.getBoundingClientRect();
      const clickY = e.clientY - rect.top;
      const trackH = rect.height;
      const thumbH = thumb.clientHeight;
      const centerY = clickY - thumbH / 2;
      const maxThumbTop = trackH - thumbH;
      const ratio = Math.max(0, Math.min(1, centerY / maxThumbTop));
      viewport.scrollTop = ratio * (viewport.scrollHeight - viewport.clientHeight);
    }, { signal });

    this.scrollbar = { track, thumb, viewport, observer, abortController: ac, update };

    update();
  }

  /**
   * Finger drags scroll by whole rows (touch-scroll.ts). While the program tracks the mouse
   * (Claude Code's fullscreen renderer) a row of drag is one wheel event at the finger:
   * xterm encodes it in whichever mouse protocol the program asked for. Otherwise it moves
   * the scrollback.
   */
  private setupTouchScroll(): void {
    const container = this.container;
    const terminal = this.terminal;
    if (!container || !terminal) return;
    this.touchScroll = new AbortController();
    attachTouchScroll(container, {
      rowHeight: () => {
        const screen = container.querySelector('.xterm-screen');
        return screen && terminal.rows > 0 ? screen.clientHeight / terminal.rows : 0;
      },
      scrollRows: (rows, x, y) => {
        if (terminal.modes.mouseTrackingMode === 'none') {
          terminal.scrollLines(rows);
          return;
        }
        const target = container.querySelector('.xterm-screen') ?? container;
        for (let i = 0; i < Math.abs(rows); i++) {
          target.dispatchEvent(new WheelEvent('wheel', {
            deltaY: Math.sign(rows),
            deltaMode: WheelEvent.DOM_DELTA_LINE,
            clientX: x,
            clientY: y,
            bubbles: true,
            cancelable: true,
          }));
        }
      },
    }, this.touchScroll.signal);
  }

  focus(): void {
    if (this.terminal) {
      this.terminal.focus();
    }
  }

  getDimensions(): { cols: number; rows: number } {
    if (this.terminal) {
      return {
        cols: this.terminal.cols,
        rows: this.terminal.rows,
      };
    }
    return { cols: 80, rows: 24 };
  }

  dispose(): void {
    this.fileListeners?.abort();
    this.fileListeners = null;
    this.touchScroll?.abort();
    this.touchScroll = null;
    this.container?.classList.remove('file-drag-over');
    if (this.scrollbar) {
      this.scrollbar.abortController.abort();
      this.scrollbar.observer.disconnect();
      this.scrollbar.track.remove();
      this.scrollbar = null;
    }
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    if (this.terminal) {
      this.terminal.dispose();
      this.terminal = null;
    }
    this.fitAddon = null;
  }
}

// Export singleton instance
export const terminalManager = new TerminalManager();

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
  write(data: string): void;
  writeln(data: string): void;
  clear(): void;
  resize(cols: number, rows: number): void;
  focus(): void;
  dispose(): void;
  onData(callback: (data: string) => void): void;
  onResize(callback: (size: { cols: number; rows: number }) => void): void;
  loadAddon(addon: ITerminalAddon): void;
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
}

export class TerminalManager {
  private terminal: ITerminal | null = null;
  private fitAddon: IFitAddon | null = null;
  private container: HTMLElement | null = null;
  private onDataCallback: ((data: string) => void) | null = null;
  private onResizeCallback: ((cols: number, rows: number) => void) | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private scrollbar: {
    track: HTMLElement;
    thumb: HTMLElement;
    viewport: HTMLElement;
    observer: MutationObserver;
    abortController: AbortController;
    update: () => void;
  } | null = null;

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
      convertEol: true,
      fontSize: 14,
      fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", Menlo, Monaco, "Courier New", monospace',
      lineHeight: 1.2,
      theme: TERMINAL_THEME,
    });

    // Load addons
    this.fitAddon = new FitAddon.FitAddon();
    this.terminal.loadAddon(this.fitAddon);

    const webLinksAddon = new WebLinksAddon.WebLinksAddon();
    this.terminal.loadAddon(webLinksAddon);

    // Open terminal in container
    this.terminal.open(this.container);

    // Fit to container
    this.fit();

    // Set up custom scrollbar (native xterm scrollbar is behind canvas layer)
    this.setupScrollbar();

    // Handle terminal input
    this.terminal.onData((data: string) => {
      if (this.onDataCallback) {
        this.onDataCallback(data);
      }
    });

    // Handle resize
    this.terminal.onResize(({ cols, rows }: { cols: number; rows: number }) => {
      if (this.onResizeCallback) {
        this.onResizeCallback(cols, rows);
      }
    });

    // Set up resize observer
    this.resizeObserver = new ResizeObserver(() => {
      this.fit();
    });
    this.resizeObserver.observe(this.container);

    // Focus terminal
    this.terminal.focus();
  }

  write(data: string): void {
    if (this.terminal) {
      this.terminal.write(data);
    }
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

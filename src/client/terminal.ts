// Terminal management using xterm.js

declare const Terminal: any;
declare const FitAddon: any;
declare const WebLinksAddon: any;

export interface TerminalOptions {
  container: HTMLElement;
  onData: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
}

export class TerminalManager {
  private terminal: any = null;
  private fitAddon: any = null;
  private container: HTMLElement | null = null;
  private onDataCallback: ((data: string) => void) | null = null;
  private onResizeCallback: ((cols: number, rows: number) => void) | null = null;
  private resizeObserver: ResizeObserver | null = null;

  initialize(options: TerminalOptions): void {
    this.container = options.container;
    this.onDataCallback = options.onData;
    this.onResizeCallback = options.onResize;

    // Create terminal
    this.terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: 'block',
      fontSize: 14,
      fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", Menlo, Monaco, "Courier New", monospace',
      lineHeight: 1.2,
      theme: {
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
      },
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

  fit(): void {
    if (this.fitAddon && this.container) {
      try {
        this.fitAddon.fit();
      } catch {
        // Ignore fit errors during initialization
      }
    }
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

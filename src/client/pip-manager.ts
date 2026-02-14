// Picture-in-Picture terminal overlay manager
// Uses Document Picture-in-Picture API (Chrome/Edge 116+)
import { TERMINAL_THEME } from './terminal.js';
import { escapeHtml, escapeAttr } from './html-utils.js';

export interface PipSessionInfo {
  id: string;
  name: string;
  status: string;
  attachable: boolean;
}

interface PipNotification {
  type: 'needs-input' | 'completed';
  timestamp: string;
}

const VALID_NOTIFICATION_TYPES = ['needs-input', 'completed'] as const;
type NotificationType = typeof VALID_NOTIFICATION_TYPES[number];

const PIP_WIDTH = 480;
const PIP_HEIGHT = 360;

export class PipManager {
  private pipWindow: Window | null = null;
  private ws: WebSocket | null = null;
  private terminal: any = null;
  private fitAddon: any = null;
  private currentSessionId: string | null = null;
  private sessions: Map<string, PipSessionInfo> = new Map();
  private notifications: Map<string, PipNotification> = new Map();
  private headerEl: HTMLElement | null = null;
  private badgeEl: HTMLSpanElement | null = null;
  private nameEl: HTMLSpanElement | null = null;
  private selectEl: HTMLSelectElement | null = null;
  private resizeObserver: ResizeObserver | null = null;

  static isSupported(): boolean {
    return 'documentPictureInPicture' in window;
  }

  isOpen(): boolean {
    return this.pipWindow !== null && !this.pipWindow.closed;
  }

  async open(sessionId: string, sessions: ReadonlyMap<string, PipSessionInfo>, notifications: ReadonlyMap<string, PipNotification>): Promise<void> {
    if (!PipManager.isSupported()) return;

    // If already open, just switch session
    if (this.isOpen()) {
      this.updateSessions(sessions, notifications);
      this.switchSession(sessionId);
      return;
    }

    this.sessions = new Map(sessions);
    this.notifications = new Map(notifications);

    // Request PiP window
    const pipWindowApi = (window as any).documentPictureInPicture;
    this.pipWindow = await pipWindowApi.requestWindow({
      width: PIP_WIDTH,
      height: PIP_HEIGHT,
    });

    if (!this.pipWindow) return;

    const doc = this.pipWindow.document;

    // Inject fonts
    const fontLink = doc.createElement('link');
    fontLink.rel = 'stylesheet';
    fontLink.href = 'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap';
    doc.head.appendChild(fontLink);

    // Inject xterm.js CSS
    const xtermCss = doc.createElement('link');
    xtermCss.rel = 'stylesheet';
    xtermCss.href = 'https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.css';
    doc.head.appendChild(xtermCss);

    // Inject PiP styles
    const style = doc.createElement('style');
    style.textContent = this.getStyles();
    doc.head.appendChild(style);

    // Set title
    doc.title = 'Claude Remote - PiP';

    // Build DOM
    const root = doc.createElement('div');
    root.id = 'pip-root';

    this.headerEl = doc.createElement('div');
    this.headerEl.id = 'pip-header';
    root.appendChild(this.headerEl);

    const termContainer = doc.createElement('div');
    termContainer.id = 'pip-terminal-container';
    root.appendChild(termContainer);

    doc.body.appendChild(root);

    // Build header elements once, wire listeners, then populate
    this.buildHeader(doc);
    this.updateHeader();

    // Load xterm.js scripts sequentially, aborting if PiP window is closed mid-load
    try {
      await this.loadScript(doc, 'https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.min.js');
      if (!this.isOpen()) return;
      await this.loadScript(doc, 'https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.min.js');
      if (!this.isOpen()) return;
      await this.loadScript(doc, 'https://cdn.jsdelivr.net/npm/xterm-addon-web-links@0.9.0/lib/xterm-addon-web-links.min.js');
      if (!this.isOpen()) return;
    } catch (err) {
      console.error('PiP: failed to load xterm.js scripts', err);
      this.close();
      return;
    }

    // Create terminal using PiP window's constructors
    const pipWin = this.pipWindow as any;
    // Slightly smaller font for compact PiP view
    this.terminal = new pipWin.Terminal({
      cursorBlink: true,
      cursorStyle: 'block',
      fontSize: 13,
      fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", Menlo, Monaco, "Courier New", monospace',
      lineHeight: 1.2,
      theme: TERMINAL_THEME,
    });

    this.fitAddon = new pipWin.FitAddon.FitAddon();
    this.terminal.loadAddon(this.fitAddon);

    const webLinksAddon = new pipWin.WebLinksAddon.WebLinksAddon();
    this.terminal.loadAddon(webLinksAddon);

    this.terminal.open(termContainer);

    // Fit terminal
    try { this.fitAddon.fit(); } catch {}

    // Handle terminal input - send to session via own WebSocket
    this.terminal.onData((data: string) => {
      if (this.currentSessionId && this.ws?.readyState === WebSocket.OPEN) {
        this.wsSend('terminal.data', { sessionId: this.currentSessionId, data });
      }
    });

    // Resize observer for fit
    this.resizeObserver = new ResizeObserver(() => {
      try { this.fitAddon?.fit(); } catch {}
    });
    this.resizeObserver.observe(termContainer);

    // Handle PiP window close
    this.pipWindow.addEventListener('pagehide', () => this.dispose());

    // Handle PiP window resize
    this.pipWindow.addEventListener('resize', () => {
      try { this.fitAddon?.fit(); } catch {}
    });

    // Connect own WebSocket and attach to session.
    // Inside try block so failures during open() are caught and cleaned up.
    try {
      this.connectWebSocket(sessionId);
    } catch (err) {
      console.error('PiP: failed to connect WebSocket', err);
      this.close();
    }
  }

  close(): void {
    if (this.pipWindow && !this.pipWindow.closed) {
      this.pipWindow.close();
    }
    this.dispose();
  }

  private dispose(): void {
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    if (this.terminal) {
      this.terminal.dispose();
      this.terminal = null;
    }
    this.fitAddon = null;
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      this.ws.onopen = null;
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close();
      }
      this.ws = null;
    }
    this.pipWindow = null;
    this.headerEl = null;
    this.badgeEl = null;
    this.nameEl = null;
    this.selectEl = null;
    this.currentSessionId = null;
  }

  switchSession(sessionId: string): void {
    if (sessionId === this.currentSessionId) return;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    // Detach from current session
    if (this.currentSessionId) {
      this.wsSend('session.detach', { sessionId: this.currentSessionId });
    }

    // Clear terminal
    if (this.terminal) {
      this.terminal.clear();
      this.terminal.write('\x1b[2J\x1b[H'); // Clear screen + home
    }

    this.currentSessionId = sessionId;
    this.wsSend('session.attach', { sessionId });
    this.updateHeader();
  }

  updateSessions(sessions: ReadonlyMap<string, PipSessionInfo>, notifications: ReadonlyMap<string, PipNotification>): void {
    // Store references - the caller (SessionManager) owns these maps.
    // PiP only reads them for rendering; its own WS handlers mutate the local copy made in open().
    this.sessions = sessions as Map<string, PipSessionInfo>;
    this.notifications = notifications as Map<string, PipNotification>;
    if (this.isOpen()) {
      this.updateHeader();
    }
  }

  private connectWebSocket(sessionId: string): void {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      this.currentSessionId = sessionId;
      this.wsSend('session.list');
      this.wsSend('session.attach', { sessionId });
    };

    this.ws.onmessage = (event) => {
      this.handleMessage(event.data);
    };

    this.ws.onclose = () => {
      // Don't reconnect - PiP is a secondary view
    };

    this.ws.onerror = () => {};
  }

  private messageId = 0;

  private wsSend(type: string, payload?: any): void {
    const id = String(++this.messageId);
    const message = JSON.stringify({ type, id, payload });
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(message);
    }
  }

  private handleMessage(data: string): void {
    let message: any;
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }

    switch (message.type) {
      case 'session.attached':
        if (message.payload?.scrollback && this.terminal) {
          this.terminal.write(message.payload.scrollback);
        }
        // Update session name in header
        if (message.payload?.session) {
          this.currentSessionId = message.payload.session.id;
          this.updateHeader();
        }
        break;

      case 'terminal.data':
        if (message.payload?.sessionId === this.currentSessionId && this.terminal) {
          this.terminal.write(message.payload.data);
        }
        break;

      case 'terminal.exit':
        if (message.payload?.sessionId === this.currentSessionId && this.terminal) {
          this.terminal.write(`\r\n[Process exited with code ${message.payload.exitCode}]`);
        }
        break;

      case 'notification':
        if (message.payload && VALID_NOTIFICATION_TYPES.includes(message.payload.type)) {
          this.notifications.set(message.payload.sessionId, {
            type: message.payload.type as NotificationType,
            timestamp: message.payload.timestamp,
          });
          this.updateHeader();
        }
        break;

      case 'session.list':
        if (message.payload?.sessions) {
          for (const s of message.payload.sessions) {
            this.sessions.set(s.id, s);
          }
          this.updateHeader();
        }
        break;

      case 'session.renamed':
        if (message.payload) {
          const session = this.sessions.get(message.payload.sessionId);
          if (session) {
            session.name = message.payload.name;
            this.updateHeader();
          }
        }
        break;

      case 'session.terminated':
        if (message.payload) {
          const session = this.sessions.get(message.payload.sessionId);
          if (session) {
            session.status = 'terminated';
            this.updateHeader();
          }
        }
        break;
    }
  }

  /** Create header elements once and wire event listeners. */
  private buildHeader(doc: Document): void {
    if (!this.headerEl) return;

    // Badge (always present in DOM, hidden when no notification)
    this.badgeEl = doc.createElement('span');
    this.badgeEl.className = 'pip-badge';
    this.badgeEl.style.display = 'none';
    this.headerEl.appendChild(this.badgeEl);

    // Session name
    this.nameEl = doc.createElement('span');
    this.nameEl.className = 'pip-session-name';
    this.headerEl.appendChild(this.nameEl);

    // Session switcher
    this.selectEl = doc.createElement('select');
    this.selectEl.className = 'pip-session-select';
    this.selectEl.title = 'Switch session';
    this.selectEl.addEventListener('change', () => {
      if (this.selectEl?.value) this.switchSession(this.selectEl.value);
    });
    this.headerEl.appendChild(this.selectEl);

    // Close button (static, never updated)
    const closeBtn = doc.createElement('button');
    closeBtn.className = 'pip-close-btn';
    closeBtn.title = 'Close PiP';
    closeBtn.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <line x1="18" y1="6" x2="6" y2="18"></line>
        <line x1="6" y1="6" x2="18" y2="18"></line>
      </svg>`;
    closeBtn.addEventListener('click', () => this.close());
    this.headerEl.appendChild(closeBtn);
  }

  /** Update header content without recreating elements or re-wiring listeners. */
  private updateHeader(): void {
    if (!this.nameEl || !this.badgeEl || !this.selectEl) return;
    if (!this.pipWindow || this.pipWindow.closed) return;

    // Update session name
    const currentSession = this.currentSessionId ? this.sessions.get(this.currentSessionId) : null;
    const sessionName = currentSession?.name || 'No session';
    this.nameEl.textContent = sessionName;
    this.nameEl.title = sessionName;

    // Update badge
    const notification = this.currentSessionId ? this.notifications.get(this.currentSessionId) : null;
    const validType = notification && VALID_NOTIFICATION_TYPES.includes(notification.type) ? notification.type : null;
    if (validType) {
      this.badgeEl.className = `pip-badge ${validType}`;
      this.badgeEl.style.display = '';
    } else {
      this.badgeEl.style.display = 'none';
    }

    // Update select options (rebuild children but keep the <select> element itself)
    const sortedSessions = Array.from(this.sessions.values())
      .filter(s => s.attachable)
      .sort((a, b) => a.name.localeCompare(b.name));

    // Only rebuild options if the session list or notifications changed
    const doc = this.selectEl.ownerDocument;
    this.selectEl.textContent = ''; // clear existing options
    for (const s of sortedSessions) {
      const opt = doc.createElement('option');
      opt.value = s.id;
      const notif = this.notifications.get(s.id);
      const notifIndicator = notif ? (notif.type === 'needs-input' ? ' \u26a0' : ' \u2713') : '';
      opt.textContent = s.name + notifIndicator;
      if (s.id === this.currentSessionId) opt.selected = true;
      this.selectEl.appendChild(opt);
    }
  }

  private loadScript(doc: Document, src: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const script = doc.createElement('script');
      script.src = src;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error(`Failed to load ${src}`));
      doc.head.appendChild(script);
    });
  }

  private getStyles(): string {
    return `
      * {
        margin: 0;
        padding: 0;
        box-sizing: border-box;
      }

      body {
        font-family: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, sans-serif;
        background: #1a1b26;
        color: #c0caf5;
        overflow: hidden;
        -webkit-font-smoothing: antialiased;
      }

      #pip-root {
        display: flex;
        flex-direction: column;
        height: 100vh;
        width: 100vw;
      }

      #pip-header {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 6px 10px;
        height: 32px;
        background: linear-gradient(180deg, #24283b 0%, #1f2335 100%);
        border-bottom: 1px solid #414868;
        flex-shrink: 0;
        user-select: none;
        -webkit-app-region: drag;
      }

      .pip-session-name {
        font-family: 'JetBrains Mono', monospace;
        font-size: 11px;
        font-weight: 600;
        color: #c0caf5;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        flex: 1;
        min-width: 0;
      }

      .pip-session-select {
        -webkit-app-region: no-drag;
        background: #1a1b26;
        border: 1px solid #414868;
        color: #9aa5ce;
        font-family: 'JetBrains Mono', monospace;
        font-size: 10px;
        padding: 2px 4px;
        border-radius: 4px;
        cursor: pointer;
        max-width: 120px;
        outline: none;
      }

      .pip-session-select:hover {
        border-color: #7aa2f7;
        color: #c0caf5;
      }

      .pip-session-select:focus {
        border-color: #7aa2f7;
        box-shadow: 0 0 0 1px rgba(122, 162, 247, 0.3);
      }

      .pip-close-btn {
        -webkit-app-region: no-drag;
        background: transparent;
        border: none;
        color: #565f89;
        cursor: pointer;
        padding: 3px;
        border-radius: 4px;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: all 0.15s ease;
        flex-shrink: 0;
      }

      .pip-close-btn:hover {
        background: #f7768e;
        color: white;
      }

      .pip-badge {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        flex-shrink: 0;
      }

      .pip-badge.needs-input {
        background: #e0af68;
        box-shadow: 0 0 6px rgba(224, 175, 104, 0.5);
        animation: pip-pulse 1.5s ease-in-out infinite;
      }

      .pip-badge.completed {
        background: #9ece6a;
        box-shadow: 0 0 6px rgba(158, 206, 106, 0.5);
      }

      @keyframes pip-pulse {
        0%, 100% { opacity: 1; transform: scale(1); }
        50% { opacity: 0.7; transform: scale(1.15); }
      }

      #pip-terminal-container {
        flex: 1;
        background: #16161e;
        overflow: hidden;
        padding: 4px;
      }

      #pip-terminal-container .xterm {
        height: 100%;
      }

      /* Option styling for notification indicators */
      .pip-session-select option {
        background: #1a1b26;
        color: #c0caf5;
      }
    `;
  }
}

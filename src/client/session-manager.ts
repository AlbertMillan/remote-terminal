// Session and WebSocket management
import { terminalManager, TerminalManager } from './terminal.js';

interface SessionInfo {
  id: string;
  name: string;
  shell: string;
  cwd: string;
  createdAt: string;
  lastAccessedAt: string;
  status: string;
  cols: number;
  rows: number;
  attachable: boolean;
}

// Type-safe server message definitions (issue #14)
interface AuthSuccessPayload {
  userId: string;
  loginName: string;
  displayName: string;
}

interface AuthFailurePayload {
  message: string;
}

interface SessionListPayload {
  sessions: SessionInfo[];
}

interface SessionCreatedPayload {
  session: SessionInfo;
}

interface SessionAttachedPayload {
  session: SessionInfo;
  scrollback: string;
}

interface SessionTerminatedPayload {
  sessionId: string;
}

interface SessionDeletedPayload {
  sessionId: string;
}

interface SessionRenamedPayload {
  sessionId: string;
  name: string;
}

interface TerminalDataPayload {
  sessionId: string;
  data: string;
}

interface TerminalExitPayload {
  sessionId: string;
  exitCode: number;
}

interface ErrorPayload {
  message: string;
}

type ServerMessage =
  | { type: 'auth.success'; id?: string; payload: AuthSuccessPayload }
  | { type: 'auth.failure'; id?: string; payload: AuthFailurePayload }
  | { type: 'session.list'; id?: string; payload: SessionListPayload }
  | { type: 'session.created'; id?: string; payload: SessionCreatedPayload }
  | { type: 'session.attached'; id?: string; payload: SessionAttachedPayload }
  | { type: 'session.terminated'; id?: string; payload: SessionTerminatedPayload }
  | { type: 'session.deleted'; id?: string; payload: SessionDeletedPayload }
  | { type: 'session.renamed'; id?: string; payload: SessionRenamedPayload }
  | { type: 'session.error'; id?: string; payload: ErrorPayload }
  | { type: 'terminal.data'; id?: string; payload: TerminalDataPayload }
  | { type: 'terminal.exit'; id?: string; payload: TerminalExitPayload }
  | { type: 'error'; id?: string; payload: ErrorPayload }
  | { type: 'pong'; id?: string; payload?: undefined };

type ConnectionStatus = 'disconnected' | 'connecting' | 'connected';

class SessionManager {
  private ws: WebSocket | null = null;
  private sessions: Map<string, SessionInfo> = new Map();
  private currentSessionId: string | null = null;
  private previousSessionId: string | null = null; // For reconnection (issue #7)
  private messageId = 0;
  private pendingRequests: Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }> = new Map();
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000;
  private terminalMgr: TerminalManager; // Use imported module instead of window (issue #12)

  constructor(terminal: TerminalManager = terminalManager) {
    this.terminalMgr = terminal;
    this.setupEventListeners();
    this.connect();
  }

  private setupEventListeners(): void {
    // Mobile menu toggle
    const mobileMenuBtn = document.getElementById('mobile-menu-btn');
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebar-overlay');

    mobileMenuBtn?.addEventListener('click', () => {
      sidebar?.classList.toggle('open');
      overlay?.classList.toggle('open');
      mobileMenuBtn?.classList.toggle('hidden');
    });

    overlay?.addEventListener('click', () => {
      sidebar?.classList.remove('open');
      overlay?.classList.remove('open');
      mobileMenuBtn?.classList.remove('hidden');
    });

    // New session buttons
    document.getElementById('new-session-btn')?.addEventListener('click', () => this.showNewSessionModal());
    document.getElementById('welcome-new-session-btn')?.addEventListener('click', () => this.showNewSessionModal());

    // New session modal
    document.getElementById('new-session-cancel')?.addEventListener('click', () => this.hideNewSessionModal());
    document.getElementById('new-session-confirm')?.addEventListener('click', () => this.createSessionFromModal());

    // Rename modal
    document.getElementById('rename-cancel')?.addEventListener('click', () => this.hideRenameModal());
    document.getElementById('rename-confirm')?.addEventListener('click', () => this.confirmRename());

    // Terminal header controls
    document.getElementById('rename-session-btn')?.addEventListener('click', () => this.showRenameModal());
    document.getElementById('terminate-session-btn')?.addEventListener('click', () => this.terminateCurrentSession());

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.hideNewSessionModal();
        this.hideRenameModal();
      }
    });

    // Modal backdrop clicks
    document.getElementById('new-session-modal')?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) this.hideNewSessionModal();
    });
    document.getElementById('rename-modal')?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) this.hideRenameModal();
    });
  }

  private connect(): void {
    this.updateConnectionStatus('connecting');

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      console.log('WebSocket connected');
      this.reconnectAttempts = 0;
      this.updateConnectionStatus('connected');
      this.listSessions();

      // Re-attach to previous session on reconnect (issue #7)
      if (this.previousSessionId) {
        const sessionToReattach = this.previousSessionId;
        this.previousSessionId = null;
        // Delay slightly to allow session list to load first
        setTimeout(() => {
          if (this.sessions.has(sessionToReattach)) {
            console.log('Re-attaching to previous session:', sessionToReattach);
            this.attachToSession(sessionToReattach);
          }
        }, 100);
      }
    };

    this.ws.onclose = () => {
      console.log('WebSocket disconnected');
      this.updateConnectionStatus('disconnected');
      // Save current session for re-attachment on reconnect (issue #7)
      if (this.currentSessionId) {
        this.previousSessionId = this.currentSessionId;
      }
      this.attemptReconnect();
    };

    this.ws.onerror = (error) => {
      console.error('WebSocket error:', error);
    };

    this.ws.onmessage = (event) => {
      this.handleMessage(event.data);
    };
  }

  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.log('Max reconnect attempts reached');
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
    console.log(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

    setTimeout(() => this.connect(), delay);
  }

  private send(type: string, payload?: any): string {
    const id = String(++this.messageId);
    const message = JSON.stringify({ type, id, payload });

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(message);
    }

    return id;
  }

  private sendRequest(type: string, payload?: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = this.send(type, payload);
      this.pendingRequests.set(id, { resolve, reject });

      // Timeout after 30 seconds
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error('Request timeout'));
        }
      }, 30000);
    });
  }

  private handleMessage(data: string): void {
    let message: ServerMessage;
    try {
      message = JSON.parse(data);
    } catch {
      console.error('Invalid message:', data);
      return;
    }

    // Handle pending request responses (issue #4 - reject on error)
    if (message.id && this.pendingRequests.has(message.id)) {
      const { resolve, reject } = this.pendingRequests.get(message.id)!;
      this.pendingRequests.delete(message.id);

      // Reject if this is an error response
      if (message.type === 'error' || message.type === 'session.error') {
        const errorPayload = message.payload as ErrorPayload;
        reject(new Error(errorPayload?.message || 'Request failed'));
        return;
      }

      resolve(message.payload);
    }

    // Handle message types
    switch (message.type) {
      case 'auth.success':
        this.handleAuthSuccess(message.payload);
        break;
      case 'auth.failure':
        this.handleAuthFailure(message.payload);
        break;
      case 'session.list':
        this.handleSessionList(message.payload);
        break;
      case 'session.created':
        this.handleSessionCreated(message.payload);
        break;
      case 'session.attached':
        this.handleSessionAttached(message.payload);
        break;
      case 'session.terminated':
        this.handleSessionTerminated(message.payload);
        break;
      case 'session.deleted':
        this.handleSessionDeleted(message.payload);
        break;
      case 'session.renamed':
        this.handleSessionRenamed(message.payload);
        break;
      case 'terminal.data':
        this.handleTerminalData(message.payload);
        break;
      case 'terminal.exit':
        this.handleTerminalExit(message.payload);
        break;
      case 'session.error':
        this.handleSessionError(message.payload);
        break;
      case 'error':
        console.error('Server error:', message.payload);
        break;
    }
  }

  private handleSessionError(payload: ErrorPayload): void {
    console.error('Session error:', payload.message);
    // Show error to user - for now use alert, could be improved with toast notification
    alert('Session error: ' + payload.message);
  }

  private handleAuthSuccess(payload: any): void {
    const userNameEl = document.getElementById('user-name');
    if (userNameEl) {
      userNameEl.textContent = payload.displayName || payload.loginName || 'Connected';
    }
  }

  private handleAuthFailure(payload: any): void {
    alert('Authentication failed: ' + payload.message);
    this.ws?.close();
  }

  private handleSessionList(payload: { sessions: SessionInfo[] }): void {
    this.sessions.clear();
    for (const session of payload.sessions) {
      this.sessions.set(session.id, session);
    }
    this.renderSessionList();
  }

  private handleSessionCreated(payload: { session: SessionInfo }): void {
    this.sessions.set(payload.session.id, payload.session);
    this.renderSessionList();
    this.attachToSession(payload.session.id);
  }

  private handleSessionAttached(payload: { session: SessionInfo; scrollback: string }): void {
    this.currentSessionId = payload.session.id;
    this.sessions.set(payload.session.id, payload.session);
    this.renderSessionList();
    this.showTerminal(payload.session);

    // Initialize terminal
    const container = document.getElementById('terminal-container');
    if (container && this.terminalMgr) {
      // Clear previous terminal if any
      container.innerHTML = '';

      this.terminalMgr.initialize({
        container,
        onData: (data: string) => this.sendTerminalData(data),
        onResize: (cols: number, rows: number) => this.sendTerminalResize(cols, rows),
      });

      // Write scrollback
      if (payload.scrollback) {
        this.terminalMgr.write(payload.scrollback);
      }

      // Send initial resize
      const dims = this.terminalMgr.getDimensions();
      this.sendTerminalResize(dims.cols, dims.rows);
    }
  }

  private handleSessionTerminated(payload: { sessionId: string }): void {
    const session = this.sessions.get(payload.sessionId);
    if (session) {
      session.status = 'terminated';
      this.sessions.set(payload.sessionId, session);
    }
    this.renderSessionList();

    if (this.currentSessionId === payload.sessionId) {
      this.showWelcomeScreen();
    }
  }

  private handleSessionDeleted(payload: { sessionId: string }): void {
    this.sessions.delete(payload.sessionId);
    this.renderSessionList();

    if (this.currentSessionId === payload.sessionId) {
      this.showWelcomeScreen();
    }
  }

  private handleSessionRenamed(payload: { sessionId: string; name: string }): void {
    const session = this.sessions.get(payload.sessionId);
    if (session) {
      session.name = payload.name;
      this.sessions.set(payload.sessionId, session);
    }
    this.renderSessionList();

    if (this.currentSessionId === payload.sessionId) {
      const nameEl = document.getElementById('session-name');
      if (nameEl) nameEl.textContent = payload.name;
    }
  }

  private handleTerminalData(payload: { sessionId: string; data: string }): void {
    if (payload.sessionId === this.currentSessionId && this.terminalMgr) {
      this.terminalMgr.write(payload.data);
    }
  }

  private handleTerminalExit(payload: { sessionId: string; exitCode: number }): void {
    if (payload.sessionId === this.currentSessionId && this.terminalMgr) {
      this.terminalMgr.writeln(`\r\n[Process exited with code ${payload.exitCode}]`);
    }
  }

  private updateConnectionStatus(status: ConnectionStatus): void {
    const statusEl = document.getElementById('connection-status');
    if (statusEl) {
      statusEl.className = `status ${status}`;
      const textEl = statusEl.querySelector('.status-text');
      if (textEl) {
        textEl.textContent = status.charAt(0).toUpperCase() + status.slice(1);
      }
    }
  }

  private renderSessionList(): void {
    const listEl = document.getElementById('session-list');
    if (!listEl) return;

    listEl.innerHTML = '';

    const sortedSessions = Array.from(this.sessions.values()).sort(
      (a, b) => new Date(b.lastAccessedAt).getTime() - new Date(a.lastAccessedAt).getTime()
    );

    for (const session of sortedSessions) {
      const li = document.createElement('li');
      li.className = 'session-item';
      if (session.id === this.currentSessionId) li.classList.add('active');
      if (session.status === 'terminated') li.classList.add('terminated');
      if (!session.attachable) li.classList.add('not-attachable');

      // Show delete button for non-attachable sessions (terminated or stale)
      const showDeleteBtn = !session.attachable;

      li.innerHTML = `
        <span class="session-icon">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="4 17 10 11 4 5"></polyline>
            <line x1="12" y1="19" x2="20" y2="19"></line>
          </svg>
        </span>
        <div class="session-info">
          <div class="session-name">${this.escapeHtml(session.name)}</div>
          <div class="session-status">${session.status}${!session.attachable && session.status !== 'terminated' ? ' (stale)' : ''}</div>
        </div>
        ${showDeleteBtn ? `
          <button class="session-delete-btn" title="Remove session" data-session-id="${session.id}">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="3 6 5 6 21 6"></polyline>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
            </svg>
          </button>
        ` : ''}
      `;

      // Add click handler for session selection (attachable only)
      li.addEventListener('click', (e) => {
        // Don't trigger if clicking delete button
        if ((e.target as HTMLElement).closest('.session-delete-btn')) return;

        if (session.attachable) {
          this.attachToSession(session.id);
          // Close mobile sidebar
          document.getElementById('sidebar')?.classList.remove('open');
          document.getElementById('sidebar-overlay')?.classList.remove('open');
          document.getElementById('mobile-menu-btn')?.classList.remove('hidden');
        }
      });

      // Add click handler for delete button
      const deleteBtn = li.querySelector('.session-delete-btn');
      deleteBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        this.deleteSession(session.id);
      });

      listEl.appendChild(li);
    }
  }

  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  private showTerminal(session: SessionInfo): void {
    document.getElementById('welcome-screen')?.classList.add('hidden');
    document.getElementById('terminal-container')?.classList.remove('hidden');
    document.getElementById('terminal-header')?.classList.remove('hidden');

    const nameEl = document.getElementById('session-name');
    if (nameEl) nameEl.textContent = session.name;
  }

  private showWelcomeScreen(): void {
    this.currentSessionId = null;
    if (this.terminalMgr) {
      this.terminalMgr.dispose();
    }

    document.getElementById('terminal-container')?.classList.add('hidden');
    document.getElementById('terminal-header')?.classList.add('hidden');
    document.getElementById('welcome-screen')?.classList.remove('hidden');

    this.renderSessionList();
  }

  // Public methods

  listSessions(): void {
    this.send('session.list');
  }

  createSession(name?: string, cwd?: string): void {
    this.send('session.create', { name, cwd });
  }

  attachToSession(sessionId: string): void {
    if (this.currentSessionId === sessionId) return;

    // Detach from current session
    if (this.currentSessionId) {
      this.send('session.detach', { sessionId: this.currentSessionId });
      if (this.terminalMgr) {
        this.terminalMgr.dispose();
      }
    }

    this.send('session.attach', { sessionId });
  }

  terminateSession(sessionId: string): void {
    if (confirm('Are you sure you want to terminate this session?')) {
      this.send('session.terminate', { sessionId });
    }
  }

  deleteSession(sessionId: string): void {
    this.send('session.delete', { sessionId });
  }

  renameSession(sessionId: string, name: string): void {
    this.send('session.rename', { sessionId, name });
  }

  sendTerminalData(data: string): void {
    if (this.currentSessionId) {
      this.send('terminal.data', { sessionId: this.currentSessionId, data });
    }
  }

  sendTerminalResize(cols: number, rows: number): void {
    if (this.currentSessionId) {
      this.send('terminal.resize', { sessionId: this.currentSessionId, cols, rows });
    }
  }

  // Modal handlers

  private showNewSessionModal(): void {
    const modal = document.getElementById('new-session-modal');
    if (modal) {
      modal.classList.remove('hidden');
      (document.getElementById('session-name-input') as HTMLInputElement).value = '';
      (document.getElementById('session-cwd-input') as HTMLInputElement).value = '';
      document.getElementById('session-name-input')?.focus();
    }
  }

  private hideNewSessionModal(): void {
    document.getElementById('new-session-modal')?.classList.add('hidden');
  }

  private createSessionFromModal(): void {
    const nameInput = document.getElementById('session-name-input') as HTMLInputElement;
    const cwdInput = document.getElementById('session-cwd-input') as HTMLInputElement;

    const name = nameInput.value.trim() || undefined;
    const cwd = cwdInput.value.trim() || undefined;

    this.createSession(name, cwd);
    this.hideNewSessionModal();
  }

  private showRenameModal(): void {
    if (!this.currentSessionId) return;

    const session = this.sessions.get(this.currentSessionId);
    if (!session) return;

    const modal = document.getElementById('rename-modal');
    const input = document.getElementById('rename-input') as HTMLInputElement;

    if (modal && input) {
      modal.classList.remove('hidden');
      input.value = session.name;
      input.focus();
      input.select();
    }
  }

  private hideRenameModal(): void {
    document.getElementById('rename-modal')?.classList.add('hidden');
  }

  private confirmRename(): void {
    if (!this.currentSessionId) return;

    const input = document.getElementById('rename-input') as HTMLInputElement;
    const name = input.value.trim();

    if (name) {
      this.renameSession(this.currentSessionId, name);
    }

    this.hideRenameModal();
  }

  private terminateCurrentSession(): void {
    if (this.currentSessionId) {
      this.terminateSession(this.currentSessionId);
    }
  }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  (window as any).sessionManager = new SessionManager();
});

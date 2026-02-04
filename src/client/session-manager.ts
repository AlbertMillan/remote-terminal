// Session and WebSocket management
import { terminalManager, TerminalManager } from './terminal.js';

// Configuration constants
const REQUEST_TIMEOUT_MS = 30000;
const NOTIFICATION_AUTO_CLOSE_MS = 10000;
const RECONNECT_BASE_DELAY_MS = 1000;
const MAX_RECONNECT_ATTEMPTS = 5;
const SESSION_REATTACH_DELAY_MS = 100;

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
  categoryId: string | null;
}

interface CategoryInfo {
  id: string;
  name: string;
  sortOrder: number;
  collapsed: boolean;
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

interface SessionMovedPayload {
  sessionId: string;
  categoryId: string | null;
}

interface CategoryCreatedPayload {
  category: CategoryInfo;
}

interface CategoryRenamedPayload {
  categoryId: string;
  name: string;
}

interface CategoryDeletedPayload {
  categoryId: string;
}

interface CategoryReorderedPayload {
  categories: { id: string; sortOrder: number }[];
}

interface CategoryToggledPayload {
  categoryId: string;
  collapsed: boolean;
}

interface CategoryListPayload {
  categories: CategoryInfo[];
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

interface NotificationPreferencesPayload {
  browserEnabled: boolean;
  visualEnabled: boolean;
  notifyOnInput: boolean;
  notifyOnCompleted: boolean;
}

interface NotificationPayload {
  sessionId: string;
  type: 'needs-input' | 'completed';
  timestamp: string;
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
  | { type: 'session.moved'; id?: string; payload: SessionMovedPayload }
  | { type: 'session.error'; id?: string; payload: ErrorPayload }
  | { type: 'terminal.data'; id?: string; payload: TerminalDataPayload }
  | { type: 'terminal.exit'; id?: string; payload: TerminalExitPayload }
  | { type: 'category.created'; id?: string; payload: CategoryCreatedPayload }
  | { type: 'category.renamed'; id?: string; payload: CategoryRenamedPayload }
  | { type: 'category.deleted'; id?: string; payload: CategoryDeletedPayload }
  | { type: 'category.reordered'; id?: string; payload: CategoryReorderedPayload }
  | { type: 'category.toggled'; id?: string; payload: CategoryToggledPayload }
  | { type: 'category.list'; id?: string; payload: CategoryListPayload }
  | { type: 'notification.preferences'; id?: string; payload: NotificationPreferencesPayload }
  | { type: 'notification.preferences.updated'; id?: string; payload: NotificationPreferencesPayload }
  | { type: 'notification'; id?: string; payload: NotificationPayload }
  | { type: 'error'; id?: string; payload: ErrorPayload }
  | { type: 'pong'; id?: string; payload?: undefined };

type ConnectionStatus = 'disconnected' | 'connecting' | 'connected';

class SessionManager {
  private ws: WebSocket | null = null;
  private sessions: Map<string, SessionInfo> = new Map();
  private categories: Map<string, CategoryInfo> = new Map();
  private currentSessionId: string | null = null;
  private previousSessionId: string | null = null; // For reconnection (issue #7)
  private attachingSessionId: string | null = null; // Prevents duplicate attach requests
  private messageId = 0;
  private pendingRequests: Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }> = new Map();
  private reconnectAttempts = 0;
  private maxReconnectAttempts = MAX_RECONNECT_ATTEMPTS;
  private reconnectDelay = RECONNECT_BASE_DELAY_MS;
  private terminalMgr: TerminalManager; // Use imported module instead of window (issue #12)
  private draggedSessionId: string | null = null;

  // Notification state
  private sessionNotifications: Map<string, { type: 'needs-input' | 'completed'; timestamp: string }> = new Map();
  private notificationPreferences: NotificationPreferencesPayload = {
    browserEnabled: true,
    visualEnabled: true,
    notifyOnInput: true,
    notifyOnCompleted: true,
  };
  private browserNotificationsPermission: 'default' | 'granted' | 'denied' = 'default';

  // Mobile navigation state
  private mobileNavVisible = true;

  constructor(terminal: TerminalManager = terminalManager) {
    this.terminalMgr = terminal;
    this.setupEventListeners();
    this.setupMobileNavigation();
    this.initBrowserNotifications();
    this.connect();
  }

  private initBrowserNotifications(): void {
    if ('Notification' in window) {
      this.browserNotificationsPermission = window.Notification.permission as 'default' | 'granted' | 'denied';
    }
  }

  private async requestNotificationPermission(): Promise<boolean> {
    if (!('Notification' in window)) {
      return false;
    }

    if (window.Notification.permission === 'granted') {
      this.browserNotificationsPermission = 'granted';
      return true;
    }

    if (window.Notification.permission === 'denied') {
      this.browserNotificationsPermission = 'denied';
      return false;
    }

    const result = await window.Notification.requestPermission();
    this.browserNotificationsPermission = result as 'default' | 'granted' | 'denied';
    return result === 'granted';
  }

  private showBrowserNotification(title: string, body: string, sessionId: string): void {
    if (this.browserNotificationsPermission !== 'granted') return;
    if (!this.notificationPreferences.browserEnabled) return;
    if (document.hasFocus()) return; // Don't show if tab is focused

    const notification = new window.Notification(title, {
      body,
      icon: '/favicon.ico',
      tag: `session-${sessionId}`,
    });

    notification.onclick = () => {
      window.focus();
      this.attachToSession(sessionId);
      notification.close();
    };

    // Auto-close notification after timeout
    setTimeout(() => notification.close(), NOTIFICATION_AUTO_CLOSE_MS);
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

    // Category modal
    document.getElementById('category-cancel')?.addEventListener('click', () => this.hideCategoryModal());
    document.getElementById('category-confirm')?.addEventListener('click', () => this.confirmCategoryAction());

    // Settings modal
    document.getElementById('settings-btn')?.addEventListener('click', () => this.showSettingsModal());
    document.getElementById('settings-cancel')?.addEventListener('click', () => this.hideSettingsModal());
    document.getElementById('settings-save')?.addEventListener('click', () => this.saveSettings());

    // Terminal header controls
    document.getElementById('rename-session-btn')?.addEventListener('click', () => this.showRenameModal());
    document.getElementById('terminate-session-btn')?.addEventListener('click', () => this.terminateCurrentSession());

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.hideNewSessionModal();
        this.hideRenameModal();
        this.hideCategoryModal();
        this.hideSettingsModal();
      }
    });

    // Modal backdrop clicks
    document.getElementById('new-session-modal')?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) this.hideNewSessionModal();
    });
    document.getElementById('rename-modal')?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) this.hideRenameModal();
    });
    document.getElementById('category-modal')?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) this.hideCategoryModal();
    });
    document.getElementById('settings-modal')?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) this.hideSettingsModal();
    });
  }

  private setupMobileNavigation(): void {
    const navToggle = document.getElementById('mobile-nav-toggle');
    const navBar = document.getElementById('mobile-nav-bar');

    if (!navToggle || !navBar) return;

    // Load saved preference (default to visible)
    const savedPref = localStorage.getItem('mobileNavVisible');
    this.mobileNavVisible = savedPref === null ? true : savedPref === 'true';
    this.updateMobileNavVisibility();

    // Toggle button handlers
    navToggle.addEventListener('touchstart', (e) => {
      e.preventDefault();
      this.toggleMobileNav();
    }, { passive: false });

    navToggle.addEventListener('click', () => this.toggleMobileNav());

    // Navigation key button handlers
    const navKeys = navBar.querySelectorAll('.mobile-nav-key');
    navKeys.forEach((btn) => {
      const handleKeyPress = () => {
        const key = (btn as HTMLElement).dataset.key;
        if (key) {
          this.sendKeyToTerminal(key);
        }
      };

      // Touch events for mobile
      btn.addEventListener('touchstart', (e) => {
        e.preventDefault();
        this.preventTerminalKeyboard();
        (document.activeElement as HTMLElement)?.blur();
        (btn as HTMLElement).classList.add('active');
      }, { passive: false });

      btn.addEventListener('touchend', (e) => {
        e.preventDefault();
        (btn as HTMLElement).classList.remove('active');
        handleKeyPress();
        setTimeout(() => this.allowTerminalKeyboard(), 300);
      }, { passive: false });

      btn.addEventListener('touchcancel', () => {
        (btn as HTMLElement).classList.remove('active');
        setTimeout(() => this.allowTerminalKeyboard(), 300);
      });

      // Mouse events for desktop
      btn.addEventListener('mousedown', (e) => e.preventDefault());
      btn.addEventListener('click', handleKeyPress);
    });
  }

  private toggleMobileNav(): void {
    this.mobileNavVisible = !this.mobileNavVisible;
    localStorage.setItem('mobileNavVisible', String(this.mobileNavVisible));
    this.updateMobileNavVisibility();
  }

  private updateMobileNavVisibility(): void {
    const navToggle = document.getElementById('mobile-nav-toggle');
    const navBar = document.getElementById('mobile-nav-bar');
    const mainContent = document.getElementById('main-content');

    if (this.mobileNavVisible) {
      navBar?.classList.add('visible');
      navToggle?.classList.add('hidden');
      mainContent?.classList.add('mobile-nav-active');
    } else {
      navBar?.classList.remove('visible');
      navToggle?.classList.remove('hidden');
      mainContent?.classList.remove('mobile-nav-active');
    }

    // Trigger terminal resize after visibility change
    setTimeout(() => {
      this.terminalMgr?.fit();
    }, 350); // Wait for CSS transition to complete
  }

  private sendKeyToTerminal(key: string): void {
    if (!this.currentSessionId) return;

    // Map key names to ANSI escape sequences
    const keyMap: Record<string, string> = {
      'Escape': '\x1b',
      'ArrowUp': '\x1b[A',
      'ArrowDown': '\x1b[B',
      'ArrowRight': '\x1b[C',
      'ArrowLeft': '\x1b[D',
      'Enter': '\r',
    };

    const sequence = keyMap[key];
    if (sequence) {
      this.sendTerminalData(sequence);
    }
  }

  private preventTerminalKeyboard(): void {
    // Find xterm's helper textarea and prevent it from showing keyboard
    const textarea = document.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement;
    if (textarea) {
      textarea.setAttribute('readonly', 'true');
      textarea.setAttribute('inputmode', 'none');
    }
  }

  private allowTerminalKeyboard(): void {
    // Re-enable xterm's helper textarea
    const textarea = document.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement;
    if (textarea) {
      textarea.removeAttribute('readonly');
      textarea.removeAttribute('inputmode');
    }
  }

  private connect(): void {
    // Close existing WebSocket to prevent duplicate connections
    if (this.ws) {
      // Remove handlers before closing to prevent reconnect loop
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      this.ws.onopen = null;
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close();
      }
      this.ws = null;
    }

    this.updateConnectionStatus('connecting');

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      console.log('WebSocket connected');
      this.reconnectAttempts = 0;
      this.updateConnectionStatus('connected');
      this.listSessions();
      this.listCategories();
      this.getNotificationPreferences();

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
        }, SESSION_REATTACH_DELAY_MS);
      }
    };

    this.ws.onclose = () => {
      console.log('WebSocket disconnected');
      this.updateConnectionStatus('disconnected');
      // Save current session for re-attachment on reconnect (issue #7)
      // Clear currentSessionId and attachingSessionId so reattach can proceed
      if (this.currentSessionId) {
        this.previousSessionId = this.currentSessionId;
        this.currentSessionId = null;
      }
      this.attachingSessionId = null;
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

      // Timeout pending requests
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error('Request timeout'));
        }
      }, REQUEST_TIMEOUT_MS);
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
      case 'session.moved':
        this.handleSessionMoved(message.payload);
        break;
      case 'category.list':
        this.handleCategoryList(message.payload);
        break;
      case 'category.created':
        this.handleCategoryCreated(message.payload);
        break;
      case 'category.renamed':
        this.handleCategoryRenamed(message.payload);
        break;
      case 'category.deleted':
        this.handleCategoryDeleted(message.payload);
        break;
      case 'category.reordered':
        this.handleCategoryReordered(message.payload);
        break;
      case 'category.toggled':
        this.handleCategoryToggled(message.payload);
        break;
      case 'terminal.data':
        this.handleTerminalData(message.payload);
        break;
      case 'terminal.exit':
        this.handleTerminalExit(message.payload);
        break;
      case 'notification.preferences':
        this.handleNotificationPreferences(message.payload);
        break;
      case 'notification.preferences.updated':
        this.handleNotificationPreferencesUpdated(message.payload);
        break;
      case 'notification':
        this.handleNotification(message.payload);
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
    // Guard against duplicate attach responses (e.g., from race conditions)
    const isAlreadyAttached = this.currentSessionId === payload.session.id;

    this.currentSessionId = payload.session.id;
    this.attachingSessionId = null; // Clear in-flight flag
    this.sessions.set(payload.session.id, payload.session);

    // Clear notification for this session
    this.sessionNotifications.delete(payload.session.id);
    this.send('notification.dismiss', { sessionId: payload.session.id });

    this.renderSessionList();
    this.showTerminal(payload.session);

    // Skip terminal reinitialization if already attached to this session
    // This prevents duplicate terminals from race conditions
    if (isAlreadyAttached) {
      return;
    }

    // Initialize terminal
    const container = document.getElementById('terminal-container');
    if (container && this.terminalMgr) {
      // Dispose previous terminal to prevent duplicate event handlers
      this.terminalMgr.dispose();
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

  private handleSessionMoved(payload: SessionMovedPayload): void {
    const session = this.sessions.get(payload.sessionId);
    if (session) {
      session.categoryId = payload.categoryId;
      this.sessions.set(payload.sessionId, session);
    }
    this.renderSessionList();
  }

  private handleCategoryList(payload: CategoryListPayload): void {
    this.categories.clear();
    for (const category of payload.categories) {
      this.categories.set(category.id, category);
    }
    this.renderSessionList();
  }

  private handleCategoryCreated(payload: CategoryCreatedPayload): void {
    this.categories.set(payload.category.id, payload.category);
    this.renderSessionList();
  }

  private handleCategoryRenamed(payload: CategoryRenamedPayload): void {
    const category = this.categories.get(payload.categoryId);
    if (category) {
      category.name = payload.name;
      this.categories.set(payload.categoryId, category);
    }
    this.renderSessionList();
  }

  private handleCategoryDeleted(payload: CategoryDeletedPayload): void {
    this.categories.delete(payload.categoryId);
    this.renderSessionList();
  }

  private handleCategoryReordered(payload: CategoryReorderedPayload): void {
    for (const cat of payload.categories) {
      const category = this.categories.get(cat.id);
      if (category) {
        category.sortOrder = cat.sortOrder;
      }
    }
    this.renderSessionList();
  }

  private handleCategoryToggled(payload: CategoryToggledPayload): void {
    const category = this.categories.get(payload.categoryId);
    if (category) {
      category.collapsed = payload.collapsed;
      this.categories.set(payload.categoryId, category);
    }
    this.renderSessionList();
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

  private handleNotificationPreferences(payload: NotificationPreferencesPayload): void {
    this.notificationPreferences = payload;
    this.updateSettingsUI();
  }

  private handleNotificationPreferencesUpdated(payload: NotificationPreferencesPayload): void {
    this.notificationPreferences = payload;
    this.updateSettingsUI();
  }

  private handleNotification(payload: NotificationPayload): void {
    const session = this.sessions.get(payload.sessionId);
    if (!session) return;

    // Don't notify for current session if we're focused
    if (payload.sessionId === this.currentSessionId && document.hasFocus()) {
      return;
    }

    // Store notification for visual badge
    if (this.notificationPreferences.visualEnabled) {
      this.sessionNotifications.set(payload.sessionId, {
        type: payload.type,
        timestamp: payload.timestamp,
      });
      this.renderSessionList();
    }

    // Show browser notification
    if (this.notificationPreferences.browserEnabled) {
      const title = payload.type === 'needs-input'
        ? `Input Required: ${session.name}`
        : `Task Completed: ${session.name}`;
      const body = payload.type === 'needs-input'
        ? 'Claude Code is waiting for your input'
        : 'Claude Code has finished the task';

      this.showBrowserNotification(title, body, payload.sessionId);
    }
  }

  private updateSettingsUI(): void {
    const browserCheckbox = document.getElementById('setting-browser-notifications') as HTMLInputElement;
    const visualCheckbox = document.getElementById('setting-visual-badges') as HTMLInputElement;
    const inputCheckbox = document.getElementById('setting-notify-input') as HTMLInputElement;
    const completedCheckbox = document.getElementById('setting-notify-completed') as HTMLInputElement;

    if (browserCheckbox) browserCheckbox.checked = this.notificationPreferences.browserEnabled;
    if (visualCheckbox) visualCheckbox.checked = this.notificationPreferences.visualEnabled;
    if (inputCheckbox) inputCheckbox.checked = this.notificationPreferences.notifyOnInput;
    if (completedCheckbox) completedCheckbox.checked = this.notificationPreferences.notifyOnCompleted;
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

    // Sort sessions by lastAccessedAt
    const sortedSessions = Array.from(this.sessions.values()).sort(
      (a, b) => new Date(b.lastAccessedAt).getTime() - new Date(a.lastAccessedAt).getTime()
    );

    // Sort categories by sortOrder
    const sortedCategories = Array.from(this.categories.values()).sort(
      (a, b) => a.sortOrder - b.sortOrder
    );

    // Group sessions by category
    const uncategorizedSessions = sortedSessions.filter(s => !s.categoryId);
    const sessionsByCategory = new Map<string, SessionInfo[]>();
    for (const cat of sortedCategories) {
      sessionsByCategory.set(cat.id, []);
    }
    for (const session of sortedSessions) {
      if (session.categoryId && sessionsByCategory.has(session.categoryId)) {
        sessionsByCategory.get(session.categoryId)!.push(session);
      }
    }

    // Add "Add Category" button at top
    const addCategoryBtn = document.createElement('button');
    addCategoryBtn.className = 'add-category-btn';
    addCategoryBtn.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <line x1="12" y1="5" x2="12" y2="19"></line>
        <line x1="5" y1="12" x2="19" y2="12"></line>
      </svg>
      Add Category
    `;
    addCategoryBtn.addEventListener('click', () => this.showCategoryModal('create'));
    listEl.appendChild(addCategoryBtn);

    // Render categories with their sessions
    for (const category of sortedCategories) {
      const sessions = sessionsByCategory.get(category.id) || [];
      this.renderCategory(listEl, category, sessions);
    }

    // Render uncategorized sessions at the bottom
    if (uncategorizedSessions.length > 0 || sortedCategories.length > 0) {
      this.renderUncategorizedSection(listEl, uncategorizedSessions);
    } else {
      // No categories, just render sessions directly
      for (const session of sortedSessions) {
        this.renderSessionItem(listEl, session);
      }
    }
  }

  private renderCategory(container: HTMLElement, category: CategoryInfo, sessions: SessionInfo[]): void {
    const section = document.createElement('div');
    section.className = 'category-section';
    if (category.collapsed) section.classList.add('collapsed');
    section.dataset.categoryId = category.id;

    const header = document.createElement('div');
    header.className = 'category-header';
    header.innerHTML = `
      <button class="category-toggle" title="${category.collapsed ? 'Expand' : 'Collapse'}">
        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="6 9 12 15 18 9"></polyline>
        </svg>
      </button>
      <span class="category-name">${this.escapeHtml(category.name)}</span>
      <span class="category-count">(${sessions.length})</span>
      <div class="category-actions">
        <button class="category-rename-btn" title="Rename">
          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>
          </svg>
        </button>
        <button class="category-delete-btn" title="Delete">
          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      </div>
    `;

    // Category toggle
    header.querySelector('.category-toggle')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleCategory(category.id, !category.collapsed);
    });

    // Category rename
    header.querySelector('.category-rename-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.showCategoryModal('rename', category);
    });

    // Category delete
    header.querySelector('.category-delete-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (confirm(`Delete category "${category.name}"? Sessions will become uncategorized.`)) {
        this.deleteCategory(category.id);
      }
    });

    // Allow dropping on category header (for empty categories)
    header.addEventListener('dragover', (e) => {
      e.preventDefault();
      header.classList.add('drop-target');
    });

    header.addEventListener('dragleave', (e) => {
      if (!header.contains(e.relatedTarget as Node)) {
        header.classList.remove('drop-target');
      }
    });

    header.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      header.classList.remove('drop-target');

      if (this.draggedSessionId) {
        const session = this.sessions.get(this.draggedSessionId);
        if (session && session.categoryId !== category.id) {
          this.moveSession(this.draggedSessionId, category.id);
        }
      }
    });

    section.appendChild(header);

    const sessionList = document.createElement('ul');
    sessionList.className = 'category-sessions';

    // Drop zone handling
    this.setupDropZone(sessionList, category.id);

    for (const session of sessions) {
      this.renderSessionItem(sessionList, session);
    }

    section.appendChild(sessionList);
    container.appendChild(section);
  }

  private renderUncategorizedSection(container: HTMLElement, sessions: SessionInfo[]): void {
    const section = document.createElement('div');
    section.className = 'category-section uncategorized';
    section.dataset.categoryId = '';

    const header = document.createElement('div');
    header.className = 'category-header';
    header.innerHTML = `
      <span class="category-name">Uncategorized</span>
      <span class="category-count">(${sessions.length})</span>
    `;

    // Allow dropping on uncategorized header
    header.addEventListener('dragover', (e) => {
      e.preventDefault();
      header.classList.add('drop-target');
    });

    header.addEventListener('dragleave', (e) => {
      if (!header.contains(e.relatedTarget as Node)) {
        header.classList.remove('drop-target');
      }
    });

    header.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      header.classList.remove('drop-target');

      if (this.draggedSessionId) {
        const session = this.sessions.get(this.draggedSessionId);
        if (session && session.categoryId !== null) {
          this.moveSession(this.draggedSessionId, null);
        }
      }
    });

    section.appendChild(header);

    const sessionList = document.createElement('ul');
    sessionList.className = 'category-sessions';

    // Drop zone handling for uncategorized
    this.setupDropZone(sessionList, null);

    for (const session of sessions) {
      this.renderSessionItem(sessionList, session);
    }

    section.appendChild(sessionList);
    container.appendChild(section);
  }

  private renderSessionItem(container: HTMLElement, session: SessionInfo): void {
    const li = document.createElement('li');
    li.className = 'session-item';
    li.draggable = true;
    li.dataset.sessionId = session.id;
    if (session.id === this.currentSessionId) li.classList.add('active');
    if (session.status === 'terminated') li.classList.add('terminated');
    if (!session.attachable) li.classList.add('not-attachable');

    // Check for notification badge - validate notification type to prevent XSS
    const notification = this.sessionNotifications.get(session.id);
    const validNotificationTypes = ['needs-input', 'completed'] as const;
    const notificationType = notification && validNotificationTypes.includes(notification.type) ? notification.type : null;
    const badgeHtml = notificationType
      ? `<span class="notification-badge ${notificationType}" title="${notificationType === 'needs-input' ? 'Waiting for input' : 'Task completed'}"></span>`
      : '';

    // Escape values for safe HTML attribute insertion
    const escapedSessionId = this.escapeAttr(session.id);
    const escapedStatus = this.escapeHtml(session.status);

    li.innerHTML = `
      <span class="session-drag-handle">
        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="9" cy="5" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="19" r="1"/>
          <circle cx="15" cy="5" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="19" r="1"/>
        </svg>
      </span>
      ${badgeHtml}
      <span class="session-icon">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="4 17 10 11 4 5"></polyline>
          <line x1="12" y1="19" x2="20" y2="19"></line>
        </svg>
      </span>
      <div class="session-info">
        <div class="session-name">${this.escapeHtml(session.name)}</div>
        <div class="session-status">${escapedStatus}${!session.attachable && session.status !== 'terminated' ? ' (stale)' : ''}</div>
      </div>
      <button class="session-delete-btn" title="Delete session" data-session-id="${escapedSessionId}">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="3 6 5 6 21 6"></polyline>
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
        </svg>
      </button>
    `;

    // Drag handling
    li.addEventListener('dragstart', (e) => {
      this.draggedSessionId = session.id;
      li.classList.add('dragging');
      e.dataTransfer?.setData('text/plain', session.id);
    });

    li.addEventListener('dragend', () => {
      this.draggedSessionId = null;
      li.classList.remove('dragging');
      document.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target'));
    });

    // Allow drops on session items (for dropping into their parent category)
    li.addEventListener('dragover', (e) => {
      e.preventDefault();
      const categorySection = li.closest('.category-section');
      const sessionList = categorySection?.querySelector('.category-sessions');
      sessionList?.classList.add('drop-target');
    });

    li.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();

      const categorySection = li.closest('.category-section');
      const categoryIdAttr = categorySection?.dataset.categoryId;
      const targetCategoryId = categoryIdAttr === '' ? null : categoryIdAttr ?? null;

      if (this.draggedSessionId) {
        const draggedSession = this.sessions.get(this.draggedSessionId);
        if (draggedSession && draggedSession.categoryId !== targetCategoryId) {
          this.moveSession(this.draggedSessionId, targetCategoryId);
        }
      }

      document.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target'));
    });

    // Click handler for session selection
    li.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.session-delete-btn')) return;
      if ((e.target as HTMLElement).closest('.session-drag-handle')) return;

      if (session.attachable) {
        this.attachToSession(session.id);
        document.getElementById('sidebar')?.classList.remove('open');
        document.getElementById('sidebar-overlay')?.classList.remove('open');
        document.getElementById('mobile-menu-btn')?.classList.remove('hidden');
      }
    });

    // Delete button handler
    const deleteBtn = li.querySelector('.session-delete-btn');
    deleteBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.deleteSession(session.id);
    });

    container.appendChild(li);
  }

  private setupDropZone(element: HTMLElement, categoryId: string | null): void {
    element.addEventListener('dragover', (e) => {
      e.preventDefault();
      element.classList.add('drop-target');
    });

    element.addEventListener('dragleave', (e) => {
      if (!element.contains(e.relatedTarget as Node)) {
        element.classList.remove('drop-target');
      }
    });

    element.addEventListener('drop', (e) => {
      e.preventDefault();
      element.classList.remove('drop-target');

      if (this.draggedSessionId) {
        const session = this.sessions.get(this.draggedSessionId);
        if (session && session.categoryId !== categoryId) {
          this.moveSession(this.draggedSessionId, categoryId);
        }
      }
    });
  }

  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  /**
   * Escape a string for use in HTML attributes.
   * Handles quotes and other characters that could break out of attribute context.
   */
  private escapeAttr(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#x27;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
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
    // Prevent duplicate attach requests (e.g., double-clicks, rapid navigation)
    if (this.currentSessionId === sessionId) return;
    if (this.attachingSessionId === sessionId) return;

    // Detach from current session
    if (this.currentSessionId) {
      this.send('session.detach', { sessionId: this.currentSessionId });
      if (this.terminalMgr) {
        this.terminalMgr.dispose();
      }
    }

    this.attachingSessionId = sessionId;
    this.send('session.attach', { sessionId });
  }

  terminateSession(sessionId: string): void {
    if (confirm('Are you sure you want to terminate this session?')) {
      this.send('session.terminate', { sessionId });
    }
  }

  deleteSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session?.attachable) {
      if (!confirm('This session is still active. Deleting will terminate it. Continue?')) {
        return;
      }
    }
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

  // Category methods

  listCategories(): void {
    this.send('category.list');
  }

  createCategory(name: string): void {
    this.send('category.create', { name });
  }

  renameCategory(categoryId: string, name: string): void {
    this.send('category.rename', { categoryId, name });
  }

  deleteCategory(categoryId: string): void {
    this.send('category.delete', { categoryId });
  }

  toggleCategory(categoryId: string, collapsed: boolean): void {
    this.send('category.toggle', { categoryId, collapsed });
  }

  moveSession(sessionId: string, categoryId: string | null): void {
    this.send('session.move', { sessionId, categoryId });
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

  // Category modal handlers

  private categoryModalMode: 'create' | 'rename' = 'create';
  private categoryModalCategoryId: string | null = null;

  private showCategoryModal(mode: 'create' | 'rename', category?: CategoryInfo): void {
    this.categoryModalMode = mode;
    this.categoryModalCategoryId = category?.id || null;

    const modal = document.getElementById('category-modal');
    const title = document.getElementById('category-modal-title');
    const input = document.getElementById('category-name-input') as HTMLInputElement;

    if (modal && title && input) {
      modal.classList.remove('hidden');
      title.textContent = mode === 'create' ? 'Create Category' : 'Rename Category';
      input.value = category?.name || '';
      input.focus();
      input.select();
    }
  }

  private hideCategoryModal(): void {
    document.getElementById('category-modal')?.classList.add('hidden');
    this.categoryModalCategoryId = null;
  }

  private confirmCategoryAction(): void {
    const input = document.getElementById('category-name-input') as HTMLInputElement;
    const name = input.value.trim();

    if (!name) return;

    if (this.categoryModalMode === 'create') {
      this.createCategory(name);
    } else if (this.categoryModalMode === 'rename' && this.categoryModalCategoryId) {
      this.renameCategory(this.categoryModalCategoryId, name);
    }

    this.hideCategoryModal();
  }

  // Notification preference methods

  getNotificationPreferences(): void {
    this.send('notification.preferences.get');
  }

  setNotificationPreferences(prefs: Partial<NotificationPreferencesPayload>): void {
    this.send('notification.preferences.set', prefs);
  }

  // Settings modal handlers

  private async showSettingsModal(): Promise<void> {
    const modal = document.getElementById('settings-modal');
    if (!modal) return;

    // Request browser notification permission if not yet granted
    if (this.browserNotificationsPermission === 'default') {
      await this.requestNotificationPermission();
    }

    // Update permission status display
    const permissionStatus = document.getElementById('notification-permission-status');
    if (permissionStatus) {
      if (this.browserNotificationsPermission === 'granted') {
        permissionStatus.textContent = 'Browser notifications enabled';
        permissionStatus.className = 'permission-status granted';
      } else if (this.browserNotificationsPermission === 'denied') {
        permissionStatus.textContent = 'Browser notifications blocked';
        permissionStatus.className = 'permission-status denied';
      } else {
        permissionStatus.textContent = 'Browser notifications not enabled';
        permissionStatus.className = 'permission-status default';
      }
    }

    this.updateSettingsUI();
    modal.classList.remove('hidden');
  }

  private hideSettingsModal(): void {
    document.getElementById('settings-modal')?.classList.add('hidden');
  }

  private saveSettings(): void {
    const browserCheckbox = document.getElementById('setting-browser-notifications') as HTMLInputElement;
    const visualCheckbox = document.getElementById('setting-visual-badges') as HTMLInputElement;
    const inputCheckbox = document.getElementById('setting-notify-input') as HTMLInputElement;
    const completedCheckbox = document.getElementById('setting-notify-completed') as HTMLInputElement;

    this.setNotificationPreferences({
      browserEnabled: browserCheckbox?.checked ?? true,
      visualEnabled: visualCheckbox?.checked ?? true,
      notifyOnInput: inputCheckbox?.checked ?? true,
      notifyOnCompleted: completedCheckbox?.checked ?? true,
    });

    this.hideSettingsModal();
  }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  (window as any).sessionManager = new SessionManager();
});

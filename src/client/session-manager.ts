// Session and WebSocket management
import { terminalManager, TerminalManager } from './terminal.js';
import { PipManager } from './pip-manager.js';
import { ProjectWorkspace } from './project-workspace.js';
import { JobBoard } from './job-board.js';
import { RollupView } from './rollup-view.js';
import { JobOverlay, type JobSummary } from './job-overlay.js';
import { PlanUsageChip } from './plan-usage-chip.js';
import { isPhaseGroupActivation, togglePhaseGroup } from './phase-group.js';
import { ShortcutsModal } from './shortcuts-modal.js';
import { ProjectLogView } from './project-log-view.js';
import { NewSessionModal } from './new-session-modal.js';
import { SessionListView } from './session-list-view.js';
import { MobileNav } from './mobile-nav.js';
import type {
  SessionInfo,
  CategoryInfo,
  SessionMovedPayload,
  SessionReorderedPayload,
  CategoryCreatedPayload,
  CategoryRenamedPayload,
  CategoryDeletedPayload,
  CategoryReorderedPayload,
  CategoryToggledPayload,
  CategoryListPayload,
  ErrorPayload,
  NotificationPreferencesPayload,
  NotificationPayload,
  ServerMessage,
  ConnectionStatus,
} from './session-types.js';

// Configuration constants
const REQUEST_TIMEOUT_MS = 30000;
const NOTIFICATION_AUTO_CLOSE_MS = 10000;
const RECONNECT_BASE_DELAY_MS = 1000;
const MAX_RECONNECT_ATTEMPTS = 5;
const SESSION_REATTACH_DELAY_MS = 100;

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

  // Notification state
  private sessionNotifications: Map<string, { type: 'needs-input' | 'completed'; timestamp: string }> = new Map();
  private notificationPreferences: NotificationPreferencesPayload = {
    browserEnabled: true,
    visualEnabled: true,
    notifyOnInput: true,
    notifyOnCompleted: true,
  };
  private browserNotificationsPermission: 'default' | 'granted' | 'denied' = 'default';

  /** The sidebar session list: categories, drag/drop reordering, and session rows. */
  private sessionListView = new SessionListView({
    sessions: this.sessions,
    categories: this.categories,
    sessionNotifications: this.sessionNotifications,
    getCurrentSessionId: () => this.currentSessionId,
    attachToSession: (sessionId) => this.attachToSession(sessionId),
    reviveSession: (sessionId) => this.reviveSession(sessionId),
    deleteSession: (sessionId) => this.deleteSession(sessionId),
    moveSession: (sessionId, categoryId) => this.moveSession(sessionId, categoryId),
    toggleCategory: (categoryId, collapsed) => this.toggleCategory(categoryId, collapsed),
    deleteCategory: (categoryId) => this.deleteCategory(categoryId),
    showCategoryModal: (mode, category) => this.showCategoryModal(mode, category),
    reorderSessions: (updates) => this.send('session.reorder', { sessions: updates }),
  });

  /** The mobile on-screen navigation bar. */
  private mobileNav = new MobileNav({
    hasCurrentSession: () => !!this.currentSessionId,
    sendTerminalData: (data) => this.sendTerminalData(data),
    fitTerminal: () => this.terminalMgr?.fit(),
  });

  // PiP manager
  private pipManager = new PipManager();

  /** The "New Session" modal: name/cwd fields, recent-path suggestions, the Track picker. */
  private newSessionModal = new NewSessionModal({
    createSession: (name, cwd) => this.createSession(name, cwd),
  });

  /** The keyboard shortcuts modal and the welcome-screen hints. */
  private shortcutsModal = new ShortcutsModal();

  /**
   * The canonical PROJECT.md board. Owns the sidebar list and the feature
   * editor; the project-log view keeps the session-history half of the
   * detail view, which still reads SESSION-LOG.md.
   */
  private workspace = new ProjectWorkspace(
    (cwd) => this.projectLogView.showProjectLog(cwd),
    (cwd) => this.showNewSessionModal(cwd),
    (cwd, featureId, title) => void this.jobBoard.dispatch(cwd, featureId, title),
    (worktreePath, trackName) => this.createSession(trackName, worktreePath)
  );
  /**
   * The pipeline board. "Take over" resumes a background run's own conversation
   * in a real terminal, inside its worktree — reusing the same resume path the
   * session-history buttons use.
   */
  private jobBoard = new JobBoard((claudeSessionId, cwd) =>
    this.openHistorySession(claudeSessionId, cwd, 'resume')
  );
  /** Cross-project overview; clicking a row opens that project. */
  private rollup = new RollupView((cwd) => this.projectLogView.showProjectLog(cwd));
  /**
   * The live job panel over the main area. Fed by pushed `jobs.summary`
   * messages, so it stays current while a terminal is in front of it.
   */
  private jobOverlay = new JobOverlay((job) => void this.openJobFromOverlay(job));
  private planUsage = new PlanUsageChip();
  /** The Projects tab: the PROJECT.md board plus the SESSION-LOG.md history/plan-progress view. */
  private projectLogView = new ProjectLogView({
    workspace: this.workspace,
    jobBoard: this.jobBoard,
    rollup: this.rollup,
    detachCurrentSession: () => this.detachCurrentSession(),
    syncJobOverlay: () => this.syncJobOverlay(),
    showNewSessionModal: (cwd) => this.showNewSessionModal(cwd),
  });

  constructor(terminal: TerminalManager = terminalManager) {
    this.terminalMgr = terminal;
    this.setupEventListeners();
    this.mobileNav.setupMobileNavigation();
    this.shortcutsModal.renderWelcomeShortcuts();
    this.setupPipButton();
    this.jobOverlay.attach();
    this.planUsage.attach();
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

    // Desktop sidebar collapse toggle (restores persisted state on load)
    if (localStorage.getItem('sidebarCollapsed') === 'true') {
      document.getElementById('app')?.classList.add('sidebar-collapsed');
      document.getElementById('sidebar-toggle')?.setAttribute('aria-expanded', 'false');
    }
    document.getElementById('sidebar-toggle')?.addEventListener('click', () => this.toggleSidebar());

    // New session buttons
    document.getElementById('new-session-btn')?.addEventListener('click', () => this.showNewSessionModal());
    document.getElementById('welcome-new-session-btn')?.addEventListener('click', () => this.showNewSessionModal());

    // Sidebar tabs (Sessions / Projects board)
    document.getElementById('tab-sessions')?.addEventListener('click', () => this.projectLogView.switchTab('sessions'));
    document.getElementById('tab-projects')?.addEventListener('click', () => this.projectLogView.switchTab('projects'));
    document.getElementById('refresh-projects-btn')?.addEventListener('click', () => this.projectLogView.loadProjectBoard());
    document.getElementById('overview-btn')?.addEventListener('click', () => {
      void this.rollup.show().then(() => this.syncJobOverlay());
    });
    document.getElementById('rollup-refresh-btn')?.addEventListener('click', () => void this.rollup.load());
    const rollupBody = document.getElementById('rollup-body');
    if (rollupBody) this.rollup.attach(rollupBody);
    document.getElementById('project-log-open-btn')?.addEventListener('click', () => this.projectLogView.openSessionForSelectedProject());
    document.getElementById('project-log-resync-btn')?.addEventListener('click', () => this.projectLogView.resyncSelectedProject());
    // Feature board interactions (delegated inside the workspace client).
    const featuresContainer = document.getElementById('project-features');
    if (featuresContainer) this.workspace.attach(featuresContainer);
    const jobsContainer = document.getElementById('project-jobs');
    if (jobsContainer) this.jobBoard.attach(jobsContainer);

    // Phases table interactions (event delegation): copy session ids + collapse groups
    const phasesContainer = document.getElementById('project-log-entries');
    phasesContainer?.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const backfillBtn = target.closest('[data-backfill-cwd]') as HTMLButtonElement | null;
      if (backfillBtn) {
        void this.projectLogView.backfillProject(backfillBtn.getAttribute('data-backfill-cwd') || '', backfillBtn);
        return;
      }
      const openBtn = target.closest('[data-open-session]') as HTMLElement | null;
      if (openBtn) {
        const claudeSessionId = openBtn.getAttribute('data-open-session') || '';
        const cwd = openBtn.getAttribute('data-open-cwd') || '';
        const mode = openBtn.getAttribute('data-open-mode') === 'fork' ? 'fork' : 'resume';
        if (claudeSessionId && cwd) this.openHistorySession(claudeSessionId, cwd, mode);
        return;
      }
      const delBtn = target.closest('[data-delete-entry]') as HTMLElement | null;
      if (delBtn) {
        this.projectLogView.showDeleteEntryModal({
          cwd: delBtn.getAttribute('data-delete-cwd') || '',
          entryIndex: Number(delBtn.getAttribute('data-delete-entry')),
          claudeSessionId: delBtn.getAttribute('data-delete-session') || null,
          siblingCount: Number(delBtn.getAttribute('data-delete-siblings')) || 0,
        });
        return;
      }
      const copyBtn = target.closest('[data-copy]') as HTMLElement | null;
      if (copyBtn) {
        const sid = copyBtn.getAttribute('data-copy') || '';
        navigator.clipboard?.writeText(sid);
        copyBtn.classList.add('copied');
        setTimeout(() => copyBtn.classList.remove('copied'), 1000);
        return;
      }
      const head = target.closest('.phase-group-head') as HTMLElement | null;
      if (head) togglePhaseGroup(head);
    });
    phasesContainer?.addEventListener('keydown', (e) => {
      if (!isPhaseGroupActivation(e.key)) return;
      const head = (e.target as HTMLElement).closest('.phase-group-head') as HTMLElement | null;
      if (head) {
        e.preventDefault();
        togglePhaseGroup(head);
      }
    });

    // New session modal
    document.getElementById('new-session-cancel')?.addEventListener('click', () => this.hideNewSessionModal());
    document.getElementById('new-session-confirm')?.addEventListener('click', () => void this.newSessionModal.createSessionFromModal());
    document.getElementById('session-name-input')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void this.newSessionModal.createSessionFromModal();
    });
    const cwdInput = document.getElementById('session-cwd-input') as HTMLInputElement | null;
    cwdInput?.addEventListener('keydown', (e) => this.newSessionModal.handleCwdInputKeydown(e));
    cwdInput?.addEventListener('input', () => {
      this.newSessionModal.renderCwdSuggestions();
      this.newSessionModal.trackPicker.schedule();
    });
    document.getElementById('session-track-select')?.addEventListener('change', () => this.newSessionModal.trackPicker.sync());
    document.getElementById('session-track-new')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void this.newSessionModal.createSessionFromModal();
    });
    cwdInput?.addEventListener('focus', () => this.newSessionModal.renderCwdSuggestions());
    // Close the dropdown when focus leaves the field (delay lets a click on an
    // option register before we hide it).
    cwdInput?.addEventListener('blur', () => {
      setTimeout(() => this.newSessionModal.hideCwdSuggestions(), 150);
    });
    document.getElementById('cwd-toggle')?.addEventListener('mousedown', (e) => {
      // mousedown + preventDefault so the input doesn't blur (which would race
      // with the toggle and immediately re-hide the list).
      e.preventDefault();
      this.newSessionModal.toggleCwdSuggestions();
    });

    // Rename modal
    document.getElementById('rename-cancel')?.addEventListener('click', () => this.hideRenameModal());
    document.getElementById('rename-confirm')?.addEventListener('click', () => this.confirmRename());
    document.getElementById('rename-input')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.confirmRename();
    });

    // Category modal
    document.getElementById('category-cancel')?.addEventListener('click', () => this.hideCategoryModal());
    document.getElementById('category-confirm')?.addEventListener('click', () => this.confirmCategoryAction());
    document.getElementById('category-name-input')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.confirmCategoryAction();
    });

    // Delete history-entry modal
    document.getElementById('delete-entry-cancel')?.addEventListener('click', () => this.projectLogView.hideDeleteEntryModal());
    document.getElementById('delete-entry-confirm')?.addEventListener('click', () => this.projectLogView.confirmDeleteEntry());

    // Settings modal
    document.getElementById('settings-btn')?.addEventListener('click', () => this.showSettingsModal());
    document.getElementById('settings-cancel')?.addEventListener('click', () => this.hideSettingsModal());
    document.getElementById('settings-save')?.addEventListener('click', () => this.saveSettings());
    document
      .getElementById('setting-job-overlay')
      ?.addEventListener('change', () => this.updatePlacementEnabled());

    // Keyboard shortcuts modal
    document.getElementById('shortcuts-btn')?.addEventListener('click', () => this.showShortcutsModal());
    document.getElementById('shortcuts-close')?.addEventListener('click', () => this.hideShortcutsModal());

    // Terminal header controls
    document.getElementById('rename-session-btn')?.addEventListener('click', () => this.showRenameModal());
    document.getElementById('terminate-session-btn')?.addEventListener('click', () => this.terminateCurrentSession());
    document.getElementById('fork-session-btn')?.addEventListener('click', () => this.forkCurrentSession());
    document.getElementById('keep-session-btn')?.addEventListener('click', () => this.keepCurrentForkSession());

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.hideNewSessionModal();
        this.hideRenameModal();
        this.hideCategoryModal();
        this.hideSettingsModal();
        this.hideShortcutsModal();
        this.projectLogView.hideDeleteEntryModal();
      }
      // Show keyboard shortcuts: ?
      // Skip when an input/textarea is focused (modal inputs or xterm helper
      // textarea), or when another modal is already open (avoid stacking).
      if (e.key === '?' && !e.ctrlKey && !e.altKey && !e.metaKey) {
        const tag = (document.activeElement?.tagName ?? '').toLowerCase();
        const otherModalOpen = !!document.querySelector('.modal:not(.hidden):not(#shortcuts-modal)');
        if (tag !== 'input' && tag !== 'textarea' && !otherModalOpen) {
          e.preventDefault();
          this.toggleShortcutsModal();
        }
      }
      // New session: Alt+N
      if (e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey && (e.key === 'n' || e.key === 'N')) {
        const tag = (document.activeElement?.tagName ?? '').toLowerCase();
        if (tag !== 'input' && tag !== 'textarea') {
          e.preventDefault();
          this.showNewSessionModal();
        }
      }
      // Session navigation: Ctrl+Q = prev, Ctrl+E = next
      // Skip when an input/textarea is focused (modal inputs or xterm helper textarea)
      if (e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
        const tag = (document.activeElement?.tagName ?? '').toLowerCase();
        if (tag !== 'input' && tag !== 'textarea') {
          if (e.key === 'q' || e.key === 'Q') {
            e.preventDefault();
            this.navigateToSession('prev');
          } else if (e.key === 'e' || e.key === 'E') {
            e.preventDefault();
            this.navigateToSession('next');
          } else if (e.key === 'b' || e.key === 'B') {
            e.preventDefault();
            this.toggleSidebar();
          }
        }
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
    document.getElementById('shortcuts-modal')?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) this.hideShortcutsModal();
    });
    document.getElementById('delete-entry-modal')?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) this.projectLogView.hideDeleteEntryModal();
    });
  }

  private setupPipButton(): void {
    const pipBtn = document.getElementById('pip-session-btn');
    if (!pipBtn) return;

    // Hide if not supported
    if (!PipManager.isSupported()) {
      pipBtn.style.display = 'none';
      return;
    }

    pipBtn.addEventListener('click', () => this.openPip());
  }

  private openPip(): void {
    if (!this.currentSessionId) return;
    this.pipManager.open(this.currentSessionId, this.sessions, this.sessionNotifications);
  }

  private toggleSidebar(): void {
    const app = document.getElementById('app');
    if (!app) return;
    const collapsed = app.classList.toggle('sidebar-collapsed');
    localStorage.setItem('sidebarCollapsed', String(collapsed));
    const toggle = document.getElementById('sidebar-toggle');
    toggle?.setAttribute('aria-expanded', String(!collapsed));
    toggle?.setAttribute('title', collapsed ? 'Expand sidebar (Ctrl+B)' : 'Collapse sidebar (Ctrl+B)');
    // Refit the terminal once the width transition has finished.
    setTimeout(() => this.terminalMgr?.fit(), 300);
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
      // Job states from before the drop go stale silently -- no further push is
      // coming -- so show nothing until the server re-seeds us after auth.
      this.jobOverlay.clear();
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
      case 'session.reordered':
        this.handleSessionReordered(message.payload);
        break;
      case 'session.forked':
        this.handleSessionForked(message.payload);
        break;
      case 'session.kept':
        this.handleSessionKept(message.payload);
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
      case 'jobs.summary':
        this.jobOverlay.update(message.payload);
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
    // Release the in-flight attach flag. It is otherwise only cleared by a successful
    // session.attached or a socket close, so a rejected attach pins it to that session id
    // and every later attachToSession() for it early-returns -- leaving a live session
    // unreachable until the page is reloaded. The reconnect path hits this routinely: it
    // re-attaches to the previously attached session, which after a server restart is stale
    // and answers "Session not found", and reviving it afterwards then showed nothing.
    this.attachingSessionId = null;
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
    this.syncPip();
  }

  private handleSessionCreated(payload: { session: SessionInfo }): void {
    this.sessions.set(payload.session.id, payload.session);
    this.renderSessionList();
    this.syncPip();
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
      this.terminalMgr.setNavigateSessionCallback((dir) => this.navigateToSession(dir));
      this.terminalMgr.setNewSessionCallback(() => this.showNewSessionModal());

      // Write scrollback at the session's original dimensions so escape
      // sequences (cursor positioning, line wrapping) render correctly.
      // Then fit to the current container and let xterm.js reflow.
      if (payload.scrollback) {
        const sessionCols = payload.session.cols;
        const sessionRows = payload.session.rows;
        const currentDims = this.terminalMgr.getDimensions();

        if (sessionCols && sessionRows &&
            (sessionCols !== currentDims.cols || sessionRows !== currentDims.rows)) {
          this.terminalMgr.resize(sessionCols, sessionRows);
        }

        this.terminalMgr.write(payload.scrollback);
        this.terminalMgr.fit();
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
    this.syncPip();

    if (this.currentSessionId === payload.sessionId) {
      this.showWelcomeScreen();
    }
  }

  private handleSessionDeleted(payload: { sessionId: string }): void {
    this.sessions.delete(payload.sessionId);
    this.renderSessionList();
    this.syncPip();

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
    this.syncPip();

    if (this.currentSessionId === payload.sessionId) {
      const nameEl = document.getElementById('session-name');
      if (nameEl) nameEl.textContent = payload.name;
    }
  }

  private handleSessionMoved(payload: SessionMovedPayload): void {
    const session = this.sessions.get(payload.sessionId);
    if (session) {
      session.categoryId = payload.categoryId;
      session.sortOrder = payload.sortOrder;
      this.sessions.set(payload.sessionId, session);
    }
    this.renderSessionList();
  }

  private handleSessionReordered(payload: SessionReorderedPayload): void {
    for (const s of payload.sessions) {
      const session = this.sessions.get(s.id);
      if (session) {
        session.sortOrder = s.sortOrder;
      }
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
      this.syncPip();
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

    // Display prefs live in localStorage (per device), not in the server's
    // notification row -- a phone and a desktop want different answers here.
    const overlayCheckbox = document.getElementById('setting-job-overlay') as HTMLInputElement;
    if (overlayCheckbox) overlayCheckbox.checked = this.jobOverlay.isEnabled();
    const placement = this.jobOverlay.getPlacement();
    for (const radio of this.placementRadios()) radio.checked = radio.value === placement;
    this.updatePlacementEnabled();
  }

  private placementRadios(): HTMLInputElement[] {
    return [
      ...document.querySelectorAll<HTMLInputElement>('input[name="job-overlay-placement"]'),
    ];
  }

  /** The placement choice means nothing while the panel is switched off. */
  private updatePlacementEnabled(): void {
    const on = (document.getElementById('setting-job-overlay') as HTMLInputElement)?.checked ?? true;
    document.getElementById('setting-job-overlay-placement')?.classList.toggle('disabled', !on);
    for (const radio of this.placementRadios()) radio.disabled = !on;
  }

  /**
   * Keep the overlay where it belongs: docked into the terminal header when
   * that is the chosen placement and a header is on screen, and off entirely
   * while the Projects or Overview view is up -- both put their own actions in
   * that corner and both already list these jobs in full.
   */
  private syncJobOverlay(): void {
    const isVisible = (id: string): boolean =>
      !document.getElementById(id)?.classList.contains('hidden');
    this.jobOverlay.setSuppressed(isVisible('project-log-view') || isVisible('rollup-view'));
    this.jobOverlay.applyPlacement();
  }

  /** Hand a job from the overlay to the board that can actually act on it. */
  private async openJobFromOverlay(job: JobSummary): Promise<void> {
    this.rollup.hide();
    // switchTab starts a board load of its own; join it rather than race a
    // second one, and re-check afterwards -- getProject() before that load
    // resolves says nothing about whether the project exists.
    if (!this.projectLogView.isProjectsTabActive()) this.projectLogView.switchTab('projects');
    if (!this.workspace.getProject(job.projectCwd)) await this.projectLogView.joinProjectBoardLoad();
    this.projectLogView.showProjectLog(job.projectCwd);
    this.jobBoard.focusJob(job.id);
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

  private getOrderedVisibleSessionIds(): string[] {
    const sortedSessions = Array.from(this.sessions.values()).sort(
      (a, b) => a.sortOrder - b.sortOrder
    );
    const sortedCategories = Array.from(this.categories.values()).sort(
      (a, b) => a.sortOrder - b.sortOrder
    );

    if (sortedCategories.length === 0) {
      return sortedSessions.map(s => s.id);
    }

    const result: string[] = [];
    for (const category of sortedCategories) {
      if (category.collapsed) continue;
      for (const session of sortedSessions) {
        if (session.categoryId === category.id) result.push(session.id);
      }
    }
    // Uncategorized sessions last
    for (const session of sortedSessions) {
      if (!session.categoryId) result.push(session.id);
    }
    return result;
  }

  private navigateToSession(direction: 'prev' | 'next'): void {
    const sessionIds = this.getOrderedVisibleSessionIds();
    if (sessionIds.length === 0) return;

    const currentIndex = this.currentSessionId ? sessionIds.indexOf(this.currentSessionId) : -1;

    let nextIndex: number;
    if (currentIndex === -1) {
      nextIndex = direction === 'next' ? 0 : sessionIds.length - 1;
    } else if (direction === 'next') {
      nextIndex = (currentIndex + 1) % sessionIds.length;
    } else {
      nextIndex = (currentIndex - 1 + sessionIds.length) % sessionIds.length;
    }

    const targetId = sessionIds[nextIndex];
    if (targetId) this.attachToSession(targetId);
  }

  private renderSessionList(): void {
    this.sessionListView.render();
  }

  private showTerminal(session: SessionInfo): void {
    this.projectLogView.clearSelection();
    this.jobBoard.stopPolling();
    document.getElementById('project-log-view')?.classList.add('hidden');
    document.getElementById('welcome-screen')?.classList.add('hidden');
    document.getElementById('terminal-container')?.classList.remove('hidden');
    document.getElementById('terminal-header')?.classList.remove('hidden');

    const nameEl = document.getElementById('session-name');
    if (nameEl) nameEl.textContent = session.name;

    this.updateForkControls(session);
    this.syncJobOverlay();
  }

  private updateForkControls(session?: SessionInfo): void {
    const keepBtn = document.getElementById('keep-session-btn');
    if (!keepBtn) return;
    const s = session ?? (this.currentSessionId ? this.sessions.get(this.currentSessionId) : undefined);
    if (s?.isFork) {
      keepBtn.classList.remove('hidden');
    } else {
      keepBtn.classList.add('hidden');
    }
  }

  private showWelcomeScreen(): void {
    this.currentSessionId = null;
    if (this.terminalMgr) {
      this.terminalMgr.dispose();
    }

    document.getElementById('terminal-container')?.classList.add('hidden');
    document.getElementById('terminal-header')?.classList.add('hidden');
    // Only reveal the welcome screen if the project-log view isn't taking over.
    if (!this.projectLogView.hasSelection()) {
      document.getElementById('welcome-screen')?.classList.remove('hidden');
    }

    this.syncJobOverlay();
    this.renderSessionList();
  }

  // ── Project-log board ──────────────────────────────────────────────
  // The board itself (tabs, PROJECT.md workspace, SESSION-LOG.md history,
  // delete/backfill modals) lives in ProjectLogView (project-log-view.ts).
  // What stays here is "current session" ownership it calls back into.

  /** Detach the live terminal session (if any) so the project view can take over the main area. */
  private detachCurrentSession(): void {
    if (this.currentSessionId) {
      this.send('session.detach', { sessionId: this.currentSessionId });
      this.terminalMgr?.dispose();
      this.currentSessionId = null;
    }
  }

  private handleSessionForked(payload: { session: SessionInfo }): void {
    this.sessions.set(payload.session.id, payload.session);
    this.renderSessionList();
    this.syncPip();
    // session.attached arrives next from the server to do terminal setup
  }

  private handleSessionKept(payload: { sessionId: string }): void {
    const session = this.sessions.get(payload.sessionId);
    if (session) {
      session.isFork = false;
      this.sessions.set(payload.sessionId, session);
    }
    if (this.currentSessionId === payload.sessionId) {
      this.updateForkControls();
    }
    this.renderSessionList();
  }

  private async forkCurrentSession(): Promise<void> {
    if (!this.currentSessionId) return;
    try {
      await this.sendRequest('session.fork', { sessionId: this.currentSessionId });
    } catch (error) {
      this.showForkError(error instanceof Error ? error.message : 'Failed to fork session');
    }
  }

  private showForkError(message: string): void {
    const toast = document.getElementById('fork-error-toast');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.remove('hidden');
    setTimeout(() => toast.classList.add('hidden'), 6000);
  }

  private keepCurrentForkSession(): void {
    if (!this.currentSessionId) return;
    this.send('session.keep', { sessionId: this.currentSessionId });
  }

  // Public methods

  listSessions(): void {
    this.send('session.list');
  }

  createSession(name?: string, cwd?: string): void {
    this.send('session.create', { name, cwd });
  }

  // Open a Claude session from a project's session history: `resume` continues the original
  // transcript, `fork` branches a copy. The server auto-attaches, so showTerminal() takes over.
  openHistorySession(claudeSessionId: string, cwd: string, mode: 'resume' | 'fork'): void {
    this.send('session.open', { claudeSessionId, cwd, mode });
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

  /**
   * Bring a stale session back in place. The server answers with session.created for the same
   * id, so handleSessionCreated updates the existing row and attaches -- no new row appears.
   */
  reviveSession(sessionId: string): void {
    const dims = this.terminalMgr.getDimensions();
    this.send('session.revive', { sessionId, cols: dims.cols, rows: dims.rows });
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

  // PiP sync

  private syncPip(): void {
    if (this.pipManager.isOpen()) {
      this.pipManager.updateSessions(this.sessions, this.sessionNotifications);
    }
  }

  // Modal handlers

  private showNewSessionModal(prefillCwd?: string): void {
    this.newSessionModal.show(prefillCwd);
  }

  private hideNewSessionModal(): void {
    this.newSessionModal.hide();
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
      // Delete (not just terminate) so the session is also removed from the
      // sidebar. deleteSession terminates the active process first on the
      // server, then removes the record — surviving a page reload.
      this.deleteSession(this.currentSessionId);
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

  // Keyboard shortcuts modal — delegates to ShortcutsModal (shortcuts-modal.ts).

  private showShortcutsModal(): void {
    this.shortcutsModal.showShortcutsModal();
  }

  private hideShortcutsModal(): void {
    this.shortcutsModal.hideShortcutsModal();
  }

  private toggleShortcutsModal(): void {
    this.shortcutsModal.toggleShortcutsModal();
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

    // Applied on Save rather than on change, so Cancel genuinely cancels.
    const overlayCheckbox = document.getElementById('setting-job-overlay') as HTMLInputElement;
    const placement = this.placementRadios().find((r) => r.checked)?.value === 'header'
      ? 'header'
      : 'below';
    this.jobOverlay.setPreferences(overlayCheckbox?.checked ?? true, placement);
    this.syncJobOverlay();

    this.hideSettingsModal();
  }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  (window as any).sessionManager = new SessionManager();
});

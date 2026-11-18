// Session and WebSocket management
import { pastedFilesText, uploadFailureMessage, uploadPastedFiles } from './pasted-file.js';
import { terminalManager, TerminalManager } from './terminal.js';
import { PipManager } from './pip-manager.js';
import { ProjectWorkspace } from './project-workspace.js';
import { JobBoard } from './job-board.js';
import { RollupView } from './rollup-view.js';
import { JobOverlay, type JobSummary } from './job-overlay.js';
import { PlanUsageChip } from './plan-usage-chip.js';
import { AccountUsageModal } from './account-usage-modal.js';
import { ShortcutsModal } from './shortcuts-modal.js';
import { SessionSocket } from './session-socket.js';
import { BrowserNotifier } from './browser-notifier.js';
import { CategoryModal, RenameModal } from './name-modals.js';
import { bindGlobalShortcuts, closeOnBackdrop } from './global-shortcuts.js';
import { BUILD_CHANGED_EVENT, BuildIndicator } from './server-restart.js';
import { SettingsModal } from './settings-modal.js';
import {
  isLandNotification,
  isPromptMissingNotification,
  isAccountChangedNotification,
  accountChangedTitle,
  showAccountChanged,
  landResultTitle,
  promptMissingTitle,
  showLandResult,
  showPromptMissing,
} from './land-result.js';
import { ProjectLogView } from './project-log-view.js';
import { NewSessionModal, type CreateCwd } from './new-session-modal.js';
import { AccountRefusalModal, LoginRetries } from './account-refusal-modal.js';
import { StopRequests, currentAfterRevive, isLive } from './session-stop.js';
import { AccountMenu } from './account-menu.js';
import { SessionListView, openMobileSidebar } from './session-list-view.js';
import { MobileNav } from './mobile-nav.js';
import type {
  SessionInfo,
  CategoryInfo,
  SessionMovedPayload,
  SessionClaudeNamesPayload,
  SessionAccountWarningsPayload,
  SessionAccountChangedPayload,
  SessionLoginEndedPayload,
  AccountChangedNotificationPayload,
  AccountRefusal,
  SessionReorderedPayload,
  CategoryCreatedPayload,
  CategoryRenamedPayload,
  CategoryDeletedPayload,
  CategoryReorderedPayload,
  CategoryToggledPayload,
  CategoryListPayload,
  ErrorPayload,
  NotificationPreferencesPayload,
  LandNotificationPayload,
  NotificationPayload,
  PromptMissingNotificationPayload,
  ServerMessage,
  ConnectionStatus,
} from './session-types.js';

const SESSION_REATTACH_DELAY_MS = 100;

class SessionManager {
  /** The /ws connection: reconnects, numbers messages, answers requests (session-socket.ts). */
  private socket = new SessionSocket({
    onStatus: (status) => this.updateConnectionStatus(status),
    onOpen: () => this.handleSocketOpen(),
    onClose: () => this.handleSocketClose(),
    onMessage: (message) => this.handleMessage(message),
  });
  private sessions: Map<string, SessionInfo> = new Map();
  private categories: Map<string, CategoryInfo> = new Map();
  private currentSessionId: string | null = null;
  private previousSessionId: string | null = null; // For reconnection (issue #7)
  private attachingSessionId: string | null = null; // Prevents duplicate attach requests
  private terminalMgr: TerminalManager; // Use imported module instead of window (issue #12)

  // Notification state
  private sessionNotifications: Map<string, { type: 'needs-input' | 'completed'; timestamp: string }> = new Map();
  private notificationPreferences: NotificationPreferencesPayload = {
    browserEnabled: true,
    visualEnabled: true,
    notifyOnInput: true,
    notifyOnCompleted: true,
  };
  private notifier = new BrowserNotifier();
  private renameModal = new RenameModal((sessionId, name) => this.renameSession(sessionId, name));
  private categoryModal = new CategoryModal({
    create: (name) => this.createCategory(name),
    rename: (categoryId, name) => this.renameCategory(categoryId, name),
  });

  /** The sidebar session list: categories, drag/drop reordering, and session rows. */
  private sessionListView = new SessionListView({
    sessions: this.sessions,
    categories: this.categories,
    sessionNotifications: this.sessionNotifications,
    getCurrentSessionId: () => this.currentSessionId,
    attachToSession: (sessionId) => this.attachToSession(sessionId),
    reviveSession: (sessionId) => this.reviveSession(sessionId),
    stopSession: (sessionId) => this.stopSession(sessionId),
    deleteSession: (sessionId) => this.deleteSession(sessionId),
    moveSession: (sessionId, categoryId) => this.moveSession(sessionId, categoryId),
    toggleCategory: (categoryId, collapsed) => this.toggleCategory(categoryId, collapsed),
    deleteCategory: (categoryId) => this.deleteCategory(categoryId),
    showCategoryModal: (mode, category) => this.categoryModal.show(mode, category),
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
    createSession: (name, cwd, notice, account, createCwd) => this.createSession(name, cwd, notice, account, createCwd),
  });

  /** A launch the account preflight refused: Log in / Clean up (docs/accounts.md). */
  private accountRefusal = new AccountRefusalModal({
    logIn: (account, cleanup, retry) => this.startLogin(account, cleanup, retry),
  });
  /** How to send a launch (create, open, revive) again, by its message id, until it is answered. */
  private launchRetries = new Map<string, () => void>();
  /** session.stop requests in flight: a second click waits, a viewers refusal is retried. */
  private stopRequests = new StopRequests();
  /** The header's account chip (project/move-conversation-account.md); null until bound. */
  private accountMenu: AccountMenu | null = null;
  /** session.changeAccount requests in flight, by message id. */
  private accountMoves = new Map<string, { sessionId: string; account: string }>();
  /** Launches waiting on a Log in session, retried once it exits (`session.loginEnded`). */
  private loginRetries = new LoginRetries();

  /** The keyboard shortcuts modal and the welcome-screen hints. */
  private shortcutsModal = new ShortcutsModal();

  /** Says when the running server is behind its build: a dot on the Settings gear and its Server tab. */
  private buildIndicator = new BuildIndicator();
  /** A notice for the session being created, until the server names its id. */
  private createNotice: { cwd: string; text: string } | null = null;
  /** Notices to write into a session's terminal on its first attach. */
  private attachNotices = new Map<string, string>();

  /**
   * The canonical PROJECT.md board. Owns the sidebar list and the feature
   * editor; the project-log view keeps the session-history half of the
   * detail view, which still reads SESSION-LOG.md.
   */
  private workspace = new ProjectWorkspace(
    (cwd) => this.projectLogView.showProjectLog(cwd),
    (cwd) => this.showNewSessionModal(cwd),
    (cwd, featureId, title) => void this.jobBoard.dispatch(cwd, featureId, title),
    (worktreePath, trackName, notice) => this.createSession(trackName, worktreePath, notice)
  );
  /**
   * The pipeline board. "Take over" resumes a background run's own conversation
   * in a real terminal, inside its worktree — reusing the same resume path the
   * session-history buttons use.
   */
  private jobBoard = new JobBoard(
    (claudeSessionId, cwd) => this.openHistorySession(claudeSessionId, cwd, 'resume'),
    (cwd) => this.workspace.getProject(cwd)?.account?.effective ?? null
  );
  /** Cross-project overview; clicking a row opens that project. */
  private rollup = new RollupView((cwd) => this.projectLogView.showProjectLog(cwd));
  /**
   * The live job panel over the main area. Fed by pushed `jobs.summary`
   * messages, so it stays current while a terminal is in front of it.
   */
  private jobOverlay = new JobOverlay((job) => void this.openJobFromOverlay(job));
  /** Notifications, display, the session limits and Restart; after jobOverlay and buildIndicator, which it is handed. */
  private settingsModal = new SettingsModal({
    buildBehind: () => this.buildIndicator.behind,
    notificationPreferences: () => this.notificationPreferences,
    setNotificationPreferences: (prefs) => this.setNotificationPreferences(prefs),
    notificationPermission: async () => {
      if (this.notifier.permission === 'default') await this.notifier.requestPermission();
      return this.notifier.permission;
    },
    jobOverlay: this.jobOverlay,
    syncJobOverlay: () => this.syncJobOverlay(),
    renderSessionList: () => this.renderSessionList(),
  });
  private planUsage = new PlanUsageChip();
  /** The per-account usage page, opened from the chip (docs/plan-usage.md); a discard refreshes the chip's counts. */
  private accountUsage = new AccountUsageModal(() => void this.planUsage.refresh());
  /** The Projects tab: the PROJECT.md board plus the SESSION-LOG.md history/plan-progress view. */
  private projectLogView = new ProjectLogView({
    workspace: this.workspace,
    jobBoard: this.jobBoard,
    rollup: this.rollup,
    detachCurrentSession: () => this.detachCurrentSession(),
    syncJobOverlay: () => this.syncJobOverlay(),
    showNewSessionModal: (cwd) => this.showNewSessionModal(cwd),
    openHistorySession: (claudeSessionId, cwd, mode, account) => this.openHistorySession(claudeSessionId, cwd, mode, account),
  });

  constructor(terminal: TerminalManager = terminalManager) {
    this.terminalMgr = terminal;
    this.setupEventListeners();
    this.mobileNav.setupMobileNavigation();
    this.shortcutsModal.renderWelcomeShortcuts();
    this.setupPipButton();
    this.jobOverlay.attach();
    this.planUsage.openBreakdown = () => void this.accountUsage.open(this.planUsage.latest());
    this.planUsage.onRender = (data, now) => this.accountUsage.update(data, now);
    this.planUsage.attach();
    this.buildIndicator.start();
    this.socket.connect();
  }

  /** A desktop notification for a session; a click opens it. */
  private showBrowserNotification(title: string, body: string, sessionId: string): void {
    if (!this.notificationPreferences.browserEnabled) return;
    this.notifier.show(title, body, `session-${sessionId}`, () => this.attachToSession(sessionId));
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
    document.getElementById('add-category-btn')?.addEventListener('click', () => this.categoryModal.show('create'));
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

    // History entries: open, delete, copy ids, fold phase groups (delegated).
    const phasesContainer = document.getElementById('project-log-entries');
    if (phasesContainer) this.projectLogView.attachEntries(phasesContainer);

    // New session modal
    document.getElementById('new-session-cancel')?.addEventListener('click', () => this.hideNewSessionModal());
    document.getElementById('new-session-confirm')?.addEventListener('click', () => void this.newSessionModal.createSessionFromModal());
    document.getElementById('session-name-input')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void this.newSessionModal.createSessionFromModal();
    });
    const cwdInput = document.getElementById('session-cwd-input') as HTMLInputElement | null;
    cwdInput?.addEventListener('keydown', (e) => this.newSessionModal.handleCwdInputKeydown(e));
    cwdInput?.addEventListener('input', (e) => {
      this.newSessionModal.onCwdInput(e);
      this.newSessionModal.trackPicker.schedule();
      this.newSessionModal.scheduleDefaultAccount();
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
    document.getElementById('session-cwd-verdict')?.addEventListener('change', (e) => this.newSessionModal.onVerdictChange(e));

    this.renameModal.bind();
    this.categoryModal.bind();

    // Delete history-entry modal
    document.getElementById('delete-entry-cancel')?.addEventListener('click', () => this.projectLogView.hideDeleteEntryModal());
    document.getElementById('delete-entry-confirm')?.addEventListener('click', () => this.projectLogView.confirmDeleteEntry());

    // Settings modal (settings-modal.ts)
    this.settingsModal.bind();

    // Keyboard shortcuts modal
    document.getElementById('shortcuts-btn')?.addEventListener('click', () => this.showShortcutsModal());
    document.getElementById('shortcuts-close')?.addEventListener('click', () => this.hideShortcutsModal());

    // Terminal header controls
    document.getElementById('rename-session-btn')?.addEventListener('click', () => this.showRenameModal());
    document.getElementById('terminate-session-btn')?.addEventListener('click', () => this.terminateCurrentSession());
    document.getElementById('fork-session-btn')?.addEventListener('click', () => this.forkCurrentSession());
    document.getElementById('keep-session-btn')?.addEventListener('click', () => this.keepCurrentForkSession());
    const accountChip = document.getElementById('session-account-btn') as HTMLButtonElement | null;
    const accountMenu = document.getElementById('session-account-menu');
    if (accountChip && accountMenu) {
      this.accountMenu = new AccountMenu(
        {
          current: () => (this.currentSessionId ? this.sessions.get(this.currentSessionId) : undefined),
          move: (sessionId, account) => this.changeAccount(sessionId, account),
        },
        accountChip,
        accountMenu
      );
    }

    bindGlobalShortcuts({
      closeModals: () => {
        this.hideNewSessionModal();
        this.renameModal.hide();
        this.categoryModal.hide();
        this.settingsModal.hide();
        this.hideShortcutsModal();
        this.projectLogView.hideDeleteEntryModal();
      },
      toggleShortcutsModal: () => this.toggleShortcutsModal(),
      showNewSessionModal: () => this.showNewSessionModal(),
      focusSessionFilter: () => this.focusSessionFilter(),
      navigateToSession: (direction) => this.navigateToSession(direction),
      toggleSidebar: () => this.toggleSidebar(),
    });

    closeOnBackdrop('new-session-modal', () => this.hideNewSessionModal());
    closeOnBackdrop('shortcuts-modal', () => this.hideShortcutsModal());
    closeOnBackdrop('delete-entry-modal', () => this.projectLogView.hideDeleteEntryModal());
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

  /** Alt+K: show the Sessions tab (and the sidebar, if folded or off-screen) and focus its filter. */
  private focusSessionFilter(): void {
    if (this.projectLogView.isProjectsTabActive()) this.projectLogView.switchTab('sessions');
    if (document.getElementById('app')?.classList.contains('sidebar-collapsed')) this.toggleSidebar();
    if (window.matchMedia?.('(max-width: 768px)').matches) openMobileSidebar();
    this.sessionListView.focusFilter();
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

  /** Connected (or reconnected): load everything, then re-attach to the session open before (issue #7). */
  private handleSocketOpen(): void {
    void this.sessionListView.refreshAccountOrder();
    void this.accountMenu?.load();
    this.listSessions();
    this.listCategories();
    this.getNotificationPreferences();

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
  }

  /** The socket dropped; the socket reconnects by itself. */
  private handleSocketClose(): void {
    // Save current session for re-attachment on reconnect (issue #7)
    // Clear currentSessionId and attachingSessionId so reattach can proceed
    if (this.currentSessionId) {
      this.previousSessionId = this.currentSessionId;
      this.currentSessionId = null;
    }
    this.attachingSessionId = null;
    // No answer is coming for a stop sent before the drop; keeping it would make the
    // next click on that session's Stop wait forever.
    this.stopRequests.clear();
    // Nor for a move: the menu would show "Moving…" and ignore the chip until a reload. A
    // move the server finished is in the session list it re-sends; a session it stopped
    // for the move is Resumed from the sidebar.
    for (const id of this.accountMoves.keys()) this.launchRetries.delete(id);
    this.accountMoves.clear();
    this.accountMenu?.finished();
    // Job states from before the drop go stale silently -- no further push is
    // coming -- so show nothing until the server re-seeds us after auth.
    this.jobOverlay.clear();
  }

  private send(type: string, payload?: any): string {
    return this.socket.send(type, payload);
  }

  private sendRequest(type: string, payload?: any): Promise<any> {
    return this.socket.request(type, payload);
  }

  private handleMessage(message: ServerMessage): void {
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
        this.trackLaunchAnswered(message.id, message.payload.session.id);
        this.handleSessionCreated(message.payload);
        break;
      case 'session.added':
        this.handleSessionAdded(message.payload);
        break;
      case 'session.updated':
        this.handleSessionUpdated(message.payload);
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
      case 'session.claudeNames':
        this.handleClaudeNames(message.payload);
        break;
      case 'session.accountWarnings':
        this.handleAccountWarnings(message.payload);
        break;
      case 'session.loginEnded':
        this.handleLoginEnded(message.payload);
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
      case 'session.stopped':
        this.stopRequests.answered(message.id);
        break;
      case 'session.accountChanged':
        this.handleAccountChanged(message.payload, message.id);
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
      case 'projects.changed':
        this.workspace.onProjectsChanged();
        break;
      case 'session.error':
        this.handleSessionError(message.payload, message.id);
        break;
      case 'error':
        console.error('Server error:', message.payload);
        break;
    }
  }

  /** A launch was answered: drop its retry, and start waiting on a Log in session's exit. */
  private trackLaunchAnswered(messageId: string | undefined, sessionId: string): void {
    if (!messageId) return;
    this.launchRetries.delete(messageId);
    this.loginRetries.created(messageId, sessionId);
  }

  /** A Log in session ended -- broadcast, so this arrives even after switching away from it. */
  private handleLoginEnded(payload: SessionLoginEndedPayload): void {
    this.loginRetries.ended(payload.sessionId);
  }

  private handleAccountWarnings(payload: SessionAccountWarningsPayload): void {
    for (const [id, session] of this.sessions) {
      session.accountWarning = payload.warnings[id] ?? null;
    }
    this.renderSessionList();
  }

  private handleSessionError(payload: ErrorPayload, messageId?: string): void {
    console.error('Session error:', payload.message);
    const retry = messageId ? this.launchRetries.get(messageId) : undefined;
    const move = messageId ? this.accountMoves.get(messageId) : undefined;
    if (messageId && move) {
      this.accountMoves.delete(messageId);
      this.launchRetries.delete(messageId);
      this.accountMenu?.finished();
      this.handleAccountMoveError(payload, move, retry);
      return;
    }
    // Another browser is viewing a session this stop would take down: ask, then insist.
    const stopping = this.stopRequests.refused(messageId, payload.code);
    if (stopping) {
      if (confirm(`${payload.message}. Stop it anyway?`)) this.stopSession(stopping, true);
      return;
    }
    if (messageId) {
      this.launchRetries.delete(messageId);
      this.loginRetries.failed(messageId);
    }
    // Release the in-flight attach flag. It is otherwise only cleared by a successful
    // session.attached or a socket close, so a rejected attach pins it to that session id
    // and every later attachToSession() for it early-returns -- leaving a live session
    // unreachable until the page is reloaded. The reconnect path hits this routinely: it
    // re-attaches to the previously attached session, which after a server restart is stale
    // and answers "Session not found", and reviving it afterwards then showed nothing.
    this.attachingSessionId = null;
    // A rejected session.create (too many sessions, say) never produces the
    // session its notice was for; held on, it would land on the next session
    // opened in that folder.
    this.createNotice = null;
    // Refused by the account preflight: say who is logged in against who is expected, and
    // offer to fix it from here. The launch is retried once the Log in session exits.
    if (payload.refusal && retry) {
      this.accountRefusal.show(payload.refusal, retry);
      return;
    }
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
    this.socket.close();
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
    const notice = this.createNotice;
    if (notice && samePath(notice.cwd, payload.session.cwd)) {
      this.attachNotices.set(payload.session.id, notice.text);
      this.createNotice = null;
    }
    this.sessions.set(payload.session.id, payload.session);
    this.renderSessionList();
    this.syncPip();
    this.attachToSession(payload.session.id);
  }

  /** A session the server started on its own (a main session's agent did): list it, never attach. */
  private handleSessionAdded(payload: { session: SessionInfo }): void {
    this.sessions.set(payload.session.id, payload.session);
    this.renderSessionList();
    this.syncPip();
  }

  /** A row changed server-side (its shell exited): refresh it in place, never attach. */
  private handleSessionUpdated(payload: { session: SessionInfo }): void {
    if (!this.sessions.has(payload.session.id)) return;
    this.sessions.set(payload.session.id, payload.session);
    this.renderSessionList();
    this.syncPip();
    // Stopped under us (here or in another browser): the server already detached this
    // connection. Keep the last output on screen and offer to resume it.
    if (payload.session.id === this.currentSessionId && !payload.session.attachable) {
      this.showStoppedPrompt(payload.session);
    }
  }

  /** Over the stopped session's last output: its name and a Resume button. */
  private showStoppedPrompt(session: SessionInfo): void {
    const container = document.getElementById('terminal-container');
    if (!container) return;
    container.querySelector('.session-stopped-prompt')?.remove();
    const prompt = document.createElement('div');
    prompt.className = 'session-stopped-prompt';
    const text = document.createElement('p');
    text.textContent = `${session.name} was stopped.`;
    prompt.appendChild(text);
    if (session.revivable) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn-primary';
      button.textContent = session.claudeSessionId ? 'Resume conversation' : 'Restart shell';
      button.addEventListener('click', () => this.reviveSession(session.id));
      prompt.appendChild(button);
    }
    container.appendChild(prompt);
  }

  private handleSessionAttached(payload: { session: SessionInfo; scrollback: string }): void {
    // Guard against duplicate attach responses (e.g., from race conditions)
    const isAlreadyAttached = this.currentSessionId === payload.session.id;

    this.currentSessionId = payload.session.id;
    this.attachingSessionId = null; // Clear in-flight flag
    this.sessions.set(payload.session.id, payload.session);
    // The plan chip tags this session's account, and its project's jobs account (docs/plan-usage.md).
    this.planUsage.setAccount(payload.session.account, payload.session.cwd);

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
        onFiles: (files: File[]) => void this.pasteFiles(payload.session.id, files),
        sessionId: payload.session.id,
      });
      this.terminalMgr.setNavigateSessionCallback((dir) => this.navigateToSession(dir));
      this.terminalMgr.setNewSessionCallback(() => this.showNewSessionModal());
      this.terminalMgr.setFindSessionCallback(() => this.focusSessionFilter());

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

      const notice = this.attachNotices.get(payload.session.id);
      if (notice) {
        this.attachNotices.delete(payload.session.id);
        this.terminalMgr.writeln(`\x1b[33m${notice.replace(/\r?\n/g, '\r\n')}\x1b[0m`);
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

  // The full set each time: a session missing from it has no Claude running.
  private handleClaudeNames(payload: SessionClaudeNamesPayload): void {
    for (const [id, session] of this.sessions) {
      session.claudeName = payload.names[id] ?? null;
    }
    this.renderSessionList();
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
    this.settingsModal.updateUI();
  }

  private handleNotificationPreferencesUpdated(payload: NotificationPreferencesPayload): void {
    this.notificationPreferences = payload;
    this.settingsModal.updateUI();
  }

  private handleNotification(
    payload: NotificationPayload | LandNotificationPayload | PromptMissingNotificationPayload | AccountChangedNotificationPayload
  ): void {
    if (isLandNotification(payload)) {
      this.handleLandResult(payload);
      return;
    }
    if (isAccountChangedNotification(payload)) {
      // The row's account chip shows the warning too (session.accountWarnings).
      showAccountChanged(payload);
      this.showBrowserNotification(accountChangedTitle(payload), payload.detail, payload.sessionId);
      return;
    }
    if (isPromptMissingNotification(payload)) {
      // A toast, never a badge: an idle session badged would read as "needs input".
      showPromptMissing(payload);
      this.showBrowserNotification(promptMissingTitle(payload), payload.detail, payload.sessionId);
      return;
    }
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

  /**
   * A Land a session asked for has run. The session is closed by now, so this
   * is a toast over every view (and a browser notification when the tab is in
   * the background), plus a board refresh: the track is gone from it, or its
   * worktree is back to take another look.
   */
  private handleLandResult(payload: LandNotificationPayload): void {
    showLandResult(payload);
    if (this.notificationPreferences.browserEnabled) {
      // Stays until clicked: the session that asked is gone, so this is the only answer.
      this.notifier.show(landResultTitle(payload), payload.detail, `land-${payload.projectCwd}-${payload.track}`, undefined, false);
    }
    void this.workspace.refresh();
    // A land of this server's own project leaves it behind its build.
    if (payload.ok) window.dispatchEvent(new window.Event(BUILD_CHANGED_EVENT));
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
      statusEl.title = status.charAt(0).toUpperCase() + status.slice(1);
      const textEl = statusEl.querySelector('.status-text');
      if (textEl) {
        textEl.textContent = status.charAt(0).toUpperCase() + status.slice(1);
      }
    }
  }

  private navigateToSession(direction: 'prev' | 'next'): void {
    // The order the sidebar shows (visibleOrder()), so the keys never land on a folded
    // child or a stopped session.
    const sessionIds = this.sessionListView.visibleOrder();
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
    // A row's account, shell or children may have changed: the header chip follows.
    this.accountMenu?.update();
  }

  /**
   * Move a session's conversation to another account. The server stops a running one first;
   * its answer (handleAccountChanged) says whether to revive it. A preflight refusal is
   * retried after Log in through launchRetries, like a launch.
   */
  changeAccount(sessionId: string, account: string, force = false): void {
    const id = this.send('session.changeAccount', { sessionId, account, ...(force ? { force: true } : {}) });
    this.accountMoves.set(id, { sessionId, account });
    this.launchRetries.set(id, () => this.changeAccount(sessionId, account));
  }

  private handleAccountChanged(payload: SessionAccountChangedPayload, messageId?: string): void {
    if (messageId) {
      this.accountMoves.delete(messageId);
      this.launchRetries.delete(messageId);
    }
    const session = this.sessions.get(payload.sessionId);
    if (session) session.account = payload.account;
    this.accountMenu?.finished();
    this.renderSessionList();
    const name = session?.name ?? 'The session';
    // Revive attaches this browser to it: only while it is still the session on screen, or a
    // move finishing would pull the user back from wherever they went meanwhile.
    const resumeHere = payload.resume && this.currentSessionId === payload.sessionId;
    this.showInfoToast(
      resumeHere
        ? `${name} now runs under ${payload.account}: resuming the conversation there.`
        : `${name} now runs under ${payload.account}. Resume opens it there.`
    );
    if (resumeHere) this.reviveSession(payload.sessionId);
  }

  private handleAccountMoveError(
    payload: ErrorPayload,
    move: { sessionId: string; account: string },
    retry: (() => void) | undefined
  ): void {
    // Another browser is viewing it: the move would close their terminal too.
    if (payload.code === 'viewers') {
      if (confirm(`${payload.message}. Move it to ${move.account} anyway?`)) this.changeAccount(move.sessionId, move.account, true);
      return;
    }
    if (payload.refusal && retry) {
      this.accountRefusal.show(payload.refusal, retry);
      return;
    }
    // It was stopped for the move and kept its account: bring it back where it was, if it is
    // still the session on screen (reviving attaches to it).
    if (payload.code === 'stopped') {
      const here = this.currentSessionId === move.sessionId;
      this.showErrorToast(`${payload.message}. Nothing moved; ${here ? 'resuming it where it was' : 'Resume brings it back'}.`);
      if (here) this.reviveSession(move.sessionId);
      return;
    }
    this.showErrorToast(payload.message);
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
    this.accountMenu?.update();
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
    const sourceId = this.currentSessionId;
    try {
      await this.sendRequest('session.fork', { sessionId: sourceId });
    } catch (error) {
      const refusal = (error as { refusal?: AccountRefusal }).refusal;
      if (refusal) {
        this.accountRefusal.show(refusal, () => {
          if (this.currentSessionId === sourceId) void this.forkCurrentSession();
        });
        return;
      }
      this.showErrorToast(error instanceof Error ? error.message : 'Failed to fork session');
    }
  }

  /**
   * Upload pasted or dropped files and paste their server paths into the session they were
   * dropped on (pasted-file.ts), only while that session is still the one shown: typed into
   * another, the paths would land in the wrong prompt. Switched away, it says so instead.
   * The paths that saved are pasted even when others failed; the failures get one toast.
   */
  private async pasteFiles(sessionId: string, files: File[]): Promise<void> {
    const { paths, failures } = await uploadPastedFiles(sessionId, files);
    // One toast for everything that went wrong: a second would replace the first.
    const problems: string[] = [];
    if (paths.length) {
      if (this.currentSessionId === sessionId) this.terminalMgr?.paste(pastedFilesText(paths));
      else {
        const what = paths.length === 1 ? 'File' : `${paths.length} files`;
        problems.push(`${what} not pasted: the session changed before the upload finished. Drop ${paths.length === 1 ? 'it' : 'them'} again.`);
      }
    }
    if (failures.length) problems.push(uploadFailureMessage(failures));
    if (problems.length) this.showErrorToast(problems.join(' '));
  }

  /** A short error under the header (a failed fork, a file that could not be attached). */
  private showErrorToast(message: string): void {
    this.showHeaderToast(message, false);
  }

  /** The same line for news that is not an error (a session moved to another account). */
  private showInfoToast(message: string): void {
    this.showHeaderToast(message, true);
  }

  private headerToastTimer: ReturnType<typeof setTimeout> | null = null;

  private showHeaderToast(message: string, info: boolean): void {
    const toast = document.getElementById('error-toast');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.toggle('info', info);
    toast.classList.remove('hidden');
    if (this.headerToastTimer) clearTimeout(this.headerToastTimer);
    this.headerToastTimer = setTimeout(() => toast.classList.add('hidden'), 6000);
  }

  private keepCurrentForkSession(): void {
    if (!this.currentSessionId) return;
    this.send('session.keep', { sessionId: this.currentSessionId });
  }

  // Public methods

  listSessions(): void {
    this.send('session.list');
  }

  /**
   * `notice` is shown at the top of the new session's terminal, written
   * locally and never sent to the PTY: a track session whose dependency
   * install failed opens anyway and says so where the user is looking.
   */
  createSession(name?: string, cwd?: string, notice?: string, account?: string, createCwd?: CreateCwd): void {
    this.createNotice = notice && cwd ? { cwd, text: notice } : null;
    const id = this.send('session.create', {
      name,
      cwd,
      ...(account ? { account } : {}),
      ...(createCwd ? { createCwd } : {}),
    });
    // A retry may create again: the folder exists by then, and is simply opened.
    this.launchRetries.set(id, () => this.createSession(name, cwd, notice, account, createCwd));
  }

  /**
   * Open a Log in session for `account` (Clean up first deletes its org-pushed settings),
   * and run `retry` -- the refused launch -- once it exits: the server preflights it again.
   */
  private startLogin(account: string, cleanup: boolean, retry: () => void): void {
    const dims = this.terminalMgr.getDimensions();
    const id = this.send('session.create', { account, login: true, cleanup, cols: dims.cols, rows: dims.rows });
    this.loginRetries.requested(id, retry);
  }

  // Open a Claude session from a project's session history: `resume` continues the original
  // transcript, `fork` branches a copy. The server auto-attaches, so showTerminal() takes over.
  openHistorySession(claudeSessionId: string, cwd: string, mode: 'resume' | 'fork', account?: string): void {
    const id = this.send('session.open', { claudeSessionId, cwd, mode, ...(account ? { account } : {}) });
    this.launchRetries.set(id, () => this.openHistorySession(claudeSessionId, cwd, mode, account));
  }

  attachToSession(sessionId: string): void {
    // Prevent duplicate attach requests (e.g., double-clicks, rapid navigation)
    if (this.currentSessionId === sessionId) return;
    if (this.attachingSessionId === sessionId) return;

    // Detach from current session (a stopped one was detached by the server already)
    if (this.currentSessionId) {
      if (this.currentIsLive()) this.send('session.detach', { sessionId: this.currentSessionId });
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
    // Forgets a stopped session still on screen, or the attach that follows early-returns.
    this.currentSessionId = currentAfterRevive(this.currentSessionId, sessionId);
    const dims = this.terminalMgr.getDimensions();
    const id = this.send('session.revive', { sessionId, cols: dims.cols, rows: dims.rows });
    this.launchRetries.set(id, () => this.reviveSession(sessionId));
  }

  /**
   * Stop a session (and the sessions it started) to resume later. The server refuses while
   * another browser views one of them; handleSessionError confirms and calls this with force.
   */
  stopSession(sessionId: string, force = false): void {
    // A second click before the answer: the row only re-renders once the shell has exited.
    if (this.stopRequests.inFlight(sessionId)) return;
    const id = this.send('session.stop', { sessionId, ...(force ? { force: true } : {}) });
    this.stopRequests.sent(id, sessionId);
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

  /** The session on screen still has a shell (a stopped one stays on screen without one). */
  private currentIsLive(): boolean {
    return !!this.currentSessionId && isLive(this.sessions.get(this.currentSessionId));
  }

  sendTerminalData(data: string): void {
    if (this.currentIsLive()) {
      this.send('terminal.data', { sessionId: this.currentSessionId, data });
    }
  }

  sendTerminalResize(cols: number, rows: number): void {
    if (this.currentIsLive()) {
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
    const session = this.currentSessionId ? this.sessions.get(this.currentSessionId) : undefined;
    if (session) this.renameModal.show(session.id, session.name);
  }

  private terminateCurrentSession(): void {
    if (this.currentSessionId) {
      // Delete (not just terminate) so the session is also removed from the
      // sidebar. deleteSession terminates the active process first on the
      // server, then removes the record — surviving a page reload.
      this.deleteSession(this.currentSessionId);
    }
  }

  // Notification preference methods

  getNotificationPreferences(): void {
    this.send('notification.preferences.get');
  }

  setNotificationPreferences(prefs: Partial<NotificationPreferencesPayload>): void {
    this.send('notification.preferences.set', prefs);
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
}

/** Same folder however the server spelled it (case, slashes, a trailing slash). */
function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  (window as any).sessionManager = new SessionManager();
});

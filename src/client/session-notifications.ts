import { BrowserNotifier, type NotificationPermissionState } from './browser-notifier.js';
import {
  accountChangedTitle,
  isAccountChangedNotification,
  isLandNotification,
  isPromptMissingNotification,
  landResultTitle,
  promptMissingTitle,
  showAccountChanged,
  showLandResult,
  showPromptMissing,
} from './land-result.js';
import type {
  LandNotificationPayload,
  NotificationPreferencesPayload,
  ServerMessage,
  SessionInfo,
} from './session-types.js';

export type SessionBadge = { type: 'needs-input' | 'completed'; timestamp: string };

export interface SessionNotificationsHost {
  send(type: string, payload?: unknown): string;
  session(sessionId: string): SessionInfo | undefined;
  currentSessionId(): string | null;
  /** Clicking a session's browser notification opens it. */
  attach(sessionId: string): void;
  /** Redraw what shows badges (the session list and the PiP window). */
  renderBadges(): void;
  /** The preferences arrived or changed: the Settings modal reflects them. */
  preferencesChanged(): void;
  /** A Land a session asked for has run (`ok`: it merged). */
  landed(ok: boolean): void;
}

/**
 * What the server tells this browser about its sessions: the `notification`
 * messages (a session needs input or finished, a Land ran, an account changed,
 * a prompt went missing), the per-session badges they leave, the user's
 * notification preferences, and desktop notifications.
 */
export class SessionNotifications {
  /** Unread badges by session id; shared with the session list and the PiP window. */
  readonly badges = new Map<string, SessionBadge>();
  private prefs: NotificationPreferencesPayload = {
    browserEnabled: true,
    visualEnabled: true,
    notifyOnInput: true,
    notifyOnCompleted: true,
  };
  private notifier = new BrowserNotifier();

  constructor(private readonly host: SessionNotificationsHost) {}

  get preferences(): NotificationPreferencesPayload {
    return this.prefs;
  }

  /** Apply a `notification*` message; false for any other message. */
  handleMessage(message: ServerMessage): boolean {
    switch (message.type) {
      case 'notification.preferences':
      case 'notification.preferences.updated':
        this.prefs = message.payload;
        this.host.preferencesChanged();
        return true;
      case 'notification':
        this.notify(message.payload);
        return true;
      default:
        return false;
    }
  }

  requestPreferences(): void {
    this.host.send('notification.preferences.get');
  }

  setPreferences(prefs: Partial<NotificationPreferencesPayload>): void {
    this.host.send('notification.preferences.set', prefs);
  }

  /** The browser's permission, asking for it first when it was never asked. */
  async permission(): Promise<NotificationPermissionState> {
    if (this.notifier.permission === 'default') await this.notifier.requestPermission();
    return this.notifier.permission;
  }

  /** The session is on screen: drop its badge here and on the server. */
  dismiss(sessionId: string): void {
    this.badges.delete(sessionId);
    this.host.send('notification.dismiss', { sessionId });
  }

  private notify(payload: Extract<ServerMessage, { type: 'notification' }>['payload']): void {
    if (isLandNotification(payload)) {
      this.landResult(payload);
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
    const session = this.host.session(payload.sessionId);
    if (!session) return;

    // Not for the session on screen while the tab has focus.
    if (payload.sessionId === this.host.currentSessionId() && document.hasFocus()) return;

    if (this.prefs.visualEnabled) {
      this.badges.set(payload.sessionId, { type: payload.type, timestamp: payload.timestamp });
      this.host.renderBadges();
    }
    const needsInput = payload.type === 'needs-input';
    this.showBrowserNotification(
      needsInput ? `Input Required: ${session.name}` : `Task Completed: ${session.name}`,
      needsInput ? 'Claude Code is waiting for your input' : 'Claude Code has finished the task',
      payload.sessionId
    );
  }

  /** A desktop notification for a session; a click opens it. */
  private showBrowserNotification(title: string, body: string, sessionId: string): void {
    if (!this.prefs.browserEnabled) return;
    this.notifier.show(title, body, `session-${sessionId}`, () => this.host.attach(sessionId));
  }

  /**
   * A Land a session asked for has run. The session is closed by now, so this
   * is a toast over every view (and a browser notification when the tab is in
   * the background), plus whatever the host refreshes.
   */
  private landResult(payload: LandNotificationPayload): void {
    showLandResult(payload);
    if (this.prefs.browserEnabled) {
      // Stays until clicked: the session that asked is gone, so this is the only answer.
      this.notifier.show(landResultTitle(payload), payload.detail, `land-${payload.projectCwd}-${payload.track}`, undefined, false);
    }
    this.host.landed(payload.ok);
  }
}

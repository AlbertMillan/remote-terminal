/**
 * Desktop notifications for a tab in the background: the permission, and one notification
 * per event that closes itself. Whether an event is worth one (the user's preferences) is the
 * caller's to decide.
 */

const NOTIFICATION_AUTO_CLOSE_MS = 10000;

export type NotificationPermissionState = 'default' | 'granted' | 'denied';

export class BrowserNotifier {
  permission: NotificationPermissionState = 'default';

  constructor() {
    if ('Notification' in window) {
      this.permission = window.Notification.permission as NotificationPermissionState;
    }
  }

  async requestPermission(): Promise<boolean> {
    if (!('Notification' in window)) return false;
    if (window.Notification.permission === 'granted') {
      this.permission = 'granted';
      return true;
    }
    if (window.Notification.permission === 'denied') {
      this.permission = 'denied';
      return false;
    }
    const result = await window.Notification.requestPermission();
    this.permission = result as NotificationPermissionState;
    return result === 'granted';
  }

  /**
   * Shows one, unless permission is missing or the tab has focus. `tag` replaces an earlier
   * notification with the same tag; `onClick` runs after the window is focused.
   */
  show(title: string, body: string, tag: string, onClick?: () => void, autoClose = true): void {
    if (this.permission !== 'granted') return;
    if (document.hasFocus()) return;
    const notification = new window.Notification(title, { body, icon: '/favicon.ico', tag });
    notification.onclick = () => {
      window.focus();
      onClick?.();
      notification.close();
    };
    if (autoClose) setTimeout(() => notification.close(), NOTIFICATION_AUTO_CLOSE_MS);
  }
}

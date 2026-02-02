import { createLogger } from '../utils/logger.js';
import { getNotificationPreferences } from '../db/queries.js';

const logger = createLogger('notifications');

export type NotificationType = 'needs-input' | 'completed';

export interface Notification {
  sessionId: string;
  type: NotificationType;
  timestamp: Date;
}

type NotificationCallback = (notification: Notification) => void;

class NotificationService {
  private callbacks: Set<NotificationCallback> = new Set();
  private sessionNotifications: Map<string, { type: NotificationType; timestamp: Date }> = new Map();

  /**
   * Trigger a notification for a session
   */
  notify(sessionId: string, type: NotificationType): void {
    logger.info({ sessionId, type }, 'Notification triggered');

    const notification: Notification = {
      sessionId,
      type,
      timestamp: new Date(),
    };

    // Store for visual badges
    this.sessionNotifications.set(sessionId, {
      type,
      timestamp: notification.timestamp,
    });

    // Notify all registered callbacks
    for (const callback of this.callbacks) {
      try {
        callback(notification);
      } catch (error) {
        logger.error({ error }, 'Error in notification callback');
      }
    }
  }

  /**
   * Register a callback to receive notifications
   */
  onNotification(callback: NotificationCallback): () => void {
    this.callbacks.add(callback);
    return () => {
      this.callbacks.delete(callback);
    };
  }

  /**
   * Get pending notification for a session (for visual badges)
   */
  getSessionNotification(sessionId: string): { type: NotificationType; timestamp: Date } | undefined {
    return this.sessionNotifications.get(sessionId);
  }

  /**
   * Clear notification for a session (when user attaches)
   */
  clearSessionNotification(sessionId: string): void {
    this.sessionNotifications.delete(sessionId);
    logger.debug({ sessionId }, 'Notification cleared');
  }

  /**
   * Check if notification type is enabled for user
   */
  isNotificationEnabled(userId: string, type: NotificationType): boolean {
    const prefs = getNotificationPreferences(userId);
    if (type === 'needs-input') {
      return prefs.notifyOnInput;
    }
    if (type === 'completed') {
      return prefs.notifyOnCompleted;
    }
    return true;
  }
}

// Singleton instance
export const notificationService = new NotificationService();

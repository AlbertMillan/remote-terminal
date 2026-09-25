import {
  createMessage,
  type ClientMessage,
  type NotificationPreferencesSetPayload,
  type NotificationDismissPayload,
} from '../protocol.js';
import {
  getNotificationPreferences,
  setNotificationPreferences,
  type NotificationPreferences,
} from '../../db/queries.js';
import { notificationService } from '../../notifications/service.js';
import { type ClientConnection, logger } from '../connections.js';

// Notification handlers

export function handleNotificationPreferencesGet(connection: ClientConnection, message: ClientMessage): void {
  const userId = connection.identity?.userId;
  if (!userId) {
    connection.ws.send(createMessage('error', { message: 'User not authenticated' }, message.id));
    return;
  }

  const prefs = getNotificationPreferences(userId);
  connection.ws.send(createMessage('notification.preferences', {
    browserEnabled: prefs.browserEnabled,
    visualEnabled: prefs.visualEnabled,
    notifyOnInput: prefs.notifyOnInput,
    notifyOnCompleted: prefs.notifyOnCompleted,
  }, message.id));
}

export function handleNotificationPreferencesSet(connection: ClientConnection, message: ClientMessage): void {
  const userId = connection.identity?.userId;
  if (!userId) {
    connection.ws.send(createMessage('error', { message: 'User not authenticated' }, message.id));
    return;
  }

  const payload = message.payload as NotificationPreferencesSetPayload;
  if (!payload) {
    connection.ws.send(createMessage('error', { message: 'Preferences payload required' }, message.id));
    return;
  }

  // Get current preferences and merge with updates
  const current = getNotificationPreferences(userId);
  const updated: NotificationPreferences = {
    userId,
    browserEnabled: payload.browserEnabled ?? current.browserEnabled,
    visualEnabled: payload.visualEnabled ?? current.visualEnabled,
    notifyOnInput: payload.notifyOnInput ?? current.notifyOnInput,
    notifyOnCompleted: payload.notifyOnCompleted ?? current.notifyOnCompleted,
  };

  setNotificationPreferences(updated);

  connection.ws.send(createMessage('notification.preferences.updated', {
    browserEnabled: updated.browserEnabled,
    visualEnabled: updated.visualEnabled,
    notifyOnInput: updated.notifyOnInput,
    notifyOnCompleted: updated.notifyOnCompleted,
  }, message.id));
}

export function handleNotificationDismiss(connection: ClientConnection, message: ClientMessage): void {
  const payload = message.payload as NotificationDismissPayload;
  if (!payload?.sessionId) {
    connection.ws.send(createMessage('error', { message: 'Session ID required' }, message.id));
    return;
  }

  // Clear notification for this session
  notificationService.clearSessionNotification(payload.sessionId);
  logger.debug({ sessionId: payload.sessionId, clientId: connection.id }, 'Notification dismissed');
}

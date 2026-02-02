// WebSocket message protocol definitions

export type ClientMessageType =
  | 'auth'
  | 'session.create'
  | 'session.attach'
  | 'session.detach'
  | 'session.terminate'
  | 'session.delete'
  | 'session.rename'
  | 'session.move'
  | 'session.list'
  | 'terminal.data'
  | 'terminal.resize'
  | 'category.create'
  | 'category.rename'
  | 'category.delete'
  | 'category.reorder'
  | 'category.toggle'
  | 'category.list'
  | 'notification.preferences.get'
  | 'notification.preferences.set'
  | 'notification.dismiss'
  | 'ping';

export type ServerMessageType =
  | 'auth.success'
  | 'auth.failure'
  | 'session.created'
  | 'session.attached'
  | 'session.detached'
  | 'session.terminated'
  | 'session.deleted'
  | 'session.renamed'
  | 'session.moved'
  | 'session.list'
  | 'session.error'
  | 'terminal.data'
  | 'terminal.exit'
  | 'category.created'
  | 'category.renamed'
  | 'category.deleted'
  | 'category.reordered'
  | 'category.toggled'
  | 'category.list'
  | 'notification.preferences'
  | 'notification.preferences.updated'
  | 'notification'
  | 'error'
  | 'pong';

export interface ClientMessage {
  type: ClientMessageType;
  id?: string; // Message ID for request/response correlation
  payload?: unknown;
}

export interface ServerMessage {
  type: ServerMessageType;
  id?: string; // Correlation ID from client message
  payload?: unknown;
}

// Client message payloads
export interface AuthPayload {
  token?: string; // Future: optional auth token
}

export interface SessionCreatePayload {
  name?: string;
  shell?: string;
  cwd?: string;
  cols?: number;
  rows?: number;
}

export interface SessionAttachPayload {
  sessionId: string;
}

export interface SessionDetachPayload {
  sessionId: string;
}

export interface SessionTerminatePayload {
  sessionId: string;
}

export interface SessionDeletePayload {
  sessionId: string;
}

export interface SessionRenamePayload {
  sessionId: string;
  name: string;
}

export interface SessionMovePayload {
  sessionId: string;
  categoryId: string | null;
}

export interface TerminalDataPayload {
  sessionId: string;
  data: string;
}

export interface TerminalResizePayload {
  sessionId: string;
  cols: number;
  rows: number;
}

// Category payloads
export interface CategoryCreatePayload {
  name: string;
}

export interface CategoryRenamePayload {
  categoryId: string;
  name: string;
}

export interface CategoryDeletePayload {
  categoryId: string;
}

export interface CategoryReorderPayload {
  categories: { id: string; sortOrder: number }[];
}

export interface CategoryTogglePayload {
  categoryId: string;
  collapsed: boolean;
}

// Server message payloads
export interface SessionInfo {
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

export interface CategoryInfo {
  id: string;
  name: string;
  sortOrder: number;
  collapsed: boolean;
}

export interface SessionCreatedPayload {
  session: SessionInfo;
  scrollback?: string;
}

export interface SessionAttachedPayload {
  session: SessionInfo;
  scrollback: string;
}

export interface SessionListPayload {
  sessions: SessionInfo[];
}

export interface TerminalDataServerPayload {
  sessionId: string;
  data: string;
}

export interface TerminalExitPayload {
  sessionId: string;
  exitCode: number;
}

export interface ErrorPayload {
  message: string;
  code?: string;
}

// Category server payloads
export interface CategoryCreatedPayload {
  category: CategoryInfo;
}

export interface CategoryRenamedPayload {
  categoryId: string;
  name: string;
}

export interface CategoryDeletedPayload {
  categoryId: string;
}

export interface CategoryReorderedPayload {
  categories: { id: string; sortOrder: number }[];
}

export interface CategoryToggledPayload {
  categoryId: string;
  collapsed: boolean;
}

export interface CategoryListPayload {
  categories: CategoryInfo[];
}

export interface SessionMovedPayload {
  sessionId: string;
  categoryId: string | null;
}

// Notification payloads

export interface NotificationPreferencesPayload {
  browserEnabled: boolean;
  visualEnabled: boolean;
  notifyOnInput: boolean;
  notifyOnCompleted: boolean;
}

export interface NotificationPreferencesSetPayload {
  browserEnabled?: boolean;
  visualEnabled?: boolean;
  notifyOnInput?: boolean;
  notifyOnCompleted?: boolean;
}

export interface NotificationDismissPayload {
  sessionId: string;
}

export interface NotificationPayload {
  sessionId: string;
  type: 'needs-input' | 'completed';
  timestamp: string;
}

// Helper functions
export function createMessage(type: ServerMessageType, payload?: unknown, id?: string): string {
  const message: ServerMessage = { type };
  if (payload !== undefined) message.payload = payload;
  if (id !== undefined) message.id = id;
  return JSON.stringify(message);
}

export function parseMessage(data: string): ClientMessage | null {
  try {
    const message = JSON.parse(data);
    if (typeof message.type !== 'string') {
      return null;
    }
    return message as ClientMessage;
  } catch {
    return null;
  }
}

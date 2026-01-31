// WebSocket message protocol definitions

export type ClientMessageType =
  | 'auth'
  | 'session.create'
  | 'session.attach'
  | 'session.detach'
  | 'session.terminate'
  | 'session.delete'
  | 'session.rename'
  | 'session.list'
  | 'terminal.data'
  | 'terminal.resize'
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
  | 'session.list'
  | 'session.error'
  | 'terminal.data'
  | 'terminal.exit'
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

export interface TerminalDataPayload {
  sessionId: string;
  data: string;
}

export interface TerminalResizePayload {
  sessionId: string;
  cols: number;
  rows: number;
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

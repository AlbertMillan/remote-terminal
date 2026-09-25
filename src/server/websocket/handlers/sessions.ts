import { sessionManager } from '../../sessions/manager.js';
import { isValidDimension, validateTerminalDimensions } from '../validation.js';
import {
  createMessage,
  type ClientMessage,
  type SessionCreatePayload,
  type SessionAttachPayload,
  type SessionTerminatePayload,
  type SessionDeletePayload,
  type SessionRenamePayload,
  type SessionMovePayload,
  type SessionReorderPayload,
  type SessionForkPayload,
  type SessionOpenPayload,
  type SessionRevivePayload,
  type SessionKeepPayload,
  type TerminalDataPayload,
  type TerminalResizePayload,
} from '../protocol.js';
import {
  updateSessionCategory,
  reorderSessions,
  getCategory,
  getSession as getSessionFromDb,
} from '../../db/queries.js';
import {
  type ClientConnection,
  attachToSession,
  detachFromSession,
  sessionToInfo,
  broadcastSessionUpdate,
  broadcastSessionKept,
  broadcastSessionMoved,
  broadcastSessionReordered,
} from '../connections.js';

// Validation constants
const MAX_SESSION_NAME_LENGTH = 100;
const MAX_CWD_LENGTH = 500;
const VALID_SHELL_PATTERN = /^[a-zA-Z0-9/_.-]+$/;

export function handleSessionList(connection: ClientConnection, message: ClientMessage): void {
  const sessions = sessionManager.getSessionList().map(sessionToInfo);
  connection.ws.send(createMessage('session.list', { sessions }, message.id));
}

function validateSessionOptions(payload: SessionCreatePayload | undefined): {
  name?: string;
  shell?: string;
  cwd?: string;
  cols?: number;
  rows?: number;
} {
  const validated: {
    name?: string;
    shell?: string;
    cwd?: string;
    cols?: number;
    rows?: number;
  } = {};

  // Validate and sanitize name
  if (payload?.name) {
    if (typeof payload.name !== 'string') {
      throw new Error('Session name must be a string');
    }
    validated.name = payload.name.slice(0, MAX_SESSION_NAME_LENGTH).trim();
  }

  // Validate shell path
  if (payload?.shell) {
    if (typeof payload.shell !== 'string') {
      throw new Error('Shell must be a string');
    }
    if (!VALID_SHELL_PATTERN.test(payload.shell)) {
      throw new Error('Invalid shell path');
    }
    validated.shell = payload.shell;
  }

  // Validate working directory
  if (payload?.cwd) {
    if (typeof payload.cwd !== 'string') {
      throw new Error('Working directory must be a string');
    }
    if (payload.cwd.length > MAX_CWD_LENGTH) {
      throw new Error('Working directory path too long');
    }
    // Basic path traversal check
    if (payload.cwd.includes('..')) {
      throw new Error('Invalid working directory path');
    }
    validated.cwd = payload.cwd;
  }

  // Validate terminal dimensions
  Object.assign(validated, validateTerminalDimensions(payload));

  return validated;
}

export async function handleSessionCreate(connection: ClientConnection, message: ClientMessage): Promise<void> {
  const payload = message.payload as SessionCreatePayload | undefined;

  try {
    // Validate input before creating session
    const validatedOptions = validateSessionOptions(payload);

    const session = await sessionManager.createSession({
      ...validatedOptions,
      ownerId: connection.identity?.userId,
    });

    // Read back metadata from DB to get the actual sortOrder and categoryId
    const sessionMetadata = getSessionFromDb(session.id);

    connection.ws.send(
      createMessage(
        'session.created',
        {
          session: sessionToInfo({ ...session, categoryId: sessionMetadata?.categoryId ?? null, sortOrder: sessionMetadata?.sortOrder ?? 0, isFork: false, claudeSessionId: sessionMetadata?.claudeSessionId ?? null }),
        },
        message.id
      )
    );

    // Detach from current session before auto-attaching to new one
    // Without this, the old session's data listener leaks (never unsubscribed),
    // causing duplicate terminal output when switching back to it
    if (connection.attachedSession) {
      detachFromSession(connection);
    }

    // Auto-attach to the new session
    attachToSession(connection, session.id);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to create session';
    connection.ws.send(createMessage('session.error', { message: errorMessage }, message.id));
  }
}

export function handleSessionAttach(connection: ClientConnection, message: ClientMessage): void {
  const payload = message.payload as SessionAttachPayload;

  if (!payload?.sessionId) {
    connection.ws.send(createMessage('session.error', { message: 'Session ID required' }, message.id));
    return;
  }

  const session = sessionManager.getSession(payload.sessionId);
  if (!session) {
    connection.ws.send(createMessage('session.error', { message: 'Session not found' }, message.id));
    return;
  }

  // Get session metadata from database to include categoryId
  const sessionMetadata = getSessionFromDb(payload.sessionId);

  // Detach from current session if any
  if (connection.attachedSession) {
    detachFromSession(connection);
  }

  attachToSession(connection, payload.sessionId);

  // Send scrollback history
  const scrollback = sessionManager.getScrollback(payload.sessionId);

  connection.ws.send(
    createMessage(
      'session.attached',
      {
        session: sessionToInfo({ ...session, categoryId: sessionMetadata?.categoryId ?? null, sortOrder: sessionMetadata?.sortOrder ?? 0, isFork: sessionMetadata?.isFork ?? false, claudeSessionId: sessionMetadata?.claudeSessionId ?? null }),
        scrollback: scrollback.join('\r\n'),
      },
      message.id
    )
  );
}

export function handleSessionDetach(connection: ClientConnection, message: ClientMessage): void {
  if (connection.attachedSession) {
    detachFromSession(connection);
    connection.ws.send(createMessage('session.detached', {}, message.id));
  } else {
    connection.ws.send(createMessage('session.error', { message: 'Not attached to any session' }, message.id));
  }
}

export async function handleSessionTerminate(connection: ClientConnection, message: ClientMessage): Promise<void> {
  const payload = message.payload as SessionTerminatePayload;

  if (!payload?.sessionId) {
    connection.ws.send(createMessage('session.error', { message: 'Session ID required' }, message.id));
    return;
  }

  // Detach if attached to this session
  if (connection.attachedSession === payload.sessionId) {
    detachFromSession(connection);
  }

  const success = await sessionManager.terminateSession(payload.sessionId);

  if (success) {
    connection.ws.send(createMessage('session.terminated', { sessionId: payload.sessionId }, message.id));
    // Notify all connected clients
    broadcastSessionUpdate(payload.sessionId, 'terminated');
  } else {
    connection.ws.send(createMessage('session.error', { message: 'Failed to terminate session' }, message.id));
  }
}

export async function handleSessionDelete(connection: ClientConnection, message: ClientMessage): Promise<void> {
  const payload = message.payload as SessionDeletePayload;

  if (!payload?.sessionId) {
    connection.ws.send(createMessage('session.error', { message: 'Session ID required' }, message.id));
    return;
  }

  const success = await sessionManager.deleteSession(payload.sessionId);

  if (success) {
    connection.ws.send(createMessage('session.deleted', { sessionId: payload.sessionId }, message.id));
    broadcastSessionUpdate(payload.sessionId, 'deleted');
  } else {
    connection.ws.send(createMessage('session.error', { message: 'Failed to delete session' }, message.id));
  }
}

export function handleSessionRename(connection: ClientConnection, message: ClientMessage): void {
  const payload = message.payload as SessionRenamePayload;

  if (!payload?.sessionId || !payload?.name) {
    connection.ws.send(createMessage('session.error', { message: 'Session ID and name required' }, message.id));
    return;
  }

  const success = sessionManager.renameSession(payload.sessionId, payload.name);

  if (success) {
    connection.ws.send(
      createMessage('session.renamed', { sessionId: payload.sessionId, name: payload.name }, message.id)
    );
  } else {
    connection.ws.send(createMessage('session.error', { message: 'Failed to rename session' }, message.id));
  }
}

export function handleTerminalData(connection: ClientConnection, message: ClientMessage): void {
  const payload = message.payload as TerminalDataPayload;

  if (!payload?.sessionId || payload?.data === undefined) {
    return;
  }

  // Ensure client is attached to this session
  if (connection.attachedSession !== payload.sessionId) {
    connection.ws.send(createMessage('error', { message: 'Not attached to this session' }));
    return;
  }

  sessionManager.writeToSession(payload.sessionId, payload.data);
}

export function handleTerminalResize(connection: ClientConnection, message: ClientMessage): void {
  const payload = message.payload as TerminalResizePayload;

  if (!payload?.sessionId || !payload?.cols || !payload?.rows) {
    return;
  }

  // Validate terminal dimensions. A bad resize is ignored rather than reported: it arrives
  // unprompted from the client's resize observer, not from a user action.
  if (!isValidDimension(payload.cols) || !isValidDimension(payload.rows)) {
    return;
  }
  const cols = Number(payload.cols);
  const rows = Number(payload.rows);

  if (connection.attachedSession !== payload.sessionId) {
    return;
  }

  sessionManager.resizeSession(payload.sessionId, cols, rows);
}

// Fork handlers

export async function handleSessionFork(connection: ClientConnection, message: ClientMessage): Promise<void> {
  const payload = message.payload as SessionForkPayload;

  if (!payload?.sessionId) {
    connection.ws.send(createMessage('session.error', { message: 'Session ID required' }, message.id));
    return;
  }

  try {
    const sourceSession = sessionManager.getSession(payload.sessionId);
    const cols = sourceSession?.cols;
    const rows = sourceSession?.rows;

    const forkedSession = await sessionManager.forkSession(payload.sessionId, {
      ownerId: connection.identity?.userId,
      cols,
      rows,
    });

    const forkMetadata = getSessionFromDb(forkedSession.id);

    connection.ws.send(
      createMessage(
        'session.forked',
        {
          session: sessionToInfo({
            ...forkedSession,
            categoryId: forkMetadata?.categoryId ?? null,
            sortOrder: forkMetadata?.sortOrder ?? 0,
            isFork: true,
          }),
        },
        message.id
      )
    );

    // Detach from source, auto-attach to fork
    if (connection.attachedSession) {
      detachFromSession(connection);
    }
    attachToSession(connection, forkedSession.id);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to fork session';
    connection.ws.send(createMessage('session.error', { message: errorMessage }, message.id));
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Open a historical Claude session directly (resume the original transcript or fork a copy).
// Mirrors handleSessionCreate's response + auto-attach path so the client's existing
// isFork -> Keep-button flow works for the fork case without any special handling.
export async function handleSessionOpen(connection: ClientConnection, message: ClientMessage): Promise<void> {
  const payload = message.payload as SessionOpenPayload | undefined;

  try {
    if (!payload || typeof payload.claudeSessionId !== 'string' || !UUID_PATTERN.test(payload.claudeSessionId)) {
      throw new Error('A valid Claude session ID is required');
    }
    if (payload.mode !== 'resume' && payload.mode !== 'fork') {
      throw new Error('Mode must be "resume" or "fork"');
    }
    if (typeof payload.cwd !== 'string' || !payload.cwd) {
      throw new Error('Working directory is required');
    }
    if (payload.cwd.length > MAX_CWD_LENGTH || payload.cwd.includes('..')) {
      throw new Error('Invalid working directory path');
    }

    const { cols, rows } = validateTerminalDimensions(payload);

    const session = await sessionManager.openClaudeSession({
      claudeSessionId: payload.claudeSessionId,
      cwd: payload.cwd,
      mode: payload.mode,
      ownerId: connection.identity?.userId,
      cols,
      rows,
    });

    const sessionMetadata = getSessionFromDb(session.id);

    connection.ws.send(
      createMessage(
        'session.created',
        {
          session: sessionToInfo({
            ...session,
            categoryId: sessionMetadata?.categoryId ?? null,
            sortOrder: sessionMetadata?.sortOrder ?? 0,
            isFork: payload.mode === 'fork',
          }),
        },
        message.id
      )
    );

    if (connection.attachedSession) {
      detachFromSession(connection);
    }
    attachToSession(connection, session.id);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to open session';
    connection.ws.send(createMessage('session.error', { message: errorMessage }, message.id));
  }
}

// Revive a stale session in place: same row, same cwd, new PTY, and `claude --resume` when
// the row carries a claudeSessionId. Answers with session.created (as handleSessionOpen does)
// so the client's existing handleSessionCreated updates the row and auto-attaches.
export function handleSessionRevive(connection: ClientConnection, message: ClientMessage): void {
  const payload = message.payload as SessionRevivePayload | undefined;

  try {
    if (!payload?.sessionId) {
      throw new Error('Session ID required');
    }

    const { cols, rows } = validateTerminalDimensions(payload);

    const session = sessionManager.reviveSession({
      id: payload.sessionId,
      cols,
      rows,
    });

    const sessionMetadata = getSessionFromDb(session.id);

    connection.ws.send(
      createMessage(
        'session.created',
        {
          session: sessionToInfo({
            ...session,
            categoryId: sessionMetadata?.categoryId ?? null,
            sortOrder: sessionMetadata?.sortOrder ?? 0,
            isFork: false,
            claudeSessionId: sessionMetadata?.claudeSessionId ?? null,
          }),
        },
        message.id
      )
    );

    // Same detach-before-attach order handleSessionCreate needs: attaching without detaching
    // first leaks the previous session's data listener onto this connection.
    if (connection.attachedSession) {
      detachFromSession(connection);
    }
    attachToSession(connection, session.id);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to revive session';
    connection.ws.send(createMessage('session.error', { message: errorMessage }, message.id));
  }
}

export function handleSessionKeep(connection: ClientConnection, message: ClientMessage): void {
  const payload = message.payload as SessionKeepPayload;

  if (!payload?.sessionId) {
    connection.ws.send(createMessage('session.error', { message: 'Session ID required' }, message.id));
    return;
  }

  const success = sessionManager.keepForkSession(payload.sessionId);

  if (success) {
    connection.ws.send(createMessage('session.kept', { sessionId: payload.sessionId }, message.id));
    broadcastSessionKept(payload.sessionId, connection.id);
  } else {
    connection.ws.send(createMessage('session.error', { message: 'Failed to keep session' }, message.id));
  }
}

export function handleSessionMove(connection: ClientConnection, message: ClientMessage): void {
  const payload = message.payload as SessionMovePayload;

  if (!payload?.sessionId) {
    connection.ws.send(createMessage('error', { message: 'Session ID required' }, message.id));
    return;
  }

  // categoryId can be null (uncategorized)
  const categoryId = payload.categoryId || null;

  // If categoryId is provided, verify it exists
  if (categoryId) {
    const existing = getCategory(categoryId);
    if (!existing) {
      connection.ws.send(createMessage('error', { message: 'Category not found' }, message.id));
      return;
    }
  }

  updateSessionCategory(payload.sessionId, categoryId);

  // Read back the new sortOrder assigned by updateSessionCategory
  const updatedSession = getSessionFromDb(payload.sessionId);
  const sortOrder = updatedSession?.sortOrder ?? 0;

  connection.ws.send(createMessage('session.moved', { sessionId: payload.sessionId, categoryId, sortOrder }, message.id));
  broadcastSessionMoved(payload.sessionId, categoryId, sortOrder, connection.id);
}

export function handleSessionReorder(connection: ClientConnection, message: ClientMessage): void {
  const payload = message.payload as SessionReorderPayload;

  if (!payload?.sessions || !Array.isArray(payload.sessions)) {
    connection.ws.send(createMessage('error', { message: 'Sessions array required' }, message.id));
    return;
  }

  for (const s of payload.sessions) {
    if (typeof s.id !== 'string' || typeof s.sortOrder !== 'number' || !Number.isFinite(s.sortOrder)) {
      connection.ws.send(createMessage('error', { message: 'Invalid session reorder entry' }, message.id));
      return;
    }
  }

  reorderSessions(payload.sessions);

  connection.ws.send(createMessage('session.reordered', { sessions: payload.sessions }, message.id));
  broadcastSessionReordered(payload.sessions, connection.id);
}

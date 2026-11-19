// Types for session-manager.ts and its views. The /ws wire format (sessions, categories,
// every server message and its payload) is defined once for client and server in
// src/shared/protocol.ts and re-exported here; the rest is client-side.
export type {
  AccountChangedNotificationPayload,
  AccountIdentity,
  AccountRefusal,
  AuthSuccessPayload,
  CategoryCreatedPayload,
  CategoryDeletedPayload,
  CategoryInfo,
  CategoryListPayload,
  CategoryRenamedPayload,
  CategoryReorderedPayload,
  CategoryToggledPayload,
  ErrorPayload,
  LandNotificationPayload,
  MessagePayload as AuthFailurePayload,
  NotificationPayload,
  NotificationPreferencesPayload,
  PromptMissingNotificationPayload,
  ServerMessage,
  SessionAccountChangedPayload,
  SessionAccountWarningsPayload,
  SessionAttachedPayload,
  SessionClaudeNamesPayload,
  SessionCreatedPayload,
  SessionIdPayload as SessionDeletedPayload,
  SessionIdPayload as SessionTerminatedPayload,
  SessionInfo,
  SessionListPayload,
  SessionLoginEndedPayload,
  SessionMovedPayload,
  SessionRenamedPayload,
  SessionReorderedPayload,
  TerminalDataPayload,
  TerminalExitPayload,
} from '../shared/protocol.js';

// Project-log board (mirrors server's ProjectBoardItem / ParsedLogEntry / LogEntryMeta)
export interface LogEntryMeta {
  date: string;
  session: string;
  branch: string;
  claudeSessionId: string;
  /** The Claude login the session ran under; absent on older entries. */
  account?: string;
  blockers: number;
  openItems: number;
}
export interface ParsedLogEntry {
  meta: LogEntryMeta | null;
  body: string;
}
export interface PhaseItem {
  id: string;
  title: string;
  status: 'done' | 'in_progress' | 'pending';
  sessionIds: string[];
}
export interface PhaseGroup {
  group: string;
  source: string;
  items: PhaseItem[];
}
export interface ProjectBoardItem {
  cwd: string;
  name: string;
  hasLog: boolean;
  lastActivity: string | null;
  transcriptCount: number;
  entries: ParsedLogEntry[];
  latest: LogEntryMeta | null;
  phaseGroups: PhaseGroup[];
}

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected';

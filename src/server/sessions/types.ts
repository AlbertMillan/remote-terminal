import type { IPty } from 'node-pty';

export interface Session {
  id: string;
  name: string;
  shell: string;
  cwd: string;
  createdAt: Date;
  lastAccessedAt: Date;
  ownerId?: string; // Tailscale user ID
  status: SessionStatus;
  cols: number;
  rows: number;
}

export type SessionStatus = 'active' | 'idle' | 'terminated';

export interface ActiveSession extends Session {
  pty: IPty;
  tmuxSession?: string; // Linux only
  scrollback: string[];
  connectedClients: Set<string>;
}

export interface SessionCreateOptions {
  name?: string;
  shell?: string;
  cwd?: string;
  ownerId?: string;
  cols?: number;
  rows?: number;
  env?: Record<string, string>;
  /** The session that started this one through the agent-sessions API. */
  spawnedBy?: string;
  /** The `--permission-mode` that session typed into this one. */
  permissionMode?: string;
}

export interface SessionMetadata {
  id: string;
  name: string;
  shell: string;
  cwd: string;
  createdAt: string;
  lastAccessedAt: string;
  ownerId: string | null;
  status: SessionStatus;
  cols: number;
  rows: number;
  tmuxSession: string | null;
  categoryId: string | null;
  sortOrder: number;
  claudeSessionId: string | null;
  isFork: boolean;
  forkJsonlPath: string | null;
  /** The session that started this one (docs/session-orchestration.md); null for the user's own. */
  spawnedBy?: string | null;
  permissionMode?: string | null;
}

export interface CategoryMetadata {
  id: string;
  name: string;
  sortOrder: number;
  collapsed: boolean;
  ownerId: string | null;
  createdAt: string;
}

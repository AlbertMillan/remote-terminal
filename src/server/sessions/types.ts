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
}

export interface CategoryMetadata {
  id: string;
  name: string;
  sortOrder: number;
  collapsed: boolean;
  ownerId: string | null;
  createdAt: string;
}

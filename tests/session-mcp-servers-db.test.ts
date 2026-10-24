import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { SessionMetadata } from '../src/server/sessions/types.js';

/**
 * sessions.mcp_servers (project/lean-started-sessions.md): what a started session's every
 * launch loads, its round trip, the transcript lookup a history Resume uses, and the
 * migration that makes started sessions from before it lean too.
 */

const dataDir = mkdtempSync(join(tmpdir(), 'cr-mcp-servers-db-'));
const configPath = join(dataDir, 'config.json');
writeFileSync(configPath, JSON.stringify({ persistence: { dataDir } }));
process.env.CLAUDE_REMOTE_CONFIG = configPath;

const { loadConfig } = await import('../src/server/config.js');
const { initDatabase, closeDatabase, getDatabase } = await import('../src/server/db/schema.js');
const { insertSession, getSession, launchProfileForTranscript } = await import('../src/server/db/queries.js');

function row(id: string, overrides: Partial<SessionMetadata> = {}): SessionMetadata {
  return {
    id,
    name: id,
    shell: 'pwsh',
    cwd: 'C:\\wt',
    createdAt: '2026-10-24T10:00:00.000Z',
    lastAccessedAt: '2026-10-24T10:00:00.000Z',
    ownerId: null,
    status: 'idle',
    cols: 80,
    rows: 24,
    tmuxSession: null,
    categoryId: null,
    sortOrder: 0,
    claudeSessionId: null,
    isFork: false,
    forkJsonlPath: null,
    ...overrides,
  };
}

beforeAll(() => {
  loadConfig();
  initDatabase();
});

afterAll(() => {
  closeDatabase();
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  getDatabase().exec('DELETE FROM sessions');
});

describe('sessions.mcp_servers', () => {
  it('round-trips: null is the full roster, [] is none, names are kept', () => {
    insertSession(row('a'));
    insertSession(row('b', { spawnedBy: 'a', mcpServers: [] }));
    insertSession(row('c', { spawnedBy: 'a', mcpServers: ['playwright'] }));
    expect(getSession('a')!.mcpServers).toBeNull();
    expect(getSession('b')!.mcpServers).toEqual([]);
    expect(getSession('c')!.mcpServers).toEqual(['playwright']);
  });

  it('finds a transcript’s profile only on a row that stored one, latest first', () => {
    insertSession(row('mine', { claudeSessionId: 'T1' }));
    expect(launchProfileForTranscript('T1')).toBeNull();
    insertSession(row('old', { claudeSessionId: 'T2', permissionMode: 'plan', mcpServers: [], createdAt: '2026-10-01T00:00:00.000Z' }));
    insertSession(row('new', { claudeSessionId: 'T2', permissionMode: 'auto', mcpServers: ['playwright'] }));
    expect(launchProfileForTranscript('T2')).toEqual({ permissionMode: 'auto', mcpServers: ['playwright'] });
    expect(launchProfileForTranscript('nope')).toBeNull();
  });

  it('migration 018 gives started sessions from before it no MCP, and leaves the user’s alone', () => {
    const db = getDatabase();
    // Back to the schema before 018, with one started and one user row in it.
    db.exec(`ALTER TABLE sessions DROP COLUMN mcp_servers; DELETE FROM migrations WHERE name = '018_session_mcp_servers';`);
    db.exec(`INSERT INTO sessions (id, name, shell, cwd, created_at, last_accessed_at, status, spawned_by)
             VALUES ('child', 'child', 'pwsh', 'C:\\wt', 'x', 'x', 'idle', 'parent'),
                    ('user', 'user', 'pwsh', 'C:\\p', 'x', 'x', 'idle', NULL)`);
    closeDatabase();
    initDatabase();
    expect(getSession('child')!.mcpServers).toEqual([]);
    expect(getSession('user')!.mcpServers).toBeNull();
  });
});

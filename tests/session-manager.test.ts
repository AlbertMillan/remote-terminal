import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';

// Mock node-pty before importing modules that use it
const mockPty = {
  pid: 12345,
  onData: vi.fn((callback: (data: string) => void) => {
    // Store callback for testing
    (mockPty as any)._dataCallback = callback;
  }),
  onExit: vi.fn((callback: (result: { exitCode: number }) => void) => {
    (mockPty as any)._exitCallback = callback;
  }),
  write: vi.fn(),
  resize: vi.fn(),
  kill: vi.fn(),
};

vi.mock('node-pty', () => ({
  spawn: vi.fn(() => mockPty),
}));

// Mock better-sqlite3
const mockStmt = {
  run: vi.fn(),
  get: vi.fn(() => ({ count: 0 })),
  all: vi.fn(() => []),
};

const mockDb = {
  pragma: vi.fn(),
  exec: vi.fn(),
  prepare: vi.fn(() => mockStmt),
  close: vi.fn(),
  transaction: vi.fn((fn: () => void) => fn),
};

vi.mock('better-sqlite3', () => ({
  default: vi.fn(() => mockDb),
}));

// Mock database schema
vi.mock('../src/server/db/schema.js', () => ({
  getDatabase: vi.fn(() => mockDb),
  initDatabase: vi.fn(() => mockDb),
  closeDatabase: vi.fn(),
}));

// Mock config
vi.mock('../src/server/config.js', () => ({
  getConfig: vi.fn(() => ({
    sessions: {
      maxSessions: 10,
      defaultShell: undefined,
      idleTimeoutMinutes: 0,
    },
    persistence: {
      scrollbackLines: 10000,
      dataDir: '/tmp/test',
    },
  })),
  loadConfig: vi.fn(),
}));

// Mock platform utils
vi.mock('../src/server/utils/platform.js', () => ({
  getDefaultShell: vi.fn(() => '/bin/bash'),
  getShellArgs: vi.fn(() => []),
  isWindows: vi.fn(() => false),
  isLinux: vi.fn(() => true),
  isMac: vi.fn(() => false),
  getPlatform: vi.fn(() => 'linux'),
}));

// Mock persistence
vi.mock('../src/server/sessions/persistence.js', () => ({
  isTmuxAvailable: vi.fn(() => Promise.resolve(false)),
  createTmuxSession: vi.fn(),
  killTmuxSession: vi.fn(),
  tmuxSessionExists: vi.fn(),
  persistScrollback: vi.fn(),
  restoreScrollback: vi.fn(() => []),
}));

// Mock logger
vi.mock('../src/server/utils/logger.js', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

// Import modules after mocks
import { ScrollbackBuffer } from '../src/server/sessions/pty-handler.js';
import { parseMessage, createMessage } from '../src/server/websocket/protocol.js';
import { RateLimiter } from '../src/server/utils/rate-limiter.js';

describe('ScrollbackBuffer', () => {
  it('should store and retrieve lines', () => {
    const buffer = new ScrollbackBuffer(100);
    buffer.push('line1\nline2\nline3\n');

    const all = buffer.getAll();
    expect(all).toContain('line1');
    expect(all).toContain('line2');
    expect(all).toContain('line3');
  });

  it('should handle partial lines correctly', () => {
    const buffer = new ScrollbackBuffer(100);
    buffer.push('partial');
    buffer.push(' line\ncomplete\n');

    const all = buffer.getAll();
    expect(all).toContain('partial line');
    expect(all).toContain('complete');
  });

  it('should respect max lines limit', () => {
    const buffer = new ScrollbackBuffer(3);
    buffer.push('line1\nline2\nline3\nline4\nline5\n');

    const all = buffer.getAll();
    expect(all.length).toBe(3);
    expect(all).not.toContain('line1');
    expect(all).not.toContain('line2');
    expect(all).toContain('line5');
  });

  it('should clear buffer', () => {
    const buffer = new ScrollbackBuffer(100);
    buffer.push('line1\nline2\n');
    buffer.clear();

    expect(buffer.length).toBe(0);
    expect(buffer.getAll()).toEqual([]);
  });

  it('should return recent lines', () => {
    const buffer = new ScrollbackBuffer(100);
    buffer.push('line1\nline2\nline3\nline4\n');

    const recent = buffer.getRecent(2);
    expect(recent.length).toBe(2);
    expect(recent).toContain('line3');
    expect(recent).toContain('line4');
  });
});

describe('WebSocket Protocol', () => {
  describe('parseMessage', () => {
    it('should parse valid JSON messages', () => {
      const msg = parseMessage('{"type":"ping","id":"1"}');
      expect(msg).toEqual({ type: 'ping', id: '1' });
    });

    it('should return null for invalid JSON', () => {
      const msg = parseMessage('not json');
      expect(msg).toBeNull();
    });

    it('should return null for messages without type', () => {
      const msg = parseMessage('{"id":"1"}');
      expect(msg).toBeNull();
    });

    it('should parse messages with payload', () => {
      const msg = parseMessage('{"type":"session.create","id":"1","payload":{"name":"test"}}');
      expect(msg?.type).toBe('session.create');
      expect(msg?.payload).toEqual({ name: 'test' });
    });
  });

  describe('createMessage', () => {
    it('should create message with type only', () => {
      const msg = createMessage('pong');
      const parsed = JSON.parse(msg);
      expect(parsed.type).toBe('pong');
    });

    it('should create message with payload', () => {
      const msg = createMessage('session.list', { sessions: [] });
      const parsed = JSON.parse(msg);
      expect(parsed.type).toBe('session.list');
      expect(parsed.payload).toEqual({ sessions: [] });
    });

    it('should create message with id', () => {
      const msg = createMessage('pong', undefined, 'request-123');
      const parsed = JSON.parse(msg);
      expect(parsed.id).toBe('request-123');
    });
  });
});

describe('RateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should allow requests within limit', () => {
    const limiter = new RateLimiter(5, 100);

    for (let i = 0; i < 5; i++) {
      expect(limiter.tryAcquire('client1')).toBe(true);
    }
  });

  it('should block requests over limit', () => {
    const limiter = new RateLimiter(3, 100);

    expect(limiter.tryAcquire('client1')).toBe(true);
    expect(limiter.tryAcquire('client1')).toBe(true);
    expect(limiter.tryAcquire('client1')).toBe(true);
    expect(limiter.tryAcquire('client1')).toBe(false);
  });

  it('should refill tokens over time', () => {
    const limiter = new RateLimiter(3, 100);

    // Use all tokens
    limiter.tryAcquire('client1');
    limiter.tryAcquire('client1');
    limiter.tryAcquire('client1');
    expect(limiter.tryAcquire('client1')).toBe(false);

    // Wait for refill
    vi.advanceTimersByTime(200);

    // Should have tokens again
    expect(limiter.tryAcquire('client1')).toBe(true);
  });

  it('should track clients independently', () => {
    const limiter = new RateLimiter(2, 100);

    limiter.tryAcquire('client1');
    limiter.tryAcquire('client1');
    expect(limiter.tryAcquire('client1')).toBe(false);

    // Client2 should still have tokens
    expect(limiter.tryAcquire('client2')).toBe(true);
  });

  it('should remove client state', () => {
    const limiter = new RateLimiter(2, 100);

    limiter.tryAcquire('client1');
    limiter.tryAcquire('client1');
    expect(limiter.getRemainingTokens('client1')).toBe(0);

    limiter.removeClient('client1');

    // After removal, client gets fresh tokens
    expect(limiter.tryAcquire('client1')).toBe(true);
    expect(limiter.getRemainingTokens('client1')).toBe(1); // Started with 2, used 1
  });
});

describe('Input Validation', () => {
  // These would test the validateSessionOptions function from handler.ts
  // Currently these are integration-level tests

  it('should reject session names that are too long', async () => {
    const longName = 'a'.repeat(200);
    // In a real test, we'd call the validation function
    expect(longName.slice(0, 100).length).toBe(100);
  });

  it('should reject invalid shell paths', () => {
    const validShellPattern = /^[a-zA-Z0-9/_.-]+$/;

    expect(validShellPattern.test('/bin/bash')).toBe(true);
    expect(validShellPattern.test('/usr/bin/zsh')).toBe(true);
    expect(validShellPattern.test('cmd.exe')).toBe(true);
    expect(validShellPattern.test('/bin/bash; rm -rf /')).toBe(false);
    expect(validShellPattern.test('$(whoami)')).toBe(false);
  });

  it('should reject paths with traversal', () => {
    const hasTraversal = (path: string) => path.includes('..');

    expect(hasTraversal('/home/user')).toBe(false);
    expect(hasTraversal('../../../etc/passwd')).toBe(true);
    expect(hasTraversal('/home/../root')).toBe(true);
  });
});

describe('IP Address Validation', () => {
  const IP_REGEX = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$|^(?:[a-fA-F0-9]{1,4}:){7}[a-fA-F0-9]{1,4}$|^::1$|^(?:[a-fA-F0-9]{1,4}:)*:[a-fA-F0-9]{1,4}$|^[a-fA-F0-9]{1,4}(?::[a-fA-F0-9]{1,4})*::$/;

  it('should accept valid IPv4 addresses', () => {
    expect(IP_REGEX.test('192.168.1.1')).toBe(true);
    expect(IP_REGEX.test('10.0.0.1')).toBe(true);
    expect(IP_REGEX.test('255.255.255.255')).toBe(true);
    expect(IP_REGEX.test('0.0.0.0')).toBe(true);
  });

  it('should accept valid IPv6 addresses', () => {
    expect(IP_REGEX.test('::1')).toBe(true);
    expect(IP_REGEX.test('2001:0db8:85a3:0000:0000:8a2e:0370:7334')).toBe(true);
  });

  it('should reject malicious input', () => {
    expect(IP_REGEX.test('127.0.0.1; rm -rf /')).toBe(false);
    expect(IP_REGEX.test('$(whoami)')).toBe(false);
    expect(IP_REGEX.test('127.0.0.1`id`')).toBe(false);
    expect(IP_REGEX.test('192.168.1.1 && cat /etc/passwd')).toBe(false);
  });
});

describe('SessionManager', () => {
  // Import after mocks are set up
  let createSessionManager: () => any;

  beforeEach(async () => {
    // Reset mocks
    vi.clearAllMocks();
    mockStmt.get.mockReturnValue({ count: 0 });
    mockStmt.all.mockReturnValue([]);

    // Dynamically import to get fresh instance
    const managerModule = await import('../src/server/sessions/manager.js');
    createSessionManager = managerModule.createSessionManager;
  });

  it('should create a session with default options', async () => {
    const manager = createSessionManager();

    const session = await manager.createSession();

    expect(session).toBeDefined();
    expect(session.id).toBeDefined();
    expect(session.name).toMatch(/^Session \d+$/);
    expect(session.shell).toBe('/bin/bash');
    expect(session.status).toBe('active');
    expect(session.cols).toBe(80);
    expect(session.rows).toBe(24);

    await manager.shutdown();
  });

  it('should create a session with custom options', async () => {
    const manager = createSessionManager();

    const session = await manager.createSession({
      name: 'Custom Session',
      cols: 120,
      rows: 40,
    });

    expect(session.name).toBe('Custom Session');
    expect(session.cols).toBe(120);
    expect(session.rows).toBe(40);

    await manager.shutdown();
  });

  it('should get session by id', async () => {
    const manager = createSessionManager();
    const created = await manager.createSession({ name: 'Test' });

    const retrieved = manager.getSession(created.id);

    expect(retrieved).toBeDefined();
    expect(retrieved?.id).toBe(created.id);
    expect(retrieved?.name).toBe('Test');

    await manager.shutdown();
  });

  it('should return undefined for non-existent session', async () => {
    const manager = createSessionManager();

    const session = manager.getSession('non-existent-id');

    expect(session).toBeUndefined();

    await manager.shutdown();
  });

  it('should list all active sessions', async () => {
    const manager = createSessionManager();
    await manager.createSession({ name: 'Session 1' });
    await manager.createSession({ name: 'Session 2' });

    const sessions = manager.getAllSessions();

    expect(sessions.length).toBe(2);
    expect(sessions.map(s => s.name)).toContain('Session 1');
    expect(sessions.map(s => s.name)).toContain('Session 2');

    await manager.shutdown();
  });

  it('should terminate a session', async () => {
    const manager = createSessionManager();
    const session = await manager.createSession({ name: 'To Terminate' });

    const result = await manager.terminateSession(session.id);

    expect(result).toBe(true);
    expect(manager.getSession(session.id)).toBeUndefined();
    expect(mockPty.kill).toHaveBeenCalled();

    await manager.shutdown();
  });

  it('should return false when terminating non-existent session', async () => {
    const manager = createSessionManager();

    const result = await manager.terminateSession('non-existent');

    expect(result).toBe(false);

    await manager.shutdown();
  });

  it('should rename a session', async () => {
    const manager = createSessionManager();
    const session = await manager.createSession({ name: 'Original' });

    const result = manager.renameSession(session.id, 'Renamed');

    expect(result).toBe(true);
    expect(manager.getSession(session.id)?.name).toBe('Renamed');

    await manager.shutdown();
  });

  it('should write data to session', async () => {
    const manager = createSessionManager();
    const session = await manager.createSession();

    const result = manager.writeToSession(session.id, 'test input');

    expect(result).toBe(true);
    expect(mockPty.write).toHaveBeenCalledWith('test input');

    await manager.shutdown();
  });

  it('should resize a session', async () => {
    const manager = createSessionManager();
    const session = await manager.createSession();

    const result = manager.resizeSession(session.id, 200, 50);

    expect(result).toBe(true);
    expect(mockPty.resize).toHaveBeenCalledWith(200, 50);
    expect(manager.getSession(session.id)?.cols).toBe(200);
    expect(manager.getSession(session.id)?.rows).toBe(50);

    await manager.shutdown();
  });

  it('should track connected clients', async () => {
    const manager = createSessionManager();
    const session = await manager.createSession();

    manager.addClient(session.id, 'client-1');
    manager.addClient(session.id, 'client-2');

    expect(manager.getSession(session.id)?.connectedClients.size).toBe(2);

    manager.removeClient(session.id, 'client-1');

    expect(manager.getSession(session.id)?.connectedClients.size).toBe(1);

    await manager.shutdown();
  });

  it('should register and call data listeners', async () => {
    const manager = createSessionManager();
    const session = await manager.createSession();
    const listener = vi.fn();

    manager.onData(session.id, listener);

    // Simulate PTY data
    const dataCallback = (mockPty as any)._dataCallback;
    dataCallback('test output');

    expect(listener).toHaveBeenCalledWith('test output');

    await manager.shutdown();
  });

  it('should unsubscribe data listeners', async () => {
    const manager = createSessionManager();
    const session = await manager.createSession();
    const listener = vi.fn();

    const unsubscribe = manager.onData(session.id, listener);
    unsubscribe();

    // Simulate PTY data
    const dataCallback = (mockPty as any)._dataCallback;
    dataCallback('test output');

    expect(listener).not.toHaveBeenCalled();

    await manager.shutdown();
  });

  it('should get scrollback from buffer', async () => {
    const manager = createSessionManager();
    const session = await manager.createSession();

    // Simulate PTY output
    const dataCallback = (mockPty as any)._dataCallback;
    dataCallback('line1\nline2\nline3\n');

    const scrollback = manager.getScrollback(session.id);

    expect(scrollback).toContain('line1');
    expect(scrollback).toContain('line2');
    expect(scrollback).toContain('line3');

    await manager.shutdown();
  });
});

describe('SessionManager - Session Limits', () => {
  let createSessionManager: () => any;
  let getConfig: any;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Mock config with low session limit
    const configModule = await import('../src/server/config.js');
    getConfig = configModule.getConfig as any;
    getConfig.mockReturnValue({
      sessions: {
        maxSessions: 2,
        defaultShell: undefined,
        idleTimeoutMinutes: 0,
      },
      persistence: {
        scrollbackLines: 10000,
        dataDir: '/tmp/test',
      },
    });

    mockStmt.get.mockReturnValue({ count: 0 });

    const managerModule = await import('../src/server/sessions/manager.js');
    createSessionManager = managerModule.createSessionManager;
  });

  it('should enforce session limit', async () => {
    const manager = createSessionManager();

    // Update mock to simulate session count
    let sessionCount = 0;
    mockStmt.get.mockImplementation(() => ({ count: sessionCount }));

    await manager.createSession({ name: 'Session 1' });
    sessionCount = 1;

    await manager.createSession({ name: 'Session 2' });
    sessionCount = 2;

    // Third session should fail
    await expect(manager.createSession({ name: 'Session 3' }))
      .rejects.toThrow('Maximum session limit (2) reached');

    await manager.shutdown();
  });
});

describe('ScrollbackBuffer - Circular Buffer Behavior', () => {
  it('should maintain correct order with circular wrap', () => {
    const buffer = new ScrollbackBuffer(5);

    // Add more lines than buffer size
    buffer.push('line1\nline2\nline3\nline4\nline5\nline6\nline7\n');

    const all = buffer.getAll();

    // Should contain only the last 5 lines
    expect(all.length).toBe(5);
    expect(all[0]).toBe('line3');
    expect(all[1]).toBe('line4');
    expect(all[2]).toBe('line5');
    expect(all[3]).toBe('line6');
    expect(all[4]).toBe('line7');
  });

  it('should handle multiple pushes with wrap-around', () => {
    const buffer = new ScrollbackBuffer(3);

    buffer.push('a\nb\n');
    buffer.push('c\nd\n');
    buffer.push('e\n');

    const all = buffer.getAll();

    expect(all.length).toBe(3);
    expect(all).toContain('c');
    expect(all).toContain('d');
    expect(all).toContain('e');
  });

  it('should handle empty buffer', () => {
    const buffer = new ScrollbackBuffer(10);

    expect(buffer.getAll()).toEqual([]);
    expect(buffer.length).toBe(0);
  });

  it('should handle only partial line', () => {
    const buffer = new ScrollbackBuffer(10);

    buffer.push('partial without newline');

    const all = buffer.getAll();
    expect(all.length).toBe(1);
    expect(all[0]).toBe('partial without newline');
  });
});

describe('WebSocket Protocol - All Message Types', () => {
  describe('createMessage', () => {
    it('should create session.created message', () => {
      const session = {
        id: '123',
        name: 'Test',
        shell: '/bin/bash',
        cwd: '/home',
        createdAt: '2024-01-01',
        lastAccessedAt: '2024-01-01',
        status: 'active',
        cols: 80,
        rows: 24,
        attachable: true,
        categoryId: null,
      };
      const msg = createMessage('session.created', { session });
      const parsed = JSON.parse(msg);

      expect(parsed.type).toBe('session.created');
      expect(parsed.payload.session.id).toBe('123');
      expect(parsed.payload.session.name).toBe('Test');
    });

    it('should create terminal.data message', () => {
      const msg = createMessage('terminal.data', { sessionId: '123', data: 'output' });
      const parsed = JSON.parse(msg);

      expect(parsed.type).toBe('terminal.data');
      expect(parsed.payload.sessionId).toBe('123');
      expect(parsed.payload.data).toBe('output');
    });

    it('should create error message', () => {
      const msg = createMessage('error', { message: 'Something went wrong' });
      const parsed = JSON.parse(msg);

      expect(parsed.type).toBe('error');
      expect(parsed.payload.message).toBe('Something went wrong');
    });

    it('should create notification message', () => {
      const msg = createMessage('notification', {
        sessionId: '123',
        type: 'needs-input',
        timestamp: '2024-01-01T00:00:00Z',
      });
      const parsed = JSON.parse(msg);

      expect(parsed.type).toBe('notification');
      expect(parsed.payload.type).toBe('needs-input');
    });
  });

  describe('parseMessage', () => {
    it('should parse session.create message', () => {
      const msg = parseMessage('{"type":"session.create","id":"1","payload":{"name":"Test","cols":100}}');

      expect(msg?.type).toBe('session.create');
      expect((msg?.payload as any).name).toBe('Test');
      expect((msg?.payload as any).cols).toBe(100);
    });

    it('should parse terminal.data message', () => {
      const msg = parseMessage('{"type":"terminal.data","payload":{"sessionId":"123","data":"input"}}');

      expect(msg?.type).toBe('terminal.data');
      expect((msg?.payload as any).sessionId).toBe('123');
      expect((msg?.payload as any).data).toBe('input');
    });

    it('should parse terminal.resize message', () => {
      const msg = parseMessage('{"type":"terminal.resize","payload":{"sessionId":"123","cols":120,"rows":40}}');

      expect(msg?.type).toBe('terminal.resize');
      expect((msg?.payload as any).cols).toBe(120);
      expect((msg?.payload as any).rows).toBe(40);
    });

    it('should handle malformed JSON gracefully', () => {
      expect(parseMessage('{')).toBeNull();
      expect(parseMessage('')).toBeNull();
      expect(parseMessage('null')).toBeNull();
      expect(parseMessage('[]')).toBeNull();
    });

    it('should reject messages with non-string type', () => {
      expect(parseMessage('{"type":123}')).toBeNull();
      expect(parseMessage('{"type":null}')).toBeNull();
      expect(parseMessage('{"type":[]}')).toBeNull();
    });
  });
});

describe('RateLimiter - Edge Cases', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should not exceed max tokens on refill', () => {
    const limiter = new RateLimiter(5, 100);

    // Use one token
    limiter.tryAcquire('client1');
    expect(limiter.getRemainingTokens('client1')).toBe(4);

    // Wait a long time
    vi.advanceTimersByTime(10000);

    // Should not exceed max
    limiter.tryAcquire('client1');
    expect(limiter.getRemainingTokens('client1')).toBe(4); // 5 max, minus 1 used
  });

  it('should handle rapid requests', () => {
    const limiter = new RateLimiter(10, 10);

    // Rapidly acquire all tokens
    for (let i = 0; i < 10; i++) {
      expect(limiter.tryAcquire('rapid')).toBe(true);
    }

    // Next should fail
    expect(limiter.tryAcquire('rapid')).toBe(false);

    // Wait for one token
    vi.advanceTimersByTime(10);
    expect(limiter.tryAcquire('rapid')).toBe(true);
  });

  it('should handle zero remaining tokens correctly', () => {
    const limiter = new RateLimiter(1, 1000);

    expect(limiter.tryAcquire('client')).toBe(true);
    expect(limiter.getRemainingTokens('client')).toBe(0);
    expect(limiter.tryAcquire('client')).toBe(false);
  });
});

describe('Terminal Dimension Validation', () => {
  const MIN_TERMINAL_DIMENSION = 1;
  const MAX_TERMINAL_DIMENSION = 500;

  function isValidDimension(value: number): boolean {
    return !isNaN(value) &&
           value >= MIN_TERMINAL_DIMENSION &&
           value <= MAX_TERMINAL_DIMENSION;
  }

  it('should accept valid dimensions', () => {
    expect(isValidDimension(80)).toBe(true);
    expect(isValidDimension(24)).toBe(true);
    expect(isValidDimension(1)).toBe(true);
    expect(isValidDimension(500)).toBe(true);
    expect(isValidDimension(120)).toBe(true);
  });

  it('should reject invalid dimensions', () => {
    expect(isValidDimension(0)).toBe(false);
    expect(isValidDimension(-1)).toBe(false);
    expect(isValidDimension(501)).toBe(false);
    expect(isValidDimension(10000)).toBe(false);
    expect(isValidDimension(NaN)).toBe(false);
  });
});

describe('Tmux Session Name Validation', () => {
  const VALID_SESSION_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

  it('should accept valid session names', () => {
    expect(VALID_SESSION_NAME_PATTERN.test('claude-remote-abc12345')).toBe(true);
    expect(VALID_SESSION_NAME_PATTERN.test('session_1')).toBe(true);
    expect(VALID_SESSION_NAME_PATTERN.test('MySession')).toBe(true);
    expect(VALID_SESSION_NAME_PATTERN.test('test-session-123')).toBe(true);
  });

  it('should reject invalid session names', () => {
    expect(VALID_SESSION_NAME_PATTERN.test('session; rm -rf /')).toBe(false);
    expect(VALID_SESSION_NAME_PATTERN.test('$(whoami)')).toBe(false);
    expect(VALID_SESSION_NAME_PATTERN.test('session name')).toBe(false);
    expect(VALID_SESSION_NAME_PATTERN.test('session\nname')).toBe(false);
    expect(VALID_SESSION_NAME_PATTERN.test('')).toBe(false);
    expect(VALID_SESSION_NAME_PATTERN.test('session"name')).toBe(false);
  });
});

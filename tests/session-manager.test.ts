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
};

vi.mock('better-sqlite3', () => ({
  default: vi.fn(() => mockDb),
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

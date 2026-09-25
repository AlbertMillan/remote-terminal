import { describe, it, expect } from 'vitest';
import { isAllowedWebSocketOrigin } from '../src/server/websocket/origin.js';

/**
 * Identity is resolved from the source IP, so a socket opened by a hostile page in the
 * user's browser would authenticate as the user. The Origin check is what stops it; these
 * tests pin that it refuses foreign pages without locking out any legitimate way in.
 */

describe('isAllowedWebSocketOrigin', () => {
  it('accepts the page the server served, however the server was reached', () => {
    expect(isAllowedWebSocketOrigin('https://box.tail1234.ts.net:4220', 'box.tail1234.ts.net:4220')).toBe(true);
    expect(isAllowedWebSocketOrigin('http://100.64.1.2:4220', '100.64.1.2:4220')).toBe(true);
    expect(isAllowedWebSocketOrigin('http://localhost:4220', 'localhost:4220')).toBe(true);
    expect(isAllowedWebSocketOrigin('http://[::1]:4220', '[::1]:4220')).toBe(true);
  });

  it('compares hosts case-insensitively', () => {
    expect(isAllowedWebSocketOrigin('https://BOX.tail1234.ts.net:4220', 'box.tail1234.ts.net:4220')).toBe(true);
  });

  it('accepts a missing Origin, which only non-browser clients send', () => {
    expect(isAllowedWebSocketOrigin(undefined, 'localhost:4220')).toBe(true);
  });

  it('rejects a foreign page', () => {
    expect(isAllowedWebSocketOrigin('https://evil.example', 'box.tail1234.ts.net:4220')).toBe(false);
  });

  it('rejects the same host on a different port', () => {
    expect(isAllowedWebSocketOrigin('http://localhost:3000', 'localhost:4220')).toBe(false);
  });

  it('rejects a host that merely contains the server name', () => {
    expect(isAllowedWebSocketOrigin('https://box.tail1234.ts.net.evil.example', 'box.tail1234.ts.net')).toBe(false);
  });

  it('rejects the opaque `null` origin and non-http schemes', () => {
    expect(isAllowedWebSocketOrigin('null', 'localhost:4220')).toBe(false);
    expect(isAllowedWebSocketOrigin('file://', 'localhost:4220')).toBe(false);
    expect(isAllowedWebSocketOrigin('chrome-extension://abc', 'abc')).toBe(false);
  });

  it('rejects when the request carries no Host', () => {
    expect(isAllowedWebSocketOrigin('http://localhost:4220', undefined)).toBe(false);
  });
});

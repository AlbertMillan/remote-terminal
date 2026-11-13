import { describe, it, expect } from 'vitest';
import { hostName, isAllowedHost, isGuardedPath } from '../src/server/host-check.js';

/** DNS rebinding: a page on another domain pointed at this server must not reach /api or /ws. */

describe('isAllowedHost', () => {
  it('takes every usual way of reaching the server, with nothing configured', () => {
    for (const host of [
      'localhost:4220',
      '127.0.0.1:4220',
      '[::1]:4220',
      '100.101.102.103:4220',
      '192.168.1.20',
      'my-pc:4220',
      'my-pc.tail1234.ts.net',
      'my-pc.tail1234.ts.net.:443',
      'app.localhost',
    ]) {
      expect(isAllowedHost(host), host).toBe(true);
    }
  });

  it('refuses any other domain, the rebinding case', () => {
    expect(isAllowedHost('evil.example:4220')).toBe(false);
    expect(isAllowedHost('ts.net.evil.example')).toBe(false);
    expect(isAllowedHost('localhost.evil.example')).toBe(false);
    expect(isAllowedHost(undefined)).toBe(false);
    expect(isAllowedHost('')).toBe(false);
  });

  it('takes configured names, whatever their case', () => {
    expect(isAllowedHost('PC.home.lan:4220', ['pc.home.lan'])).toBe(true);
    expect(isAllowedHost('pc.home.lan', [undefined])).toBe(false);
  });
});

describe('hostName', () => {
  it('drops the port and IPv6 brackets', () => {
    expect(hostName('Example.COM:80')).toBe('example.com');
    expect(hostName('[fd7a:115c:a1e0::1]:4220')).toBe('fd7a:115c:a1e0::1');
    expect(hostName('[')).toBeNull();
    expect(hostName('a:b:c')).toBeNull();
  });
});

describe('isGuardedPath', () => {
  it('covers the API and the socket, not the page', () => {
    expect(isGuardedPath('/api/sessions')).toBe(true);
    expect(isGuardedPath('/ws')).toBe(true);
    expect(isGuardedPath('/ws?x=1')).toBe(true);
    expect(isGuardedPath('/')).toBe(false);
    expect(isGuardedPath('/terminal.js')).toBe(false);
    expect(isGuardedPath('/wsx')).toBe(false);
  });
});

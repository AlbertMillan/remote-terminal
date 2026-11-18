import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { registerAccessGate } from '../src/server/auth/access-gate.js';
import { createIdentityVerifier, type TailscaleIdentity } from '../src/server/auth/tailscale.js';
import { isGuardedRequest } from '../src/server/host-check.js';

/** The gate in front of /api/* and /ws (docs/auth.md). */

async function gatedApp(verify: (ip: string) => Promise<unknown> = async () => ({ userId: 'me' })) {
  const app = Fastify();
  registerAccessGate(app, { hosts: () => [], verify });
  app.get('/api/secret', async () => 'SECRET');
  app.post('/api/jobs', async () => 'QUEUED');
  app.get('/ws', async () => 'WS');
  app.get('/page', async () => 'PAGE');
  await app.ready();
  return app;
}

describe('isGuardedRequest', () => {
  it('judges the matched route and the decoded path, not the raw URL', () => {
    expect(isGuardedRequest('/%61pi/secret', '/api/secret')).toBe(true);
    expect(isGuardedRequest('/%61pi/secret', undefined)).toBe(true);
    expect(isGuardedRequest('/w%73', undefined)).toBe(true);
    expect(isGuardedRequest('/ws?device=x', '/ws')).toBe(true);
    expect(isGuardedRequest('/terminal.js', '/*')).toBe(false);
    expect(isGuardedRequest('/%zz', undefined)).toBe(true);
  });
});

describe('registerAccessGate', () => {
  it('refuses an unknown Host however the path is spelled', async () => {
    const app = await gatedApp();
    for (const url of ['/api/secret', '/%61pi/secret', '/%2561pi/secret', '/ws', '/w%73']) {
      const res = await app.inject({ url, headers: { host: 'evil.example' } });
      expect(res.body, url).not.toMatch(/SECRET|WS/);
    }
    // The page itself is not guarded.
    expect((await app.inject({ url: '/page', headers: { host: 'evil.example' } })).statusCode).toBe(200);
    await app.close();
  });

  it('refuses a caller with no identity, encoded path included', async () => {
    const app = await gatedApp(async () => null);
    for (const url of ['/api/secret', '/%61pi/secret', '/w%73']) {
      const res = await app.inject({ url, headers: { host: 'localhost:4220' } });
      expect(res.statusCode, url).toBe(403);
    }
    await app.close();
  });

  it('refuses a state-changing request from another origin, allows one with none', async () => {
    const app = await gatedApp();
    const cross = await app.inject({
      method: 'POST',
      url: '/api/jobs',
      headers: { host: '127.0.0.1:4220', origin: 'https://evil.example' },
    });
    expect(cross.statusCode).toBe(403);
    const same = await app.inject({
      method: 'POST',
      url: '/api/jobs',
      headers: { host: '127.0.0.1:4220', origin: 'http://127.0.0.1:4220' },
    });
    expect(same.body).toBe('QUEUED');
    const script = await app.inject({ method: 'POST', url: '/api/jobs', headers: { host: '127.0.0.1:4220' } });
    expect(script.body).toBe('QUEUED');
    // A read from another origin is left to CORS (the browser hides the answer).
    const read = await app.inject({ url: '/api/secret', headers: { host: '127.0.0.1:4220', origin: 'https://evil.example' } });
    expect(read.body).toBe('SECRET');
    await app.close();
  });
});

describe('createIdentityVerifier', () => {
  const someone: TailscaleIdentity = {
    userId: '1',
    loginName: 'me@example.com',
    displayName: 'Me',
    node: 'phone',
    nodeIp: '100.64.0.2',
    tailnet: 'example',
  };

  function verifier(over: Partial<Parameters<typeof createIdentityVerifier>[0]> = {}) {
    let t = 0;
    const whois = vi.fn(async (_ip: string) => someone as TailscaleIdentity | null);
    const verify = createIdentityVerifier({
      auth: () => ({ enabled: true, allowedUsers: [] }),
      available: async () => true,
      whois,
      now: () => t,
      ...over,
    });
    return { verify, whois, advance: (ms: number) => (t += ms) };
  }

  it('admits loopback without asking Tailscale', async () => {
    const { verify, whois } = verifier({ available: async () => false });
    expect(await verify('127.0.0.1')).toMatchObject({ userId: 'local' });
    expect(await verify('::1')).toMatchObject({ userId: 'local' });
    expect(whois).not.toHaveBeenCalled();
  });

  it('refuses everyone else when the tailscale CLI is missing', async () => {
    const { verify } = verifier({ available: async () => false });
    expect(await verify('192.168.1.20')).toBeNull();
    expect(await verify('')).toBeNull();
  });

  it('caches answers, refusals for less time', async () => {
    const { verify, whois, advance } = verifier();
    await verify('100.64.0.2');
    await verify('100.64.0.2');
    expect(whois).toHaveBeenCalledTimes(1);
    advance(61_000);
    await verify('100.64.0.2');
    expect(whois).toHaveBeenCalledTimes(2);

    whois.mockResolvedValue(null);
    expect(await verify('192.168.1.20')).toBeNull();
    expect(await verify('192.168.1.20')).toBeNull();
    expect(whois).toHaveBeenCalledTimes(3);
    advance(11_000);
    await verify('192.168.1.20');
    expect(whois).toHaveBeenCalledTimes(4);
  });

  it('applies allowedUsers', async () => {
    const { verify } = verifier({ auth: () => ({ enabled: true, allowedUsers: ['other@example.com'] }) });
    expect(await verify('100.64.0.2')).toBeNull();
  });

  it('admits everyone when auth is off', async () => {
    const { verify } = verifier({ auth: () => ({ enabled: false, allowedUsers: [] }) });
    expect(await verify('192.168.1.20')).toMatchObject({ userId: 'anonymous' });
  });
});

import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'child_process';
import { createServer, type Server } from 'http';
import { join } from 'path';
import type { AddressInfo } from 'net';

/**
 * scripts/statusline.mjs, run as Claude Code runs it: payload on stdin, one
 * line on stdout. It runs on every status line render, so the property that
 * matters most is that it never waits long or fails — server down included.
 */

const SCRIPT = join(__dirname, '..', 'scripts', 'statusline.mjs');

function run(stdin: string, url: string): Promise<{ stdout: string; ms: number; code: number | null }> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [SCRIPT], { env: { ...process.env, CLAUDE_REMOTE_URL: url } });
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += String(d)));
    child.on('close', (code) => resolve({ stdout, ms: Date.now() - started, code }));
    child.stdin.end(stdin);
  });
}

const PAYLOAD = {
  model: { display_name: 'Opus 5' },
  rate_limits: {
    five_hour: { used_percentage: 55.4, resets_at: 1790000000 },
    seven_day: { used_percentage: 22, resets_at: 1790300000 },
  },
};

let server: Server | null = null;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

function listen(handler: (body: string) => void, delayMs = 0): Promise<string> {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (d) => (body += String(d)));
      req.on('end', () => {
        handler(body);
        setTimeout(() => res.end('{}'), delayMs);
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server!.address() as AddressInfo).port}`));
  });
}

describe('statusline.mjs', () => {
  it('prints the model and both windows, and relays the payload', async () => {
    const received: string[] = [];
    const url = await listen((b) => received.push(b));
    const out = await run(JSON.stringify(PAYLOAD), url);
    expect(out.stdout).toBe('Opus 5 · 5h 55% · wk 22%\n');
    expect(JSON.parse(received[0]).rate_limits.five_hour.used_percentage).toBe(55.4);
  });

  it('prints the model alone before the first response, and relays nothing', async () => {
    const received: string[] = [];
    const url = await listen((b) => received.push(b));
    const out = await run(JSON.stringify({ model: { display_name: 'Opus 5' } }), url);
    expect(out.stdout).toBe('Opus 5\n');
    expect(received).toHaveLength(0);
  });

  it('still prints, promptly, when the server is down', async () => {
    const out = await run(JSON.stringify(PAYLOAD), 'http://127.0.0.1:1');
    expect(out.stdout).toBe('Opus 5 · 5h 55% · wk 22%\n');
    expect(out.code).toBe(0);
    expect(out.ms).toBeLessThan(3000);
  });

  it('gives up on a server that hangs instead of stalling the status line', async () => {
    const url = await listen(() => {}, 5000);
    const out = await run(JSON.stringify(PAYLOAD), url);
    expect(out.stdout).toBe('Opus 5 · 5h 55% · wk 22%\n');
    expect(out.ms).toBeLessThan(3000);
  });

  it('prints something even for a payload it cannot parse', async () => {
    const out = await run('not json', 'http://127.0.0.1:1');
    expect(out.stdout).toBe('Claude Code\n');
  });
});

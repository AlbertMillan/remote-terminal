import { describe, it, expect, afterEach, afterAll } from 'vitest';
import { spawn } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { createServer, type Server } from 'http';
import { tmpdir } from 'os';
import { join } from 'path';
import type { AddressInfo } from 'net';

/**
 * scripts/statusline.mjs, run as Claude Code runs it: payload on stdin, one
 * line on stdout. It runs on every status line render, so the property that
 * matters most is that it never waits long or fails — server down included.
 */

const SCRIPT = join(__dirname, '..', 'scripts', 'statusline.mjs');

// The accounts the script maps CLAUDE_CONFIG_DIR against: pinned, so this machine's
// own config.json never decides the output. Neither is the default ~/.claude.
const ACCOUNTS_DIR = mkdtempSync(join(tmpdir(), 'cr-statusline-'));
const WORK_DIR = join(ACCOUNTS_DIR, 'work');
const ACCOUNTS_CONFIG = join(ACCOUNTS_DIR, 'config.json');
writeFileSync(
  ACCOUNTS_CONFIG,
  JSON.stringify({ accounts: { personal: { configDir: join(ACCOUNTS_DIR, 'personal') }, work: { configDir: WORK_DIR } } })
);
afterAll(() => rmSync(ACCOUNTS_DIR, { recursive: true, force: true }));

function run(
  stdin: string,
  url: string,
  configDir?: string
): Promise<{ stdout: string; ms: number; code: number | null }> {
  return new Promise((resolve) => {
    const started = Date.now();
    // CLAUDE_CONFIG_DIR as the session's `claude` has it: unset for the default ~/.claude.
    const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_REMOTE_URL: url, CLAUDE_REMOTE_CONFIG: ACCOUNTS_CONFIG };
    delete env.CLAUDE_CONFIG_DIR;
    if (configDir) env.CLAUDE_CONFIG_DIR = configDir;
    const child = spawn(process.execPath, [SCRIPT], { env });
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
  it('prints the model and both windows, and relays the limits', async () => {
    const received: string[] = [];
    const url = await listen((b) => received.push(b));
    const out = await run(JSON.stringify(PAYLOAD), url);
    expect(out.stdout).toBe('Opus 5 · 5h 55% · wk 22%\n');
    expect(JSON.parse(received[0]).rate_limits.five_hour.used_percentage).toBe(55.4);
  });

  it('relays only the limits, never the rest of the payload', async () => {
    // The payload carries the cwd, transcript path, session id and cost; the
    // server reads none of it, and CLAUDE_REMOTE_URL may name another machine.
    const received: string[] = [];
    const url = await listen((b) => received.push(b));
    await run(
      JSON.stringify({
        ...PAYLOAD,
        session_id: 'abc',
        transcript_path: 'C:/Users/me/.claude/projects/x/abc.jsonl',
        workspace: { current_dir: 'C:/secret-project' },
        cost: { total_cost_usd: 1.23 },
      }),
      url
    );
    expect(Object.keys(JSON.parse(received[0]))).toEqual(['rate_limits', 'config_dir']);
    expect(received[0]).not.toContain('secret-project');
  });

  it('prints the model alone before the first response, and still reports in', async () => {
    // No limits yet, but the contact is what tells the chip the relay is installed.
    const received: string[] = [];
    const url = await listen((b) => received.push(b));
    const out = await run(JSON.stringify({ model: { display_name: 'Opus 5' } }), url);
    expect(out.stdout).toBe('Opus 5\n');
    expect(received).toEqual(['{"rate_limits":null,"config_dir":null}']);
  });

  it("says which account's folder the limits belong to", async () => {
    const received: string[] = [];
    const url = await listen((b) => received.push(b));
    await run(JSON.stringify(PAYLOAD), url, 'C:/Users/me/.claude-personal');
    expect(JSON.parse(received[0]).config_dir).toBe('C:/Users/me/.claude-personal');
  });

  it("names the account whose folder this claude runs on, matched however it's spelled", async () => {
    const out = await run(JSON.stringify(PAYLOAD), 'http://127.0.0.1:1', WORK_DIR.toUpperCase() + '/');
    expect(out.stdout).toBe(
      process.platform === 'win32' ? 'Opus 5 · [work] · 5h 55% · wk 22%\n' : 'Opus 5 · 5h 55% · wk 22%\n'
    );
    const exact = await run(JSON.stringify(PAYLOAD), 'http://127.0.0.1:1', WORK_DIR);
    expect(exact.stdout).toBe('Opus 5 · [work] · 5h 55% · wk 22%\n');
  });

  it('names no account for a folder none uses', async () => {
    const out = await run(JSON.stringify(PAYLOAD), 'http://127.0.0.1:1', join(ACCOUNTS_DIR, 'other'));
    expect(out.stdout).toBe('Opus 5 · 5h 55% · wk 22%\n');
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

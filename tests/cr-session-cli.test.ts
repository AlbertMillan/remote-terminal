import { describe, it, expect, afterEach, vi } from 'vitest';
import { spawn } from 'child_process';
import { createServer, type Server } from 'http';
import { join } from 'path';
import { Readable } from 'stream';
import type { AddressInfo } from 'net';
// @ts-expect-error -- a plain .mjs script with no type declarations
import { main } from '../scripts/cr-session.mjs';

/**
 * scripts/cr-session.mjs, the agent's way into the agent-sessions API. The
 * prompt arrives on stdin, from a quoted heredoc, and must reach the server
 * byte for byte; a missing prompt must fail before any request is sent.
 */

const SCRIPT = join(__dirname, '..', 'scripts', 'cr-session.mjs');
const ENV = { CLAUDE_REMOTE_URL: 'http://127.0.0.1:4399', CLAUDE_REMOTE_TOKEN: 't0ken' };
const PROMPT = 'Implement f-abc123 per "project/split-view.md".\nKeep $HOME, `ticks`, \'quotes\' and \\back\\slashes.\n\nDone.\n';

function okFetch(body: unknown = { sessionId: 's1' }) {
  return vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify(body), { status: 200 }));
}

async function run(opts: { argv: string[]; stdin?: unknown; env?: Record<string, string>; fetchImpl?: unknown }) {
  let stdout = '';
  let stderr = '';
  const code = await main({
    argv: opts.argv,
    env: opts.env ?? ENV,
    stdin: opts.stdin ?? Readable.from([PROMPT]),
    fetchImpl: opts.fetchImpl ?? okFetch(),
    out: (s: string) => (stdout += s),
    err: (s: string) => (stderr += s),
  });
  return { code, stdout, stderr };
}

describe('start', () => {
  it('sends the prompt from stdin unchanged, with the token and flags', async () => {
    const fetchImpl = okFetch();
    const res = await run({ argv: ['start', '--track', 'Split view', '--mode', 'acceptEdits', '--name', 'impl'], fetchImpl });
    expect(res.code).toBe(0);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:4399/api/agent/sessions');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer t0ken');
    expect(JSON.parse(init.body as string)).toEqual({ track: 'Split view', prompt: PROMPT, name: 'impl', permissionMode: 'acceptEdits' });
    expect(JSON.parse(res.stdout)).toEqual({ sessionId: 's1' });
  });

  it('fails before any request when stdin is a terminal', async () => {
    const fetchImpl = okFetch();
    const res = await run({ argv: ['start', '--track', 'Split view'], stdin: { isTTY: true }, fetchImpl });
    expect(res.code).not.toBe(0);
    expect(res.stderr).toMatch(/stdin/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fails before any request when stdin is empty or blank', async () => {
    for (const input of [[], ['  \n\n']]) {
      const fetchImpl = okFetch();
      const res = await run({ argv: ['start', '--track', 'Split view'], stdin: Readable.from(input), fetchImpl });
      expect(res.code).not.toBe(0);
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  it('refuses a missing --track, an unknown mode or a --prompt flag', async () => {
    for (const argv of [
      ['start'],
      ['start', '--track', 'X', '--mode', 'bypassPermissions'],
      ['start', '--track', 'X', '--mode', 'dontAsk'],
      ['start', '--track', 'X', '--prompt', 'hi'],
    ]) {
      const fetchImpl = okFetch();
      const res = await run({ argv, fetchImpl });
      expect(res.code).toBe(2);
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  it('sends auto and manual, and passes the old name default on for the server to map', async () => {
    for (const mode of ['auto', 'manual', 'default']) {
      const fetchImpl = okFetch();
      const res = await run({ argv: ['start', '--track', 'X', '--mode', mode], fetchImpl });
      expect(res.code).toBe(0);
      expect(JSON.parse(fetchImpl.mock.calls[0][1].body as string).permissionMode).toBe(mode);
    }
  });

  it('says where it is meant to run when the env is missing', async () => {
    const res = await run({ argv: ['list'], env: {} });
    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/inside a claude-remote session/);
  });

  it("reports the server's error with its status", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: 'No track "X"' }), { status: 404 }));
    const res = await run({ argv: ['start', '--track', 'X'], fetchImpl });
    expect(res.code).toBe(1);
    expect(JSON.parse(res.stderr).error).toBe('404: No track "X"');
  });
});

describe('list', () => {
  it('GETs with the token and prints the JSON', async () => {
    const fetchImpl = okFetch({ sessions: [] });
    const res = await run({ argv: ['list'], fetchImpl });
    expect(res.code).toBe(0);
    expect(fetchImpl.mock.calls[0][1].method).toBe('GET');
    expect(JSON.parse(res.stdout)).toEqual({ sessions: [] });
  });
});

describe('as a process, the way the agent runs it', () => {
  let server: Server | null = null;
  afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

  it('carries a heredoc-style prompt through a real pipe and HTTP request unchanged', async () => {
    let received = '';
    const url = await new Promise<string>((resolve) => {
      server = createServer((req, res) => {
        let body = '';
        req.on('data', (d) => (body += String(d)));
        req.on('end', () => {
          received = body;
          res.setHeader('Content-Type', 'application/json');
          res.end('{"sessionId":"s1"}');
        });
      });
      server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server!.address() as AddressInfo).port}`));
    });
    const code = await new Promise<number | null>((resolve) => {
      const child = spawn(process.execPath, [SCRIPT, 'start', '--track', 'Split view'], {
        env: { ...process.env, CLAUDE_REMOTE_URL: url, CLAUDE_REMOTE_TOKEN: 't0ken' },
      });
      child.on('close', resolve);
      child.stdin.end(PROMPT);
    });
    expect(code).toBe(0);
    expect(JSON.parse(received).prompt).toBe(PROMPT);
  });
});

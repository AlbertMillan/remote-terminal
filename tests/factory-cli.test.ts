import { describe, it, expect, vi } from 'vitest';
import { Readable } from 'stream';
// @ts-expect-error -- a plain .mjs script with no type declarations
import { main, parseFactoryArgs } from '../scripts/cr-session.mjs';

/**
 * `cr factory add|send|status` (scripts/cr-session.mjs, f-h1nykc): the work
 * on stdin reaches /api/agent/factory/add unchanged, send's overrides become
 * the body, and every usage error fails before a request is sent.
 */

const ENV = { CLAUDE_REMOTE_URL: 'http://127.0.0.1:4399/', CLAUDE_REMOTE_TOKEN: 't0ken' };
const WORK = 'Add a dark-mode toggle\n- remember it per device\n- mockup first\nAlso sort sessions by "activity" $HOME\n';

function okFetch(body: unknown = { ok: true }) {
  return vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify(body), { status: 200 }));
}

async function run(argv: string[], opts: { stdin?: unknown; fetchImpl?: ReturnType<typeof okFetch> } = {}) {
  let stdout = '';
  let stderr = '';
  const fetchImpl = opts.fetchImpl ?? okFetch();
  const code = await main({
    argv,
    env: ENV,
    stdin: opts.stdin ?? Readable.from([WORK]),
    fetchImpl,
    out: (s: string) => (stdout += s),
    err: (s: string) => (stderr += s),
  });
  return { code, stdout, stderr, fetchImpl };
}

const bodyOf = (f: ReturnType<typeof okFetch>, i = 0) => JSON.parse(f.mock.calls[i][1].body as string);

describe('factory add', () => {
  it('sends the work from stdin byte for byte, with the token', async () => {
    const res = await run(['factory', 'add']);
    expect(res.code).toBe(0);
    const [url, init] = res.fetchImpl.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:4399/api/agent/factory/add');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer t0ken');
    expect(bodyOf(res.fetchImpl)).toEqual({ text: WORK });
    expect(JSON.parse(res.stdout)).toEqual({ ok: true });
  });

  it('sends --track and --from (repeated or comma-separated) as discovered work', async () => {
    const res = await run(['factory', 'add', '--track', 'Polish', '--from', 'f-aaaaaa', '--from=f-bbbbbb, f-cccccc']);
    expect(bodyOf(res.fetchImpl)).toEqual({ text: WORK, track: 'Polish', discoveredFrom: ['f-aaaaaa', 'f-bbbbbb', 'f-cccccc'] });
  });

  it('sends --mockup as mockupFirst, which only add takes', async () => {
    const res = await run(['factory', 'add', '--mockup', '--track', 'Polish']);
    expect(bodyOf(res.fetchImpl)).toEqual({ text: WORK, track: 'Polish', mockupFirst: true });
    const send = await run(['factory', 'send', '--mockup']);
    expect(send.code).toBe(2);
    expect(send.fetchImpl).not.toHaveBeenCalled();
  });

  it('fails before any request with no work, a terminal stdin, or a flag it does not take', async () => {
    for (const [argv, stdin] of [
      [['factory', 'add'], Readable.from(['  \n'])],
      [['factory', 'add'], Object.assign(Readable.from([]), { isTTY: true })],
      [['factory', 'add', '--review', 'track'], undefined],
      [['factory', 'add', '--track', ' '], undefined],
      [['factory', 'add', '--mockup=yes'], undefined],
    ] as [string[], unknown][]) {
      const res = await run(argv, { stdin });
      expect(res.code, argv.join(' ')).toBe(2);
      expect(res.fetchImpl).not.toHaveBeenCalled();
    }
  });
});

describe('factory send', () => {
  it('sends nothing but the track by default, so the server applies Settings defaults', async () => {
    const res = await run(['factory', 'send']);
    expect(res.fetchImpl.mock.calls[0][0]).toBe('http://127.0.0.1:4399/api/agent/factory/send');
    expect(bodyOf(res.fetchImpl)).toEqual({});
    const named = await run(['factory', 'send', '--track', 'Split view']);
    expect(bodyOf(named.fetchImpl)).toEqual({ track: 'Split view' });
  });

  it('sends --review and every --model as overrides', async () => {
    const res = await run(['factory', 'send', '--track', 'X', '--review', 'feature', '--model', 'f-aaaaaa=opus', '--model=f-bbbbbb=haiku']);
    expect(bodyOf(res.fetchImpl)).toEqual({ track: 'X', review: 'feature', models: { 'f-aaaaaa': 'opus', 'f-bbbbbb': 'haiku' } });
  });

  it('refuses a bad --review or --model before any request', async () => {
    for (const argv of [
      ['factory', 'send', '--review', 'sometimes'],
      ['factory', 'send', '--model', 'opus'],
      ['factory', 'send', '--model', 'f-aaaaaa='],
      ['factory', 'send', '--from', 'f-aaaaaa'],
    ]) {
      const res = await run(argv);
      expect(res.code, argv.join(' ')).toBe(2);
      expect(res.fetchImpl).not.toHaveBeenCalled();
    }
  });

  it("prints the server's refusal and exits 1", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: 'already in the factory' }), { status: 409 }));
    const res = await run(['factory', 'send', '--track', 'X'], { fetchImpl: fetchImpl as never });
    expect(res.code).toBe(1);
    expect(JSON.parse(res.stderr).error).toBe('409: already in the factory');
  });
});

describe('factory status and usage', () => {
  it('GETs the status', async () => {
    const res = await run(['factory', 'status'], { fetchImpl: okFetch({ items: [] }) });
    const [url, init] = res.fetchImpl.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:4399/api/agent/factory/status');
    expect(init.method).toBe('GET');
    expect(JSON.parse(res.stdout)).toEqual({ items: [] });
  });

  it('refuses an unknown or missing subcommand and status flags', async () => {
    for (const argv of [['factory'], ['factory', 'run'], ['factory', 'status', '--track', 'X']]) {
      const res = await run(argv);
      expect(res.code, argv.join(' ')).toBe(2);
      expect(res.fetchImpl).not.toHaveBeenCalled();
    }
  });

  it('parses flags into the shapes the routes take', () => {
    expect(parseFactoryArgs(['send', '--model', 'f-a=opus', '--model', 'f-b=claude-sonnet-5-5'])).toEqual({
      sub: 'send',
      flags: { models: { 'f-a': 'opus', 'f-b': 'claude-sonnet-5-5' } },
    });
  });
});

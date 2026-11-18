import { describe, it, expect, vi, afterEach } from 'vitest';
import { RESET, TerminalOutput } from '../src/server/websocket/terminal-output.js';

/** One attached socket's output: coalesced, held, and resynced when the socket falls behind. */

const OPEN = 1;

function setup(options: { highWater?: number; lowWater?: number } = {}) {
  const socket = { readyState: OPEN, bufferedAmount: 0, sent: [] as string[], send(d: string) { this.sent.push(d); } };
  const deferred: (() => void)[] = [];
  let screen = 'SCREEN';
  const snapshots: ((s: string) => void)[] = [];
  const output = new TerminalOutput({
    socket,
    openState: OPEN,
    encode: (d) => d,
    snapshot: (fn) => snapshots.push(fn),
    defer: (fn) => deferred.push(fn),
    highWater: options.highWater ?? 100,
    lowWater: options.lowWater ?? 10,
    drainCheckMs: 50,
  });
  return {
    socket,
    output,
    runDeferred: () => deferred.splice(0).forEach((fn) => fn()),
    setScreen: (s: string) => (screen = s),
    answerSnapshot: () => snapshots.splice(0).forEach((fn) => fn(screen)),
  };
}

afterEach(() => vi.useRealTimers());

describe('TerminalOutput', () => {
  it('coalesces chunks from one turn into one message', () => {
    const { socket, output, runDeferred } = setup();
    output.push('a');
    output.push('b');
    output.push('c');
    expect(socket.sent).toEqual([]);
    runDeferred();
    expect(socket.sent).toEqual(['abc']);
  });

  it('holds output until release, then sends it after what the caller sent', () => {
    const { socket, output, runDeferred } = setup();
    output.hold();
    output.push('live');
    runDeferred();
    expect(socket.sent).toEqual([]);
    socket.send('attached');
    output.release();
    expect(socket.sent).toEqual(['attached', 'live']);
  });

  it('flush() sends what is queued now, so an exit comes after the last output', () => {
    const { socket, output } = setup();
    output.push('bye');
    output.flush();
    expect(socket.sent).toEqual(['bye']);
  });

  it('drops output while the socket is backed up, then resets and redraws once it drains', () => {
    vi.useFakeTimers();
    const { socket, output, runDeferred, setScreen, answerSnapshot } = setup();
    socket.bufferedAmount = 500;
    output.push('lost');
    runDeferred();
    output.push('also lost');
    runDeferred();
    expect(socket.sent).toEqual([]);

    // Still above the low-water mark: nothing yet.
    socket.bufferedAmount = 50;
    vi.advanceTimersByTime(60);
    expect(socket.sent).toEqual([]);

    socket.bufferedAmount = 0;
    vi.advanceTimersByTime(60);
    // Output arriving while the snapshot is made goes out after it.
    output.push('after');
    setScreen('NOW');
    answerSnapshot();
    expect(socket.sent).toEqual([RESET + 'NOW', 'after']);

    // Live again.
    output.push('x');
    runDeferred();
    expect(socket.sent.at(-1)).toBe('x');
  });

  it('resyncs instead of replaying when too much was held', () => {
    vi.useFakeTimers();
    const { socket, output, answerSnapshot } = setup();
    output.hold();
    output.push('x'.repeat(150));
    socket.send('attached');
    output.release();
    answerSnapshot();
    expect(socket.sent).toEqual(['attached', RESET + 'SCREEN']);
  });

  it('sends nothing once closed', () => {
    vi.useFakeTimers();
    const { socket, output, runDeferred } = setup();
    output.push('a');
    output.close();
    runDeferred();
    socket.bufferedAmount = 500;
    output.push('b');
    vi.advanceTimersByTime(500);
    expect(socket.sent).toEqual([]);
  });
});

import { describe, it, expect } from 'vitest';
import headless from '@xterm/headless';
import { ScreenMirror, SNAPSHOT_MARKER, storedToReplay } from '../src/server/sessions/screen-mirror.js';

type Term = InstanceType<typeof headless.Terminal>;

function fresh(cols: number, rows: number): Term {
  return new headless.Terminal({ cols, rows, scrollback: 1000, allowProposedApi: true });
}

function write(term: Term, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve));
}

/** Every line of the buffer, scrollback included, trailing blanks trimmed. */
function text(term: Term): string[] {
  const buf = term.buffer.active;
  const lines: string[] = [];
  for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? '');
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  return lines;
}

const snapshotOf = (mirror: ScreenMirror) =>
  new Promise<string>((resolve) => mirror.afterQueued(() => resolve(mirror.snapshot())));

/**
 * What Claude Code does through ConPTY: print a line wider than the terminal (it wraps),
 * then move the cursor up by rows to repaint it, while the PTY changes size between turns
 * (the phone and the desktop taking turns). Relative moves count *rows as drawn*, so the
 * same bytes replayed at another width repaint the wrong row.
 */
const WIDE = 'x'.repeat(90);
const steps: Array<{ data: string } | { cols: number; rows: number }> = [
  { data: `header\r\n${WIDE}\r\n\x1b[2A\rREPAINT` },
  { cols: 100, rows: 6 },
  { data: '\x1b[4;1H> prompt' },
];

describe('ScreenMirror', () => {
  it('replays to the screen the session really shows, where the raw log does not', async () => {
    const truth = fresh(60, 6);
    const mirror = new ScreenMirror(60, 6, 1000);
    let raw = '';
    for (const step of steps) {
      if ('data' in step) {
        await write(truth, step.data);
        mirror.write(step.data);
        raw += step.data;
      } else {
        truth.resize(step.cols, step.rows);
        mirror.resize(step.cols, step.rows);
      }
    }

    const replayed = fresh(100, 6);
    await write(replayed, await snapshotOf(mirror));
    expect(text(replayed)).toEqual(text(truth));

    // The old way: every byte replayed at the final size. Kept as proof the case bites.
    const old = fresh(100, 6);
    await write(old, raw);
    expect(text(old)).not.toEqual(text(truth));
    mirror.dispose();
  });

  it('applies a resize after the bytes written before it, never ahead of them', async () => {
    const mirror = new ScreenMirror(10, 3, 100);
    // Drawn at 10 columns this wraps onto a second row (headless xterm keeps the rows as
    // drawn on widening); had the resize jumped ahead, it would fit on one.
    mirror.write('0123456789AB');
    mirror.resize(20, 3);
    const snap = await snapshotOf(mirror);
    const replayed = fresh(20, 3);
    await write(replayed, snap);
    expect(text(replayed).slice(0, 2)).toEqual(['0123456789', 'AB']);
    expect(mirror.cols).toBe(20);
    mirror.dispose();
  });

  it('snapshots exactly the bytes written before afterQueued(), none after', async () => {
    const mirror = new ScreenMirror(40, 4, 100);
    mirror.write('before\r\n');
    const snap = new Promise<string>((resolve) => mirror.afterQueued(() => resolve(mirror.snapshot())));
    mirror.write('after\r\n');
    const result = await snap;
    expect(result).toContain('before');
    expect(result).not.toContain('after');
    mirror.dispose();
  });

  it('round-trips a persisted snapshot through seed() at the size it was drawn at', async () => {
    const first = new ScreenMirror(20, 4, 100);
    first.write('abcdefghij\r\nsecond\x1b[1;5HX');
    await first.caughtUp();
    const stored = first.persistable();
    expect(stored.startsWith(SNAPSHOT_MARKER)).toBe(true);

    const revived = new ScreenMirror(40, 4, 100);
    revived.seed(stored, 20, 4);
    const replayed = fresh(40, 4);
    await write(replayed, await snapshotOf(revived));
    expect(text(replayed).slice(0, 2)).toEqual(['abcdXfghij', 'second']);
    first.dispose();
    revived.dispose();
  });

  it('runs pending callbacks on dispose instead of leaving them hanging', async () => {
    const mirror = new ScreenMirror(20, 4, 100);
    mirror.write('x');
    const done = mirror.caughtUp();
    mirror.dispose();
    await expect(done).resolves.toBeUndefined();
    expect(mirror.snapshot()).toBe('');
  });

  it('reads a legacy raw log with the CRLF join it was always replayed with', () => {
    expect(storedToReplay('a\nb\r\nc')).toBe('a\r\nb\r\nc');
    expect(storedToReplay(`${SNAPSHOT_MARKER}x\r\ny`)).toBe('x\r\ny');
    expect(storedToReplay('')).toBe('');
  });
});

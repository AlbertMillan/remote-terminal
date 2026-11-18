import { describe, it, expect } from 'vitest';
import headless from '@xterm/headless';
import { resetWrapOnLineStart } from '../src/client/wrap-reset.js';
import { ScreenMirror } from '../src/server/sessions/screen-mirror.js';

type Term = InstanceType<typeof headless.Terminal>;

function fresh(cols: number, rows: number, reset: boolean): Term {
  const term = new headless.Terminal({ cols, rows, scrollback: 100, allowProposedApi: true });
  if (reset) resetWrapOnLineStart(term);
  return term;
}

function write(term: Term, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve));
}

function text(term: Term): string[] {
  const buf = term.buffer.active;
  const lines: string[] = [];
  for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? '');
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  return lines;
}

/**
 * The resize repaint Claude Code does through ConPTY, shrunk: a line wraps at the narrow
 * width, the screen is repainted from a cursor move to column 1 that lands on the wrapped
 * continuation row, the cursor ends on the prompt below (xterm never reflows the cursor's
 * row), and the terminal widens.
 */
const DRAWN = `header\r\n${'x'.repeat(15)}\r\n>`;
const REPAINT = '\x1b[3;1Hnew\x1b[K\x1b[4;3H';

async function run(term: Term): Promise<string[]> {
  await write(term, DRAWN);
  await write(term, REPAINT);
  term.resize(20, 4);
  return text(term);
}

describe('resetWrapOnLineStart', () => {
  it('keeps a row repainted from column 1 off the line above when the terminal widens', async () => {
    expect(await run(fresh(10, 4, false))).toEqual(['header', 'xxxxxxxxxxnew', '>']);
    expect(await run(fresh(10, 4, true))).toEqual(['header', 'xxxxxxxxxx', 'new', '>']);
  });

  it('leaves a wrap alone when the cursor moves to another column', async () => {
    const term = fresh(10, 4, true);
    await write(term, `${DRAWN}\x1b[3;3H\x1b[4;3H`);
    term.resize(20, 4);
    expect(text(term)).toEqual(['header', 'x'.repeat(15), '>']);
  });

  it('is applied by the screen mirror, so a snapshot carries no glued rows', async () => {
    const mirror = new ScreenMirror(10, 4, 100);
    mirror.write(DRAWN);
    mirror.write(REPAINT);
    mirror.resize(20, 4);
    const snap = await new Promise<string>((resolve) => mirror.afterQueued(() => resolve(mirror.snapshot())));
    const replayed = fresh(20, 4, false);
    await write(replayed, snap);
    expect(text(replayed)).toEqual(['header', 'xxxxxxxxxx', 'new', '>']);
    mirror.dispose();
  });
});

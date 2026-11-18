/**
 * Moving the cursor to column 1 of a row (CUP, `ESC[r;1H` / `ESC[H`) starts a new logical
 * line there, so the row stops continuing the one above.
 *
 * Why: xterm.js reflows on resize and marks the overflow rows as wrapped continuations. After
 * a resize, ConPTY and then Claude Code repaint the screen from `ESC[H` with CRLFs. A
 * CRLF clears the wrapped mark of the row it reaches, but the first row, reached by CUP,
 * keeps it. On the next widening xterm joins that row onto the line above, and a narrow
 * table row shows old text from about the old width onward.
 *
 * xterm.js has no public setter for `isWrapped`, so this reaches into its buffer. If that
 * internal shape ever changes, it does nothing and the stray joins come back.
 */

interface WrapLine {
  isWrapped: boolean;
}

interface WrapHost {
  rows: number;
  parser: {
    registerCsiHandler(id: { final: string }, handler: (params: (number | number[])[]) => boolean): unknown;
  };
}

interface InternalBuffer {
  ybase: number;
  lines: { get(index: number): WrapLine | undefined };
}

function param(params: (number | number[])[], index: number): number {
  const value = params[index];
  const n = Array.isArray(value) ? value[0] : value;
  return n && n > 0 ? n : 1;
}

export function resetWrapOnLineStart(terminal: WrapHost): void {
  const handler = (params: (number | number[])[]): boolean => {
    if (param(params, 1) !== 1) return false;
    const buffer = (terminal as unknown as { _core?: { buffer?: InternalBuffer } })._core?.buffer;
    if (buffer?.lines && typeof buffer.ybase === 'number') {
      // Origin mode (DECOM) would offset the row; nothing that runs here sets it.
      const row = Math.min(param(params, 0), terminal.rows) - 1;
      const line = buffer.lines.get(buffer.ybase + row);
      if (line) line.isWrapped = false;
    }
    // false: xterm's own CUP still moves the cursor.
    return false;
  };
  terminal.parser.registerCsiHandler({ final: 'H' }, handler);
  terminal.parser.registerCsiHandler({ final: 'f' }, handler);
}

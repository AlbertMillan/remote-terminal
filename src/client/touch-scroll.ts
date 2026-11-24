/**
 * Finger drags over the terminal scroll it a whole row at a time, with a glide after a flick.
 *
 * Why not xterm.js's own touch handling (5.3): it fails twice on phones.
 * - While the program tracks the mouse it drops touches outright. Claude Code's fullscreen
 *   renderer (alt screen + mouse tracking) scrolls only on wheel reports, so a drag did
 *   nothing there.
 * - Otherwise it moves the viewport by raw pixels, and the next output (a spinner is
 *   enough) snaps it back to the nearest whole row: every move under half a row is lost, so
 *   a slow drag stalls and has to be redone.
 *
 * So this takes `touchmove` in the capture phase, before xterm's listener, and turns the
 * distance into whole rows: a wheel report per row when the program tracks the mouse,
 * scrollback lines otherwise. `touchstart` is left alone, so a tap still focuses the
 * terminal (and opens the keyboard) as before.
 */

/** What the drag drives: the terminal, seen through only what scrolling needs. */
export interface TouchScrollHost {
  /** The height of one row in CSS pixels; 0 while the terminal has no size. */
  rowHeight(): number;
  /** Positive scrolls towards newer output. `x`/`y` are the finger's client position. */
  scrollRows(rows: number, x: number, y: number): void;
}

/** Pixels in, whole rows out; the remainder carries over to the next move. */
export class RowAccumulator {
  private px = 0;

  add(deltaPx: number, rowHeight: number): number {
    if (rowHeight <= 0) return 0;
    this.px += deltaPx;
    const rows = Math.trunc(this.px / rowHeight);
    this.px -= rows * rowHeight;
    return rows;
  }

  reset(): void {
    this.px = 0;
  }
}

/** Below this speed (px/ms) a lifted finger stops dead rather than gliding. */
export const GLIDE_MIN_SPEED = 0.3;
/** The glide ends once it slows to this (px/ms). */
const GLIDE_STOP_SPEED = 0.02;
/** Speed kept per 16 ms frame of glide. */
const GLIDE_DECAY = 0.95;
/** Weight of the newest sample in the speed estimate. */
const SPEED_SMOOTHING = 0.8;

/** The glide's next speed after `dtMs`, or 0 once it has slowed to a stop. */
export function decayedSpeed(speed: number, dtMs: number): number {
  const next = speed * Math.pow(GLIDE_DECAY, dtMs / 16);
  return Math.abs(next) < GLIDE_STOP_SPEED ? 0 : next;
}

/**
 * Wires drag-to-scroll onto `element` (the terminal's container) until `signal` aborts.
 * Only drags that start inside `.xterm` count, so a panel overlaid on the container keeps
 * its own scrolling. `now` and `frame` are injectable for tests.
 */
export function attachTouchScroll(
  element: HTMLElement,
  host: TouchScrollHost,
  signal: AbortSignal,
  now: () => number = () => performance.now(),
  frame: (cb: (t: number) => void) => number = (cb) => requestAnimationFrame(cb),
  cancelFrame: (id: number) => void = (id) => cancelAnimationFrame(id),
): void {
  const rows = new RowAccumulator();
  let lastY = 0;
  let lastX = 0;
  let lastTime = 0;
  let speed = 0; // px/ms, positive = finger moving up = towards newer output
  let tracking = false;
  let glideFrame: number | null = null;

  const stopGlide = () => {
    if (glideFrame !== null) cancelFrame(glideFrame);
    glideFrame = null;
  };

  const apply = (deltaPx: number) => {
    const n = rows.add(deltaPx, host.rowHeight());
    if (n !== 0) host.scrollRows(n, lastX, lastY);
  };

  element.addEventListener('touchstart', (e: TouchEvent) => {
    stopGlide();
    rows.reset();
    tracking = e.touches.length === 1 && e.target instanceof Element && e.target.closest('.xterm') !== null;
    if (!tracking) return;
    lastX = e.touches[0].clientX;
    lastY = e.touches[0].clientY;
    lastTime = now();
    speed = 0;
  }, { capture: true, passive: true, signal });

  element.addEventListener('touchmove', (e: TouchEvent) => {
    // Two fingers are a pinch: the browser's, not ours.
    if (!tracking || e.touches.length !== 1) return;
    // Ours alone: xterm's handler would scroll the same distance again (or snap it back).
    e.stopPropagation();
    if (e.cancelable) e.preventDefault();
    const touch = e.touches[0];
    const deltaY = lastY - touch.clientY;
    const t = now();
    const dt = t - lastTime;
    if (dt > 0) speed = SPEED_SMOOTHING * (deltaY / dt) + (1 - SPEED_SMOOTHING) * speed;
    lastX = touch.clientX;
    lastY = touch.clientY;
    lastTime = t;
    apply(deltaY);
  }, { capture: true, passive: false, signal });

  const release = () => {
    if (!tracking) return;
    tracking = false;
    // A finger that paused before lifting has no flick left in it.
    if (now() - lastTime > 100 || Math.abs(speed) < GLIDE_MIN_SPEED) return;
    let prev = now();
    const step = () => {
      const t = now();
      const dt = t - prev;
      prev = t;
      apply(speed * dt);
      speed = decayedSpeed(speed, dt);
      glideFrame = speed === 0 ? null : frame(step);
    };
    glideFrame = frame(step);
  };
  element.addEventListener('touchend', release, { capture: true, passive: true, signal });
  element.addEventListener('touchcancel', () => { tracking = false; }, { capture: true, passive: true, signal });
  signal.addEventListener('abort', stopGlide);
}

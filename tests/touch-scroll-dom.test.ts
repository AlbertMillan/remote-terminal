// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { attachTouchScroll, decayedSpeed, RowAccumulator, type TouchScrollHost } from '../src/client/touch-scroll.js';
import { TerminalManager } from '../src/client/terminal.js';

/**
 * Drag-to-scroll on phones (touch-scroll.ts): whole rows from any drag speed, a glide after
 * a flick, xterm's own touch handler kept out, and, through terminal.ts, wheel reports while
 * the program tracks the mouse (Claude Code's fullscreen renderer) or scrollback otherwise.
 */

function touch(type: string, target: Element, points: { x?: number; y: number }[]): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const touches = points.map((p) => ({ clientX: p.x ?? 10, clientY: p.y }));
  Object.defineProperty(event, 'touches', { value: touches });
  target.dispatchEvent(event);
  return event;
}

describe('RowAccumulator', () => {
  it('carries the part of a row over, so small moves add up', () => {
    const acc = new RowAccumulator();
    const rows = [4, 4, 4, 4, 4, 4, 4, 4].map((px) => acc.add(px, 16));
    expect(rows).toEqual([0, 0, 0, 1, 0, 0, 0, 1]);
  });

  it('counts back towards older output the same way', () => {
    const acc = new RowAccumulator();
    expect(acc.add(-20, 16)).toBe(-1);
    expect(acc.add(-12, 16)).toBe(-1);
  });

  it('gives nothing while the terminal has no row height', () => {
    expect(new RowAccumulator().add(100, 0)).toBe(0);
  });
});

describe('decayedSpeed', () => {
  it('slows each frame and stops once nearly still', () => {
    expect(decayedSpeed(1, 16)).toBeCloseTo(0.95);
    expect(decayedSpeed(0.021, 16)).toBe(0);
  });
});

describe('attachTouchScroll', () => {
  let container: HTMLElement;
  let screen: HTMLElement;
  let outside: HTMLElement;
  let scrolled: number[];
  let ac: AbortController;
  let clock: number;
  let frames: ((t: number) => void)[];

  beforeEach(() => {
    container = document.createElement('div');
    const xterm = document.createElement('div');
    xterm.className = 'xterm';
    screen = document.createElement('div');
    screen.className = 'xterm-screen';
    xterm.appendChild(screen);
    outside = document.createElement('div');
    container.append(xterm, outside);
    document.body.appendChild(container);
    scrolled = [];
    clock = 0;
    frames = [];
    ac = new AbortController();
    const host: TouchScrollHost = { rowHeight: () => 16, scrollRows: (n) => scrolled.push(n) };
    attachTouchScroll(container, host, ac.signal, () => clock, (cb) => frames.push(cb), () => { frames = []; });
  });

  afterEach(() => {
    ac.abort();
    container.remove();
  });

  /** A drag from `fromY` in `steps` moves of `stepPx`, `msPerStep` apart. */
  function drag(fromY: number, steps: number, stepPx: number, msPerStep: number): void {
    touch('touchstart', screen, [{ y: fromY }]);
    let y = fromY;
    for (let i = 0; i < steps; i++) {
      clock += msPerStep;
      y -= stepPx;
      touch('touchmove', screen, [{ y }]);
    }
  }

  it('scrolls a slow drag by whole rows instead of losing each small move', () => {
    drag(300, 16, 2, 50); // 32px up, slowly
    expect(scrolled.reduce((a, b) => a + b, 0)).toBe(2);
  });

  it('scrolls towards older output when the finger moves down', () => {
    drag(100, 4, -8, 50);
    expect(scrolled.reduce((a, b) => a + b, 0)).toBe(-2);
  });

  it('keeps the move from xterm and the page', () => {
    const xtermSaw: string[] = [];
    screen.parentElement!.addEventListener('touchmove', () => xtermSaw.push('touchmove'));
    touch('touchstart', screen, [{ y: 100 }]);
    const move = touch('touchmove', screen, [{ y: 80 }]);
    expect(xtermSaw).toEqual([]);
    expect(move.defaultPrevented).toBe(true);
  });

  it('leaves a tap alone, so xterm still focuses on it', () => {
    const xtermSaw: string[] = [];
    screen.parentElement!.addEventListener('touchstart', () => xtermSaw.push('touchstart'));
    touch('touchstart', screen, [{ y: 100 }]);
    expect(xtermSaw).toEqual(['touchstart']);
  });

  it('ignores drags that start outside the terminal', () => {
    touch('touchstart', outside, [{ y: 300 }]);
    const move = touch('touchmove', outside, [{ y: 200 }]);
    expect(scrolled).toEqual([]);
    expect(move.defaultPrevented).toBe(false);
  });

  it('leaves a two-finger pinch to the browser', () => {
    touch('touchstart', screen, [{ y: 300 }, { y: 400 }]);
    const move = touch('touchmove', screen, [{ y: 200 }, { y: 450 }]);
    expect(scrolled).toEqual([]);
    expect(move.defaultPrevented).toBe(false);
  });

  it('glides on after a flick, slowing to a stop', () => {
    drag(300, 3, 30, 10); // 3 px/ms
    const during = scrolled.reduce((a, b) => a + b, 0);
    touch('touchend', screen, []);
    for (let i = 0; i < 500 && frames.length; i++) {
      clock += 16;
      frames.shift()!(clock);
    }
    expect(frames).toEqual([]);
    expect(scrolled.reduce((a, b) => a + b, 0)).toBeGreaterThan(during + 10);
  });

  it('does not glide when the finger stopped before lifting', () => {
    drag(300, 3, 30, 10);
    clock += 300;
    touch('touchend', screen, []);
    expect(frames).toEqual([]);
  });

  it('stops a glide when the finger comes back down', () => {
    drag(300, 3, 30, 10);
    touch('touchend', screen, []);
    touch('touchstart', screen, [{ y: 300 }]);
    expect(frames).toEqual([]);
  });

  it('stops listening once aborted', () => {
    ac.abort();
    drag(300, 4, 16, 50);
    expect(scrolled).toEqual([]);
  });
});

describe('terminal drag scrolling', () => {
  let container: HTMLElement;
  let mode: string;
  let scrollLines: number[];
  // The finger's position rides on clientX/Y too, but happy-dom's WheelEvent drops those.
  let wheels: { deltaY: number; deltaMode: number }[];

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    mode = 'none';
    scrollLines = [];
    wheels = [];
    vi.stubGlobal(
      'Terminal',
      class {
        cols = 80;
        rows = 10;
        get modes() { return { mouseTrackingMode: mode }; }
        open(el: HTMLElement) {
          const xterm = document.createElement('div');
          xterm.className = 'xterm';
          const screen = document.createElement('div');
          screen.className = 'xterm-screen';
          Object.defineProperty(screen, 'clientHeight', { value: 160 });
          xterm.appendChild(screen);
          // xterm's wheel listener sits on .xterm and reports to the program in mouse mode.
          xterm.addEventListener('wheel', (e) => {
            const w = e as WheelEvent;
            wheels.push({ deltaY: w.deltaY, deltaMode: w.deltaMode });
          });
          el.appendChild(xterm);
        }
        scrollLines(n: number) { scrollLines.push(n); }
        write() {}
        writeln() {}
        paste() {}
        clear() {}
        resize() {}
        focus() {}
        dispose() {}
        onData() {}
        onResize() {}
        loadAddon() {}
        attachCustomKeyEventHandler() {}
        parser = { registerCsiHandler() {} };
      }
    );
    vi.stubGlobal('FitAddon', { FitAddon: class { fit() {} } });
    vi.stubGlobal('WebLinksAddon', { WebLinksAddon: class {} });
  });

  afterEach(() => {
    container.remove();
    vi.unstubAllGlobals();
  });

  function dragOnScreen(fromY: number, toY: number): void {
    const screen = container.querySelector('.xterm-screen')!;
    touch('touchstart', screen, [{ x: 40, y: fromY }]);
    touch('touchmove', screen, [{ x: 40, y: toY }]);
  }

  it('moves the scrollback when the program does not track the mouse', () => {
    new TerminalManager().initialize({ container, onData: () => {}, onResize: () => {} });
    dragOnScreen(100, 52); // 48px = 3 rows of 16px, towards newer output
    expect(scrollLines).toEqual([3]);
    expect(wheels).toEqual([]);
  });

  it('sends one wheel step per row to a program that tracks the mouse', () => {
    mode = 'any';
    new TerminalManager().initialize({ container, onData: () => {}, onResize: () => {} });
    dragOnScreen(52, 100); // towards older output
    expect(scrollLines).toEqual([]);
    expect(wheels).toEqual([
      { deltaY: -1, deltaMode: WheelEvent.DOM_DELTA_LINE },
      { deltaY: -1, deltaMode: WheelEvent.DOM_DELTA_LINE },
      { deltaY: -1, deltaMode: WheelEvent.DOM_DELTA_LINE },
    ]);
  });

  it('removes the drag listeners with the terminal', () => {
    const manager = new TerminalManager();
    manager.initialize({ container, onData: () => {}, onResize: () => {} });
    const screen = container.querySelector('.xterm-screen')!;
    manager.dispose();
    touch('touchstart', screen, [{ y: 100 }]);
    touch('touchmove', screen, [{ y: 20 }]);
    expect(scrollLines).toEqual([]);
  });
});

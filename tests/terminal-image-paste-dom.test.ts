// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TerminalManager } from '../src/client/terminal.js';

/**
 * The terminal's image paste/drop wiring (terminal.ts): an image is taken before xterm's
 * textarea sees the event, a text paste is left to xterm, and the listeners go with the
 * terminal. xterm itself is loaded by a script tag, so a stand-in plays it here.
 */

/** A paste or drop event carrying `items`, as the browser builds it. */
function transferEvent(type: 'paste' | 'drop', items: { kind: string; type: string }[]): Event {
  const data = {
    items: items.map((i) => ({ ...i, getAsFile: () => new File([new Uint8Array([1])], 'x', { type: i.type }) })),
    files: [],
  };
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, type === 'paste' ? 'clipboardData' : 'dataTransfer', { value: data });
  return event;
}

describe('terminal image paste', () => {
  let container: HTMLElement;
  let textarea: HTMLTextAreaElement;
  let xtermSaw: string[];

  beforeEach(() => {
    xtermSaw = [];
    container = document.createElement('div');
    document.body.appendChild(container);
    vi.stubGlobal(
      'Terminal',
      class {
        cols = 80;
        rows = 24;
        open(el: HTMLElement) {
          textarea = document.createElement('textarea');
          // xterm handles paste on its own textarea, inside the container.
          textarea.addEventListener('paste', () => xtermSaw.push('paste'));
          textarea.addEventListener('drop', () => xtermSaw.push('drop'));
          el.appendChild(textarea);
        }
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
      }
    );
    vi.stubGlobal('FitAddon', { FitAddon: class { fit() {} } });
    vi.stubGlobal('WebLinksAddon', { WebLinksAddon: class {} });
  });

  afterEach(() => {
    container.remove();
    vi.unstubAllGlobals();
  });

  function init(onImage: (f: File) => void): TerminalManager {
    const manager = new TerminalManager();
    manager.initialize({ container, onData: () => {}, onResize: () => {}, onImage });
    return manager;
  }

  it('takes an image paste before xterm and stops the browser default', () => {
    const images: File[] = [];
    init((f) => images.push(f));
    const event = transferEvent('paste', [{ kind: 'file', type: 'image/png' }]);
    textarea.dispatchEvent(event);
    expect(images.map((f) => f.type)).toEqual(['image/png']);
    expect(event.defaultPrevented).toBe(true);
    expect(xtermSaw).toEqual([]);
  });

  it('takes a dropped image the same way', () => {
    const images: File[] = [];
    init((f) => images.push(f));
    const event = transferEvent('drop', [{ kind: 'file', type: 'image/jpeg' }]);
    textarea.dispatchEvent(event);
    expect(images).toHaveLength(1);
    expect(event.defaultPrevented).toBe(true);
    expect(xtermSaw).toEqual([]);
  });

  it('leaves a text paste to xterm', () => {
    const images: File[] = [];
    init((f) => images.push(f));
    const event = transferEvent('paste', [{ kind: 'string', type: 'text/plain' }]);
    textarea.dispatchEvent(event);
    expect(images).toEqual([]);
    expect(event.defaultPrevented).toBe(false);
    expect(xtermSaw).toEqual(['paste']);
  });

  it('removes its listeners with the terminal', () => {
    const images: File[] = [];
    const manager = init((f) => images.push(f));
    manager.dispose();
    container.dispatchEvent(transferEvent('paste', [{ kind: 'file', type: 'image/png' }]));
    expect(images).toEqual([]);
  });
});

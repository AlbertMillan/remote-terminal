import nodeConsole from 'node:console';
import { afterAll, beforeAll } from 'vitest';

/**
 * happy-dom refuses to load an iframe's page and reports it with console.error on every
 * render ("Iframe page loading is disabled"). The factory drawer's mockup frames point at
 * the server, and the DOM tests never need that page, so the error is only noise. Call
 * this at the top of a happy-dom test file: it drops that one message while the file runs
 * and forwards everything else to the console it replaced. Restored after the file.
 *
 * The target is Node's original console (`node:console`), not the global one: happy-dom
 * logs through the console that existed when its window was built, and vitest swaps the
 * global for its own before the test file runs. Patching `window.console` or the global
 * misses the message. The method is swapped directly, not with vi.spyOn, so a test file's
 * vi.restoreAllMocks() cannot remove the filter halfway through.
 */
const NOISE = 'Iframe page loading is disabled';

export function isIframeLoadNoise(arg: unknown): boolean {
  const text = typeof arg === 'object' && arg !== null && 'message' in arg ? String(arg.message) : String(arg);
  return text.includes(NOISE);
}

export function silenceIframePageLoads(): void {
  let saved: typeof nodeConsole.error | undefined;
  beforeAll(() => {
    saved = nodeConsole.error;
    const forward = saved;
    nodeConsole.error = (...args: unknown[]) => {
      if (args.length === 1 && isIframeLoadNoise(args[0])) return;
      forward.apply(nodeConsole, args);
    };
  });
  afterAll(() => {
    if (saved) nodeConsole.error = saved;
  });
}

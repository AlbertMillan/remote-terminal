// @vitest-environment happy-dom
import nodeConsole from 'node:console';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { isIframeLoadNoise, silenceIframePageLoads } from './helpers/happy-dom-iframe.js';

/**
 * The filter the factory DOM tests install (tests/helpers/happy-dom-iframe.ts): an
 * iframe page happy-dom can't load is silenced, and any other console.error still reaches
 * the console beneath it (Node's original console, which happy-dom logs through).
 */

// Captures what reaches the console beneath the filter. Installed before the helper, so
// the helper's saved error method is this capture and its afterAll puts it back.
const reached: unknown[][] = [];
let original: typeof nodeConsole.error;
beforeAll(() => {
  original = nodeConsole.error;
  nodeConsole.error = (...args: unknown[]) => {
    reached.push(args);
  };
});
afterAll(() => {
  nodeConsole.error = original;
});

silenceIframePageLoads();

describe('silenceIframePageLoads', () => {
  it("recognises happy-dom's iframe refusal by its message, not by type", () => {
    const refusal = new DOMException(
      'Failed to load iframe page "http://localhost:3000/x.html?r=0". Iframe page loading is disabled.',
      'NotSupportedError',
    );
    expect(isIframeLoadNoise(refusal)).toBe(true);
    expect(isIframeLoadNoise(new Error('Iframe page loading is disabled.'))).toBe(true);
    expect(isIframeLoadNoise(new Error('network down'))).toBe(false);
    expect(isIframeLoadNoise('plain string')).toBe(false);
  });

  it('drops the refusal that happy-dom logs when an iframe with a src is attached', () => {
    reached.length = 0;
    document.body.innerHTML = '<iframe class="fb-mockup-frame" src="http://localhost:3000/api/factory/mockup/a/index.html"></iframe>';
    const refusals = reached.filter((args) => args.some(isIframeLoadNoise));
    expect(refusals).toHaveLength(0);
  });

  it('still forwards any other console.error', () => {
    reached.length = 0;
    nodeConsole.error('something real');
    expect(reached).toEqual([['something real']]);
  });
});

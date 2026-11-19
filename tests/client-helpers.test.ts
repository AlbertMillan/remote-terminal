// @vitest-environment happy-dom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { formatCost, formatTokens, shortAge, timeAgo } from '../src/client/format.js';
import { failureMessage, requestJson } from '../src/client/api.js';
import { openDialog } from '../src/client/dialog.js';
import { html } from '../src/client/html-utils.js';

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const MIN = 60_000;

describe('timeAgo / shortAge', () => {
  it('reads elapsed time, rounding down', () => {
    expect(timeAgo(ago(20_000))).toBe('just now');
    expect(timeAgo(ago(59.6 * MIN))).toBe('59m ago');
    expect(timeAgo(ago(90 * MIN))).toBe('1h ago');
    expect(timeAgo(ago(3 * 24 * 60 * MIN))).toBe('3d ago');
    expect(timeAgo(ago(65 * 24 * 60 * MIN))).toBe('2mo ago');
    expect(timeAgo(ago(400 * 24 * 60 * MIN))).toBe('1y ago');
    expect(shortAge(ago(5 * MIN))).toBe('5m');
    expect(shortAge(ago(90 * MIN))).toBe('1h');
    expect(shortAge(ago(50 * 60 * MIN))).toBe('2d');
  });

  it('is empty for a missing or unparsable timestamp, and never negative', () => {
    expect(timeAgo('')).toBe('');
    expect(timeAgo('not a date')).toBe('');
    expect(shortAge(undefined)).toBe('');
    expect(timeAgo(new Date(Date.now() + 10 * MIN).toISOString())).toBe('just now');
  });
});

describe('formatTokens / formatCost', () => {
  it('formats token counts and costs', () => {
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(1250)).toBe('1.3k');
    expect(formatTokens(18_004)).toBe('18k');
    expect(formatTokens(2_400_000)).toBe('2.4M');
    expect(formatTokens(24_000_000)).toBe('24M');
    expect(formatCost(0)).toBe('$0.00');
    expect(formatCost(0.004)).toBe('<$0.01');
    expect(formatCost(1.5)).toBe('$1.50');
  });
});

describe('requestJson', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns the parsed body and status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ moved: ['a'] }), { status: 200 })));
    const result = await requestJson<{ moved?: string[] }>('/x');
    expect(result).toEqual({ ok: true, status: 200, data: { moved: ['a'] } });
  });

  it("reads a non-JSON error body as {} and names the status", async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>oops', { status: 502 })));
    const result = await requestJson('/x');
    expect(result.ok).toBe(false);
    expect(failureMessage(result, 'Could not save')).toBe('Could not save (502)');
  });

  it("prefers the server's own reason", async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Track is busy' }), { status: 409 })));
    const result = await requestJson('/x');
    expect(result.status).toBe(409);
    expect(failureMessage(result, 'Could not save')).toBe('Track is busy');
  });

  it('never throws: a network failure is status 0 with its message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }));
    const result = await requestJson('/x');
    expect(result).toMatchObject({ ok: false, status: 0 });
    expect(result.timedOut).toBeUndefined();
    expect(failureMessage(result, 'Could not save')).toBe('Failed to fetch');
  });

  it('tells a timed-out signal from a dropped connection', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new DOMException('signal timed out', 'TimeoutError');
    }));
    const result = await requestJson('/x');
    expect(result).toMatchObject({ ok: false, status: 0, timedOut: true });
  });
});

describe('openDialog', () => {
  const content = html`<div><button data-cancel>Cancel</button><button class="ok">OK</button></div>`;

  it('settles with what close() is given and removes the modal', async () => {
    const { modal, close, closed } = openDialog<string | null>('td-modal', content, null);
    expect(document.body.contains(modal)).toBe(true);
    expect(modal.className).toBe('modal td-modal');
    close('done');
    close('ignored');
    await expect(closed).resolves.toBe('done');
    expect(document.body.contains(modal)).toBe(false);
  });

  it('Escape and [data-cancel] close with the cancel value, and Escape is released after', async () => {
    const first = openDialog<string | null>('td-modal', content, null);
    (first.modal.querySelector('[data-cancel]') as HTMLButtonElement).click();
    await expect(first.closed).resolves.toBeNull();

    const second = openDialog<string>('td-modal', content, 'cancelled');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await expect(second.closed).resolves.toBe('cancelled');
    expect(document.querySelectorAll('.modal')).toHaveLength(0);
  });
});

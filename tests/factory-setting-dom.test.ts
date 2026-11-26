// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { FactorySetting } from '../src/client/factory-setting.js';

/**
 * Settings → Factory (f-o5veqv): loaded from the server's config, edited in the real
 * panel markup from index.html, and saved as only what changed.
 */

const INDEX = readFileSync(join(import.meta.dirname, '../src/client/index.html'), 'utf-8');
const PANEL = INDEX.slice(
  INDEX.indexOf('<div class="settings-panel" role="tabpanel" id="settings-panel-factory"'),
  INDEX.indexOf('<!-- Restart / build & restart')
);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const VIEW = {
  mode: 'agent-escalate',
  rules: { sensitivePaths: true, largeDiff: true, fixLoops: true, assumptions: true, newDependency: false },
  largeDiffLines: 600,
  granularity: 'track',
  largeDiffRange: { min: 50, max: 100000 },
  fixLoopMax: 2,
  limits: { seats: 3, seatsPerProject: 2, pauseWhenParked: 3, fiveHourCapPct: 80, weeklyCapPct: 90, runawayTokens: 3000000 },
};

const el = <T extends HTMLElement = HTMLInputElement>(id: string) => document.getElementById(id) as T;
const radio = (name: string, value: string) =>
  document.querySelector<HTMLInputElement>(`input[name="${name}"][value="${value}"]`)!;

beforeEach(() => {
  document.body.innerHTML = PANEL;
});
afterEach(() => vi.unstubAllGlobals());

describe('FactorySetting', () => {
  it('shows the mode, rules, granularity and the engine limits', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(VIEW)));
    await new FactorySetting().refresh();
    expect(radio('factory-review-mode', 'agent-escalate').checked).toBe(true);
    expect(radio('factory-review-granularity', 'track').checked).toBe(true);
    expect(el('setting-factory-rule-sensitive').checked).toBe(true);
    expect(el('setting-factory-rule-new-dependency').checked).toBe(false);
    expect(el('setting-factory-large-diff').value).toBe('600');
    expect(el('setting-factory-rule-sensitive').disabled).toBe(false);
    const limits = [...el<HTMLElement>('setting-factory-limits').querySelectorAll('li')].map((li) => li.textContent);
    expect(limits).toContain('Seats: 3 across all projects');
    expect(limits).toContain('Park an item past 3,000,000 tokens');
  });

  it('greys out the rules outside "agent, escalate when risky"', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ ...VIEW, mode: 'me' })));
    const setting = new FactorySetting();
    await setting.refresh();
    expect(el('setting-factory-rule-sensitive').disabled).toBe(true);
    radio('factory-review-mode', 'agent-escalate').checked = true;
    setting.updateRulesEnabled();
    expect(el('setting-factory-rule-sensitive').disabled).toBe(false);
  });

  it('saves only what changed, and keeps the reason when the server refuses', async () => {
    const puts: unknown[] = [];
    let refuse = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method !== 'PUT') return json(VIEW);
        puts.push(JSON.parse(String(init.body)));
        return refuse ? json({ error: 'granularity must be one of track, feature' }, 400) : json({ ...VIEW, granularity: 'feature' });
      })
    );
    const setting = new FactorySetting();
    await setting.refresh();
    expect(await setting.save()).toBe(true);
    expect(puts).toEqual([]);

    radio('factory-review-granularity', 'feature').checked = true;
    el('setting-factory-rule-new-dependency').checked = true;
    expect(await setting.save()).toBe(true);
    expect(puts).toEqual([{ granularity: 'feature', rules: { newDependency: true } }]);

    refuse = true;
    radio('factory-review-mode', 'me').checked = true;
    expect(await setting.save()).toBe(false);
    expect(el<HTMLElement>('setting-factory-status').textContent).toBe('granularity must be one of track, feature');
  });
});

// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { SettingsModal, type SettingsModalHost } from '../src/client/settings-modal.js';
import { BuildIndicator } from '../src/client/server-restart.js';

/**
 * The Settings modal's tabs, against the real markup in index.html: which tab the gear opens
 * on, the Server tab without Save/Cancel, the unsaved-changes dots, the notification
 * permission warning and the restart confirm naming what a restart would discard.
 */

// happy-dom replaces URL, so not import.meta.url: vitest runs from the repo root.
const INDEX = readFileSync(join(process.cwd(), 'src', 'client', 'index.html'), 'utf8');
const MODAL = INDEX.slice(INDEX.indexOf('<div id="settings-modal"'), INDEX.indexOf('<!-- Keyboard Shortcuts Modal -->'));

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const flush = () => new Promise((r) => setTimeout(r, 0));

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const selected = () => document.querySelector('.settings-tab[aria-selected="true"]')?.id;
const dirty = (tab: string) => !el(`settings-tab-${tab}`).querySelector('.settings-tab-dirty')!.classList.contains('hidden');
const change = (input: HTMLInputElement, apply: (i: HTMLInputElement) => void) => {
  apply(input);
  input.dispatchEvent(new Event(input.type === 'number' ? 'input' : 'change', { bubbles: true }));
};

let behind = false;
let permission: 'default' | 'granted' | 'denied' = 'granted';

function host(): SettingsModalHost {
  return {
    notificationPreferences: () => ({ browserEnabled: true, visualEnabled: true, notifyOnInput: true, notifyOnCompleted: true }),
    setNotificationPreferences: vi.fn(),
    notificationPermission: async () => permission,
    jobOverlay: { isEnabled: () => true, getPlacement: () => 'below', setPreferences: vi.fn() },
    syncJobOverlay: vi.fn(),
    renderSessionList: vi.fn(),
    buildBehind: () => behind,
  };
}

async function open(): Promise<SettingsModal> {
  const settings = new SettingsModal(host());
  settings.bind();
  el('settings-btn').click();
  await flush();
  await flush();
  return settings;
}

beforeEach(() => {
  behind = false;
  permission = 'granted';
  document.body.innerHTML = `<button id="settings-btn"></button>${MODAL}`;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/server/settings') {
      return json({ maxSessions: 30, range: { min: 1, max: 100 }, counted: 3, maxPerParent: 5, maxPerParentRange: { min: 0, max: 20 } });
    }
    if (url === '/api/server/status') return json({ bootId: 'b', canRestart: true, reason: null });
    return json({}, 404);
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Settings tabs', () => {
  it('opens on Notifications, or on Server while the build is behind', async () => {
    await open();
    expect(selected()).toBe('settings-tab-notifications');
    expect(el('settings-panel-notifications').hidden).toBe(false);
    expect(el('settings-panel-server').hidden).toBe(true);

    document.body.innerHTML = `<button id="settings-btn"></button>${MODAL}`;
    behind = true;
    await open();
    expect(selected()).toBe('settings-tab-server');
    expect(el('settings-panel-server').hidden).toBe(false);
  });

  it('makes hidden panels inert, and never hides them by an inherited property', async () => {
    await open();
    expect(el('settings-panel-notifications').inert).toBe(false);
    for (const tab of ['display', 'sessions', 'server']) expect(el(`settings-panel-${tab}`).inert).toBe(true);
    el('settings-tab-server').click();
    expect(el('settings-panel-server').inert).toBe(false);
    expect(el('settings-panel-notifications').inert).toBe(true);

    // The cards and buttons inside carry `transition: all`: hiding a panel by `visibility`
    // (inherited) animated it, drawing the old tab over the new one for ~150ms per switch.
    const css = readFileSync(join(process.cwd(), 'src', 'client', 'styles.css'), 'utf8');
    const rule = css.match(/\.settings-panel\[hidden\]\s*\{([^}]*)\}/);
    expect(rule?.[1]).toContain('opacity: 0');
    expect(rule?.[1]).not.toMatch(/visibility/);
  });

  it('has no Save/Cancel on the Server tab, and gets them back elsewhere', async () => {
    await open();
    el('settings-tab-server').click();
    expect(el('settings-actions').hidden).toBe(true);
    expect(el('settings-actions').inert).toBe(true);
    el('settings-tab-sessions').click();
    expect(el('settings-actions').hidden).toBe(false);
    expect(el('settings-actions').inert).toBe(false);

    // Hidden by opacity, keeping its room: removing it shrank the modal on the Server tab.
    const css = readFileSync(join(process.cwd(), 'src', 'client', 'styles.css'), 'utf8');
    const rule = css.match(/\.settings-content \.modal-actions\[hidden\]\s*\{([^}]*)\}/);
    expect(rule?.[1]).toContain('display: flex');
    expect(rule?.[1]).toContain('opacity: 0');
  });

  it('moves between tabs with the arrow keys, wrapping, and Home/End', async () => {
    await open();
    const key = (k: string) =>
      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
    el('settings-tab-notifications').focus();
    key('ArrowLeft');
    expect(selected()).toBe('settings-tab-server');
    key('ArrowRight');
    expect(selected()).toBe('settings-tab-notifications');
    key('End');
    expect(selected()).toBe('settings-tab-server');
    key('Home');
    expect(selected()).toBe('settings-tab-notifications');
    // Roving tabindex: only the selected tab is in the Tab order.
    expect(el('settings-tab-notifications').tabIndex).toBe(0);
    expect(el('settings-tab-display').tabIndex).toBe(-1);
  });

  it('dots a tab with unsaved changes, and clears it when the change is undone', async () => {
    await open();
    const badges = el<HTMLInputElement>('setting-visual-badges');
    change(badges, (i) => (i.checked = false));
    expect(dirty('notifications')).toBe(true);
    expect(dirty('display')).toBe(false);
    expect(el('settings-unsaved').textContent).toBe('Unsaved: Notifications');
    expect(el('settings-tab-notifications').textContent).toContain('(unsaved changes)');

    change(badges, (i) => (i.checked = true));
    expect(dirty('notifications')).toBe(false);
    expect(el('settings-unsaved').textContent).toBe('');
  });

  it('does not dot Sessions for the limits loading, only for an edit', async () => {
    await open();
    expect(el<HTMLInputElement>('setting-max-per-parent').value).toBe('5');
    expect(dirty('sessions')).toBe(false);
    change(el<HTMLInputElement>('setting-max-per-parent'), (i) => (i.value = '8'));
    expect(dirty('sessions')).toBe(true);
  });

  it('forgets unsaved changes on Cancel', async () => {
    const settings = await open();
    change(el<HTMLInputElement>('setting-visual-badges'), (i) => (i.checked = false));
    el('settings-cancel').click();
    await settings.show();
    await flush();
    expect(el<HTMLInputElement>('setting-visual-badges').checked).toBe(true);
    expect(dirty('notifications')).toBe(false);
  });

  it('warns under Browser notifications only when the browser has not allowed them', async () => {
    await open();
    expect(el('setting-browser-notifications-warning').classList.contains('hidden')).toBe(true);

    document.body.innerHTML = `<button id="settings-btn"></button>${MODAL}`;
    permission = 'denied';
    await open();
    const warning = el('setting-browser-notifications-warning');
    expect(warning.classList.contains('hidden')).toBe(false);
    expect(warning.textContent).toMatch(/^Blocked by this browser/);
  });

  it('lists the changed files one per line, the folder apart, capped with "and N more"', async () => {
    const files = ['src/a/one.ts', 'src/a/two.ts', 'src/b/three.ts', 'src/b/four.ts', 'src/c/five.ts', 'package.json', 'src/c/six.ts'];
    const stamp = { sha: '38fb1d4bb7288a87', builtAt: new Date().toISOString() };
    const indicator = new BuildIndicator(async () => ({
      bootId: 'b',
      canRestart: false,
      reason: 'dev mode',
      build: { state: 'rebuild', running: stamp, onDisk: stamp, reason: 'why', files },
    }));
    await indicator.refresh();
    expect(el('server-build-state').textContent).toBe('New commits on main');
    expect(el('server-build-summary').textContent).toMatch(/^7 files changed since this build \(38fb1d4, today \d\d:\d\d\)\.$/);
    expect(el('server-build-summary').querySelector('code')?.textContent).toBe('38fb1d4');
    const items = [...el('server-build-files').querySelectorAll('li')].map((li) => li.textContent);
    expect(items).toEqual(['src/a/one.ts', 'src/a/two.ts', 'src/b/three.ts', 'src/b/four.ts', 'src/c/five.ts', 'and 2 more']);
    expect(el('server-build-files').querySelector('.server-build-dir')?.textContent).toBe('src/a/');
    expect(el('server-build-files').hidden).toBe(false);
    expect(el('server-build-manual').textContent).toMatch(/^By hand: run npm run build/);
  });

  it('names the tabs whose unsaved changes a restart would discard', async () => {
    await open();
    change(el<HTMLInputElement>('setting-keep-stopped'), (i) => (i.checked = !i.checked));
    el('settings-tab-server').click();
    el('server-restart-btn').click();
    expect(el('server-restart-confirm').classList.contains('hidden')).toBe(false);
    expect(el('server-restart-confirm-text').textContent).toMatch(/Unsaved changes on Display will be lost\.$/);
  });
});

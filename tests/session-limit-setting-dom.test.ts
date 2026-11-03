// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SessionLimitSetting } from '../src/client/session-limit-setting.js';
import { SettingsModal, type SettingsModalHost } from '../src/client/settings-modal.js';

/**
 * Settings → Sessions → Maximum sessions: a value in the server's config, edited from a
 * modal whose other settings apply only on Save. What the field shows has to match what
 * the server holds, through refusals, an unreachable server, overlapping loads and a
 * modal closed while its save is still in flight.
 */

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const view = (maxSessions: number, counted = 3) => ({ maxSessions, range: { min: 1, max: 100 }, counted });

/** Let awaited fetches and their .json() settle. */
const flush = () => new Promise((r) => setTimeout(r, 0));

const input = () => document.getElementById('setting-max-sessions') as HTMLInputElement;
const status = () => document.getElementById('setting-max-sessions-status')?.textContent ?? '';
const counted = () => document.getElementById('setting-max-sessions-counted')?.textContent ?? '';
const modal = () => document.getElementById('settings-modal') as HTMLElement;

beforeEach(() => {
  document.body.innerHTML = `
    <button id="settings-btn"></button>
    <div id="settings-modal" class="modal hidden">
      <div class="modal-content">
        <div id="notification-permission-status"></div>
        <input type="checkbox" id="setting-browser-notifications">
        <input type="checkbox" id="setting-visual-badges">
        <input type="checkbox" id="setting-notify-input">
        <input type="checkbox" id="setting-notify-completed">
        <input type="checkbox" id="setting-job-overlay">
        <div id="setting-job-overlay-placement">
          <input type="radio" name="job-overlay-placement" value="below">
          <input type="radio" name="job-overlay-placement" value="header">
        </div>
        <span id="setting-max-sessions-counted"></span>
        <input type="number" id="setting-max-sessions" disabled>
        <div id="setting-max-sessions-status"></div>
        <button id="settings-cancel"></button>
        <button id="settings-save"></button>
      </div>
    </div>`;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SessionLimitSetting', () => {
  it('loads the limit and the count it is checked against', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(view(30, 7))));
    await new SessionLimitSetting().refresh();
    expect(input().value).toBe('30');
    expect(input().disabled).toBe(false);
    expect(counted()).toBe('Counted now: 7.');
  });

  it('keeps the modal open and shows the reason when the server refuses a save', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === 'PUT'
        ? json({ error: 'The session limit must be a whole number from 1 to 100' }, 400)
        : json(view(30))
    );
    vi.stubGlobal('fetch', fetchMock);
    const setting = new SessionLimitSetting();
    await setting.refresh();
    input().value = '500';
    expect(await setting.save()).toBe(false);
    expect(status()).toBe('The session limit must be a whole number from 1 to 100');
    // Still unsaved: Save again sends it again rather than treating 500 as the saved value.
    expect(await setting.save()).toBe(false);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(2);
  });

  it('says so when the server cannot be reached, for a load and for a save', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(view(30))));
    const setting = new SessionLimitSetting();
    await setting.refresh();

    input().value = '40';
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    expect(await setting.save()).toBe(false);
    expect(status()).toBe('Could not reach the server to save the session limit.');

    await setting.refresh();
    expect(input().disabled).toBe(true);
    expect(input().value).toBe('');
    expect(status()).toBe('Could not read the session limit from the server.');
    // Never loaded: Save leaves the limit alone and lets the other settings through.
    expect(await setting.save()).toBe(true);
  });

  it('bounds every request with a timeout, and says a timed-out save may not have landed', async () => {
    const signals: (AbortSignal | undefined)[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      signals.push(init?.signal ?? undefined);
      if (init?.method === 'PUT') throw new DOMException('signal timed out', 'TimeoutError');
      return json(view(30));
    }));
    const setting = new SessionLimitSetting();
    await setting.refresh();
    input().value = '40';
    expect(await setting.save()).toBe(false);
    expect(status()).toBe('The server did not answer in time; the session limit may not have been saved.');
    expect(signals).toHaveLength(2);
    for (const signal of signals) expect(signal).toBeInstanceOf(AbortSignal);
  });

  it('does not let an older load overwrite a newer one', async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    const answers = [first, second];
    vi.stubGlobal('fetch', vi.fn(() => answers.shift()!.promise));
    const setting = new SessionLimitSetting();
    const older = setting.refresh();
    const newer = setting.refresh();
    second.resolve(json(view(25, 4)));
    await newer;
    first.resolve(json(view(10, 9)));
    await older;
    expect(input().value).toBe('25');
    expect(counted()).toBe('Counted now: 4.');
  });

  it('reloads only after a save still in flight has been answered', async () => {
    const put = deferred<Response>();
    let limit = 30;
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => {
      if (init?.method !== 'PUT') return Promise.resolve(json(view(limit)));
      return put.promise.then((response) => {
        limit = 45;
        return response;
      });
    }));
    const setting = new SessionLimitSetting();
    await setting.refresh();
    input().value = '45';
    const saving = setting.save();
    // Reopened before the server answered: it must not show the limit from before the save.
    const reload = setting.refresh();
    await flush();
    expect(input().disabled).toBe(true);
    put.resolve(json(view(45)));
    expect(await saving).toBe(true);
    await reload;
    expect(input().value).toBe('45');
    expect(input().disabled).toBe(false);
  });
});

describe('SettingsModal', () => {
  function host(): SettingsModalHost & { setNotificationPreferences: ReturnType<typeof vi.fn>; jobOverlay: { isEnabled: () => boolean; getPlacement: () => 'below'; setPreferences: ReturnType<typeof vi.fn> } } {
    return {
      notificationPreferences: () => ({ browserEnabled: true, visualEnabled: true, notifyOnInput: true, notifyOnCompleted: true }),
      setNotificationPreferences: vi.fn(),
      notificationPermission: async () => 'granted',
      jobOverlay: { isEnabled: () => true, getPlacement: () => 'below', setPreferences: vi.fn() },
      syncJobOverlay: vi.fn(),
    };
  }

  it('applies nothing local when closed while the limit is saving, and still records the save', async () => {
    const put = deferred<Response>();
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url !== '/api/server/settings') return Promise.resolve(json({}, 404));
      return init?.method === 'PUT' ? put.promise : Promise.resolve(json(view(30)));
    });
    vi.stubGlobal('fetch', fetchMock);
    const h = host();
    const settings = new SettingsModal(h);
    settings.bind();
    await settings.show();
    await flush();
    expect(modal().classList.contains('hidden')).toBe(false);

    input().value = '45';
    (document.getElementById('setting-browser-notifications') as HTMLInputElement).checked = false;
    document.getElementById('settings-save')!.click();
    expect((document.getElementById('settings-save') as HTMLButtonElement).disabled).toBe(true);
    document.getElementById('settings-cancel')!.click();
    expect(modal().classList.contains('hidden')).toBe(true);

    put.resolve(json(view(45)));
    await flush();
    await flush();
    expect(h.setNotificationPreferences).not.toHaveBeenCalled();
    expect(h.jobOverlay.setPreferences).not.toHaveBeenCalled();
    expect((document.getElementById('settings-save') as HTMLButtonElement).disabled).toBe(false);
    // The server took 45: Save without touching the field sends nothing more.
    await settings.show();
    await flush();
    const puts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT').length;
    expect(puts()).toBe(1);
    document.getElementById('settings-save')!.click();
    await flush();
    expect(puts()).toBe(1);
    expect(h.setNotificationPreferences).toHaveBeenCalledTimes(1);
    expect(modal().classList.contains('hidden')).toBe(true);
  });

  it('applies the local preferences and closes once the server accepts the limit', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      if (url !== '/api/server/settings') return Promise.resolve(json({}, 404));
      return Promise.resolve(json(view(init?.method === 'PUT' ? 45 : 30)));
    }));
    const h = host();
    const settings = new SettingsModal(h);
    settings.bind();
    await settings.show();
    await flush();
    input().value = '45';
    document.getElementById('settings-save')!.click();
    await flush();
    await flush();
    expect(h.setNotificationPreferences).toHaveBeenCalledTimes(1);
    expect(h.jobOverlay.setPreferences).toHaveBeenCalledWith(true, 'below');
    expect(modal().classList.contains('hidden')).toBe(true);
  });
});

// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  PlanUsageChip,
  remindersDue,
  renderPlanUsage,
  shortLeft,
  type AccountPlanUsage,
  type LoginInfo,
  type PlanUsage,
} from '../src/client/plan-usage-chip.js';

/**
 * The plan-usage chip's login warning (project/login-expiry.md): a tag on the
 * account's line only when it needs attention, a Login row with a small link,
 * and exactly one reminder per login, 3 days before it ends.
 */

const NOW = Date.parse('2026-11-25T12:00:00Z');
const H = 3600_000;
const D = 24 * H;
const ends = (ms: number): string => new Date(NOW + ms).toISOString();

const account = (name: string, login?: LoginInfo, rest: Partial<AccountPlanUsage> = {}): AccountPlanUsage => ({
  account: name,
  verified: true,
  snapshot: null,
  relaySeenAt: null,
  setup: { command: null },
  ...(login ? { login } : {}),
  ...rest,
});
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const render = (data: PlanUsage) => {
  const view = renderPlanUsage(data, NOW);
  return { ...view, summary: view.summary.value, body: view.body.value };
};

describe('the login tag and row', () => {
  it('shows no tag with more than 7 days left, and the end date in the popover', () => {
    const view = render({ accounts: [account('work', { state: 'ok', endsAt: ends(10 * D) })] });
    expect(text(view.summary)).not.toContain('login');
    expect(view.level).toBe('ok');
    expect(text(view.body)).toContain('ends');
    expect(text(view.body)).toContain('10d');
    expect(text(view.body)).toContain('Renew now');
  });

  it('tags an ending login amber and one ending today red', () => {
    const amber = render({ accounts: [account('work', { state: 'ending', endsAt: ends(3 * D + H) })] });
    expect(text(amber.summary)).toContain('login 3d');
    expect(amber.summary).toContain('pu-tag warn');
    expect(amber.level).toBe('warn');

    const red = render({ accounts: [account('work', { state: 'ends-today', endsAt: ends(5 * H) })] });
    expect(text(red.summary)).toContain('login 5h');
    expect(red.level).toBe('danger');
  });

  it('tags a logged-out account and offers Log in, as a link', () => {
    const view = render({
      accounts: [account('personal', { state: 'logged-out', endsAt: null }), account('work', { state: 'ok', endsAt: ends(10 * D) })],
    });
    expect(text(view.summary)).toContain('logged out');
    expect(view.level).toBe('danger');
    expect(text(view.body)).toContain('not logged in');
    expect(view.body).toContain('class="pu-link" data-action="login" data-account="personal"');
    expect(view.body).not.toContain('btn-primary');
  });

  it('says nothing about a login it has not checked yet, or from an older server', () => {
    const view = render({ accounts: [account('work', { state: 'unknown', endsAt: null }), account('personal')] });
    expect(text(view.summary)).not.toContain('login');
    expect(text(view.body)).not.toContain('Login');
  });

  it('rounds the time left down to its largest unit', () => {
    expect(shortLeft(3 * D + 23 * H)).toBe('3d');
    expect(shortLeft(5 * H + 59 * 60_000)).toBe('5h');
    expect(shortLeft(40 * 60_000)).toBe('40m');
    expect(shortLeft(-1)).toBe('0m');
  });
});

describe('remindersDue', () => {
  it('is due within 3 days of the end, never before and never after', () => {
    const data = (ms: number, state: LoginInfo['state'] = 'ending'): PlanUsage => ({
      accounts: [account('work', { state, endsAt: ends(ms) })],
    });
    expect(remindersDue(data(4 * D), NOW)).toEqual([]);
    expect(remindersDue(data(3 * D), NOW)).toEqual([{ account: 'work', endsAt: ends(3 * D) }]);
    expect(remindersDue(data(2 * H, 'ends-today'), NOW)).toHaveLength(1);
    expect(remindersDue({ accounts: [account('work', { state: 'logged-out', endsAt: null })] }, NOW)).toEqual([]);
  });
});

describe('the chip', () => {
  let payload: PlanUsage;
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = `
      <details id="plan-usage" class="plan-usage" hidden>
        <summary class="plan-usage-summary"></summary>
        <div class="plan-usage-body"></div>
      </details>`;
    payload = { accounts: [account('work', { state: 'ending', endsAt: ends(2 * D) })] };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(payload))));
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    document.querySelectorAll('.login-toast, .modal').forEach((el) => el.remove());
  });

  it('shows the reminder toast once per login, and again for a renewed one', async () => {
    const chip = new PlanUsageChip();
    await chip.refresh();
    expect(document.querySelectorAll('.login-toast')).toHaveLength(1);
    expect(document.querySelector('.login-toast')?.textContent).toContain('work login ends in 2d');

    document.querySelector<HTMLButtonElement>('[data-toast="dismiss"]')!.click();
    await chip.refresh();
    chip.render(NOW + 60_000);
    expect(document.querySelectorAll('.login-toast')).toHaveLength(0);

    // A new chip (a reload) remembers it was shown for this login.
    await new PlanUsageChip().refresh();
    expect(document.querySelectorAll('.login-toast')).toHaveLength(0);

    // Renewed, then ending again a month later: its own reminder.
    payload = { accounts: [account('work', { state: 'ending', endsAt: ends(2 * D + 30 * D) })] };
    vi.setSystemTime(NOW + 30 * D);
    await chip.refresh();
    expect(document.querySelectorAll('.login-toast')).toHaveLength(1);
  });

  it('opens the steps from a Log in link and starts the login only on confirm', async () => {
    payload = { accounts: [account('personal', { state: 'logged-out', endsAt: null })] };
    const chip = new PlanUsageChip();
    const logIn = vi.fn();
    chip.logIn = logIn;
    chip.attach();
    await chip.refresh();

    document.querySelector<HTMLButtonElement>('[data-action="login"]')!.click();
    const modal = document.querySelector('.login-modal');
    expect(modal?.textContent).toContain('/login');
    expect(logIn).not.toHaveBeenCalled();

    modal!.querySelector<HTMLButtonElement>('.login-modal-go')!.click();
    expect(logIn).toHaveBeenCalledWith('personal');
    expect(document.querySelector('.login-modal')).toBeNull();
    chip.detach();
  });

  it('cancels without starting a login', async () => {
    payload = { accounts: [account('personal', { state: 'logged-out', endsAt: null })] };
    const chip = new PlanUsageChip();
    const logIn = vi.fn();
    chip.logIn = logIn;
    chip.confirmLogin('personal');
    document.querySelector<HTMLButtonElement>('.login-modal [data-cancel]')!.click();
    expect(logIn).not.toHaveBeenCalled();
    expect(document.querySelector('.login-modal')).toBeNull();
  });
});

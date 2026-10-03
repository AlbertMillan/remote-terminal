import { jsonPost } from './job-board-types.js';

/**
 * The Restart / Build & restart controls in the Settings modal. The server side
 * is src/server/server-restart.ts.
 *
 * A restart closes every terminal, this page's included, so it asks once inline
 * (no window.confirm — it blocks the page) and then waits for a *different*
 * server: the old one keeps answering for a moment after the 202, so "the
 * server responds" is not proof it restarted. Each boot has its own bootId.
 */

/** Mirrors BuildStatus in src/server/server-restart.ts. */
export interface BuildStatus {
  state: 'current' | 'restart' | 'rebuild' | 'unknown';
  running: { sha: string; builtAt: string } | null;
  onDisk: { sha: string; builtAt: string } | null;
  reason: string | null;
}

export interface ServerStatus {
  bootId: string;
  canRestart: boolean;
  reason: string | null;
  /** Absent from a server older than the build-state check. */
  build?: BuildStatus;
}

/** Fired after something that can change the build state (a Land), so the chip re-checks now. */
export const BUILD_CHANGED_EVENT = 'claude-remote:build-changed';

const POLL_MS = 1000;
const WAIT_LIMIT_MS = 60_000;

async function fetchStatus(): Promise<ServerStatus | null> {
  try {
    const res = await fetch('/api/server/status', { cache: 'no-store' });
    return res.ok ? ((await res.json()) as ServerStatus) : null;
  } catch {
    // Down mid-restart; the caller keeps polling.
    return null;
  }
}

/** Resolves true once a server with a different bootId answers, false on timeout. */
export async function waitForNewBoot(
  oldBootId: string,
  poll: () => Promise<ServerStatus | null> = fetchStatus,
  opts: { intervalMs?: number; limitMs?: number; sleep?: (ms: number) => Promise<void> } = {}
): Promise<boolean> {
  const intervalMs = opts.intervalMs ?? POLL_MS;
  const limitMs = opts.limitMs ?? WAIT_LIMIT_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let waited = 0; waited < limitMs; waited += intervalMs) {
    await sleep(intervalMs);
    const status = await poll();
    if (status && status.bootId !== oldBootId) return true;
  }
  return false;
}

export class ServerRestartControl {
  private bootId: string | null = null;
  private pendingBuild = false;
  private running = false;

  constructor() {
    this.el('server-restart-btn')?.addEventListener('click', () => this.ask(false));
    this.el('server-build-restart-btn')?.addEventListener('click', () => this.ask(true));
    this.el('server-restart-cancel')?.addEventListener('click', () => this.hideConfirm());
    this.el('server-restart-go')?.addEventListener('click', () => void this.run());
  }

  /** Called when the Settings modal opens: learn the bootId and whether restart is possible. */
  async refresh(): Promise<void> {
    if (this.running) return;
    this.hideConfirm();
    const status = await fetchStatus();
    this.bootId = status?.bootId ?? null;
    const usable = !!status?.canRestart;
    this.setButtonsDisabled(!usable);
    if (!status) {
      // Most likely the page is newer than the running server: the build is in
      // dist/client already, but the routes arrive with the next restart.
      this.setStatus('This server has no restart route yet — restart it once with restart-server.vbs to enable these buttons.', false);
    } else {
      this.setStatus(usable ? '' : status.reason || 'Restart is unavailable.', false);
    }
  }

  private el(id: string): HTMLElement | null {
    return document.getElementById(id);
  }

  private ask(build: boolean): void {
    if (this.running) return;
    this.pendingBuild = build;
    const text = this.el('server-restart-confirm-text');
    if (text) {
      text.textContent = build
        ? 'Run npm run build, then restart if it passes? Every open terminal will close.'
        : 'Restart the server now? Every open terminal will close.';
    }
    this.el('server-restart-confirm')?.classList.remove('hidden');
  }

  private hideConfirm(): void {
    this.el('server-restart-confirm')?.classList.add('hidden');
  }

  private setButtonsDisabled(disabled: boolean): void {
    for (const id of ['server-restart-btn', 'server-build-restart-btn', 'server-restart-go']) {
      const button = this.el(id) as HTMLButtonElement | null;
      if (button) button.disabled = disabled;
    }
  }

  private setStatus(text: string, isError: boolean): void {
    const status = this.el('server-restart-status');
    if (!status) return;
    status.textContent = text;
    status.classList.toggle('error', isError);
  }

  private async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.hideConfirm();
    this.setButtonsDisabled(true);
    const build = this.pendingBuild;
    this.setStatus(build ? 'Building… this can take a minute.' : 'Restarting…', false);

    try {
      const res = await fetch('/api/server/restart', jsonPost({ build }));
      const body = (await res.json().catch(() => ({}))) as { error?: string; detail?: string; bootId?: string };
      if (res.status !== 202) {
        const message = [body.error || `Restart failed (${res.status})`, body.detail].filter(Boolean).join('\n');
        this.fail(message);
        return;
      }
      const oldBootId = body.bootId || this.bootId || '';
      this.setStatus(build ? 'Build passed. Restarting…' : 'Restarting…', false);
      if (await waitForNewBoot(oldBootId)) {
        this.setStatus('Server is back — reloading…', false);
        window.location.reload();
      } else {
        this.fail('The server did not come back within 60s — check ~/.claude-remote/logs/server.log.');
      }
    } catch (error) {
      this.fail(`Restart request failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private fail(message: string): void {
    this.running = false;
    this.setButtonsDisabled(false);
    this.setStatus(message, true);
  }
}

const CHIP_POLL_MS = 60_000;

export interface ChipView {
  text: string;
  title: string;
}

/**
 * What the chip says, or null to hide it. Only `restart` and `rebuild` show:
 * `unknown` (dev mode, an unstamped dist/) would otherwise sit lit forever.
 * When this server can't restart itself the chip still shows, and its tooltip
 * gives why and the step to take by hand.
 */
export function chipView(status: ServerStatus | null): ChipView | null {
  const build = status?.build;
  if (!status || !build || (build.state !== 'restart' && build.state !== 'rebuild')) return null;
  const rebuild = build.state === 'rebuild';
  const lines = [build.reason || ''];
  if (status.canRestart) {
    lines.push(rebuild ? 'Open Settings → Server → Build & restart.' : 'Open Settings → Server → Restart.');
  } else {
    lines.push(
      status.reason || 'Restart from the UI is unavailable here.',
      rebuild
        ? 'By hand: run npm run build, then restart the server where it was started.'
        : 'By hand: restart the server where it was started.'
    );
  }
  return {
    text: rebuild ? 'New commits' : 'New build',
    title: lines.filter(Boolean).join('\n'),
  };
}

/**
 * The chip beside the "Claude Remote" title that says the running server is behind its build.
 * It only ever opens Settings → Server: a restart ends every terminal, so the
 * confirm stays there, in ServerRestartControl, never on one click here.
 */
export class BuildChip {
  private checking = false;

  constructor(
    private readonly openServerSettings: () => void,
    private readonly poll: () => Promise<ServerStatus | null> = fetchStatus
  ) {
    this.el()?.addEventListener('click', () => this.openServerSettings());
  }

  /** Check now, then every minute, on window focus, and after a Land. */
  start(): void {
    void this.refresh();
    window.setInterval(() => void this.refresh(), CHIP_POLL_MS);
    window.addEventListener('focus', () => void this.refresh());
    window.addEventListener(BUILD_CHANGED_EVENT, () => void this.refresh());
  }

  async refresh(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try {
      this.render(chipView(await this.poll()));
    } finally {
      this.checking = false;
    }
  }

  private el(): HTMLButtonElement | null {
    return document.getElementById('build-chip') as HTMLButtonElement | null;
  }

  private render(view: ChipView | null): void {
    const chip = this.el();
    if (!chip) return;
    chip.hidden = !view;
    if (!view) return;
    chip.textContent = view.text;
    chip.title = view.title;
    chip.setAttribute('aria-label', `${view.text}. ${view.title}`);
  }
}

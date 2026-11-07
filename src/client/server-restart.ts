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

/** Fired after something that can change the build state (a Land), so the indicator re-checks now. */
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

  /** `unsavedTabs`: the Settings tabs a restart would discard edits on, named in the confirm. */
  constructor(private readonly unsavedTabs: () => string[] = () => []) {
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
      const unsaved = this.unsavedTabs();
      text.textContent =
        (build
          ? 'Run npm run build, then restart if it passes? Every open terminal will close.'
          : 'Restart the server now? Every open terminal will close.') +
        (unsaved.length ? ` Unsaved changes on ${unsaved.join(', ')} will be lost.` : '');
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

const BUILD_POLL_MS = 60_000;

export interface BuildView {
  /** The running build is behind: the gear and the Server tab show an amber dot. */
  behind: boolean;
  /** The Settings gear's tooltip and accessible name. */
  gearLabel: string;
  /** The Server tab's status line: a short state ("New commits on main.") … */
  state: string;
  /** … and what to do about it, which may run to several lines. */
  detail: string;
  /** The button the state calls for, shown as the primary one. */
  lead: 'restart' | 'build' | null;
}

/**
 * What the build indicator shows. Only `restart` and `rebuild` light the dot:
 * `unknown` (dev mode, an unstamped dist/) would otherwise sit lit forever.
 * When this server can't restart itself the dot still lights, and the Server tab
 * gives the step to take by hand.
 */
export function buildView(status: ServerStatus | null): BuildView {
  const build = status?.build;
  if (!status || !build || (build.state !== 'restart' && build.state !== 'rebuild')) {
    return {
      behind: false,
      gearLabel: 'Settings',
      state: build?.state === 'current' ? 'Up to date.' : '',
      detail: build?.state === 'current' ? 'The running build is the latest.' : '',
      lead: null,
    };
  }
  const rebuild = build.state === 'rebuild';
  const lines = [build.reason || ''];
  if (status.canRestart) {
    lines.push(rebuild ? 'Build & restart picks them up.' : 'Restart loads it.');
  } else {
    // Why the buttons are disabled is ServerRestartControl's status line, right below.
    lines.push(
      rebuild
        ? 'By hand: run npm run build, then restart the server where it was started.'
        : 'By hand: restart the server where it was started.'
    );
  }
  return {
    behind: true,
    gearLabel: rebuild
      ? 'Settings. New commits on main: Build & restart to load them.'
      : 'Settings. New build ready: Restart to load it.',
    state: rebuild ? 'New commits on main.' : 'New build ready.',
    detail: lines.filter(Boolean).join('\n'),
    lead: status.canRestart ? (rebuild ? 'build' : 'restart') : null,
  };
}

/**
 * Says when the running server is behind its build: an amber dot on the Settings gear and
 * on Settings' Server tab, plus that tab's status line. The gear then opens on the Server
 * tab (SettingsModal reads `behind`). It never restarts anything itself: a restart ends
 * every terminal, so the confirm stays in ServerRestartControl.
 */
export class BuildIndicator {
  private checking = false;
  private view: BuildView = buildView(null);

  constructor(private readonly poll: () => Promise<ServerStatus | null> = fetchStatus) {}

  get behind(): boolean {
    return this.view.behind;
  }

  /** Check now, then every minute, on window focus, and after a Land. */
  start(): void {
    void this.refresh();
    window.setInterval(() => void this.refresh(), BUILD_POLL_MS);
    window.addEventListener('focus', () => void this.refresh());
    window.addEventListener(BUILD_CHANGED_EVENT, () => void this.refresh());
  }

  async refresh(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try {
      this.render(buildView(await this.poll()));
    } finally {
      this.checking = false;
    }
  }

  private render(view: BuildView): void {
    this.view = view;
    const dot = document.getElementById('settings-build-dot');
    if (dot) dot.hidden = !view.behind;
    const tabDot = document.getElementById('settings-tab-server-dot');
    if (tabDot) tabDot.hidden = !view.behind;
    const gear = document.getElementById('settings-btn');
    if (gear) {
      gear.title = view.gearLabel;
      gear.setAttribute('aria-label', view.gearLabel);
    }
    const state = document.getElementById('server-build-state');
    if (state) {
      state.textContent = view.state;
      state.classList.toggle('behind', view.behind);
    }
    const detail = document.getElementById('server-build-detail');
    if (detail) detail.textContent = view.detail;
    for (const [id, lead] of [['server-restart-btn', 'restart'], ['server-build-restart-btn', 'build']] as const) {
      const button = document.getElementById(id);
      if (!button) continue;
      button.classList.toggle('btn-primary', view.lead === lead);
      button.classList.toggle('btn-secondary', view.lead !== lead);
    }
  }
}

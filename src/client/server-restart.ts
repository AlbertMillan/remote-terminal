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

interface ServerStatus {
  bootId: string;
  canRestart: boolean;
  reason: string | null;
}

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

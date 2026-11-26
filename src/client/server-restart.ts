import { failureMessage, jsonPost, requestJson } from './api.js';

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
  /** Absent from a server older than the list. */
  files?: string[] | null;
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
          ? 'Run npm run build, then restart if it passes? Running sessions are resumed after the restart; a reply in progress is interrupted.'
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

    const result = await requestJson<{ detail?: string; bootId?: string }>('/api/server/restart', jsonPost({ build }));
    if (result.status === 0) {
      this.fail(`Restart request failed: ${result.data.error ?? 'no answer'}`);
      return;
    }
    if (result.status !== 202) {
      this.fail([failureMessage(result, 'Restart failed'), result.data.detail].filter(Boolean).join('\n'));
      return;
    }
    const oldBootId = result.data.bootId || this.bootId || '';
    this.setStatus(build ? 'Build passed. Restarting…' : 'Restarting…', false);
    if (await waitForNewBoot(oldBootId)) {
      this.setStatus('Server is back — reloading…', false);
      window.location.reload();
    } else {
      this.fail('The server did not come back within 60s — check ~/.claude-remote/logs/server.log.');
    }
  }

  private fail(message: string): void {
    this.running = false;
    this.setButtonsDisabled(false);
    this.setStatus(message, true);
  }
}

const BUILD_POLL_MS = 60_000;

/** A line of text, with commit ids set in monospace. */
export type BuildText = Array<string | { code: string }>;

export interface BuildView {
  /** The running build is behind: the gear and the Server tab show an amber dot. */
  behind: boolean;
  /** The Settings gear's tooltip and accessible name. */
  gearLabel: string;
  /** The Server tab's headline ("New commits on main"); empty shows no status at all. */
  state: string;
  /** One plain line under it: how many files, and which build. */
  summary: BuildText;
  /** The changed build inputs, listed one per line under the summary. */
  files: string[];
  /** The step to take by hand when this server can't restart itself; else empty. */
  manual: string;
  /** The button the state calls for, shown as the primary one. */
  lead: 'restart' | 'build' | null;
}

/** How many files the Server tab lists before "and N more". */
export const BUILD_FILES_SHOWN = 5;

const pad = (n: number) => String(n).padStart(2, '0');

/** A build time in local time, short: "today 01:32", "yesterday 21:46", "Nov 7, 21:46". */
export function formatBuiltAt(iso: string, now: Date = new Date()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(now) - day(at)) / 86_400_000);
  if (days === 0) return `today ${time}`;
  if (days === 1) return `yesterday ${time}`;
  const month = at.toLocaleString('en', { month: 'short' });
  return `${month} ${at.getDate()}${at.getFullYear() === now.getFullYear() ? '' : ` ${at.getFullYear()}`}, ${time}`;
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/**
 * What the build indicator shows. Only `restart` and `rebuild` light the dot:
 * `unknown` (dev mode, an unstamped dist/) would otherwise sit lit forever.
 * When this server can't restart itself the dot still lights, and the Server tab
 * gives the step to take by hand. The highlighted button says which action to
 * take, so no line repeats it.
 */
export function buildView(status: ServerStatus | null, now: Date = new Date()): BuildView {
  const build = status?.build;
  const stamp = (s: { sha: string; builtAt: string }): BuildText => [{ code: s.sha.slice(0, 7) }, `, ${formatBuiltAt(s.builtAt, now)}`];
  if (!status || !build || (build.state !== 'restart' && build.state !== 'rebuild')) {
    const current = build?.state === 'current';
    return {
      behind: false,
      gearLabel: 'Settings',
      state: current ? 'Up to date' : '',
      summary: current && build.running ? ['Running the latest build (', ...stamp(build.running), ').'] : [],
      files: [],
      manual: '',
      lead: null,
    };
  }
  const rebuild = build.state === 'rebuild';
  const files = build.files ?? [];
  let summary: BuildText;
  if (rebuild) {
    summary = build.onDisk
      ? [`${plural(files.length, 'file')} changed since this build (`, ...stamp(build.onDisk), ').']
      : [`${plural(files.length, 'file')} changed since this build.`];
  } else {
    summary =
      build.onDisk && build.running
        ? [
            `Built ${formatBuiltAt(build.onDisk.builtAt, now)} (`,
            { code: build.onDisk.sha.slice(0, 7) },
            `); this server runs the build from ${formatBuiltAt(build.running.builtAt, now)}.`,
          ]
        : ['dist/ holds a newer build than this server runs.'];
  }
  // An older server sends only its sentence: show that rather than nothing.
  if (build.files === undefined && build.reason) summary = [build.reason];
  return {
    behind: true,
    gearLabel: rebuild
      ? 'Settings. New commits on main: Build & restart to load them.'
      : 'Settings. New build ready: Restart to load it.',
    state: rebuild ? 'New commits on main' : 'New build ready',
    summary,
    files,
    // Why the buttons are disabled is ServerRestartControl's status line, right below.
    manual: status.canRestart
      ? ''
      : rebuild
        ? 'By hand: run npm run build, then restart the server where it was started.'
        : 'By hand: restart the server where it was started.',
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
      state.classList.toggle('current', !view.behind && !!view.state);
    }
    const summary = document.getElementById('server-build-summary');
    if (summary) {
      summary.replaceChildren(
        ...view.summary.map((part) => {
          if (typeof part === 'string') return document.createTextNode(part);
          const code = document.createElement('code');
          code.textContent = part.code;
          return code;
        })
      );
    }
    const files = document.getElementById('server-build-files');
    if (files) {
      const items = view.files.slice(0, BUILD_FILES_SHOWN).map((file) => {
        const li = document.createElement('li');
        li.title = file;
        const cut = file.lastIndexOf('/') + 1;
        if (cut > 0) {
          const dir = document.createElement('span');
          dir.className = 'server-build-dir';
          dir.textContent = file.slice(0, cut);
          li.append(dir);
        }
        li.append(file.slice(cut));
        return li;
      });
      if (view.files.length > BUILD_FILES_SHOWN) {
        const more = document.createElement('li');
        more.className = 'server-build-more';
        more.textContent = `and ${view.files.length - BUILD_FILES_SHOWN} more`;
        items.push(more);
      }
      files.replaceChildren(...items);
      files.hidden = items.length === 0;
    }
    const manual = document.getElementById('server-build-manual');
    if (manual) manual.textContent = view.manual;
    for (const [id, lead] of [['server-restart-btn', 'restart'], ['server-build-restart-btn', 'build']] as const) {
      const button = document.getElementById(id);
      if (!button) continue;
      button.classList.toggle('btn-primary', view.lead === lead);
      button.classList.toggle('btn-secondary', view.lead !== lead);
    }
  }
}

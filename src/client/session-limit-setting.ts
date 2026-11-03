/**
 * The session limit in the Settings modal. Unlike the other settings it lives in
 * the server's config, not this browser: see src/server/server-settings.ts.
 */

/** GET and PUT /api/server/settings answer with this. */
interface ServerSettingsView {
  maxSessions: number;
  range: { min: number; max: number };
  /** Sessions the limit counts: every one not closed, stale ones waiting to be revived included. */
  counted: number;
}

/** Longest a load or save may take, or a hung request would leave Save disabled for good. */
const REQUEST_TIMEOUT_MS = 10_000;

export class SessionLimitSetting {
  /** The limit the server last reported; null until loaded, or if it could not be. */
  private saved: number | null = null;
  /** Each open starts a new load, so an older answer can't overwrite a newer one. */
  private loadId = 0;
  /**
   * The save in flight. Closing the modal doesn't stop it: the server may already have
   * written the file, so the next load waits for its answer rather than racing it.
   */
  private pending: Promise<boolean> | null = null;

  private input(): HTMLInputElement | null {
    return document.getElementById('setting-max-sessions') as HTMLInputElement | null;
  }

  private setStatus(text: string): void {
    const status = document.getElementById('setting-max-sessions-status');
    if (status) status.textContent = text;
  }

  private setCounted(counted: number | null): void {
    const el = document.getElementById('setting-max-sessions-counted');
    if (el) el.textContent = counted === null ? '' : `Counted now: ${counted}.`;
  }

  /** Called when the Settings modal opens. The field stays disabled until the server answers. */
  async refresh(): Promise<void> {
    const id = ++this.loadId;
    const input = this.input();
    if (!input) return;
    this.saved = null;
    input.disabled = true;
    this.setStatus('');
    this.setCounted(null);
    // Its failure, if any, stays in the status: it is news to whoever reopened.
    if (this.pending) await this.pending;
    if (id !== this.loadId) return;
    try {
      const response = await fetch('/api/server/settings', { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.json()) as ServerSettingsView;
      if (id !== this.loadId) return;
      this.saved = body.maxSessions;
      input.min = String(body.range.min);
      input.max = String(body.range.max);
      input.value = String(body.maxSessions);
      input.disabled = false;
      this.setCounted(body.counted);
    } catch {
      if (id !== this.loadId) return;
      input.value = '';
      this.setStatus('Could not read the session limit from the server.');
    }
  }

  /** Saves a changed limit. False means it was refused, and the modal should stay open to say why. */
  save(): Promise<boolean> {
    const run = this.send();
    this.pending = run;
    // send() never rejects, so neither does this.
    void run.finally(() => {
      if (this.pending === run) this.pending = null;
    });
    return run;
  }

  private async send(): Promise<boolean> {
    const input = this.input();
    // Never loaded: nothing to change, and the other settings can still save.
    if (!input || this.saved === null) return true;
    const value = Number(input.value);
    if (input.value.trim() !== '' && value === this.saved) return true;
    this.setStatus('');
    try {
      const response = await fetch('/api/server/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        // An empty or fractional field reaches the server's check, whose message names the range.
        body: JSON.stringify({ maxSessions: input.value.trim() === '' ? null : value }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        this.setStatus(body?.error || `Could not save the session limit (HTTP ${response.status}).`);
        return false;
      }
      const body = (await response.json().catch(() => null)) as ServerSettingsView | null;
      this.saved = body?.maxSessions ?? value;
      if (body) this.setCounted(body.counted);
      return true;
    } catch (error) {
      this.setStatus(
        (error as { name?: unknown } | null)?.name === 'TimeoutError'
          ? 'The server did not answer in time; the session limit may not have been saved.'
          : 'Could not reach the server to save the session limit.'
      );
      return false;
    }
  }
}

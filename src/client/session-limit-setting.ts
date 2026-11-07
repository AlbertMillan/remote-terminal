/**
 * The session limits in the Settings modal: Maximum sessions and Started sessions per
 * session. Unlike the other settings they live in the server's config, not this browser:
 * see src/server/server-settings.ts.
 */

/** GET and PUT /api/server/settings answer with this. */
interface ServerSettingsView {
  maxSessions: number;
  range: { min: number; max: number };
  /** Sessions the limit counts: every one not closed, stale ones waiting to be revived included. */
  counted: number;
  /** Live started sessions one session may have (agentSessions.maxPerParent). */
  maxPerParent: number;
  maxPerParentRange: { min: number; max: number };
}

/** The server's limit keys (LIMIT_SETTINGS in src/server/config.ts). */
type LimitKey = 'maxSessions' | 'maxPerParent';

/** Where a limit's range sits in the server's answer. */
type RangeOf = (v: ServerSettingsView) => { min: number; max: number };

/** A limit, the id of its field, and where its range sits in the server's answer. */
interface LimitField {
  key: LimitKey;
  inputId: string;
  range: RangeOf;
}

/** One field per limit. The client keeps its own list: it owns the ids, the server the ranges. */
const LIMITS: LimitField[] = [
  { key: 'maxSessions', inputId: 'setting-max-sessions', range: (v) => v.range },
  { key: 'maxPerParent', inputId: 'setting-max-per-parent', range: (v) => v.maxPerParentRange },
];

/** Longest a load or save may take, or a hung request would leave Save disabled for good. */
const REQUEST_TIMEOUT_MS = 10_000;

export class SessionLimitSetting {
  /** The limits the server last reported; null until loaded, or if they could not be. */
  private saved: ServerSettingsView | null = null;
  /** Each open starts a new load, so an older answer can't overwrite a newer one. */
  private loadId = 0;
  /**
   * The save in flight. Closing the modal doesn't stop it: the server may already have
   * written the file, so the next load waits for its answer rather than racing it.
   */
  private pending: Promise<boolean> | null = null;

  /** The fields present on the page; a page without one simply doesn't edit that limit. */
  private inputs(): (Omit<LimitField, 'inputId'> & { input: HTMLInputElement })[] {
    return LIMITS.flatMap(({ key, inputId, range }) => {
      const input = document.getElementById(inputId) as HTMLInputElement | null;
      return input ? [{ key, input, range }] : [];
    });
  }

  private setStatus(text: string): void {
    const status = document.getElementById('setting-session-limits-status');
    if (status) status.textContent = text;
  }

  private setCounted(counted: number | null): void {
    const el = document.getElementById('setting-max-sessions-counted');
    if (el) el.textContent = counted === null ? '' : `Counted now: ${counted}.`;
  }

  /** Called when the Settings modal opens. The fields stay disabled until the server answers. */
  async refresh(): Promise<void> {
    const id = ++this.loadId;
    const fields = this.inputs();
    if (fields.length === 0) return;
    this.saved = null;
    for (const { input } of fields) input.disabled = true;
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
      this.saved = body;
      for (const { key, input, range } of fields) {
        // An older server without this limit: leave its field disabled and empty.
        if (typeof body[key] !== 'number' || !range(body)) {
          input.value = '';
          continue;
        }
        input.min = String(range(body).min);
        input.max = String(range(body).max);
        input.value = String(body[key]);
        input.disabled = false;
      }
      this.setCounted(body.counted);
    } catch {
      if (id !== this.loadId) return;
      for (const { input } of fields) input.value = '';
      this.setStatus('Could not read the session limits from the server.');
    }
  }

  /** Saves changed limits. False means they were refused, and the modal should stay open to say why. */
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
    const saved = this.saved;
    // Never loaded: nothing to change, and the other settings can still save.
    if (!saved) return true;
    const changes: Partial<Record<LimitKey, number | null>> = {};
    for (const { key, input } of this.inputs()) {
      if (input.disabled) continue;
      const value = Number(input.value);
      if (input.value.trim() !== '' && value === saved[key]) continue;
      // An empty or fractional field reaches the server's check, whose message names the range.
      changes[key] = input.value.trim() === '' ? null : value;
    }
    if (Object.keys(changes).length === 0) return true;
    this.setStatus('');
    try {
      const response = await fetch('/api/server/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(changes),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        this.setStatus(body?.error || `Could not save the session limits (HTTP ${response.status}).`);
        return false;
      }
      const body = (await response.json().catch(() => null)) as ServerSettingsView | null;
      this.saved = body ?? { ...saved, ...(changes as Partial<ServerSettingsView>) };
      if (body) this.setCounted(body.counted);
      return true;
    } catch (error) {
      this.setStatus(
        (error as { name?: unknown } | null)?.name === 'TimeoutError'
          ? 'The server did not answer in time; the session limits may not have been saved.'
          : 'Could not reach the server to save the session limits.'
      );
      return false;
    }
  }
}

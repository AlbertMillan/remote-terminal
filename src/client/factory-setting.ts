import { requestJson } from './api.js';

/**
 * Settings → Factory: who decides a unit's review, the escalation rules, the review
 * granularity, and the engine's limits (read-only). Kept in the server's config like the
 * session limits (session-limit-setting.ts); see src/server/factory/review-settings.ts.
 */

type ReviewMode = 'agent' | 'agent-escalate' | 'me';
type Granularity = 'track' | 'feature';
type RuleKey = 'sensitivePaths' | 'largeDiff' | 'fixLoops' | 'assumptions' | 'newDependency';

/** GET and PUT /api/factory/settings answer with this. */
interface FactorySettingsView {
  mode: ReviewMode;
  rules: Record<RuleKey, boolean>;
  largeDiffLines: number;
  granularity: Granularity;
  largeDiffRange: { min: number; max: number };
  fixLoopMax: number;
  limits: Record<string, number>;
}

const RULES: { key: RuleKey; inputId: string }[] = [
  { key: 'sensitivePaths', inputId: 'setting-factory-rule-sensitive' },
  { key: 'largeDiff', inputId: 'setting-factory-rule-large-diff' },
  { key: 'fixLoops', inputId: 'setting-factory-rule-fix-loops' },
  { key: 'assumptions', inputId: 'setting-factory-rule-assumptions' },
  { key: 'newDependency', inputId: 'setting-factory-rule-new-dependency' },
];

/** How each engine limit is shown; one the server adds later is listed under its key. */
const LIMIT_LABELS: Record<string, (n: number) => string> = {
  seats: (n) => `Seats: ${n} across all projects`,
  seatsPerProject: (n) => `At most ${n} per project`,
  pauseWhenParked: (n) => `Pause dispatch when ${n} wait for you`,
  fiveHourCapPct: (n) => `No new items past ${n}% of the 5-hour window`,
  weeklyCapPct: (n) => `No new items past ${n}% of the weekly window`,
  runawayTokens: (n) => `Park an item past ${n.toLocaleString('en-US')} tokens`,
};

const REQUEST_TIMEOUT_MS = 10_000;

export class FactorySetting {
  private saved: FactorySettingsView | null = null;
  private loadId = 0;
  private pending: Promise<boolean> | null = null;

  private radios(name: string): HTMLInputElement[] {
    return [...document.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`)];
  }

  private modeRadios = () => this.radios('factory-review-mode');
  private granularityRadios = () => this.radios('factory-review-granularity');

  private rules(): { key: RuleKey; input: HTMLInputElement }[] {
    return RULES.flatMap(({ key, inputId }) => {
      const input = document.getElementById(inputId) as HTMLInputElement | null;
      return input ? [{ key, input }] : [];
    });
  }

  private lines = () => document.getElementById('setting-factory-large-diff') as HTMLInputElement | null;

  private all(): HTMLInputElement[] {
    const lines = this.lines();
    return [...this.modeRadios(), ...this.granularityRadios(), ...this.rules().map((r) => r.input), ...(lines ? [lines] : [])];
  }

  private setStatus(text: string): void {
    const status = document.getElementById('setting-factory-status');
    if (status) status.textContent = text;
  }

  /** The rules only act in "agent, escalate when risky": greyed out otherwise. */
  updateRulesEnabled(): void {
    if (!this.saved) return;
    const mode = this.modeRadios().find((r) => r.checked)?.value;
    const on = mode === 'agent-escalate';
    document.getElementById('setting-factory-rules')?.classList.toggle('disabled', !on);
    for (const { input } of this.rules()) input.disabled = !on;
    const lines = this.lines();
    if (lines) lines.disabled = !on;
  }

  private showLimits(view: FactorySettingsView | null): void {
    const list = document.getElementById('setting-factory-limits');
    if (!list) return;
    list.replaceChildren(
      ...Object.entries(view?.limits ?? {}).map(([key, value]) => {
        const li = document.createElement('li');
        li.textContent = LIMIT_LABELS[key]?.(value) ?? `${key}: ${value}`;
        return li;
      })
    );
  }

  /** Called when the Settings modal opens. The fields stay disabled until the server answers. */
  async refresh(): Promise<void> {
    const id = ++this.loadId;
    const fields = this.all();
    if (fields.length === 0) return;
    this.saved = null;
    for (const input of fields) input.disabled = true;
    this.setStatus('');
    if (this.pending) await this.pending;
    if (id !== this.loadId) return;
    try {
      const response = await fetch('/api/factory/settings', { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.json()) as FactorySettingsView;
      if (id !== this.loadId) return;
      this.saved = body;
      for (const r of this.modeRadios()) {
        r.checked = r.value === body.mode;
        r.disabled = false;
      }
      for (const r of this.granularityRadios()) {
        r.checked = r.value === body.granularity;
        r.disabled = false;
      }
      for (const { key, input } of this.rules()) input.checked = body.rules?.[key] === true;
      const lines = this.lines();
      if (lines) {
        lines.min = String(body.largeDiffRange.min);
        lines.max = String(body.largeDiffRange.max);
        lines.value = String(body.largeDiffLines);
      }
      const loops = document.getElementById('setting-factory-fix-loops');
      if (loops) loops.textContent = String(body.fixLoopMax);
      this.showLimits(body);
      this.updateRulesEnabled();
    } catch {
      if (id !== this.loadId) return;
      this.showLimits(null);
      this.setStatus('Could not read the factory settings from the server.');
    }
  }

  /** Saves what changed. False means it was refused, and the modal should stay open to say why. */
  save(): Promise<boolean> {
    const run = this.send();
    this.pending = run;
    void run.finally(() => {
      if (this.pending === run) this.pending = null;
    });
    return run;
  }

  private async send(): Promise<boolean> {
    const saved = this.saved;
    if (!saved) return true;
    const changes: Record<string, unknown> = {};
    const mode = this.modeRadios().find((r) => r.checked)?.value;
    if (mode && mode !== saved.mode) changes.mode = mode;
    const granularity = this.granularityRadios().find((r) => r.checked)?.value;
    if (granularity && granularity !== saved.granularity) changes.granularity = granularity;
    const rules: Partial<Record<RuleKey, boolean>> = {};
    for (const { key, input } of this.rules()) {
      if (input.checked !== (saved.rules?.[key] === true)) rules[key] = input.checked;
    }
    if (Object.keys(rules).length > 0) changes.rules = rules;
    const lines = this.lines();
    if (lines && (lines.value.trim() === '' || Number(lines.value) !== saved.largeDiffLines)) {
      // An empty or fractional field reaches the server's check, whose message names the range.
      changes.largeDiffLines = lines.value.trim() === '' ? null : Number(lines.value);
    }
    if (Object.keys(changes).length === 0) return true;
    this.setStatus('');
    const result = await requestJson<Partial<FactorySettingsView>>('/api/factory/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(changes),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (result.status === 0) {
      this.setStatus(
        result.timedOut
          ? 'The server did not answer in time; the factory settings may not have been saved.'
          : 'Could not reach the server to save the factory settings.'
      );
      return false;
    }
    if (!result.ok) {
      this.setStatus(result.data.error || `Could not save the factory settings (HTTP ${result.status}).`);
      return false;
    }
    this.saved = 'mode' in result.data ? (result.data as FactorySettingsView) : saved;
    return true;
  }
}

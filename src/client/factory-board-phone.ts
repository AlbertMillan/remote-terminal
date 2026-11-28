import { html, type SafeHtml } from './html-utils.js';
import { levelOf, type PlanUsage } from './plan-usage-chip.js';
import { renderNeedsYou } from './factory-board-needs.js';
import { renderStageRows, type StageGroup } from './factory-board-pipeline.js';
import { renderReport } from './factory-board-side.js';
import type { FactoryBoard, FactoryColumn, FactoryReport } from '../shared/protocol.js';

/**
 * The board on a phone (project/factory-page-redesign.md, layout E, "Phone
 * (≤640px)"): a three-tab bar instead of the desktop's columns.
 *
 * - **You** (default): plan-usage, running and merging tiles; Needs you with
 *   44px buttons (styles.css); a running preview that opens Flow at Running.
 * - **Flow**: B's stage view — scrollable stage buttons with counts (amber when
 *   one holds work for you) and the selected stage's cards. Ready ("the queue")
 *   and Running are one stage here; Done has its own tab.
 * - **Done**: what merged today and the "since you last looked" report.
 *
 * The board (factory-board.ts) decides it is on a phone (`isPhone`), owns the tab
 * and the stage, and draws the detail pane as a bottom sheet (CSS on `.fb-phone`).
 */

export const PHONE_QUERY = '(max-width: 640px)';

export type PhoneTab = 'you' | 'flow' | 'done';

export const PHONE_TABS: { id: PhoneTab; label: string }[] = [
  { id: 'you', label: 'You' },
  { id: 'flow', label: 'Flow' },
  { id: 'done', label: 'Done' },
];

/** Flow's stages on a phone: Ready folds into Running; Done is its own tab. */
export const PHONE_STAGES: { id: FactoryColumn; label: string }[] = [
  { id: 'intake', label: 'Intake' },
  { id: 'running', label: 'Running' },
  { id: 'review', label: 'Review' },
  { id: 'merging', label: 'Merging' },
];

/** Where a desktop stage is in the phone's Flow (Ready is shown under Running; Done in its tab). */
export function phoneStage(stage: FactoryColumn): FactoryColumn {
  if (stage === 'ready') return 'running';
  if (stage === 'done') return 'running';
  return stage;
}

/** The phone's Flow groups: the desktop's, with Ready's units queued ahead in Running. */
export function phoneStageGroups(groups: StageGroup[]): StageGroup[] {
  const by = (id: FactoryColumn) => groups.find((g) => g.id === id) as StageGroup;
  return PHONE_STAGES.map(({ id }) => {
    if (id !== 'running') return by(id);
    const ready = by('ready');
    const running = by('running');
    return { id, units: [...running.units, ...ready.units], merges: [...running.merges, ...ready.merges], you: running.you + ready.you };
  });
}

export function renderPhoneTabs(tab: PhoneTab, needs: number): SafeHtml {
  return html`${PHONE_TABS.map(
    (t) => html`<button type="button" role="tab" class="fb-phone-tab${t.id === tab ? ' on' : ''}" aria-selected="${t.id === tab ? 'true' : 'false'}"
      data-fb="phone-tab" data-tab="${t.id}">${t.label}${t.id === 'you' && needs > 0 ? html` <em>${needs}</em>` : ''}</button>`
  )}`;
}

/** The highest 5-hour reading across the logins, with that login's weekly one. */
export function planTile(usage: PlanUsage | null): { value: string; note: string; level: string } {
  const read = (usage?.accounts ?? []).filter((a) => a.snapshot?.fiveHour);
  if (read.length === 0) return { value: '—', note: 'no reading yet', level: '' };
  const top = read.reduce((a, b) => ((b.snapshot!.fiveHour!.usedPercentage > a.snapshot!.fiveHour!.usedPercentage) ? b : a));
  const five = Math.round(top.snapshot!.fiveHour!.usedPercentage);
  const week = top.snapshot!.sevenDay ? `week ${Math.round(top.snapshot!.sevenDay.usedPercentage)}%` : 'week —';
  return { value: `${five}%`, note: `5-hour · ${week}${read.length > 1 ? ` · ${top.account}` : ''}`, level: levelOf(five) };
}

const PREVIEW = 3;

export function renderYou(
  d: FactoryBoard,
  groups: StageGroup[],
  usage: PlanUsage | null,
  busy: boolean,
  openKey: string | null
): SafeHtml {
  const plan = planTile(usage);
  const running = groups.find((g) => g.id === 'running') as StageGroup;
  const merging = groups.find((g) => g.id === 'merging') as StageGroup;
  const preview: StageGroup = { ...running, units: running.units.slice(0, PREVIEW), merges: [] };
  return html`<div class="fb-main fb-you">
    <div class="fb-tiles">
      <div class="fb-tile ${plan.level}" data-tile="plan"><span>Plan usage</span><b>${plan.value}</b><em>${plan.note}</em></div>
      <button type="button" class="fb-tile" data-tile="running" data-fb="phone-flow" data-stage="running">
        <span>Running</span><b>${running.units.length}</b><em>${d.dispatch.running} of ${d.dispatch.seats} seats</em>
      </button>
      <button type="button" class="fb-tile${merging.you > 0 ? ' you' : ''}" data-tile="merging" data-fb="phone-flow" data-stage="merging">
        <span>Merging</span><b>${merging.units.length + merging.merges.length}</b><em>merge queue</em>
      </button>
    </div>
    ${renderNeedsYou(d.units, busy, openKey)}
    <section class="fb-preview" aria-label="Running now">
      <h3>Running <em>${running.units.length}</em></h3>
      ${running.units.length > 0 ? renderStageRows(preview, openKey, null) : html`<p class="fb-empty">Nothing running.</p>`}
      <button type="button" class="btn-secondary fb-wide-btn" data-fb="phone-flow" data-stage="running">Open Flow at Running</button>
    </section>
  </div>`;
}

export function renderPhoneFlow(groups: StageGroup[], stage: FactoryColumn, openKey: string | null, openMerge: string | null): SafeHtml {
  const selected = groups.find((g) => g.id === stage) ?? (groups.find((g) => g.id === 'running') as StageGroup);
  return html`<div class="fb-main fb-phone-flow">
    <div class="fb-phone-stages" role="tablist" aria-label="Stages">${PHONE_STAGES.map((s) => {
      const g = groups.find((x) => x.id === s.id) as StageGroup;
      const on = s.id === selected.id;
      return html`<button type="button" role="tab" class="fb-phone-stage${on ? ' on' : ''}${g.you > 0 ? ' you' : ''}" aria-selected="${on ? 'true' : 'false'}"
        data-fb="stage" data-stage="${s.id}">${s.label} <em>${g.units.length + g.merges.length}</em></button>`;
    })}</div>
    ${renderStageRows(selected, openKey, openMerge)}
  </div>`;
}

export function renderDone(done: StageGroup, report: FactoryReport | null, openKey: string | null, openMerge: string | null): SafeHtml {
  return html`<div class="fb-main fb-done">
    <section aria-label="Merged today">
      <h3>Merged today <em>${done.units.length + done.merges.length}</em></h3>
      ${done.units.length + done.merges.length > 0 ? renderStageRows(done, openKey, openMerge) : html`<p class="fb-empty">Nothing merged today.</p>`}
    </section>
    ${report ? renderReport(report) : html`<p class="fb-path">Nothing new since you last looked.</p>`}
  </div>`;
}

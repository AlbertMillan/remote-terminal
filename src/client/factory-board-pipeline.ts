import { html, type SafeHtml } from './html-utils.js';
import { formatTokens } from './format.js';
import { cardKind, cardStatus, progressStrip } from './factory-overlay.js';
import type { FactoryBoard, FactoryBoardUnit, FactoryColumn, FactoryMergeSummary } from '../shared/protocol.js';

/**
 * The board's Pipeline (project/factory-page-redesign.md, layout E): a stage
 * picker instead of six columns. One tab per `FactoryColumn` with its count and
 * a one-line note; the selected stage lists its units as rows below. Loose merge
 * entries (a session's Land, or an entry whose unit is gone) list under Merging
 * until merged, then under Done. The board (factory-board.ts) owns the selected
 * stage and the clicks: a row carries `data-unit-key` / `data-merge-card`, a tab
 * `data-fb="stage"`.
 */

export const STAGES: { id: FactoryColumn; label: string; note: string }[] = [
  { id: 'intake', label: 'Intake', note: 'shaping and triage' },
  { id: 'ready', label: 'Ready', note: 'shaped, waiting for a seat' },
  { id: 'running', label: 'Running', note: 'agents building' },
  { id: 'review', label: 'Review', note: 'reviewer agent or you' },
  { id: 'merging', label: 'Merging', note: 'merge queue, Lands too' },
  { id: 'done', label: 'Done today', note: 'merged today' },
];

export const DEFAULT_STAGE: FactoryColumn = 'running';

export interface StageGroup {
  id: FactoryColumn;
  units: FactoryBoardUnit[];
  merges: FactoryMergeSummary[];
  /** Units (and parked loose merges) in it that wait for you: the count shows amber. */
  you: number;
}

/** Merge entries with no unit on the board: a session's Land, or a unit already gone. */
export function looseMerges(board: Pick<FactoryBoard, 'units' | 'merges'>): FactoryMergeSummary[] {
  const unitMergeIds = new Set(board.units.map((u) => u.mergeId).filter(Boolean));
  return board.merges.filter((m) => !unitMergeIds.has(m.id));
}

/** Every stage with its units, in the board's order, and its loose merges. */
export function stageGroups(board: Pick<FactoryBoard, 'units' | 'merges'>): StageGroup[] {
  const loose = looseMerges(board);
  return STAGES.map(({ id }) => {
    const units = board.units.filter((u) => u.column === id);
    const merges = loose.filter((m) => (id === 'done' ? m.status === 'merged' : id === 'merging' && m.status !== 'merged'));
    const you = units.filter((u) => u.needsYou).length + merges.filter((m) => m.status === 'parked').length;
    return { id, units, merges, you };
  });
}

/** The tab's note: Review splits the agent's from yours, as the column header did. */
function stageNote(group: StageGroup, note: string): string {
  if (group.id === 'review' && group.units.length > 0) {
    const you = group.units.filter((u) => u.needsYou).length;
    return `agent ${group.units.length - you} · you ${you}`;
  }
  return note;
}

export function renderStagePicker(groups: StageGroup[], selected: FactoryColumn): SafeHtml {
  return html`<div class="fb-stages" role="tablist" aria-label="Pipeline stages">${STAGES.map((stage) => {
    const g = groups.find((x) => x.id === stage.id) as StageGroup;
    const on = stage.id === selected;
    return html`<button type="button" role="tab" class="fb-stage${on ? ' on' : ''}${g.you > 0 ? ' you' : ''}" aria-selected="${on ? 'true' : 'false'}"
      data-fb="stage" data-stage="${stage.id}">
      <span class="fb-stage-head">${stage.label} <em>${g.units.length + g.merges.length}</em></span>
      <span class="fb-stage-note">${stageNote(g, stage.note)}</span>
    </button>`;
  })}</div>`;
}

export function renderStageRows(group: StageGroup, openKey: string | null, openMerge: string | null): SafeHtml {
  const label = STAGES.find((s) => s.id === group.id)?.label ?? group.id;
  if (group.units.length === 0 && group.merges.length === 0) {
    return html`<div class="fb-rows" data-stage-rows="${group.id}"><p class="fb-empty">Nothing in ${label}.</p></div>`;
  }
  return html`<div class="fb-rows" data-stage-rows="${group.id}">
    ${group.units.map((u) => renderRow(u, u.key === openKey))}
    ${group.merges.map((m) => renderMergeRow(m, m.id === openMerge))}
  </div>`;
}

function renderRow(u: FactoryBoardUnit, open: boolean): SafeHtml {
  return html`<button type="button" class="fb-row ${cardKind(u)}${u.stalled ? ' stalled' : ''}${open ? ' open' : ''}" data-unit-key="${u.key}">
    <span class="fo-id">${u.isTrack ? 'Track' : u.unitId}</span>
    <span class="fb-row-main">
      <span class="fb-title">${u.title}</span>
      <span class="fb-sub">${cardStatus(u)}</span>
    </span>
    ${progressStrip(u, 'fo-prog wide')}
    <span class="fb-row-meta"><span class="fb-proj">${u.projectName}</span>${u.tokens > 0 && html`<span class="fb-tokens">${formatTokens(u.tokens)} tokens</span>`}</span>
  </button>`;
}

function renderMergeRow(m: FactoryMergeSummary, open: boolean): SafeHtml {
  return html`<button type="button" class="fb-row merging${m.status === 'parked' ? ' you' : ''}${open ? ' open' : ''}" data-merge-card="${m.id}">
    <span class="fo-id">${m.kind === 'session-land' ? 'Land' : 'merge'}</span>
    <span class="fb-row-main">
      <span class="fb-title">${m.title}</span>
      <span class="fb-sub">${m.status}${m.detail ? ` · ${m.detail}` : ''}</span>
    </span>
    <span class="fb-row-meta"><span class="fb-proj">${m.projectName}</span></span>
  </button>`;
}

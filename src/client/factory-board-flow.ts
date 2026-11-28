import { html, type SafeHtml } from './html-utils.js';
import { cardKind, cardStatus, progressStrip } from './factory-overlay.js';
import { STAGES, looseMerges } from './factory-board-pipeline.js';
import type { FactoryBoard, FactoryBoardUnit, FactoryColumn, FactoryMergeSummary } from '../shared/protocol.js';

/**
 * The board's Flow view (project/factory-page-redesign.md, layout E, "B's
 * lanes"): one row per track, the stages as columns, each unit drawn as a tag at
 * its stage. A project's loose items share its Inbox row. Built from the same
 * GET /api/factory/board data as the Pipeline; no route of its own.
 *
 * A loose merge entry (a session's Land, or an entry whose unit is gone) is drawn
 * at Merging (Done once merged) in the row of the track it lands, matched by
 * project and title, or else in its project's Inbox row.
 *
 * Tags carry `data-unit-key` / `data-merge-card`: the board opens them in the
 * detail pane like any card or row.
 */

/** Board or Flow: the choice is remembered per browser. */
export const VIEW_MODE_KEY = 'factoryBoardViewMode';
export type ViewMode = 'board' | 'flow';

export function readViewMode(stored: string | null): ViewMode {
  return stored === 'flow' ? 'flow' : 'board';
}

export interface FlowLane {
  key: string;
  /** The track's name, or `Inbox` for a project's loose items. */
  name: string;
  projectName: string;
  inbox: boolean;
  units: FactoryBoardUnit[];
  merges: FactoryMergeSummary[];
}

/**
 * One lane per (project, track) for track units, in the board's order (what needs
 * you first, as the server sorts); then one Inbox lane per project for loose items.
 */
export function flowLanes(board: Pick<FactoryBoard, 'units' | 'merges'>): FlowLane[] {
  const tracks = new Map<string, FlowLane>();
  const inboxes = new Map<string, FlowLane>();
  const inbox = (cwd: string, projectName: string): FlowLane => {
    let lane = inboxes.get(cwd);
    if (!lane) {
      lane = { key: `inbox:${cwd}`, name: 'Inbox', projectName, inbox: true, units: [], merges: [] };
      inboxes.set(cwd, lane);
    }
    return lane;
  };
  for (const u of board.units) {
    if (!u.isTrack) {
      inbox(u.projectCwd, u.projectName).units.push(u);
      continue;
    }
    const key = `track:${u.projectCwd}\n${u.trackName}`;
    let lane = tracks.get(key);
    if (!lane) {
      lane = { key, name: u.trackName, projectName: u.projectName, inbox: false, units: [], merges: [] };
      tracks.set(key, lane);
    }
    lane.units.push(u);
  }
  for (const m of looseMerges(board)) {
    const lane = tracks.get(`track:${m.projectCwd}\n${m.title}`) ?? inbox(m.projectCwd, m.projectName);
    lane.merges.push(m);
  }
  return [...tracks.values(), ...inboxes.values()];
}

/** Where a loose merge entry is drawn. */
export function mergeStage(m: FactoryMergeSummary): FactoryColumn {
  return m.status === 'merged' ? 'done' : 'merging';
}

export function renderFlow(lanes: FlowLane[], openKey: string | null, openMerge: string | null): SafeHtml {
  if (lanes.length === 0) return html`<section class="fb-flow" aria-label="Flow"><h3>Flow</h3><p class="fb-empty">Nothing in the factory.</p></section>`;
  return html`<section class="fb-flow" aria-label="Flow">
    <h3>Flow</h3>
    <div class="fb-flow-scroll"><div class="fb-flow-grid" role="table" aria-label="Units by track and stage">
      <div class="fb-flow-row fb-flow-head" role="row">
        <span class="fb-lane-name" role="columnheader">Track</span>
        ${STAGES.map((s) => html`<span role="columnheader">${s.label}</span>`)}
      </div>
      ${lanes.map((lane) => renderLane(lane, openKey, openMerge))}
    </div></div>
  </section>`;
}

function renderLane(lane: FlowLane, openKey: string | null, openMerge: string | null): SafeHtml {
  const you = lane.units.some((u) => u.needsYou) || lane.merges.some((m) => m.status === 'parked');
  return html`<div class="fb-flow-row${you ? ' you' : ''}" role="row" data-lane="${lane.key}">
    <span class="fb-lane-name" role="rowheader"><b>${lane.name}</b><span class="fb-proj">${lane.projectName}</span></span>
    ${STAGES.map(
      (s) => html`<span class="fb-lane-cell" role="cell" data-lane-stage="${s.id}">
        ${lane.units.filter((u) => u.column === s.id).map((u) => renderTag(u, u.key === openKey))}
        ${lane.merges.filter((m) => mergeStage(m) === s.id).map((m) => renderMergeTag(m, m.id === openMerge))}
      </span>`
    )}
  </div>`;
}

function renderTag(u: FactoryBoardUnit, open: boolean): SafeHtml {
  // A track is one unit: its tag names the feature it is at; a loose item its own title.
  const now = u.isTrack ? u.features.find((f) => f.state === 'now')?.title : undefined;
  return html`<button type="button" class="fb-tag ${cardKind(u)}${u.stalled ? ' stalled' : ''}${open ? ' open' : ''}" data-unit-key="${u.key}"
    title="${u.title} · ${cardStatus(u)}">
    <span class="fb-tag-title">${u.isTrack ? (now ?? u.title) : u.title}</span>
    ${progressStrip(u, 'fo-prog')}
  </button>`;
}

function renderMergeTag(m: FactoryMergeSummary, open: boolean): SafeHtml {
  return html`<button type="button" class="fb-tag merging${m.status === 'parked' ? ' you' : ''}${open ? ' open' : ''}" data-merge-card="${m.id}"
    title="${m.title} · ${m.status}">
    <span class="fb-tag-title">${m.kind === 'session-land' ? 'Land' : 'merge'} · ${m.status}</span>
  </button>`;
}

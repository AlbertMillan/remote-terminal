import { html, type SafeHtml } from './html-utils.js';
import { formatTokens, shortAge } from './format.js';
import type { FactoryBoard, FactoryReport } from '../shared/protocol.js';

/**
 * The board's right-hand side panel (project/factory-page-redesign.md, layout
 * E): capacity (seats, dispatch, plan-usage caps, tokens today), the morning
 * report ("since you last looked", hidden when there is nothing to say, and
 * dismissable) and the merge queue. Its links are `data-unit-key` /
 * `data-merge-card`, opened by the board like any card.
 */

export function renderSidePanel(d: FactoryBoard, report: FactoryReport | null): SafeHtml {
  return html`<aside class="fb-side" aria-label="Factory status">
    ${renderCapacity(d)}
    ${report && renderReport(report)}
    ${renderMergeQueue(d)}
  </aside>`;
}

function renderCapacity(d: FactoryBoard): SafeHtml {
  const { dispatch } = d;
  const capped = Object.entries(dispatch.capped);
  const seats = Array.from({ length: dispatch.seats }, (_, i) => html`<i class="${i < dispatch.running ? 'busy' : ''}"></i>`);
  return html`<section class="fb-panel fb-capacity" aria-label="Capacity">
    <h3>Capacity</h3>
    <div class="fb-seats" aria-label="${dispatch.running} of ${dispatch.seats} seats busy">${seats}</div>
    <dl class="fb-kv">
      <dt>Seats</dt><dd>${dispatch.running} of ${dispatch.seats} busy</dd>
      <dt>Dispatch</dt><dd>${dispatch.paused ? html`<span class="fb-warn" title="${dispatch.paused}">paused</span>` : dispatch.started ? 'on' : 'off'}</dd>
      <dt>Tokens today</dt><dd>${formatTokens(d.tokensToday)}</dd>
    </dl>
    ${dispatch.paused && html`<p class="fb-path">${dispatch.paused}</p>`}
    ${capped.length > 0 && html`<h4>Capped by plan usage</h4><ul>${capped.map(([cwd, why]) => html`<li title="${cwd}">${why}</li>`)}</ul>`}
  </section>`;
}

/** What landed, what stalls and what it cost since this browser last opened the board. */
export function renderReport(r: FactoryReport): SafeHtml {
  return html`<section class="fb-panel fb-report" aria-label="Since you last looked">
    <div class="fb-report-head"><h3>Since you last looked <span class="fb-path">${shortAge(r.since)} ago</span></h3>
      <button type="button" class="fb-x" data-fb="dismiss-report" aria-label="Dismiss the report">×</button></div>
    <h4>Landed (${r.landed.length})</h4>${r.landed.length > 0
      ? html`<ul>${r.landed.map((m) => html`<li>${m.title} <span class="fb-path">${m.projectName}${m.mergeSha ? ` · ${m.mergeSha.slice(0, 7)}` : ''}</span></li>`)}</ul>`
      : html`<p class="fb-path">Nothing merged.</p>`}
    <h4>Stalls (${r.stalls.length})</h4>${r.stalls.length > 0
      ? html`<ul>${r.stalls.map((u) => html`<li><button type="button" class="fb-link" data-unit-key="${u.key}">${u.title}</button> <span class="fb-path">${u.stalled}</span></li>`)}</ul>`
      : html`<p class="fb-path">Nothing stuck.</p>`}
    <h4>Tokens · ${formatTokens(r.totalTokens)}</h4>${r.tokens.length > 0
      ? html`<ul>${r.tokens.slice(0, 8).map((t) => html`<li>${t.title} <span class="fb-path">${t.projectName} · ${formatTokens(t.tokens)}</span></li>`)}</ul>`
      : html`<p class="fb-path">No factory runs.</p>`}
  </section>`;
}

function renderMergeQueue(d: FactoryBoard): SafeHtml {
  const pending = d.merges.filter((m) => m.status !== 'merged');
  const merged = d.merges.length - pending.length;
  return html`<section class="fb-panel fb-queue" aria-label="Merge queue">
    <h3>Merge queue <em>${pending.length}</em></h3>
    ${pending.length > 0
      ? html`<ul>${pending.map(
          (m) => html`<li><button type="button" class="fb-link" data-merge-card="${m.id}">${m.title}</button>
            <span class="fb-chip ${m.status === 'parked' ? 'y' : m.status === 'running' ? 'b' : ''}">${m.status}</span>
            <span class="fb-path">${m.kind === 'session-land' ? 'Land · ' : ''}${m.projectName}</span></li>`
        )}</ul>`
      : html`<p class="fb-path">Nothing queued.</p>`}
    ${merged > 0 && html`<p class="fb-path">${merged} merged today</p>`}
  </section>`;
}

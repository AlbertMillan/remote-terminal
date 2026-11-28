import { html, joinHtml, type SafeHtml } from './html-utils.js';
import { canTakeOver, renderClaimActions } from './factory-claims.js';
import { formatTokens, shortAge } from './format.js';
import { isMockupPark, type MockupDrawer } from './factory-mockup.js';
import { STAGES } from './factory-board-pipeline.js';
import type { FactoryBoard, FactoryBoardUnit, FactoryColumn, FactoryMergeSummary } from '../shared/protocol.js';

/**
 * The board's detail pane (project/factory-page-redesign.md, layout E): the
 * selected unit or merge entry, docked in the right-hand column beside the
 * board, where it takes the side panel's place instead of covering the board.
 * A row of stage dots says where the unit is; below it every view the drawer
 * had: review (summary, diff, request changes; Approve, Take over), shaping
 * questions, triage, mockup (factory-mockup.ts), parked runs, merge entry,
 * cancel confirmation and the claimed-unit actions (factory-claims.ts).
 *
 * The board (factory-board.ts) owns the state, the drafts and the clicks; this
 * module only renders, from a `PaneContext`. The pane keeps the `#factory-drawer`
 * element, so `data-fb` actions inside it resolve their unit from the selection.
 */

/** `take-over`: the phone's confirm step before Take over (a desktop takes over at once). */
export type UnitView = 'main' | 'summary' | 'diff' | 'changes' | 'cancel' | 'take-over';

/** What the pane shows: a unit (in one of its views) or a merge-queue entry. */
export type PaneSelection = { kind: 'unit'; key: string; view: UnitView } | { kind: 'merge'; id: string };

export interface PaneNotice {
  text: string;
  error: boolean;
}

export interface PaneContext {
  data: FactoryBoard | null;
  busy: boolean;
  notice: PaneNotice | null;
  drafts: Map<string, string>;
  /** The unit's summary page; `load` starts the fetch while it is missing. */
  summary(u: FactoryBoardUnit, load: boolean): string | undefined;
  diff(key: string): { stat: string; patch: string; truncated: boolean } | undefined;
  mockup: MockupDrawer;
  sessionExists(id: string): boolean;
  /**
   * The pane is the phone's bottom sheet: its main actions stick to the sheet's
   * bottom (`fb-sticky`), and Take over asks first.
   */
  phone?: boolean;
}

/**
 * A summary page's markdown, as blocks: headings, bullets, paragraphs and
 * fenced code. The page is the agent's own short text, so this is all it needs;
 * everything is escaped (html``), nothing is trusted.
 */
export function renderMarkdown(text: string): SafeHtml {
  const out: SafeHtml[] = [];
  let list: string[] = [];
  let code: string[] | null = null;
  const flush = () => {
    if (list.length > 0) out.push(html`<ul>${list.map((li) => html`<li>${li}</li>`)}</ul>`);
    list = [];
  };
  for (const line of text.split(/\r?\n/)) {
    if (code) {
      if (/^```/.test(line)) {
        out.push(html`<pre class="fb-pre">${code.join('\n')}</pre>`);
        code = null;
      } else code.push(line);
      continue;
    }
    if (/^```/.test(line)) {
      flush();
      code = [];
      continue;
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      out.push(html`<h4>${heading[1]}</h4>`);
    } else if (bullet) {
      list.push(bullet[1]);
    } else if (line.trim()) {
      flush();
      out.push(html`<p>${line}</p>`);
    } else flush();
  }
  flush();
  if (code) out.push(html`<pre class="fb-pre">${code.join('\n')}</pre>`);
  return joinHtml(out);
}

/**
 * Cancel is offered on any live unit no terminal session holds and no merge is
 * running for (server factory/cancel.ts refuses those too): a parked merge is dropped.
 */
export function cancellable(u: FactoryBoardUnit): boolean {
  if (u.triage || u.claim || u.status === 'done') return false;
  return !(u.column === 'merging' && u.mergeStatus !== 'parked');
}

/** The unit selected for the pane's main view, if it is a mockup park (the pane then widens). */
export function paneShowsMockup(sel: PaneSelection | null, data: FactoryBoard | null): boolean {
  if (sel?.kind !== 'unit' || sel.view !== 'main') return false;
  const u = data?.units.find((x) => x.key === sel.key);
  return !!u && isMockupPark(u);
}

/**
 * Where the unit is, one dot per stage: passed, here (amber when it waits for
 * you), still ahead. `data-dot` is the dot's state, for the tests and the CSS.
 */
export function stageDots(column: FactoryColumn, needsYou = false): SafeHtml {
  const at = STAGES.findIndex((s) => s.id === column);
  const here = STAGES[at]?.label ?? column;
  return html`<ol class="fb-dots" aria-label="Stage: ${here}">${STAGES.map((s, i) => {
    const state = i < at ? 'done' : i === at ? (needsYou ? 'you' : 'now') : 'todo';
    return html`<li class="${state}" data-dot="${state}" title="${s.label}"><i></i><span>${s.label}</span></li>`;
  })}</ol>`;
}

export function renderPane(sel: PaneSelection, ctx: PaneContext): SafeHtml {
  const close = html`<button type="button" class="fb-x" data-fb="close" aria-label="Close">×</button>`;
  const notice = ctx.notice ? html`<div class="fb-notice${ctx.notice.error ? ' error' : ''}">${ctx.notice.text}</div>` : '';
  if (sel.kind === 'merge') {
    const m = ctx.data?.merges.find((x) => x.id === sel.id);
    return html`${close}${m
      ? html`${stageDots(m.status === 'merged' ? 'done' : 'merging', m.status === 'parked')}${renderMerge(m, true, ctx.busy)}`
      : html`<p class="fb-path">This merge entry is no longer listed.</p>`}${notice}`;
  }
  const u = ctx.data?.units.find((x) => x.key === sel.key);
  if (!u) {
    return html`${close}${ctx.data ? html`<p class="fb-path">This unit is no longer on the board.</p>` : html`<p class="fb-path">Loading…</p>`}`;
  }
  return html`${close}${renderUnit(u, sel.view, ctx)}${notice}`;
}

function viewButton(view: UnitView, label: string): SafeHtml {
  return html`<button type="button" class="btn-secondary" data-fb="view" data-view="${view}">${label}</button>`;
}

function renderUnit(u: FactoryBoardUnit, view: UnitView, ctx: PaneContext): SafeHtml {
  const busy = ctx.busy ? 'disabled' : '';
  const head = html`<span class="fb-path">${u.isTrack ? 'Track' : u.unitId} · ${u.projectName}</span>
    <h3>${u.title}</h3>
    ${stageDots(u.column, u.needsYou)}
    <div class="fb-chips">
      <span class="fb-chip ${u.needsYou ? 'y' : ''}">${u.needsYou ? 'needs you' : u.column}</span>
      ${u.isTrack && html`<span class="fb-chip b">1 agent${u.modelTier ? ` · ${u.modelTier}` : ''}</span>`}
      ${!u.isTrack && u.modelTier && html`<span class="fb-chip">${u.modelTier}</span>`}
      ${u.reviewer && html`<span class="fb-chip v">${u.reviewer === 'agent' ? 'reviewer agent checking' : 'review: you'}</span>`}
      ${u.waitsFor.length > 0 && html`<span class="fb-chip">waits for ${u.waitsFor.join(', ')}</span>`}
    </div>
    ${u.stalled && html`<div class="fb-verdict">Stalled: ${u.stalled}</div>`}`;

  if (view === 'summary') {
    const text = ctx.summary(u, false);
    return html`${head}<div class="fb-tabs">${viewButton('main', 'Back')}</div>
      <h4>Summary page</h4>${text === undefined ? html`<p class="fb-path">Loading…</p>` : html`<div class="fb-md">${renderMarkdown(text)}</div>`}`;
  }
  if (view === 'diff') {
    const diff = ctx.diff(u.key);
    return html`${head}<div class="fb-tabs">${viewButton('main', 'Back')}</div>
      ${diff === undefined
        ? html`<p class="fb-path">Loading the diff…</p>`
        : html`<pre class="fb-pre">${diff.stat}</pre><pre class="fb-pre fb-diff">${diff.patch}</pre>${diff.truncated && html`<p class="fb-path">Cut short; the worktree has the rest.</p>`}`}`;
  }
  if (view === 'changes') {
    return html`${head}<h4>What should change?</h4>
      <textarea class="fb-textarea" rows="6" data-draft="changes:${u.key}" placeholder="The fix step reads this as the review's findings">${ctx.drafts.get(`changes:${u.key}`) ?? ''}</textarea>
      <div class="fb-acts">
        <button type="button" class="btn-primary" data-fb="send-changes" ${busy}>Send back</button>
        ${viewButton('main', 'Cancel')}
      </div>`;
  }

  if (view === 'take-over') {
    return html`${head}<h4>Take this over in a terminal?</h4>
      <p>The factory's agent is stopped and its conversation goes on in a terminal in the unit's worktree. The factory skips the unit until you return it or mark it done.</p>
      <div class="fb-acts fb-sticky">
        <button type="button" class="btn-primary" data-fb="take-over" ${busy}>Take over</button>
        ${viewButton('main', 'Keep it')}
      </div>`;
  }

  if (view === 'cancel') {
    return html`${head}<h4>Cancel this ${u.isTrack ? 'track' : 'item'}?</h4>
      <p>${u.status === 'in_progress' ? 'Its agent is stopped first. ' : ''}${u.isTrack ? 'Its features leave' : 'It leaves'} the factory,
      and ${u.isTrack ? 'their lines stay' : 'its line stays'} unticked in PROJECT.md. ${u.isTrack
        ? 'The track keeps its worktree and branch, with every commit made so far.'
        : 'Its worktree and branch are removed, with any work in them.'}${u.mergeStatus === 'parked' ? ' Its parked merge is dropped.' : ''}</p>
      <div class="fb-acts">
        <button type="button" class="btn-primary" data-fb="cancel-unit" ${busy}>Cancel ${u.isTrack ? 'track' : 'item'}</button>
        ${viewButton('main', 'Keep it')}
      </div>`;
  }

  const parts: SafeHtml[] = [head];
  if (u.triage) {
    parts.push(html`<p>An agent filed this while working on something else. Accept it into the factory, move it to the backlog, or dismiss it.</p>
      <div class="fb-acts">
        <button type="button" class="btn-primary" data-fb="triage" data-action="accept">Accept</button>
        <button type="button" class="btn-secondary" data-fb="triage" data-action="backlog">Backlog</button>
        <button type="button" class="btn-secondary" data-fb="triage" data-action="dismiss">Dismiss</button>
      </div>`);
  } else if (u.detail.questions.length > 0 && u.needsYou) {
    parts.push(renderQuestions(u, ctx));
  } else if (u.column === 'review' && u.needsYou) {
    parts.push(html`<div class="fb-verdict"><b>${u.escalated ? 'Escalated to you' : 'Waiting for your review'}</b>${u.detail.parkReason
      ? html`: ${u.detail.parkReason.split('\n')[0].replace(/^review: (escalated: )?/, '')}`
      : ''}</div>
      ${u.detail.verdict && html`<h4>Reviewer agent</h4><pre class="fb-pre">${u.detail.verdict}</pre>`}
      ${u.detail.hasSummary && inlineSummary(u, ctx)}
      <div class="fb-acts${ctx.phone ? ' fb-sticky' : ''}">
        <button type="button" class="btn-primary" data-fb="approve" ${busy}>Approve</button>
        ${viewButton('changes', 'Request changes')}
        ${ctx.phone && canTakeOver(u) && viewButton('take-over', 'Take over')}
        ${u.detail.worktreePath && viewButton('diff', 'Open diff')}
      </div>`);
  } else if (u.column === 'merging') {
    const m = ctx.data?.merges.find((x) => x.id === u.mergeId);
    parts.push(m ? renderMerge(m, false, ctx.busy) : html`<p class="fb-path">Handed to the merge queue.</p>`);
  } else if (isMockupPark(u)) {
    // Only the mockup: the Live block's ages would change the pane, and reload the frame, every minute.
    return joinHtml([head, ctx.mockup.render(u), cancellable(u) ? html`<div class="fb-acts">${viewButton('cancel', 'Cancel item')}</div>` : html``]);
  } else if (u.status === 'parked') {
    parts.push(html`<div class="fb-verdict"><b>Parked</b> at ${u.step ?? 'setup'}</div>
      ${u.detail.parkReason && html`<pre class="fb-pre">${u.detail.parkReason}</pre>`}
      <div class="fb-acts">
        <button type="button" class="btn-primary" data-fb="release" ${busy}>Release for another round</button>
        ${u.detail.worktreePath && viewButton('diff', 'Open diff')}
      </div>`);
  }

  if (u.features.length > 0) {
    parts.push(html`<h4>Features, in order, one worktree</h4>
      <ul class="fb-features">${u.features.map(
        (f) => html`<li class="${f.state}"><span class="fb-mark">${f.state === 'done' ? '✓' : f.state === 'now' ? '…' : '○'}</span> ${f.state === 'now' ? html`<b>${f.title}</b> <span class="fb-path">(now)</span>` : f.title}</li>`
      )}</ul>`);
  }
  // On a phone Take over asks first; a review's sticky bar already carries it.
  const reviewBar = !!ctx.phone && u.column === 'review' && u.needsYou && !u.triage && u.detail.questions.length === 0;
  parts.push(
    renderClaimActions(u, ctx.busy, (id) => ctx.sessionExists(id), {
      takeOver: reviewBar ? 'none' : ctx.phone ? 'confirm' : 'direct',
      sticky: !!ctx.phone,
    })
  );
  parts.push(html`<h4>Live</h4><dl class="fb-kv">
    <dt>Step</dt><dd>${u.step ?? '—'}</dd>
    <dt>Heartbeat</dt><dd>${u.claim ? (u.claim.live ? 'your terminal' : 'terminal closed') : u.heartbeatAt ? `${shortAge(u.heartbeatAt)} ago` : '—'}</dd>
    <dt>Tokens</dt><dd>${formatTokens(u.tokens)}</dd>
    ${u.detail.worktreePath && html`<dt>Worktree</dt><dd class="fb-mono">${u.detail.worktreePath}</dd>`}
    ${u.detail.branch && html`<dt>Branch</dt><dd class="fb-mono">${u.detail.branch}</dd>`}
    ${u.detail.lastCommit && html`<dt>Last commit</dt><dd class="fb-mono">${u.detail.lastCommit.slice(0, 10)}</dd>`}
  </dl>`);
  const extra: SafeHtml[] = [];
  if (u.detail.hasSummary && !(u.column === 'review' && u.needsYou)) extra.push(viewButton('summary', 'Summary page'));
  if (u.detail.worktreePath && !u.needsYou) extra.push(viewButton('diff', 'Open diff'));
  if (cancellable(u)) extra.push(viewButton('cancel', u.isTrack ? 'Cancel track' : 'Cancel item'));
  if (extra.length > 0) parts.push(html`<div class="fb-acts">${extra}</div>`);
  return joinHtml(parts);
}

/** The summary page inline under an escalated review: what you read before approving. */
function inlineSummary(u: FactoryBoardUnit, ctx: PaneContext): SafeHtml {
  const text = ctx.summary(u, true);
  return html`<h4>Summary</h4>${text === undefined ? html`<p class="fb-path">Loading…</p>` : html`<div class="fb-md">${renderMarkdown(text)}</div>`}`;
}

function renderQuestions(u: FactoryBoardUnit, ctx: PaneContext): SafeHtml {
  return html`<div class="fb-verdict"><b>Shaping needs an answer</b>${u.reason ? html`: ${u.reason}` : ''}</div>
    ${u.detail.questions.map((q) => {
      const chosen = ctx.drafts.get(`choice:${u.key}:${q.id}`) ?? q.default ?? '';
      const name = `choice:${u.key}:${q.id}`;
      return html`<fieldset class="fb-question"><legend>${q.question}</legend>
        ${q.options.map(
          (o) => html`<label><input type="radio" name="${name}" value="${o}" data-draft="${name}" ${o === chosen ? 'checked' : ''}> ${o}${o === q.default ? html` <span class="fb-path">(default)</span>` : ''}</label>`
        )}
        <label><input type="radio" name="${name}" value="__other" data-draft="${name}" ${chosen === '__other' || (q.options.length === 0) ? 'checked' : ''}> Other:</label>
        <input type="text" class="fb-input" data-draft="other:${u.key}:${q.id}" value="${ctx.drafts.get(`other:${u.key}:${q.id}`) ?? ''}" placeholder="Your answer">
      </fieldset>`;
    })}
    <div class="fb-acts"><button type="button" class="btn-primary" data-fb="answer" ${ctx.busy ? 'disabled' : ''}>Answer</button></div>`;
}

function renderMerge(m: FactoryMergeSummary, withHead: boolean, busy: boolean): SafeHtml {
  return html`${withHead && html`<span class="fb-path">${m.kind === 'session-land' ? 'Land' : 'Merge'} · ${m.projectName}</span><h3>${m.title}</h3>`}
    <h4>Merge queue</h4>
    <dl class="fb-kv">
      <dt>Status</dt><dd>${m.status}</dd>
      <dt>Branch</dt><dd class="fb-mono">${m.branch}</dd>
      ${m.mergeSha && html`<dt>Merge commit</dt><dd class="fb-mono">${m.mergeSha.slice(0, 10)}</dd>`}
      <dt>Updated</dt><dd>${shortAge(m.updatedAt)} ago</dd>
    </dl>
    ${m.detail && html`<div class="fb-verdict">${m.status === 'parked' ? html`<b>Parked</b>: ` : ''}${m.detail}</div>`}
    ${m.conflictPaths.length > 0 && html`<h4>Conflicts the resolver could not settle</h4><ul>${m.conflictPaths.map((p) => html`<li class="fb-mono">${p}</li>`)}</ul>`}
    ${m.status === 'parked' && html`<div class="fb-acts"><button type="button" class="btn-primary" data-fb="retry-merge" data-merge-id="${m.id}" ${busy ? 'disabled' : ''}>Retry merge</button></div>`}`;
}

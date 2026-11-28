import { html, type SafeHtml } from './html-utils.js';
import { cardStatus } from './factory-overlay.js';
import { isMockupPark } from './factory-mockup.js';
import type { FactoryBoardUnit } from '../shared/protocol.js';

/**
 * The board's **Needs you** (project/factory-page-redesign.md, layout E): every
 * unit that waits for you, as a card with its decision inline. Hidden when
 * empty, with no placeholder. Everything else about a unit stays in the drawer.
 *
 * - an escalated (or your) review: Approve / Open
 * - one shaping question: its options as buttons (the default marked); Other and
 *   several questions: Open
 * - a mockup park: Build it (approves the mockup) / Open
 * - triage: Accept / Backlog / Dismiss
 * - anything else parked for you (a loop cap, a merge conflict): Open
 *
 * A card is `data-need="<key>"`: the board resolves an inline `data-fb` action's
 * unit from it rather than from the drawer. Open is a `data-unit-key` button.
 */

export type NeedKind = 'triage' | 'question' | 'mockup' | 'review' | 'other';

/** The units Needs you lists, in the board's order (the server sorts what needs you first). */
export function needsYouUnits(units: FactoryBoardUnit[]): FactoryBoardUnit[] {
  return units.filter((u) => u.needsYou && u.column !== 'done');
}

export function needKind(u: FactoryBoardUnit): NeedKind {
  if (u.triage) return 'triage';
  if (u.detail.questions.length > 0) return 'question';
  if (isMockupPark(u)) return 'mockup';
  if (u.column === 'review') return 'review';
  return 'other';
}

const KIND_LABEL: Record<NeedKind, string> = {
  triage: 'Triage',
  question: 'Question',
  mockup: 'Mockup',
  review: 'Review',
  other: 'Parked',
};

/** Needs you, or nothing at all when no unit waits for you. */
export function renderNeedsYou(units: FactoryBoardUnit[], busy: boolean, openKey: string | null): SafeHtml | '' {
  const needs = needsYouUnits(units);
  if (needs.length === 0) return '';
  return html`<section class="fb-needs" aria-label="Needs you">
    <h3>Needs you <em>${needs.length}</em></h3>
    <div class="fb-needs-grid">${needs.map((u) => renderNeed(u, busy, u.key === openKey))}</div>
  </section>`;
}

function renderNeed(u: FactoryBoardUnit, busy: boolean, open: boolean): SafeHtml {
  const kind = needKind(u);
  const disabled = busy ? 'disabled' : '';
  const openButton = (label = 'Open') => html`<button type="button" class="btn-secondary" data-unit-key="${u.key}">${label}</button>`;
  let decision: SafeHtml;
  switch (kind) {
    case 'triage':
      decision = html`<button type="button" class="btn-primary" data-fb="triage" data-action="accept" ${disabled}>Accept</button>
        <button type="button" class="btn-secondary" data-fb="triage" data-action="backlog" ${disabled}>Backlog</button>
        <button type="button" class="btn-secondary" data-fb="triage" data-action="dismiss" ${disabled}>Dismiss</button>`;
      break;
    case 'question': {
      const qs = u.detail.questions;
      decision =
        qs.length === 1 && qs[0].options.length > 0
          ? html`<span class="fb-need-q">${qs[0].question}</span>
            ${qs[0].options.map(
              (o) => html`<button type="button" class="${o === qs[0].default ? 'btn-primary' : 'btn-secondary'}" data-fb="answer-option" data-value="${o}" ${disabled}
                title="${o === qs[0].default ? 'The default' : ''}">${o}</button>`
            )}
            ${openButton('Other…')}`
          : html`<span class="fb-need-q">${qs.length} question${qs.length === 1 ? '' : 's'}</span>${openButton('Answer')}`;
      break;
    }
    case 'mockup':
      decision = html`<button type="button" class="btn-primary" data-fb="mockup-approve" ${disabled}>Build it</button>${openButton()}`;
      break;
    case 'review':
      decision = html`<button type="button" class="btn-primary" data-fb="approve" ${disabled}>Approve</button>${openButton()}`;
      break;
    default:
      decision = openButton();
  }
  return html`<article class="fb-need${open ? ' open' : ''}" data-need="${u.key}" data-need-kind="${kind}">
    <div class="fb-card-top"><span class="fo-id">${KIND_LABEL[kind]}</span><span class="fo-id">${u.isTrack ? 'Track' : u.unitId}</span><span class="fb-proj">${u.projectName}</span></div>
    <button type="button" class="fb-title fb-link" data-unit-key="${u.key}">${u.title}</button>
    <span class="fb-sub">${cardStatus(u)}</span>
    <div class="fb-acts">${decision}</div>
  </article>`;
}

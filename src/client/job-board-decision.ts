import { escapeHtml, escapeAttr } from './html-utils.js';
import { parseDecision, stripMarks, type DecisionCard } from './decision-format.js';
import type { Job, Finding } from './job-board-types.js';
import { linked, paragraphs, type JobDoc } from './job-board-docs.js';

/**
 * Rendering for the decision a parked run is waiting on, and for the review
 * gate's findings list. See `docs/job-decisions.md`.
 */

/**
 * The decision a parked run is waiting on: `job.detail` parsed
 * (decision-format.ts) with each part rendered as its own element rather than
 * printed as prose. See `docs/job-decisions.md`.
 *
 * Parsing is best-effort by design — a detail it cannot make sense of falls
 * back to the text as written, never to a wrong reading of it.
 */
export function renderDecision(
  job: Job,
  answerDrafts: Map<string, string>,
  docsCache: Map<string, JobDoc[]>
): string {
  const detail = job.detail as string;
  const parsed = parseDecision(detail);
  const head = (extra = ''): string =>
    `<div class="jb-question-label">This run stopped rather than guess${extra}</div>`;
  const form = (inner: string): string => `
    <form class="jb-answer" data-job="${escapeAttr(job.id)}">
      ${inner}
      <div class="jb-answer-actions">
        <button type="submit" class="btn-secondary">Answer &amp; continue</button>
      </div>
    </form>`;

  if (!parsed) {
    return `
      <div class="jb-question">
        ${head()}
        <div class="jb-question-text">${linked(job, plainDetail(detail), docsCache)}</div>
        ${form(`<input type="text" class="jb-answer-input" data-index="1"
                 value="${escapeAttr(answerDrafts.get(`${job.id}#1`) || '')}"
                 placeholder="Your decision…" aria-label="Answer" maxlength="500" />`)}
      </div>`;
  }

  let numbered = 0;
  const cards = parsed.cards
    .map((card) =>
      renderDecisionCard(
        job,
        card,
        card.question ? ++numbered : null,
        parsed.questionCount,
        answerDrafts,
        docsCache
      )
    )
    .join('');

  return `
    <div class="jb-question">
      ${head(parsed.questionCount > 1 ? ` · ${parsed.questionCount} questions` : '')}
      ${
        parsed.preamble.length
          ? `<div class="jb-q-preamble">${paragraphs(job, parsed.preamble, docsCache)}</div>`
          : ''
      }
      ${form(`<div class="jb-q-cards">${cards}</div>`)}
    </div>`;
}

/** One question: what is being asked, what informs it, and the box to answer in. */
function renderDecisionCard(
  job: Job,
  card: DecisionCard,
  number: number | null,
  total: number,
  answerDrafts: Map<string, string>,
  docsCache: Map<string, JobDoc[]>
): string {
  // A block that asks nothing is something the run wanted said alongside the
  // questions. It keeps its text and does not pretend to need an answer.
  if (number === null) {
    return `<div class="jb-q-note">${paragraphs(job, card.context, docsCache)}</div>`;
  }

  const part = (label: string, body: string): string => `
    <div class="jb-q-part">
      <span class="jb-q-part-label">${label}</span>
      <div class="jb-q-part-body">${body}</div>
    </div>`;

  const options = card.options
    .map(
      (option) => `
      <li class="jb-q-option">
        <span class="jb-q-opt">${escapeHtml(option.label)}</span>
        <span class="jb-q-opt-text">${linked(job, option.text, docsCache)}</span>
      </li>`
    )
    .join('');

  const rec = card.recommendation;
  const recLabel = rec
    ? `${rec.kind === 'assumes' ? 'Assumed' : 'Recommends'}${rec.option ? ` (${escapeHtml(rec.option)})` : ''}`
    : '';

  return `
    <div class="jb-q-card">
      <div class="jb-q-head">
        <span class="jb-q-num">Q${number}</span>
        <span class="jb-q-text">${linked(job, card.question, docsCache)}</span>
      </div>
      ${card.context.length ? part('Context', paragraphs(job, card.context, docsCache)) : ''}
      ${card.options.length ? part('Options', `<ul class="jb-q-options">${options}</ul>`) : ''}
      ${
        rec
          ? `<div class="jb-q-rec ${rec.kind}">
               <span class="jb-q-rec-label">${recLabel}</span>
               <span class="jb-q-rec-text">${linked(job, rec.text, docsCache)}</span>
             </div>`
          : ''
      }
      <input type="text" class="jb-answer-input" data-index="${number}"
             data-question="${escapeAttr(card.question)}"
             value="${escapeAttr(answerDrafts.get(`${job.id}#${number}`) || '')}"
             placeholder="${total > 1 ? `Your decision on Q${number}…` : 'Your decision…'}"
             aria-label="Answer to question ${number}" maxlength="500" />
    </div>`;
}

/** The detail as the model laid it out, minus the syntax it wrote it in. */
export function plainDetail(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.slice(0, line.length - line.trimStart().length) + stripMarks(line))
    .join('\n')
    .trim();
}

/**
 * The review gate: every finding with a checkbox, nothing pre-ticked. The
 * user decides what is worth acting on; the fix stage applies exactly that
 * and is told explicitly to leave the rest alone.
 */
export function renderFindings(job: Job, findings: Finding[]): string {
  if (findings.length === 0) {
    return '<div class="pw-hint">No findings.</div>';
  }
  const rows = findings
    .map((f) => {
      const where = f.file
        ? `${escapeHtml(f.file)}${f.line ? `:${f.line}` : ''}`
        : '';
      return `
      <li class="jb-finding ${f.severity}">
        <label class="jb-finding-head">
          <input type="checkbox" class="jb-finding-box" data-job="${escapeAttr(job.id)}"
                 data-finding="${escapeAttr(f.id)}" ${f.selected ? 'checked' : ''} />
          <span class="jb-sev ${f.severity}">${f.severity}</span>
          <span class="jb-finding-title">${escapeHtml(stripMarks(f.title))}</span>
          ${where ? `<code class="jb-finding-where">${where}</code>` : ''}
        </label>
        ${f.detail ? `<div class="jb-finding-detail">${escapeHtml(stripMarks(f.detail))}</div>` : ''}
        ${
          f.suggestion
            ? `<div class="jb-finding-fix"><strong>Fix:</strong> ${escapeHtml(stripMarks(f.suggestion))}</div>`
            : ''
        }
      </li>`;
    })
    .join('');

  const chosen = findings.filter((f) => f.selected).length;
  return `
    <div class="jb-findings">
      <div class="jb-findings-head">
        <span>${findings.length} finding${findings.length === 1 ? '' : 's'} — tick the ones to fix</span>
        <span class="jb-findings-count">${chosen} selected</span>
      </div>
      <ul class="jb-finding-list">${rows}</ul>
    </div>`;
}

import { escapeHtml, escapeAttr } from './html-utils.js';
import { findReferences, resolveReference } from './decision-format.js';
import type { Job } from './job-board-types.js';

/**
 * Rendering for a job's document pane and for the `§3.2` / path references a
 * parked question cites into it. See `docs/job-documents.md`.
 */

/** Mirrors JobDoc in src/server/jobs/docs.ts. */
export interface JobDoc {
  path: string;
  status: 'added' | 'edited' | 'deleted' | 'renamed' | 'unchanged';
  insertions: number;
  deletions: number;
  isSpec: boolean;
  headings: string[];
}

/** How a document row describes itself, once you know what the run did to it. */
const DOC_STATUS_LABEL: Record<JobDoc['status'], string> = {
  added: 'written by this run',
  edited: 'edited by this run',
  deleted: 'deleted by this run',
  renamed: 'renamed by this run',
  unchanged: 'read-only',
};

/** Unchanged documents past this point are folded away until asked for. */
const DOCS_SHOWN = 8;

/**
 * The documents behind this job: what its branch changed, and the markdown it
 * could have been reading.
 *
 * The two are marked differently on purpose. A changed document is something
 * the run did that the user had no way of knowing about; an unchanged one is
 * context a question cites. The unchanged tail folds away, because in a
 * docs-heavy repo it is long and nobody opens the end of it.
 *
 * The head is a disclosure control over the whole list, and the shell is
 * rendered even for an empty one: a loaded pane with no header would be a
 * pane with nothing to unfold it by. The count chip stays outside the folding
 * body, because "3 changed by this run" is the line that makes anyone open it.
 */
export function renderDocs(
  job: Job,
  docs: JobDoc[],
  docsExpanded: Set<string>,
  docsCollapsed: Set<string>,
  openDoc: Map<string, { path: string; mode: 'text' | 'diff' }>,
  docBodies: Map<string, { body: string; truncated: boolean }>
): string {
  const changed = docs.filter((d) => d.status !== 'unchanged');
  const unchanged = docs.filter((d) => d.status === 'unchanged');
  const showAll = docsExpanded.has(job.id);
  const shown = showAll ? unchanged : unchanged.slice(0, DOCS_SHOWN);
  const hidden = unchanged.length - shown.length;
  const collapsed = docsCollapsed.has(job.id);

  const rows = [...changed, ...shown]
    .map((doc) => renderDocRow(job, doc, openDoc, docBodies))
    .join('');

  const body =
    docs.length === 0
      ? '<div class="pw-hint">No documents for this job yet.</div>'
      : `<ul class="jb-doc-list">${rows}</ul>
         ${
           hidden > 0
             ? `<button type="button" class="jb-doc-more" data-job="${escapeAttr(job.id)}">
                  Show ${hidden} more document${hidden === 1 ? '' : 's'}
                </button>`
             : ''
         }`;

  // aria-expanded on its own announces a state without saying whose, so the
  // body carries an id for the head to point at.
  const bodyId = `jb-docs-body-${escapeAttr(job.id)}`;

  return `
    <div class="jb-docs${collapsed ? ' collapsed' : ''}">
      <button type="button" class="jb-docs-head" data-job="${escapeAttr(job.id)}"
              aria-expanded="${collapsed ? 'false' : 'true'}" aria-controls="${bodyId}">
        <span>Documents</span>
        <span class="jb-docs-count">${
          docs.length === 0 ? 'no documents' : `${changed.length} changed by this run`
        }</span>
        <span class="jb-chevron">${collapsed ? '▸' : '▾'}</span>
      </button>
      <div class="jb-docs-body" id="${bodyId}">${body}</div>
    </div>`;
}

function renderDocRow(
  job: Job,
  doc: JobDoc,
  openDoc: Map<string, { path: string; mode: 'text' | 'diff' }>,
  docBodies: Map<string, { body: string; truncated: boolean }>
): string {
  const open = openDoc.get(job.id);
  const isOpen = open?.path === doc.path;
  const changed = doc.status !== 'unchanged';
  const stat =
    changed && (doc.insertions || doc.deletions)
      ? `<span class="jb-doc-stat">+${doc.insertions} −${doc.deletions}</span>`
      : '';

  return `
    <li class="jb-doc ${changed ? 'changed' : 'unchanged'}${isOpen ? ' open' : ''}">
      <button type="button" class="jb-doc-row" data-job="${escapeAttr(job.id)}"
              data-path="${escapeAttr(doc.path)}">
        <span class="jb-doc-mark" aria-hidden="true">${changed ? '●' : '○'}</span>
        <span class="jb-doc-path">${escapeHtml(doc.path)}</span>
        ${doc.isSpec ? '<span class="jb-doc-tag">spec</span>' : ''}
        ${stat}
        <span class="jb-doc-status">${DOC_STATUS_LABEL[doc.status]}</span>
      </button>
      ${isOpen ? renderDocView(job, doc, open.mode, docBodies) : ''}
    </li>`;
}

function renderDocView(
  job: Job,
  doc: JobDoc,
  mode: 'text' | 'diff',
  docBodies: Map<string, { body: string; truncated: boolean }>
): string {
  const cached = docBodies.get(`${job.id}|${mode}|${doc.path}`);
  const changed = doc.status !== 'unchanged';
  const tab = (value: 'text' | 'diff', label: string): string => `
    <button type="button" class="jb-doc-tab${mode === value ? ' on' : ''}"
            data-job="${escapeAttr(job.id)}" data-path="${escapeAttr(doc.path)}"
            data-mode="${value}">${label}</button>`;

  const body = !cached
    ? '<div class="pw-hint">Loading…</div>'
    : !cached.body.trim()
      ? `<div class="pw-hint">${
          mode === 'diff'
            ? 'This run has not committed a change to this file.'
            : 'This file is empty.'
        }</div>`
      : mode === 'diff'
        ? `<pre class="jb-diff">${highlightDiff(cached.body)}</pre>`
        : `<pre class="jb-doc-body">${renderDocText(cached.body)}</pre>`;

  return `
    <div class="jb-doc-view" data-doc="${escapeAttr(doc.path)}">
      <div class="jb-doc-tabs">
        ${tab('text', 'text')}
        ${changed ? tab('diff', 'diff') : ''}
        ${cached?.truncated ? '<span class="jb-doc-trunc">truncated</span>' : ''}
      </div>
      ${body}
    </div>`;
}

/**
 * Document text, with its numbered headings marked.
 *
 * Only the headings become elements — enough for a reference to scroll to one
 * and for the eye to find it, without pretending to render markdown.
 */
function renderDocText(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      // Kept in step with headingNumbers() in src/server/jobs/docs.ts: a
      // single-level number counts only under a `#`, where the file has
      // already said the line is a heading.
      const match =
        /^\s{0,3}#{1,6}\s*§?\s*(\d+(?:\.\d+)*)[.)]?\s+\S/.exec(line) ??
        /^\s{0,3}§?\s*(\d+(?:\.\d+)+)[.)]?\s+\S/.exec(line);
      if (!match) return escapeHtml(line);
      return `<span class="jb-doc-h" data-section="${escapeAttr(match[1])}">${escapeHtml(
        line
      )}</span>`;
    })
    .join('\n');
}

export function paragraphs(job: Job, parts: string[], docs: Map<string, JobDoc[]>): string {
  return parts.map((p) => `<p>${linked(job, p, docs)}</p>`).join('');
}

/**
 * Escape a question's prose and turn its references into buttons.
 *
 * ONE helper, not a call per site: a decision card escapes in eight places,
 * and linking in only some leaves refs live in the options and dead in the
 * recommendation. Escaping and linking must happen together — splicing into
 * escaped text needs offsets the escaping has already moved — and linking
 * only ever WRAPS, so nothing the model wrote is dropped.
 */
export function linked(job: Job, raw: string, docsCache: Map<string, JobDoc[]>): string {
  const refs = findReferences(raw);
  if (refs.length === 0) return escapeHtml(raw);

  const docs = docsCache.get(job.id) || [];
  let out = '';
  let at = 0;
  for (const ref of refs) {
    out += escapeHtml(raw.slice(at, ref.start));
    const target = resolveReference(ref, docs);
    out += target
      ? `<button type="button" class="jb-ref" data-job="${escapeAttr(job.id)}"
                 data-path="${escapeAttr(target.path)}"
                 data-section="${escapeAttr(ref.kind === 'section' ? ref.value : '')}"
                 title="Open ${escapeAttr(target.path)}">${escapeHtml(ref.raw)}</button>`
      : escapeHtml(ref.raw);
    at = ref.end;
  }
  return out + escapeHtml(raw.slice(at));
}

/**
 * Which document is this job's spec, as the server marked it.
 *
 * Read from the document list rather than recomputed from the stage: whether
 * a parked design's detail holds a spec path is the server's rule
 * (routes.ts), and a second copy of that rule here is how the two drift.
 */
export function specPathOf(job: Job, docs: Map<string, JobDoc[]>): string | null {
  return (docs.get(job.id) || []).find((d) => d.isSpec)?.path ?? null;
}

/** Escape first, then colour by diff prefix — never the other way round. */
export function highlightDiff(diff: string): string {
  return escapeHtml(diff)
    .split('\n')
    .map((line) => {
      if (line.startsWith('+++') || line.startsWith('---')) return `<span class="d-meta">${line}</span>`;
      if (line.startsWith('@@')) return `<span class="d-hunk">${line}</span>`;
      if (line.startsWith('diff --git')) return `<span class="d-file">${line}</span>`;
      if (line.startsWith('+')) return `<span class="d-add">${line}</span>`;
      if (line.startsWith('-')) return `<span class="d-del">${line}</span>`;
      return line;
    })
    .join('\n');
}

export { DOC_STATUS_LABEL, DOCS_SHOWN };

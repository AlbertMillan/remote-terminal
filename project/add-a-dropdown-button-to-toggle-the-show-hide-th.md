# Collapsible document pane on a job card

## Goal

The **Documents** pane on a job card gets a disclosure control in its own header that
folds and unfolds the list in place, independently of whether the list has been loaded,
and a pane the board loaded on its own starts **folded**. Today visibility and loading
are the same thing: `View documents` fetches the list, `Hide documents` **deletes** it
from the cache, and a job parked on a question gets no hide control at all
(`renderActions()` in `src/client/job-board.ts` guards it with
`job.parkReason !== 'question'`, because dropping the list would unlink the `§3.2` and
`project/QA.md` references inside the question). So the one card where the pane is
longest — a parked decision, which eagerly loads its documents and lists every changed
file plus up to eight unchanged ones — is the one card where the pane cannot be got out
of the way, and the answer boxes sit below all of it. After this feature a parked card
reads question → answer box → a one-line `Documents · N changed by this run` header;
clicking that header (or any `§3.2` link, or `View spec`) unfolds the same list that is
already cached, so references stay clickable throughout and unfolding restores exactly
what was on screen.

## Design decisions

- **"Dropdown" is read as a disclosure control on the pane header, not a popup menu
  listing documents** — the pane's viewer opens *inside* the row (`renderDocView()`), a
  reference click scrolls to a `.jb-doc-h` heading inside it (`applyPendingAnchor()`),
  and the decision card is meant to be read alongside the document. A floating menu
  would have to reparent or duplicate the viewer and would break the scroll-to-heading
  path. Rejected: a `<select>` or popup listing paths.
- **Folding is presentational state kept separately from the cache** — a new
  `docsCollapsed: Set<string>` on `JobBoard`, beside the existing `docsExpanded`. This
  is the whole point: `toggleDocs()` currently deletes `docs`, `openDoc` and
  `docsExpanded` for the job, which is why the parked-question case had to be excluded.
  Once hiding is a class, the exclusion goes and the button is offered on every job with
  a worktree.
- **An automatically loaded pane starts folded; an asked-for one does not.**
  `loadDocsForParked()` adds each job it fetches for to `docsCollapsed`; `toggleDocs()`
  does not, because clicking `View documents` *is* the request to see them. The eager
  fetch itself is unchanged and still necessary — it is what makes the citations in a
  question resolve (`linked()` reads `this.docs`) and what tells `specPathOf()` which
  row is the spec — so folding costs the parked card nothing but shows the answer box
  first.
- **Re-folding only ever happens on first load.** `loadDocsForParked()` selects parked
  jobs with `!this.docs.has(j.id)` and refetches live jobs already in the cache, so the
  job is added to `docsCollapsed` exactly once and a poll cannot re-fold a pane the user
  has opened. Rejected: folding inside `fetchDocs()`, which the live-refetch path calls
  on every poll.
- **The count chip stays in the head, outside the folding body** — folded, the pane
  still reads `Documents · 3 changed by this run`, which is the line that makes someone
  open it. A header saying only "Documents" would hide that the run touched anything.
- **The header becomes a real `<button>`, not a `role="button"` div** — `.jb-doc-row` is
  already a `<button>` in this pane, so it matches its neighbours and gets Enter and
  Space for free. Rejected: reusing `.phase-group` markup plus `togglePhaseGroup()` from
  `src/client/phase-group.ts`. That helper toggles a class *without* re-rendering and its
  CSS hides `.phase-list` only, which would leave the pane's "Show N more documents"
  button dangling below a collapsed list; the board also re-renders wholesale on poll, so
  a class set outside `render()` would be lost.
- **Folding goes through `render()`, like every other board toggle** — `render()`
  replaces the board's HTML wholesale and `captureDrafts()` at the top of it reads
  part-written answers back out of the DOM, so a fold cannot lose a half-typed decision.
  Reaching into the DOM to hide the list directly is what CLAUDE.md warns against.
- **Two controls, one state.** The header chevron is the affordance once the pane is on
  screen; the actions-row button stays as the entry point for a job whose list has never
  been fetched (there is no pane to click). Its label reads `Hide documents` only when the
  list is loaded *and* unfolded, otherwise `View documents`. Rejected: dropping the
  actions-row button, which would leave a non-parked job with no way to ask for documents
  at all.
- **Nothing ever discards the list any more.** `toggleDocs()` fetches when the list is
  absent and flips the fold bit otherwise. Freshness is unaffected: `loadDocsForParked()`
  already refetches on every poll for a live job that is on screen, and
  `forgetCachedDetail()` still clears everything when the project changes.
- **Opening a document implicitly unfolds the pane** — cleared in `toggleDoc()`'s opening
  path *and* at the top of `openReference()`. `toggleDoc()` covers `View spec`
  (`jb-spec-btn`) and a first reference click; `openReference()` needs its own because it
  early-returns with a bare `render()` when the referenced document is already the open
  one, and that path would otherwise scroll to a heading inside a `display: none`
  container and silently do nothing. This is the normal path now, not an edge case: with
  parked panes starting folded, every `§3.2` click begins on a folded pane.
- **`renderDocs()` always renders the `.jb-docs` shell, even for an empty list** — it
  currently returns a bare `pw-hint` with no header, which would be a loaded pane with no
  chevron, and under start-folded an eagerly loaded empty list would show a stray hint
  with nothing to fold it. The hint moves inside the body and the count chip reads
  `no documents`.
- **In-memory only, not `localStorage`** — every sibling piece of board view state
  (`expanded`, `docsExpanded`, `diffs`, `findings`) is per-session and cleared on project
  switch. `pw.collapsedTracks` in `project-workspace.ts` persists because a track fold is
  a standing preference about a document; a fold on a transient job card is not.
- **The chevron glyphs are `▾`/`▸`, matching `.jb-chevron` on the job head** — the board
  already states fold with those two characters rather than a rotated icon, and the class
  is styled globally.

## Planned changes

- `src/client/job-board.ts` —
  - add `private docsCollapsed = new Set<string>()`; clear it in `forgetCachedDetail()`
    and delete the job's entry in `discard()` beside `this.docs.delete(jobId)`;
  - `loadDocsForParked()` — `this.docsCollapsed.add(job.id)` for each job in the `parked`
    set it fetched, in the same loop that already does `this.expanded.add(job.id)`;
  - `renderDocs()` — always emit the `.jb-docs` shell; add `collapsed` to its class when
    the job is in `docsCollapsed`; make the head a
    `<button type="button" class="jb-docs-head" data-job=… aria-expanded=…>` holding the
    `Documents` label, the existing `.jb-docs-count` chip and a `<span class="jb-chevron">`;
    wrap `.jb-doc-list` and the `.jb-doc-more` button in a `<div class="jb-docs-body">`;
    render the empty-list hint inside that body with the chip reading `no documents`;
  - `toggleDocs()` — fetch when `docs` has no entry for the job (and clear the job from
    `docsCollapsed`), otherwise flip its membership of `docsCollapsed`; never delete
    `docs`, `openDoc` or `docsExpanded`;
  - `toggleDoc()` — `this.docsCollapsed.delete(jobId)` on the opening path;
    `openReference()` — the same, before its already-open early return;
  - `renderActions()` — drop the `job.parkReason !== 'question'` guard on the documents
    button; label from `this.docs.has(job.id) && !this.docsCollapsed.has(job.id)`;
  - the click handler in `attach()` — route `.jb-docs-head` to `toggleDocs(...)`, beside
    the existing `.jb-docs-btn` branch.
- `src/client/styles.css` — `.jb-docs-body`; `.jb-docs.collapsed .jb-docs-body
  { display: none; }` and `.jb-docs.collapsed .jb-docs-head { border-bottom: 0; }`; give
  `.jb-docs-head` the button reset `.jb-doc-row` already uses (`width: 100%`,
  `border: none` except the bottom rule, `cursor: pointer`, `text-align: left`,
  `font: inherit`; it already sets `background: var(--bg-primary)` and its own flex
  layout) plus a `:hover` in the shape of `.jb-doc-row:hover`.
- `tests/job-board-docs-dom.test.ts` (new) — a `happy-dom` test over `JobBoard`, in the
  shape of `tests/job-overlay-dom.test.ts` (`// @vitest-environment happy-dom`, since
  `vitest.config.ts` sets `environment: 'node'`).
- `CLAUDE.md` — extend the "Reading a Job's Documents" section: an eagerly loaded pane
  starts folded, folding is a class over a cache that is never dropped, and opening a
  document or following a reference unfolds.

## Verification

- `tests/job-board-docs-dom.test.ts` (new), with `fetch` stubbed and a `#project-jobs`
  container:
  - a job parked on a question renders `.jb-docs.collapsed` with `aria-expanded="false"`
    on first load, and the documents button now renders in its actions row;
  - clicking `.jb-docs-head` drops `collapsed`, sets `aria-expanded="true"` and makes no
    second `/api/jobs/:id/docs` call; clicking again re-folds;
  - loading the board a second time does not re-fold a pane the user unfolded;
  - a job whose list comes back empty still renders a clickable header;
  - unfolding restores the same open `.jb-doc-view` that was open before the fold;
  - clicking a `.jb-ref` on a folded pane unfolds it and scrolls (`.jb-docs` has no
    `collapsed`, `.jb-doc-h` for the section is present).
- `tests/decision-format.test.ts` and `tests/job-docs.test.ts` — unchanged, but re-run:
  reference resolution reads `this.docs`, which a fold must not touch.
- By hand, on a job parked on a question: confirm the answer box is above the fold and the
  header reads its changed-file count; type half an answer, fold and unfold, and confirm
  the draft and the open document both survived; click a `§`-reference in the question and
  confirm the pane unfolds and scrolls to the heading; confirm `View spec` unfolds it too.
- `npm run build`, `npm test`, `npm run lint`.

## Out of scope

- Persisting the fold across page reloads or project switches.
- Folding the findings list, the diff pane or any other card section.
- Changing which documents the server lists, or `src/server/jobs/docs.ts` at all.
- A "collapse all documents" control across jobs, like the feature board's `Collapse all`.
- Changing what `loadDocsForParked()` fetches, or when — only whether the result starts
  folded.

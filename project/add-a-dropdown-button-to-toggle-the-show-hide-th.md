# Collapsible document pane on a job card

## Goal

The **Documents** pane on a job card can be folded and unfolded from a disclosure
control in its own header, independently of whether the list has been loaded. Today
visibility and loading are the same thing: `View documents` fetches the list,
`Hide documents` **deletes** it from the cache, and a job parked on a question gets no
hide control at all (`renderActions()` in `src/client/job-board.ts` guards it with
`job.parkReason !== 'question'`, because dropping the list would unlink the `§3.2` and
`project/QA.md` references inside the question). The result is that the one card where
the pane is longest — a parked decision, which eagerly loads its documents and lists
every changed file plus up to eight unchanged ones — is also the one card where the
pane cannot be got out of the way, and the answer boxes sit below all of it. After this
feature, every loaded pane carries a chevron in its header that folds the list in place,
keeping the cached list, the open document and the `docsExpanded` tail exactly as they
were, so references stay clickable and unfolding restores what was on screen.

## Design decisions

- **"Dropdown" is read as a disclosure control on the pane header, not a popup menu
  listing documents** — the pane's viewer opens *inside* the row (`renderDocView()`), a
  reference click scrolls to a `.jb-doc-h` heading inside it (`applyPendingAnchor()`),
  and the merge/decision card is meant to be read alongside the document. A floating
  menu would have to reparent or duplicate the viewer and would break the scroll-to-
  heading path. Rejected: a `<select>` or popup listing paths.
- **Folding is presentational state kept separately from the cache** — a new
  `docsCollapsed: Set<string>` on `JobBoard`, beside the existing `docsExpanded`. This
  is the whole point of the feature: `toggleDocs()` currently deletes `docs`, `openDoc`
  and `docsExpanded` for the job, which is why the parked-question case had to be
  excluded. Once hiding is a class, the exclusion goes and the button is offered on
  every job with a worktree.
- **The header becomes a real `<button>`, not a `role="button"` div** — `.jb-doc-row`
  is already a `<button>` in this pane, so it matches its neighbours and gets Enter and
  Space for free. Rejected: reusing `.phase-group` markup plus `togglePhaseGroup()` from
  `src/client/phase-group.ts`. That helper toggles a class *without* re-rendering and
  its CSS hides `.phase-list` only, which would leave the pane's "Show N more documents"
  button dangling below a collapsed list; the board also re-renders wholesale on poll,
  so a class set outside `render()` would be lost.
- **Folding goes through `render()`, like every other board toggle** — `render()`
  replaces the board's HTML wholesale and `captureDrafts()` at the top of it reads
  part-written answers back out of the DOM, so a fold cannot lose a half-typed decision.
  Reaching into the DOM to hide the list directly is exactly what CLAUDE.md warns
  against.
- **Two controls, one state.** The header chevron is the affordance once the pane is on
  screen; the actions-row button stays as the entry point for a job whose list has never
  been fetched (there is no pane to click). Its label reads `Hide documents` only when
  the list is loaded *and* unfolded, otherwise `View documents`. Rejected: dropping the
  actions-row button, which would leave a non-parked job with no way to ask for
  documents at all.
- **Nothing ever discards the list any more.** `toggleDocs()` fetches when the list is
  absent and flips the fold bit otherwise. Freshness is unaffected:
  `loadDocsForParked()` already refetches on every poll for a live job that is on
  screen, and `forgetCachedDetail()` still clears everything when the project changes.
- **Opening a document implicitly unfolds the pane** — `toggleDoc()` clears the job from
  `docsCollapsed`. This covers both callers that can arrive from outside the pane:
  `View spec` (`jb-spec-btn`) and a reference click (`openReference()`). Without it,
  clicking `§3.2` in a question while the pane is folded would open a row inside a
  `display: none` container, and `applyPendingAnchor()` would silently find no heading.
- **`renderDocs()` always renders the `.jb-docs` shell, even for an empty list** —
  it currently returns a bare `pw-hint` with no header, which would be a loaded pane
  with no chevron. The hint moves inside the body and the count chip reads
  `no documents`.
- **In-memory only, not `localStorage`** — every sibling piece of board view state
  (`expanded`, `docsExpanded`, `diffs`, `findings`) is per-session and cleared on
  project switch. `pw.collapsedTracks` in `project-workspace.ts` persists because a
  track fold is a standing preference about a document; a fold on a transient job card
  is not.
- **The chevron glyphs are `▾`/`▸`, matching `.jb-chevron` on the job head** — the board
  already states fold with those two characters rather than a rotated icon, and the
  class is styled globally.

## Planned changes

- `src/client/job-board.ts` —
  - add `private docsCollapsed = new Set<string>()`; clear it in
    `forgetCachedDetail()` and in `discard()` beside `this.docs.delete(jobId)`;
  - `renderDocs()` — always emit the `.jb-docs` shell; add `collapsed` to its class when
    the job is in `docsCollapsed`; make the head a
    `<button type="button" class="jb-docs-head" data-job=… aria-expanded=…>` carrying a
    `<span class="jb-chevron">`; wrap the list and the "Show N more" button in a
    `<div class="jb-docs-body">`; render the empty-list hint inside that body;
  - `toggleDocs()` — fetch when `docs` has no entry for the job (and clear the job from
    `docsCollapsed`), otherwise flip its membership of `docsCollapsed`; never delete
    `docs`, `openDoc` or `docsExpanded`;
  - `toggleDoc()` — `this.docsCollapsed.delete(jobId)` on the opening path;
  - `renderActions()` — drop the `job.parkReason !== 'question'` guard on the documents
    button; label from `this.docs.has(job.id) && !this.docsCollapsed.has(job.id)`;
  - the click handler — route `.jb-docs-head` to `toggleDocs(...)`, added beside the
    existing `.jb-docs-btn` branch and **before** the `.jb-doc-more` / `.jb-doc-row`
    branches are reached (the head is not inside a row, so ordering is only a
    readability concern).
- `src/client/styles.css` — `.jb-docs-body`; `.jb-docs.collapsed .jb-docs-body
  { display: none; }` and `.jb-docs.collapsed .jb-docs-head { border-bottom: 0; }`;
  give `.jb-docs-head` the button reset `.jb-doc-row` already uses (`width: 100%`,
  `background: var(--bg-primary)`, `border: 0` except the bottom rule, `cursor: pointer`,
  `text-align: left`, `font: inherit`) plus a hover.
- `tests/job-board-docs-dom.test.ts` (new) — a `happy-dom` test over `JobBoard`, in the
  shape of `tests/job-overlay-dom.test.ts`.
- `CLAUDE.md` — extend the "Reading a Job's Documents" section: folding is a class over
  a cache that is never dropped, and opening a document or following a reference
  unfolds.

## Verification

- `tests/job-board-docs-dom.test.ts` (new), with `fetch` stubbed and a `#project-jobs`
  container: for a job parked on a question, the documents button now renders; clicking
  the header adds `collapsed` to `.jb-docs` and leaves `/api/jobs/:id/docs` uncalled a
  second time; unfolding restores the same open `.jb-doc-view` that was open before;
  `aria-expanded` tracks the class; a job whose document list comes back empty still
  renders a clickable header.
- `tests/decision-format.test.ts` — unchanged, but re-run: reference resolution reads
  `this.docs`, which a fold must not touch.
- By hand: on a job parked on a question, type half an answer, fold the pane, unfold it,
  and confirm the draft and the open document both survived; fold the pane and click a
  `§`-reference in the question, and confirm it unfolds and scrolls to the heading;
  confirm `View spec` unfolds a folded pane.
- `npm run build`, `npm test`, `npm run lint`.

## Out of scope

- Persisting the fold across page reloads or project switches.
- Folding the findings list, the diff pane or any other card section.
- Changing which documents the server lists, or `src/server/jobs/docs.ts` at all.
- A "collapse all documents" control across jobs, like the feature board's
  `Collapse all`.
- Changing the eager fetch in `loadDocsForParked()`.

## Open questions

- **When a job parks and the board loads its documents automatically, should the new
  Documents pane start folded or unfolded?** Context: a job that stops to ask the user a
  question has its document list fetched up front, and the card then shows, in this
  order, the question and its answer box, then the Documents pane listing every file the
  run changed plus up to eight it only read. The project's `CLAUDE.md` gives the current
  reason for always showing it: "No hide for a job parked on a question: the documents
  are part of the decision, and dropping them would unlink the references in it" — the
  second half of that stops being true with this change, since folding no longer drops
  anything. (a) Start unfolded, as today, and let the user fold it — the question often
  cites those documents and they are one click away either way; (b) start folded, so the
  answer box is immediately visible and the documents open on demand. I recommend (a):
  it changes nothing about what a parked card shows today and only adds the fold, and a
  user who has not read the documents yet would not know to go looking for them behind a
  collapsed header. (b) is the better choice if the pane being in the way of the answer
  box is the actual complaint.

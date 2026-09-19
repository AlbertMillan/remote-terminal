# Reading a job's documents

A stage writes its spec — and may edit other docs under `project/` — inside the job's
**worktree**, commits them to the job branch, and then parks asking about what it wrote.
None of that is in the user's checkout, so a question citing `§3.2` used to be
unanswerable without **Take over**. Every job card now carries a document pane
(`/api/jobs/:id/docs`, `/api/jobs/:id/file`, server code in `src/server/jobs/docs.ts`).

- The list is **what the branch changed** (`git diff --numstat`, exact) **union the
  markdown in the worktree** (context a question only read). Changed rows are marked and
  lead; the unchanged tail folds after eight. `git ls-files` is called with `--cached
  --others --exclude-standard`, and the changed-set mirrors `diffAgainst()`'s fallback to
  `git diff HEAD` — without either, a doc a *running* stage just wrote is missing and a
  job before its first commit reports nothing changed, while the diff pane beside it shows
  content.
- **A parked design records its spec path** (`parkOnQuestion(job, 'design', q,
  result.specPath)`). What stops implement building off an unapproved spec is
  `specPathOf()`'s `status === 'passed'` check in `runner.ts` — that check is now the
  *only* thing standing there, not a side effect of the detail field holding a label.
- `routes.ts` resolves the diff base from **`job.baseBranch`**, not
  `currentBranch(projectCwd)`. The old fallback is what `baseBranchOf()` in the runner
  warns about: a job parked while the user switched branches was diffed — and its document
  list computed — against whatever branch they happened to be on.
- There is **one viewer**: `View spec` opens the spec's row in the pane rather than
  rendering the file a second way. Documents are read-only; an edit made here would be
  swept into the branch by the next stage's `commitAll` and land in the merge.
- `/api/jobs/:id/docs` marks the spec row itself (`isSpec`), so the client never needs its
  own copy of "which stage states mean the detail is a path". This replaced a separate
  `/api/jobs/:id/spec` route. `specPathOf()` falls back to `specSlugFor()` when the
  recorded detail is not a path — jobs parked *before* the path was recorded carry the old
  `"Needs a decision"` label, and those are exactly the ones waiting on an answer now.
- Browser-supplied paths are untrusted: `resolveInWorktree()` resolves symlinks *before*
  the containment check. A job with no worktree answers `{ docs: [] }`, never an error —
  the board still renders `done` and discarded rows.

### Folding the pane

The pane's head is a `<button class="jb-docs-head">` that folds the list away, and a pane
the board loaded on its own (`loadDocsForParked()`) **starts folded** — so a parked card
reads question → answer box → a one-line `Documents · N changed by this run`. Without it,
the longest pane on the board sat above the boxes you had to type into.

- **Folding is a class, not a delete.** `docsCollapsed` on `JobBoard` is presentational
  state beside the `docs` cache; nothing discards the list any more. `toggleDocs()` used
  to drop `docs`/`openDoc`/`docsExpanded`, which is exactly why a job parked on a question
  could not be offered a hide button at all — `linked()` and `specPathOf()` read
  `this.docs`, so dropping it unlinks every `§3.2` in the question. Now the button is
  offered on every job with a worktree, and its label reads `Hide documents` only when the
  list is loaded *and* unfolded.
- **Unfolding a cached list expands the card too.** The pane renders only inside
  `renderBody()`, which `renderJob()` emits for an expanded card, while the actions row
  renders always. A job parked at the design or merge gate is cached *and* collapsed, so
  without the `expanded.add()` its `View documents` flips its own label and puts nothing on
  screen — and the merge gate is precisely the gate that is a decision about what the
  branch changed.
- **Only the first fetch folds.** `loadDocsForParked()` selects parked jobs with
  `!this.docs.has(j.id)` and refetches live ones already cached, so the add to
  `docsCollapsed` happens once. Folding inside `fetchDocs()` instead would let a poll
  re-fold a pane the user had just opened.
- **Anything that opens a document unfolds the pane** — `toggleDoc()`'s opening path *and*
  the top of `openReference()`. `openReference()` needs its own: it early-returns with a
  bare `render()` when the referenced document is already open, and `applyPendingAnchor()`
  would then scroll to a heading inside a `display: none` container and silently do
  nothing. With parked panes starting folded, that is every reference click, not an edge.
- Folding goes through `render()` like every other board toggle, so `captureDrafts()` runs
  and a half-typed decision survives it. `renderDocs()` always emits the `.jb-docs` shell,
  even for an empty list — a loaded pane with no header has nothing to unfold it by.
- That same wholesale `render()` destroys the head button on its own click, so the fold
  path records `refocusDocsHead` and `applyRefocusDocsHead()` puts focus back — otherwise
  focus falls to `<body>` and a keyboard user cannot press Space twice to fold and unfold.
  Only the head sets it; moving focus off the actions-row button would be a surprise.

Covered by `tests/job-board-docs-dom.test.ts`.

### Linking the references in a question

`findReferences()` / `resolveReference()` in `decision-format.ts` turn `§3.2` and
`project/QA.md` into buttons that open the pane at that heading.

- The ladder is **unique among the documents this job changed → unique among all of them →
  plain text**. Global uniqueness alone links almost nothing, because `3.2` is a common
  heading; guessing between two is worse than not linking. Identifiers
  (`MAX_HISTORICAL_DAYS`) are never matched — there is no target for them.
- Linking only ever **wraps**, and runs through one `linked()` helper in `job-board.ts`
  rather than at each of the ~8 `escapeHtml()` sites, or references would be clickable in
  the options and dead in the recommendation. The escape and the splice have to happen
  together: escaping first moves the offsets `findReferences` returned.
- `headingNumbers()` (server) and `renderDocText()` (client) must stay in step — the
  server decides what a reference *can* resolve to, the client renders what it scrolls to.
  A single-level number counts only under a `#`; `3 files changed` is not a heading.

Covered by `tests/job-docs.test.ts` (against a real git repo) and
`tests/decision-format.test.ts`.

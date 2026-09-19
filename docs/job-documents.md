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

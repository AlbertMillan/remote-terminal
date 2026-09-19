# Job document visibility

## Goal

A job that parks on an open question asks about documents the user cannot read.
The design stage writes its spec — and may edit any other doc under `project/` —
inside the job's worktree under `~/.claude-remote/worktrees/`, commits it, and
then parks. The board shows the question and nothing else: `View spec` is gated
on the design stage being `passed`, which a parked stage by definition is not,
and `View diff` is gated on `implement` having passed. So the user answers a
question that cites `§3.2` of a document that exists only on a branch they have
never seen, with no way to read it short of **Take over** into a terminal.

After this feature, every job card exposes the documents behind its question:
the spec it just wrote, every file the branch changed, and the docs it read for
context — readable as text or as this job's diff, without leaving the board.
References the question makes to those documents (`§3.2`, `project/QA.md`) are
clickable where they resolve unambiguously.

## Design decisions

- **`parkOnQuestion` records the spec path, and the document list marks it as
  the spec whether the design passed or parked** — the spec always exists at park time
  (`design.ts` throws without it, `runner.ts` commits before parking), so the
  gate was never protecting against missing data. It could not simply be
  deleted because `stage.detail` is overloaded: `passed` stores the spec path,
  a park stores the label `"Needs a decision"`. Passing `result.specPath` as
  the park's `stageDetail` makes the field mean one thing.
- **`specPathOf()` keeps its explicit `status === 'passed'` check, now
  deliberately** — it decides whether **implement** may run, and implement must
  never build off a spec the user has not approved. Today that check is
  load-bearing by accident (the detail happens not to be a path); after this
  change it is load-bearing on purpose. Rejected: deriving the path in the
  route via `specSlugFor()`, which duplicates knowledge of where specs live.
- **The diff base becomes the job's recorded `baseBranch`, not the project's
  current branch.** `routes.ts` computes it as `currentBranch(projectCwd)`,
  which is exactly the fallback `baseBranchOf()` in `runner.ts` warns against:
  a job that sat parked while the user switched branches is measured against
  the wrong base. The runner is careful and the route is not, and the document
  list is computed from the same base — so a wrong changed-set would be
  reported with no sign anything was off. The route prefers `job.baseBranch`
  and only then falls back, matching the runner.
- **The document list is the union of "changed by this branch" and "markdown
  in the worktree"** — the first comes from `git diff --numstat` and is exact;
  the second is the context the question cites, which is frequently a doc the
  run only *read*. Rejected: listing `project/**` only, which misses a PRD
  living at the repo root or under `docs/`. Changed files sort first and are
  marked; the unchanged tail collapses after the first eight.
- **The listing includes untracked-but-not-ignored files
  (`git ls-files --cached --others --exclude-standard`), and the changed-set
  mirrors `diffAgainst()`'s fallback to `git diff HEAD`** — `ls-files` alone
  lists tracked files only, so a doc a *running* stage has just written would
  be missing, and a job before its first commit would report nothing changed.
  The two panes must not disagree about what this branch did.
- **Read-only.** Editing a doc from the board would write into the worktree,
  where the next stage's `commitAll` would sweep it into the branch and the
  merge would land it — an edit the user made in a "viewer" silently becoming a
  commit. Take over remains the way to change something.
- **Rendered in `<pre>`, not as markdown** — the client has never had a
  markdown renderer and this does not justify adding one, the same call
  `decision-format.ts` made. Structure comes from the file list and the
  `text | diff` toggle, not from typography.
- **Per-document `text | diff` toggle** — for a doc the run edited, "what does
  §3.2 say now" and "what did this run change about §3.2" are different
  questions, and answering the park usually needs both. `diff` reuses
  `highlightDiff()`.
- **`View spec` becomes a shortcut into the pane, not a second viewer** — once
  the pane lists every document, a separate spec block would be two surfaces
  showing one file, drifting apart the first time either changes. The button
  opens the pane at the spec's row.
- **The Projects tab reuses `/api/projects/detail?cwd=&feature=`, which
  already returns the spec's content and has no client consumer at all.** The
  endpoint resolves the path through the registry guard and `readSpec()`; the
  `spec` chip just needs to call it. Rejected: a new `GET /api/projects/file`
  plus generalising `resolveSpecPath()` into a shared `resolveInside()` — a new
  public route and a refactor to duplicate a route that already exists.
- **The job reader does its own containment** — the path round-trips through
  the browser, so it is untrusted input and is resolved and asserted inside the
  worktree before any read, the same stance `history-delete.ts` takes.
- **Reference linking resolves on a precedence ladder and degrades to plain
  text** — `§` followed by digits and dots is looked up against a heading index
  built from the job's documents: unique among the documents *this job changed*
  wins; else unique among all of them; else it renders as written. A rule that
  only linked on global uniqueness would link almost nothing in a docs-heavy
  repo, since `3.2` is a common heading — correct, but the useless kind of
  safe. No picker and no best guess at any rung. Path-like tokens resolve the
  same way against real files. Identifiers such as `MAX_HISTORICAL_DAYS` are
  explicitly not linked: there is no reliable target, and a wrong jump is worse
  than none.
- **Linking wraps, never removes, and goes through a single `text()` helper** —
  `renderDecisionCard` and `paragraphs()` call `escapeHtml()` at roughly eight
  separate sites (question, each context paragraph, each option label and text,
  the recommendation), so linking has to replace all of them at once or refs
  become clickable in the options and dead in the recommendation. One
  escape-then-link helper is substituted everywhere. Because it only wraps, the
  existing property that nothing the model wrote is dropped extends to it: the
  plain-text projection of the rendered output equals the input.
- **Opening a document re-renders rather than patching the DOM** —
  `captureDrafts()` already runs at the top of `render()`, so a toggle that
  goes through `render()` (as `toggleSpec` does) preserves a part-written
  answer for free. Reaching into the DOM directly to expand a row is what would
  break it.
- **A job with no worktree answers with an empty list, not an error** — a
  `done` or discarded job has had its worktree removed, and the board still
  renders those rows. `mode=diff` on an untracked file likewise returns an
  empty diff with the file's text still available.

## Planned changes

- `src/server/jobs/runner.ts` — pass `result.specPath` as `parkOnQuestion`'s
  `stageDetail` for the design park; comment `specPathOf()`'s status check as
  the implement guard it now solely is.
- `src/server/jobs/routes.ts` — `baseBranchFor` prefers `job.baseBranch`; new
  `GET /api/jobs/:id/docs` (list with per-file `status`/`insertions`/
  `deletions`, and `isSpec` on the spec's row) and
  `GET /api/jobs/:id/file?path=&mode=` (`text` | `diff`), both path-contained
  and size-capped like `MAX_DIFF_CHARS`, both empty-safe for a job with no
  worktree. `/api/jobs/:id/spec` is **removed**: with the pane serving every
  document, it was a second route for one file, and `isSpec` keeps the rule
  about which stage states carry a spec path on the server where it belongs.
- `src/server/jobs/worktree.ts` — `diffNumstat(worktreePath, baseBranch)`
  returning per-file `{ path, insertions, deletions, status }` with the same
  `git diff HEAD` fallback `diffAgainst()` uses, and `fileDiff(worktreePath,
  baseBranch, path)` for one file.
- `src/server/jobs/docs.ts` (new) — assemble the document list: the numstat
  changed-set union `git ls-files --cached --others --exclude-standard '*.md'`,
  changed first, plus the heading index used by reference linking.
- `src/client/job-board.ts` — render the document pane, its rows and the
  expanded viewer; fetch and cache per job; drop the `implement`-passed
  condition on `View diff` and repoint `View spec` at the pane; keep every
  toggle going through `render()`.
- `src/client/decision-format.ts` — export the reference tokenizer
  (`findReferences(text)`) so linking is testable independently of rendering.
- `src/client/project-workspace.ts` — the `spec` chip becomes a button that
  fetches `/api/projects/detail?cwd=&feature=` and shows the spec inline.
- `src/client/styles.css` — document list rows, changed/unchanged marks, the
  expanded viewer, reference-link styling.
- `CLAUDE.md` — a section recording the `needs_decision` spec-path contract,
  the base-branch rule, and the linking ladder.

## Verification

- `tests/job-docs.test.ts` (new) — against a scratch repo: the list marks
  added/edited/unchanged correctly, includes an untracked doc, excludes a
  gitignored one, is non-empty before the first commit, and returns empty for a
  job with no worktree; `..`, absolute paths and symlinks out of the worktree
  are refused.
- `tests/job-gates.test.ts` — extend: a design park records the spec path, the
  spec route serves it, and `specPathOf()` still returns `null` so implement
  cannot run.
- `tests/decision-format.test.ts` — extend: `§3.2` unique to a changed doc
  links to it even when another doc shares the heading; unique nowhere stays
  plain; `MAX_HISTORICAL_DAYS` never links; and the plain-text projection of a
  linked render equals the input.
- By hand: dispatch a feature whose design parks on a question, confirm the
  spec and both edited and read-only docs are readable from the card, that a
  `§`-ref jumps to its heading, and that a part-typed answer survives opening a
  document.
- `npm run build`, `npm test`, `npm run lint`.

## Out of scope

- **Changing any stage's prompt.** A question could be made self-contained by
  telling the design pass to quote what it cites; that was considered and
  deliberately left out, so questions keep citing sections by number and the
  reader is the whole remedy.
- Editing documents from the board.
- A markdown renderer.
- Searching documents across jobs or projects.
- Resolving references for the **Take over** terminal path.
- Changing which documents a stage is allowed to write.

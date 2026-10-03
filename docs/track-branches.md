# Track branches

A track can own a git branch and worktree while it is being implemented, so that
everything the track did can later be landed, or deleted, as one unit. The spec is
`project/track-branches-and-delete.md`; this doc records how it works and why.
Code: `src/server/projects/track-branches.ts`, the merge stage
(`src/server/jobs/stages/merge.ts`), the runner's `trackBaseFor()`, and the board and
new-session picker on the client.

## Why

Job-built work was always attributable: a job lives in its own worktree and branch until
a `--no-ff` merge. Session-built work wasn't. A session edits whatever the project has
checked out, and nothing ties a commit or an uncommitted edit to a track. The Usage
visibility track (2026-09-19) had to be undone by rewinding a Claude Code checkpoint,
restoring PROJECT.md and removing a folder by hand.

The general version of this split, and the rules for new features that touch it, is in
`change-provenance.md`.

## The model

**A track's plan lives where its work lives.**

| Track state | Where its plan lives |
|---|---|
| Backlog (no branch) | Main's `PROJECT.md` and `project/` |
| In progress (unlanded branch) | Only the track branch: its section and its specs |
| Landed | Main again, put back by Land |

- **Backlog planning on main.** Writing down an idea mustn't create a worktree or
  leave anything to clean up, so a track with no branch is planned in the main
  checkout, hand edits included.
- **Implementation.** The track gets `track/<slug>-<id8>` and a worktree at
  `~/.claude-remote/worktrees/tracks/<row id>`. The branch is created the first time
  implementation starts:
  - **Open session** on the track heading;
  - picking the track in the **new-session dialog**. Its default is "No track", so
    planning and unrelated sessions see no change. The picker (`src/client/track-picker.ts`)
    only uses a list for the directory it was loaded for, and hides the old one as soon as
    the field changes: loading takes up to a second, and Create in that window once opened a
    session in the previous project's track;
  - **dispatching a job** for one of the track's features (`trackBaseFor()` in
    `runner.ts`). Ad-hoc jobs, and features no longer in PROJECT.md, still branch from
    the current branch.

**Why the plan moves.** Until 2026-10 main's PROJECT.md was the only authoritative copy
and the worktree held only ticks, meeting at Land. That split caused two of four Land
failures and both lost ticks reviewed on 2026-10-01: a heading `ensureTrackBranch` wrote
on main and never committed made claude-remote block its own Land with a bare
"uncommitted changes", and features added on main after branching had no worktree copy
for the tick sync to read. The spec is `project/track-plan-in-branch.md`.

**Moving a section off main** (`moveSectionOffMain` in `src/server/projects/track-plan.ts`)
happens when `ensureTrackBranch` creates the branch — Open session, the picker, dispatch
and Branch now all go through it. Two steps, in this order:

1. **Into the worktree.** Main's *working* copy of the section (so uncommitted lines come
   along) is written into the worktree's PROJECT.md, with the track's specs that are
   uncommitted on main, and committed on the track branch. A track with no heading yet
   gets its heading there, never on main.
2. **Off main.** One commit removes the section, and the specs that only this track's
   lines link to. It is built from HEAD's PROJECT.md through a temporary index
   (`GIT_INDEX_FILE`), so anything staged stays staged and out of it; the real index is
   then updated only for paths where it still matched HEAD. The working copy drops the
   section separately, keeping its other edits. Never pushed.

Worktree first: a failed step 2 leaves the plan in both places, which is handled
("Both copies"); main first would leave a window with the plan nowhere. A spec that
another section (on main, or in another track's worktree) links to stays on main.

A spec leaves main only once the worktree holds **main's** content: copied by this move,
or the same text already. When the track has revised its own copy and main's differs
(Move into branch, the migration), main's stays and is reported (`specsKept`). Removing
it would delete main's version, uncommitted edits or an untracked file with no history,
with nowhere to recover it from.

**Reading and writing.** `readProjectPlan()` (`project-plan.ts`) is main's doc with
each in-progress track's section taken from its worktree. The board, `trackOfFeature`
(dispatch), attribution and Delete read through it. A branched track whose worktree has
no section shows empty with a warning, never main's stale copy.

- **Board writes** go to the file that holds the feature or track (`planFileFor`). The
  `revision` is per file: each branched track carries its own on the board, and the
  routes check it against the file they write. Moving a feature between files is
  refused. Worktree writes stay uncommitted; Land and the next job merge into the track
  commit them (`commitWorktreePlanning`), since that worktree belongs to the track and
  never pushes.
- **Worktree writes take the project lock** (try-only, so a busy project answers 409
  with the holder's name). Land reads the worktree's section and then resets the file to
  its merge-base; a tick written in between would be overwritten without a trace. Main's
  file needs no lock, since Land leaves backlog edits alone. The client tells this 409
  from a stale revision by the response's `conflict` flag.
- **Ids** are generated against main plus every unlanded worktree (`allFeatureIds`).

**Specs.** The board's spec view reads the track worktree's copy when the track has one
and the file exists there (`readSpecForTrack`), and falls back to main's otherwise.

### Both copies

A session on main can still write `## Track: X` for an in-progress track, and a failed
move or the migration leaves one. The board shows the worktree's section with an "also
has lines on main · Move into branch" button (`POST /api/projects/track/move-into-branch`),
which re-runs the move for those lines, the worktree's line winning by id. Land merges
both copies anyway, so a line written on main is never lost.

**Migration.** At server start `migrateBranchedPlans()` moves the section of each track
branched before this model (`track_branches.plan_in_branch = 0`, migration
`016_track_plan_in_branch`). Main's lines win there, since main was authoritative then,
but the worktree's further-along ticks are kept. The row is then flagged, after any
attempt: a retry would let main win again over whatever was edited in the worktree since.
A failure is logged and leaves a "both copies" track.

Rows created by `ensureTrackBranch` are flagged from the start. A flagged track whose
section shows up on main again had it written there after branching; the worktree is
authoritative for it, so the migration leaves it to Move into branch and Land, which
merge with the worktree winning. Without the flag, every restart moved such a track with
main winning and reverted the worktree's own edits.

## Jobs inside a track

A job's recorded `baseBranch` is the track branch. Diff, review and integrate already
work against `baseBranch`, so they needed no change. The merge stage changed:

- **Where it merges.** A worktree can't check out a branch another worktree holds, so
  the merge runs where the base is checked out: the project for main, the track's
  worktree for a track (`mergeCwd`).
- **Clean tree.** The clean-tree rule applies there too, except that uncommitted
  planning files (board ticks, a session's spec edits) are committed in the worktree
  first. Uncommitted code still blocks the job's merge, with the worktree named in the
  error.
- **No push.** Track branches are local. Merges into them are never pushed; only Land
  pushes.
- **Rebuild ticks the worktree.** For a job whose base is a track branch, the feature
  is ticked in the worktree's PROJECT.md and committed there.

**Every merge records its sha**: `jobs.merge_sha` from the merge stage, and
`track_branches.merge_sha` from Land. The message `Merge job: <title>` is shared by any
two jobs with the same title, so it can't identify the commit Delete track has to
revert.

## Storage

`track_branches` in `sessions.db` (migration `014_track_branches`) is keyed by project
path (`pathKey`) and track name. Tracks have no id in the PROJECT.md format.

- **Uniqueness.** It is a **partial** index: unique only among rows with no `landed_at`.
  A landed row is kept for its `merge_sha`, because deleting the track later has to
  revert it. Reopening the track after a land starts a new row. The spec's plain
  `UNIQUE` would have made reopening impossible.
- **Renames.** Renaming a track heading by hand orphans its row, and the board simply
  stops showing a branch for it. There is no rename action on the board yet, so none
  updates the row. Detecting and offering to delete orphaned rows belongs with Delete
  track (`f-nk734f`).

## Land

Land is refused (409) unless:

- no job for the track is queued, running or parked;
- no live session has its cwd inside the worktree. On Windows an open shell holds the
  directory, and `git worktree remove` would fail half-way;
- the project is on the track's base branch;
- the worktree holds no uncommitted code. Uncommitted planning files there
  (PROJECT.md, `project/*.md` outside `project/reviews/`) are committed on the track
  branch first;
- main holds no uncommitted code: code edited on main may be this track's work.
  Uncommitted backlog planning, and a tracked session log (worktree sessions are
  logged into main's copy, `session-log-feature.md` §5a), are let through and left
  uncommitted and unpushed;
- nothing is staged on main, since `git merge` refuses then.

Every dirty refusal names the files (`statusEntries`, every untracked file listed).

It then puts the section back on main (`returnSectionToMain`): one commit through the
temporary index of HEAD's PROJECT.md plus the worktree's section — merged by id with any
section main also has, the worktree's line winning and nothing dropped, or appended
after main's last section — plus the specs it links to that HEAD lacks. The working copy
gets the same section and keeps the backlog edits. This runs **before** the merge: the
move took those specs off main, so a spec the track revised would otherwise be a
modify/delete conflict, and one it didn't would be deleted by the merge. Then the
branch's PROJECT.md is reset to its merge-base, `git merge --no-ff`
(`Merge track: <name>`) runs, `merge_sha` is recorded, it pushes when there is a remote,
and removes the worktree and the branch label.

After a successful land the route rebuilds the main checkout (`project-build.ts`):
`npm run build` when `package.json` declares a `build` script, nothing otherwise. It
runs **outside** the project lock, since a build touches no git state and holding the
lock for minutes would refuse every other track operation. A failed build does not undo
the land; its output tail is appended to the Land message. Nothing is restarted — for
claude-remote itself the new `dist/` takes effect on the next server restart.

A merge conflict aborts the merge and leaves both checkouts as they were. That includes
taking back the plan commit on main (`git reset` to before it, which is safe because
nothing was staged, and the working files written back), and the commit that reset the
branch's PROJECT.md: without that rollback the next Land would read the reset copy, so
the track's section would be lost for good. The fix for a conflict is to merge the base into
the track in its worktree, resolve there, and land again.

A worktree folder that has gone missing is re-attached to its branch before Land, as
`ensureTrackBranch` does, rather than failing with a 500.

## Dependencies

The spec is `project/worktree-dependencies.md`. Code: `src/server/projects/project-deps.ts`,
`removeWorktree` and `sweepLeftoverWorktrees` in `src/server/jobs/worktree.ts`.

**Each worktree installs its own, from its lockfile** (`npm ci`, `pnpm install
--frozen-lockfile` or `yarn install --frozen-lockfile`, all `--prefer-offline`; nothing
without a lockfile). Never a link to the main checkout's copy: agents did that by hand
twice (2026-09-25, 2026-09-29), and it is dangerous. A worktree holding a `node_modules`
junction to a target folder, removed five ways (2026-10-02, Git 2.39.1 for Windows,
Node 20.18):

| How the worktree was removed | Target |
|---|---|
| `git worktree remove` | **emptied** |
| `git worktree remove --force` | **emptied** |
| Node `fs.rmSync(path, { recursive: true })` | intact |
| PowerShell 5.1 `Remove-Item -Recurse -Force` | intact |
| Git Bash `rm -rf` | intact |

`git status` shows such a worktree as clean, so nothing warned before Land, Delete or
Discard emptied main's `node_modules`.

**Cost.** Measured 2026-10-03 in this track's worktree: `npm ci --prefer-offline
--no-audit --no-fund` took **21 s** (291 packages) with a warm npm cache.
`better-sqlite3` and `node-pty` used prebuilt binaries, so nothing compiled.

**When it runs.**

- **Track worktrees:** when a session opens there and `node_modules` is missing. Open
  session and the new-session picker call `POST /api/projects/track/branch`, which
  answers `needsInstall`. They then wait on `POST /api/projects/track/install` with
  "Installing dependencies…" before creating the session, so no agent in it can start a
  second install into the same folder. The install route takes the worktree from the
  track's row, never from the browser, and concurrent calls for one folder share one
  install. Not at branch creation: dispatch creates track branches too, and its job never
  uses them. A failed install still opens the session, with the failure written at the
  top of its terminal (client-side, never sent to the PTY). A failed install removes its
  partial `node_modules`, so the next session opened there tries again.
- **Job worktrees:** in the design stage, right after the worktree exists, and on every
  design pass that finds `node_modules` missing (a retried job's worktree is already
  recorded). It counts against `jobs.stageTimeoutMs`. A failure fails the stage with
  the tail of the installer's output, and nothing retries it automatically. A cancel kills
  the installer's process tree and waits for it before the stage unwinds, so teardown
  never races npm writing into the folder.

**Teardown never follows a link.** `removeWorktree`, before git:

1. Remove the worktree's `node_modules` (`fs/promises` `rm`). It removes a junction
   itself, never its target, and spares git deleting thousands of files one by one.
2. Walk the rest (skipping `.git`) with `lstat`, unlinking each symlink or junction, and
   log each one. A folder or entry it can't read counts as a link left: it might hide
   one, so the walk fails closed.
3. `git worktree remove --force`, only if no link is left. Git is never handed a tree
   that still holds a link.

Every step is async. The teardown runs on the server's event loop, and a synchronous
`rmSync` of a real `node_modules` (11,791 files) blocked every live terminal for 1.7 s.
The boot sweep stays synchronous, since it runs before the server listens.

**A link left behind is reported, and the record kept.** `removeWorktree` returns
`linksLeft`. When it is non-empty the worktree is still registered and on disk, so every
caller keeps what would let the teardown run again:

- Cancel keeps the job's `worktreePath` and says why in its detail, and so does the
  merge stage's teardown;
- Discard refuses with a 409 naming the links, and keeps the row;
- Delete track keeps its unlanded row and names the leftover path (as for a busy folder);
- Land stands (the merge is done), and its message names the worktree and the link and
  says to remove them, since nothing else records them.

**Land and Delete track refuse while an install is running** in the track's worktree
(`isInstalling`). During Open session's wait no session exists yet, so the
live-session check can't see it, and the teardown would delete `node_modules` under a
running npm.

The boot sweep also removes a deregistered folder holding only `node_modules` (and
session-log stubs): a busy teardown can leave one, and without this it was kept forever.
It removes `node_modules` with `rmSync` first.

## One track operation at a time

`src/server/projects/project-lock.ts` allows one of these at a time per project: Land,
Delete track, Branch now, and the merge stage when it merges into a track branch. Each
checks the repository's state, then acts on it over many git calls. Two at once pass
their checks and then undo each other's work: a double-clicked Delete reverts twice, or
a job approved at its merge gate merges into a worktree its track's Land is removing.

The lock is **try-acquire, never wait.** A second caller is refused with what holds the
lock: a 409 from a route, or a failed stage that can be retried from the merge. A waiting
lock would deadlock: Delete holds it while `cancelJob` waits for a running stage to stop,
and a merge stage waiting on the same lock would never stop. Inside the lock, the merge
also checks again that its track branch still exists, so a track landed or deleted while
the job waited fails with that reason instead of merging into a removed folder.

## Delete track

`src/server/projects/track-delete.ts` and `src/client/track-delete-dialog.ts`. It works
in two calls:

- `GET /api/projects/track/delete-plan` returns everything the delete would do, plus a
  token. The token hashes the PROJECT.md revision, HEAD, the track's jobs (id, status,
  updated) and its branch rows.
- `DELETE /api/projects/track` sends the token back, with the reverts and specs the user
  left ticked. It re-plans and returns 409 if the token no longer matches.

**Attribution comes only from records.** A merge is reverted only when it can be tied
to the track exactly. Code a session wrote on main without a branch is only reported
(`unattributed`). Guessing at that code is `f-4blxce`'s job, and a guess is never
ticked by default.

- **Which merges.** A landed track's `merge_sha`, and a job's `merge_sha` when it merged
  straight into main. Jobs that merged into one of the track's own branches are covered
  by the track's merge, or disappear with an unlanded branch.
- **Finding a merge by its trailers.** Discarding a done job deletes its row and its
  `merge_sha` with it, and that is the normal end of a job's life. So every job merge
  also carries `Job-Id: <id>` and, for a feature's job, `Feature: <f-id>` in its commit
  message (`src/server/jobs/merge-trailers.ts`). A job row without a sha is found by its
  `Job-Id`. Every merge carrying one of the track's feature ids is the track's: that
  includes discarded jobs, and earlier runs of a feature that has a job now. A feature id
  is unique, so this needs no uniqueness check.
- **Finding a merge by its message.** A merge from before trailers existed falls back to
  its exact subject, `Merge job: <title>`, used only when exactly one merge on the
  branch carries it **and has no trailer**. A merge with a trailer is recorded as some
  job's, so a same-titled feature in another track never matches it by title.
- **First-parent only.** The trailer and subject lookups read
  `git log --first-parent --merges`. A job merged into a track branch is reachable from
  main once the track lands, and reverting it on top of the land would revert it twice.
- **Skipped merges** are listed under "Revert by hand": two merges sharing the subject,
  two carrying one job id, a merge not on the current branch, or a job whose base isn't
  the checked-out branch.

**Step order** (the comment on `executeTrackDelete` has the same list):

1. Re-plan and compare tokens.
2. Preflight: reverting needs a clean main checkout.
3. Cancel live jobs. This is the only step before a revert can fail, and a cancelled job
   can still be discarded.
4. `git revert --no-commit`, `-m 1` for merges, newest first by `rev-list --topo-order`.
   On a conflict: `revert --abort`, then `reset --hard` to the preflight HEAD, which is
   safe because step 2 guaranteed there was nothing uncommitted. Return 409 with the
   conflicting files.
5. Close sessions in the track worktree, discard the jobs, remove the worktree and
   branch, and delete the track's `track_branches` rows. If the worktree or branch can't
   be removed (on Windows a held file handle is enough), the unlanded row is **kept**.
   Dropping it would leave a worktree on disk that nothing records. Kept, it shows under
   "Branches with no matching track" and Delete can run again; the result names the
   leftover path.
6. Remove the track from PROJECT.md (`removeTrack`), delete the ticked specs, and
   remove the SESSION-LOG phase group (`removePhaseGroup`, matched on label **and**
   source).
7. Commit only if something was reverted: one commit, `Delete track: <name>`. It is
   never pushed. Each path is staged separately, because `git add` rejects a whole call
   when any pathspec matches nothing, which a deleted spec that was never committed does.

**In-progress tracks.** Their plan is on the branch, so tearing down the worktree and
branch removes it; main is untouched. Only a "both copies" section on main is removed,
as a backlog track's would be (`inDoc`, `mainLines`). The plan's features, used to find
jobs and merges, come from both copies.

**The spec rule** applies only to specs on main; a spec on the track branch goes with the
branch.

| Spec | Default |
|---|---|
| committed and clean | delete (recoverable from git) |
| never committed, and neither were the track's lines | delete (the whole plan was a draft) |
| never committed, but the lines were | keep, offered unticked |
| committed, with local edits | keep, offered unticked |

A spec is never offered while something outside the track references it: another
feature's line, a tracked file (`git grep -F`), another SESSION-LOG group's `source`, or
another job's design spec.

**Branches with no matching track.** An unlanded row whose heading is gone (renamed or
removed by hand) is listed under "Branches with no matching track" on the board, with
Delete. The plan works without any features.

**The per-feature ×** is hidden on branched tracks. Removing one line from a track whose
code sits on a branch would suggest the code went too.

## Work on main outside any branch (a guess)

`src/server/projects/track-attribution.ts`. The agent rule below can't stop a session
from editing a track's code in the main checkout. This part notices when one did. It is
a **guess**, and every surface treats it as one:

- the board shows a count of **uncommitted files** only. Guessed commits alone would badge
  every track with history from before track branches existed (seven of this repo's own),
  and Branch now can't move a commit anyway;
- Branch now asks for the file list to be confirmed;
- Delete track offers these items **unticked**.

**Which sessions.** A session counts as the track's when either:

- it is in the `sessionIds` of the track's SESSION-LOG phase group, or
- its transcript wrote one of the track's feature ids into a PROJECT.md. That covers a
  Write or Edit of the file, and a `Bash`/`PowerShell` command that names `PROJECT.md`,
  which is how the Usage visibility session added its track (`cat >> PROJECT.md`).

Transcripts are read from the Claude Code folder for the project cwd (every
non-alphanumeric character becomes `-`). Discovery's `transcriptPaths` isn't used,
because it is capped at 5.

**What gets guessed.**

- **Files:** paths those sessions wrote with Write, Edit, MultiEdit or NotebookEdit,
  minus PROJECT.md, `project/**` and the session log. Only paths that are still modified
  or untracked on main count, so anything since restored (a rewound checkpoint, say)
  drops out.
- **Commits:** first-parent, non-merge commits made in a session's time window that
  touch one of those paths. First-parent means a job's branch commits are never
  guessed; the job's merge covers them.

**Blind spot.** Files changed through a shell (`sed -i`, `cat >`, a script) are
invisible.

**Status must list every untracked file** (`gitStatusEntries(cwd, { allUntracked: true })`).
By default git collapses a new directory to one `?? dir/` entry. That hides every file
in it from a per-file match, so Branch now would leave them behind and Delete's clean
check would ask about a directory instead.

**Cost.** Each transcript is cached by size and read incrementally. Only appended whole
lines are parsed, cut at the last newline byte, which can never fall inside a multi-byte
UTF-8 character. On this repo (64 transcripts, 50 MB) the first scan took about 270 ms
and later ones about 50 ms. The board fetches `GET /api/projects/unbranched-work` once
per render of a project, and re-renders when the result arrives.

**Branch now** (`POST /api/projects/track/branch-now`) moves only files in the server's
own guess, so a request can't move an arbitrary path. Every file is copied into the new
worktree before any is restored on main. Commits already on main aren't moved (that
would rewrite main); Delete offers them instead.

**In Delete track**, ticked guessed files are snapshotted, then restored to HEAD (or
deleted, if untracked) *before* the reverts. They don't block the clean-checkout check.
If a revert conflicts, the snapshots are written back after the `reset --hard`.

## The agent rule (global CLAUDE.md)

The picker and Open session only help when they're used. A session started in the main
checkout can still edit a track's code there. The global `~/.claude/CLAUDE.md` carries
this rule, in its "Project workspace" section (added 2026-09-24, flipped 2026-10-01 when
plans moved into track branches). It lives outside this repo, so a change here has to
be copied there by hand:

> **Track work happens in the track's worktree (claude-remote).** Plan a *backlog* track
> (one with no branch) in the main checkout. Once a track has a branch, its plan lives
> in its worktree (`~/.claude-remote/worktrees/tracks/…`): write its `PROJECT.md` lines,
> ticks and `project/*.md` specs there, and never add `## Track:` on main for it. Before
> editing *code* for a track's feature, check that the cwd is that track's worktree. If
> you are in the main checkout, stop and ask: code written there can't be attributed to
> the track, so deleting the track later can't remove it. Landing the track puts its
> plan back on main.

The rule is advisory. Detecting work that lands on main anyway is `f-4blxce`.

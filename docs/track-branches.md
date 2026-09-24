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

## The model

**Planning on main, implementation in the worktree.**

- **Planning.** PROJECT.md lines and `project/*.md` specs are written in the main
  checkout, however they are written, hand edits included. Delete track can always
  remove them.
- **Implementation.** The track gets `track/<slug>-<id8>` and a worktree at
  `~/.claude-remote/worktrees/tracks/<row id>`. The branch is created the first time
  implementation starts:
  - **Open session** on the track heading;
  - picking the track in the **new-session dialog**. Its default is "No track", so
    planning and unrelated sessions see no change;
  - **dispatching a job** for one of the track's features (`trackBaseFor()` in
    `runner.ts`). Ad-hoc jobs, and features no longer in PROJECT.md, still branch from
    the current branch.

**PROJECT.md on main is the only authoritative copy.** The board, dispatch and rebuild
read and write it there. The worktree's copy is never authoritative. At Land, ticks in
the worktree copy that are further along (`pending`/`blocked` < `in_progress` < `done`)
are applied to main with `mutateProjectDoc`. The branch's PROJECT.md is first reset to
its merge-base version in its own commit, so the land merge never touches the file.
Otherwise every land would conflict on the one file every track edits.

**Specs can live on either side.** The board's spec view reads the track worktree's copy
when the track has one and the file exists there (`readSpecForTrack`), and falls back to
main's otherwise.

## Jobs inside a track

A job's recorded `baseBranch` is the track branch. Diff, review and integrate already
work against `baseBranch`, so they needed no change. The merge stage changed:

- **Where it merges.** A worktree can't check out a branch another worktree holds, so
  the merge runs where the base is checked out: the project for main, the track's
  worktree for a track (`mergeCwd`).
- **Clean tree.** The clean-tree rule applies there too. A session with uncommitted
  edits in the track worktree blocks the job's merge, with the worktree named in the
  error.
- **No push.** Track branches are local. Merges into them are never pushed; only Land
  pushes.
- **Rebuild is unchanged.** It still ticks the feature on main.

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
- both checkouts are clean;
- the project is on the track's base branch.

It then syncs ticks, runs `git merge --no-ff` (`Merge track: <name>`), records
`merge_sha`, commits the carried-over ticks (PROJECT.md only), pushes when there is a
remote, and removes the worktree and the branch label.

A merge conflict aborts the merge and leaves both checkouts as they were. That includes
taking back the commit that reset the branch's PROJECT.md: by then the worktree's ticks
exist only in memory, and without the rollback the next Land would read the reset copy,
so the progress would be lost for good. The fix for a conflict is to merge the base into
the track in its worktree, resolve there, and land again.

A worktree folder that has gone missing is re-attached to its branch before Land, as
`ensureTrackBranch` does, rather than failing with a 500.

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
- **Finding a merge by its message.** A job whose row has no sha falls back to its exact
  subject, `Merge job: <title>`, used only when exactly one merge commit on HEAD carries
  it. The same lookup runs for features that have no job row left. Discarding a done job
  deletes its row and its `merge_sha` with it, and that is the normal end of a job's
  life, so this is the common case rather than an edge.
- **Skipped merges** are listed under "Revert by hand": two merges sharing the subject,
  a merge not on the current branch, or a job whose base isn't the checked-out branch.

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
this rule, in its "Project workspace" section (added 2026-09-24). It lives outside this
repo, so a change here has to be copied there by hand:

> **Track work happens in the track's worktree (claude-remote).** Planning — writing
> `PROJECT.md` lines and `project/*.md` specs — belongs in the main checkout. But before
> editing *code* for a track's feature, check that the cwd is that track's worktree
> (`~/.claude-remote/worktrees/tracks/…`). If you are in the main checkout, stop and ask:
> code written there can't be attributed to the track, so deleting the track later can't
> remove it. `PROJECT.md` and `project/*.md` are exempt. Inside a track worktree, ticking
> features in its `PROJECT.md` copy is fine — landing the track carries the ticks to main.

The rule is advisory. Detecting work that lands on main anyway is `f-4blxce`.

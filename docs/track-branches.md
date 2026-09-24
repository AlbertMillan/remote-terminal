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

A merge conflict aborts the merge and leaves both checkouts as they were. The fix is to
merge the base into the track in its worktree, resolve there, and land again.

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

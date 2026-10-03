# Behind main, and Update from main

Track: Track workflow polish

## Goal

Before you click Land, the track heading should say whether the track is behind main and
whether the merge would conflict. One click should bring main into the track's worktree
when that's safe.

Today Land finds out at merge time. On 2026-09-25, "Plan usage limits" landed second, and
its merge conflicted in `src/server/app.ts` (both tracks added a line after
`reconcileJobsOnStartup()`). Land aborted, and an agent had to dry-run the merge, merge
main into the worktree by hand, resolve it and re-run the tests. With more than one track
open at a time, that happens to whichever track lands second.

## The trap: main has deleted this track's plan

When a track branches, `moveSectionOffMain` commits on **main** a change that removes the
track's `## Track:` section and its specs (e.g. `40dc583 Move "Session orchestration" plan
into its track branch`). That commit is on main, **not** on the branch. A plain
`git merge main` in the worktree therefore applies main's deletion to the branch:

- the track's section disappears from the worktree's `PROJECT.md`;
- each spec the branch hasn't changed since branching is **deleted silently**, with no
  conflict. A spec the branch did change is a modify/delete conflict.

Checked on 2026-10-03: `git merge-tree --write-tree main track/session-orchestration-74ac3dcf`
reports no conflict, yet the result has no `project/session-orchestration.md`. So both the
warning and the button must protect the track's plan files. A plain `merge-tree` result is
not enough.

Land doesn't hit this because it merges the other way, and copies the section and specs
back to main first (`returnSectionToMain`).

## Design decisions

### The warning

- **What it shows:** on a branched track's heading, `N behind main` (`git rev-list --count
  <branch>..<base>`) when N > 0. Next to it, `would conflict: a.ts, b.ts` when the dry
  run has conflicts. Nothing when N = 0.
- **How:** `git merge-tree --write-tree --name-only <branch> <base>` in the project. The
  git here is 2.39.1, and `--write-tree` needs 2.38+. If it's unavailable, or git fails,
  show only the behind count, never a false "clean".
- **Plan files don't count as conflicts.** Conflicts in the plan doc (`PROJECT.md`, or the
  project's `doc`) and in the track's own specs (`specsOf(track)`) are excluded from the
  list, because Update resolves them itself (below). Every other conflicting path is listed.
- **Cost:** computed when the board is built, cached by `(base sha, branch sha)`, so it
  re-runs only when one of them moves. One `rev-list` plus one `merge-tree` per branched
  track. The board's other git reads already run at that point.

### Update from main

A button on the track heading, shown only when the track is behind. It runs in the
**worktree** (`track.worktreePath`), under the per-project **try** lock (`withProjectLock`,
the same as Land, Delete and Branch now; refuse while held, never wait).

1. **Preflight**, refusing with the files named (`nameFiles`):
   - commit uncommitted planning in the worktree first (`commitWorktreePlanning`, as Land
     does);
   - any other uncommitted change in the worktree → refuse;
   - a live job for the track → refuse, since a job merging into the track branch
     meanwhile would race it;
   - the install guard (`isInstalling`) → refuse.
2. **Remember the track's plan:** read the worktree's section of this track and the
   bytes of each `specsOf(track)` file, as of the branch's HEAD.
3. `git merge --no-ff --no-commit <base>` in the worktree.
4. **Put the plan back:** write the plan doc as **main's version with this track's section
   replaced by the remembered one** (`replaceTrack`). Restore every remembered spec from
   step 2 (`git checkout HEAD -- <spec>`). Stage both. This settles the section and specs
   whether git deleted them, conflicted on them, or merged them cleanly.
5. If any **other** path is still unmerged: `git merge --abort`, then refuse with the
   paths. The worktree is back where it was. The message says to merge main in a session
   and resolve them there.
6. Otherwise commit, `Merge <base> into track: <name>`. Never push (track branches are
   local).

Doesn't run the tests. The message says to run them in the track's session. The
heading's warning clears on the next board refresh.

### Why step 4 replaces the doc rather than merging it

The worktree's copy of `PROJECT.md` is authoritative only for this track's section
(`docs/track-branches.md`). Everything else in it is a stale copy of main's from branch
time. Taking main's file wholesale, then putting this track's section back, gives the
right answer every time. A three-way merge of the file conflicts on almost every Update.

## Planned changes

- `src/server/projects/track-branches.ts`: `behindMain(track)` (count plus filtered
  conflict list, cached) and `updateTrackFromMain(project, trackName)`.
- `src/server/projects/workspace.ts`: `behind` and `wouldConflict` on the branched
  track's board data.
- `src/server/projects/routes.ts`: `POST /api/projects/track/update`, under the lock.
- `src/client/project-feature-board.ts` / `project-workspace.ts`: the line on the heading
  and the button, with a `confirm()` naming the base branch.
- `docs/track-branches.md`: an "Update from main" section with the trap above. Add a
  `CLAUDE.md` bullet: "Never `git merge <base>` into a track branch without restoring its
  plan: main holds the commit that deleted it".

## Verification

Real temp repos, following the existing `tests/track-branches.test.ts` setup:

- Track behind main with an unrelated change → `behind: 1`, no conflicts. After Update,
  the change is in the worktree, and **the track's section and every spec are unchanged**,
  including a spec the branch never touched (the silent-delete case).
- A spec the branch revised → Update keeps the branch's version (the modify/delete case).
- Main and the branch both change the same line of a code file → listed in `wouldConflict`.
  Update refuses naming it, and the worktree's HEAD, index and files are as before.
- Main changed other tracks in `PROJECT.md` → no conflict reported. After Update, the
  worktree has main's other sections and this track's own section.
- Uncommitted code in the worktree → refused, naming it. Uncommitted planning → committed
  first, then Update proceeds.
- A Land after an Update still works: the section is copied back, the merge is clean, and
  specs are intact on main.

## Out of scope

- Rebasing instead of merging.
- Updating automatically.
- Resolving code conflicts. That stays in a session.

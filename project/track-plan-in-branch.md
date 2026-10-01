# Track plans live in the track branch

Track: Track branches & delete

## Goal

Land should never be blocked by planning that nobody committed, and a feature added to a
track should never miss its tick.

Today a branched track's plan is split. Main's `PROJECT.md` holds the lines and the
worktree holds the ticks, and the two meet only at Land. That split caused two of the four
recent Land failures and the two features that lost their tick:

- **Main gets dirty, and Land refuses.**
  - On 2026-09-24, `f-mpon58` and its spec were written on main and left uncommitted.
  - On 2026-09-29, `ensureTrackBranch` (`track-branches.ts:236`) wrote the
    `## Track: UI Improvements` heading on main and never committed it, so claude-remote
    blocked its own Land.
  - In both cases the 409 said only "The project has uncommitted changes", and finding
    out why took a session.
- **Ticks go missing.** `f-mpon58` and `f-jmqczy` were added to main after their tracks
  branched. They weren't in the worktree's copy, so `syncTicks` had nothing to carry
  over, and both were ticked by hand.

The fix: **a track's plan lives where its work lives.** While a track has a branch, its
`PROJECT.md` section and its specs exist only on that branch. Main gets them back when the
track lands.

## Design decisions

### Three states

| Track state | Where its plan lives |
|---|---|
| Backlog (no branch) | Main's `PROJECT.md` and `project/`, as today |
| In progress (unlanded branch) | Only the track branch: the section and its specs |
| Landed | Main again, copied over by Land |

- **The backlog stays on main.** Writing down an idea mustn't create a worktree, start
  Claude Code's trust/MCP prompt, or leave something behind to clean up. Sessions on main
  still see the whole roadmap except for the tracks being built.
- **The move happens at branch creation.** Open session, the track picker, dispatch and
  Branch now all go through `ensureTrackBranch`. There is no separate "start" action.

### Moving a section off main

`ensureTrackBranch`, after the worktree exists:

1. **Into the worktree.** Write main's *working* copy of the section into the worktree's
   `PROJECT.md`, not the `HEAD` copy, so uncommitted lines come along. Do the same for the
   track's specs that are uncommitted on main. Then commit `PROJECT.md` and those specs on
   the track branch.
2. **Off main.** Make one commit on main that removes the section, plus the specs that
   **only** this track's lines reference. The commit is built from `HEAD`'s `PROJECT.md`
   minus the section, through a temporary index (`GIT_INDEX_FILE`), so anything you have
   staged stays staged and out of the commit. Then drop the section from the working
   copy, keeping any other uncommitted edits. The commit is never pushed: only Land
   pushes.

**The order is load-bearing:** worktree first, then main. If step 2 fails, the plan
exists in both places, and the "both copies" rule below covers it. Doing main first would
leave a window where the plan exists nowhere.

A spec that another track's lines also reference stays on main and is only copied into
the worktree.

### Reading and writing an in-progress track

- **The board reads the worktree.** `workspace.ts` builds each track from main's doc. For
  a track with an unlanded branch, it reads that section from the worktree's
  `PROJECT.md` instead. A branched track with no section in its worktree shows empty with
  a warning, never main's stale copy.
- **Board writes go to the worktree.** Tick, add, edit, reorder and remove for a feature
  of a branched track resolve to the worktree's `PROJECT.md`.
  - Every write still carries a content-hash `revision` and still returns 409, but the
    revision is now **per file**: the board response gives each branched track its own
    `revision`, and the write routes check it against the file they write.
  - Writes in the worktree are left uncommitted. Land commits them (below).
- **Lookups search all copies.** `trackOfFeature` (dispatch's base branch,
  `pipeline.ts:567`), `track-attribution.ts` (which reads feature ids to link sessions),
  and the spec view (`readSpecForTrack`, which already prefers the worktree) search main
  plus every unlanded worktree of the project.
- **Feature ids are unique across all copies.** `generateFeatureId` is given the ids from
  main plus every unlanded worktree, or two tracks could hand out the same `f-xxxxxx`.
- **Rebuild ticks the copy that holds the feature.** For a job whose `baseBranch` is a
  track branch, the rebuild stage (`rebuild.ts:56`) ticks the worktree's `PROJECT.md` and
  commits it there. It no longer reports "no longer in PROJECT.md".

### Land

1. **Commit planning in the worktree first.** If every uncommitted file in the worktree
   is a planning file (`PROJECT.md`, `project/*.md` outside `project/reviews/`), Land
   commits them on the track branch without asking. That worktree belongs only to this
   track and never pushes. Any other uncommitted file still refuses.
2. **Uncommitted planning on main doesn't block Land.** Backlog edits (`PROJECT.md`,
   `project/*.md`) stay uncommitted and untouched: the merge never touches `PROJECT.md`,
   and the section commit in step 4 uses a temporary index. Any other uncommitted file on
   main still refuses, since code edited on main may be this track's work.
3. **Name the files in every dirty refusal**, for the worktree and main alike, using
   `gitStatusEntries(cwd, { allUntracked: true })`. "Uncommitted changes" alone is never
   the whole message.
4. **Merge as today.** The branch's `PROJECT.md` is still reset to its merge-base before
   the merge (`resetDocToMergeBase`). Main has since removed the section, so merging the
   file would conflict on every land.
5. **Copy the section, not the ticks.** `syncTicks` becomes `syncSection`, which writes
   the worktree's whole section into main's `PROJECT.md`.
   - If main has no section by that name, the section is appended at the end.
   - If main also has one (the "both copies" case below), the two are merged by feature
     id: the worktree's line wins, and lines only main has are kept. **Nothing is
     dropped.**
   - The commit is `HEAD`'s `PROJECT.md` plus the section, built through the temporary
     index the move uses. The working copy gets the section too, and keeps your
     uncommitted backlog edits. Only this commit is pushed, never those edits.

### Both copies

A session on main can still write `## Track: X` for a track that is in progress. Two
cases also leave a section on main and in the worktree: a failed step 2, and the
migration below.

- **The board shows the worktree's section**, plus a badge reading "also has lines on
  main", with a **Move into branch** button that runs the move again for just those
  lines.
- **Land merges both copies** (above). A line added on main is never lost, which fixes
  pain point 2 for this path too.

### Delete track

- **Backlog track:** unchanged. Lines, heading and the spec rule are applied on main.
- **In-progress track:** the plan is on the branch, so tearing down the worktree and
  branch removes it. There's nothing on main to clean up, apart from a "both copies"
  section, which is removed as a backlog track would be. Specs that stayed on main
  because another track shares them are left alone.
- **Landed track:** unchanged. The revert takes out the specs, and `removeTrack` takes
  out the lines.

### Migration

Any track that has an unlanded branch but still has its section on main gets moved once,
at server start, using the same two steps. Today that is rent-seeker's "Roadmap (SPEC.md
§7)". If a move fails, it is logged and left as a "both copies" track, which the board
and Land already handle.

### Agent rules

- **Global `~/.claude/CLAUDE.md`, "Project workspace".** The rule flips. Plan a
  *backlog* track on main. Plan a track that has a branch in its worktree, both the lines
  and the specs. Never add `## Track:` on main for a track that has a branch. The file is
  outside the repo, so the new text goes in `docs/track-branches.md` and is copied over by
  hand.
- **Project `CLAUDE.md`, "Track branches".** "PROJECT.md in the main checkout is the
  only authoritative copy" becomes: main is authoritative for the backlog and for landed
  tracks; an in-progress track's worktree is authoritative for that track. Land copies
  the section and must never merge the file.

## Planned changes

- `src/server/projects/track-branches.ts`
  - `ensureTrackBranch`: replace `ensureTrack` on main with the two-step move.
  - `landTrack`: commit planning files in the worktree first, let uncommitted planning
    files on main through, list dirty files in the refusal, and replace `syncTicks` with
    `syncSection`.
  - `trackOfFeature`: search the worktree copies too.
  - Add a `moveSectionOffMain` helper, built on a temporary index, shared by the move,
    Move into branch and the migration.
- `src/server/projects/project-doc-format.ts`
  - Section helpers: extract a section, replace a section, and merge two sections by id.
  - `usedIds` across several docs.
- `src/server/projects/project-store.ts`: a way to read and write a track worktree's doc
  (`{ cwd: worktreePath }` already works for reads, as `qa.ts:150` shows).
- `src/server/projects/workspace.ts`: build branched tracks from the worktree, add a
  per-track `revision`, and add the "both copies" badge data.
- `src/server/projects/routes.ts`: route feature writes to the file that owns the
  feature, check the per-file revision, and add a Move into branch route.
- `src/server/jobs/stages/rebuild.ts`: tick in the worktree of a track-branch job.
- `src/server/projects/track-attribution.ts`: collect ids from all copies.
- `src/server/projects/track-delete.ts`: the in-progress plan skips main's line and spec
  edits, except for "both copies" lines.
- Boot (`boot-sweep.ts` or the projects startup path): the one-time migration move.
- Client: `project-workspace.ts` / `project-feature-board.ts` send each track's own
  `revision`, and show the badge and the Move into branch button.
- Docs: `docs/track-branches.md`, the project `CLAUDE.md` "Track branches" bullets, and
  the new global rule text.

## Verification

Tests (`tests/track-branches.test.ts`, plus new ones next to it):

- **Branch creation**
  - Main is clean afterwards, with one new commit removing the section.
  - A staged unrelated file is still staged and isn't in that commit.
  - An uncommitted edit elsewhere in `PROJECT.md` survives.
  - The worktree has the section, including lines that were uncommitted on main.
  - A spec shared with another track stays on main.
- **Failure after step 1:** the plan is in both places, and the board shows one copy
  with the badge.
- **Board:** a tick on a branched track writes the worktree file. A stale revision gets a
  409. Main's revision is unaffected.
- **Ids:** a new id never collides with an id that exists only in a worktree.
- **Land**
  - Uncommitted planning files in the worktree are committed and Land goes through.
  - An uncommitted code file refuses, and the message names it.
  - An uncommitted backlog line and spec on main survive the land, uncommitted and
    unpushed.
  - An uncommitted code file on main refuses, and the message lists it.
  - The section reappears on main with every tick.
  - A "both copies" line added on main is kept.
- **Rebuild:** a job merged into a track branch ticks the worktree copy.
- **Delete:** an unlanded track leaves main untouched. A "both copies" track's lines on
  main are removed.
- **Migration:** an unlanded track whose section is on main is moved at boot.

Manual, in the running app (`project/QA.md`):

- Create a track from the board, open a session on it, add a feature and tick it from
  the board, then land.
- At each step, main's `git status` stays clean, the board shows the tick live, and the
  feature is ticked on main after the land.

## Out of scope

- Live ticks on main while a track is in progress. The board now reads the worktree, so
  this isn't needed.
- Rebuilding or restarting after Land, the "behind main / would conflict" indicator, and
  `node_modules` in worktrees. These are pain points 3, 5 and 6 from the 2026-10-01
  review, each a separate feature.
- Committing backlog edits on main. They stay uncommitted until you commit them, as they
  do today. They no longer block Land (Land step 2).

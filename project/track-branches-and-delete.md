# Track branches and Delete track

Track: Track branches & delete

## Goal

Deleting a track should undo everything the track did: its PROJECT.md lines, its
specs, its unmerged code and its merged code. Today only the first is possible. The ✕ on
a feature row runs `removeFeature()` (`project-doc-format.ts:390`) and touches nothing
else: jobs keep running and can still merge, worktrees stay behind, and specs are left in
place.

The hard part is **attribution**. Job-built work is already attributable: it lives in a
worktree and branch until a `--no-ff` merge. Session-built work is not. A session edits
whichever branch the project has checked out, and no commit or uncommitted edit carries a
track id.

The Usage visibility track (2026-09-19) is the case to design for. One session:
- created the track itself (`cat >> PROJECT.md`), with no board involved;
- wrote `pricing.ts`, `transcript-index.ts` and a `schema.ts` migration in the main
  checkout;
- was undone by rewinding a Claude Code checkpoint, restoring PROJECT.md and removing a
  folder by hand.

A branch you have to remember to ask for would not have helped, because nothing offered
one at the moment it mattered.

So the design separates **planning** (always on main, always fully deletable) from
**implementation** (in the track's worktree by default). Guessing, and showing you what
it guessed, is kept for the leftovers. It's three features:

1. **Track branches** (`f-kzucpb`): every track that is implemented gets a branch and
   worktree. Sessions and jobs for the track work there, and **Land track** merges it
   into main once.
2. **Delete track** (`f-nk734f`): one action that removes a track's plan and code,
   reverting whatever already reached main. It is all-or-nothing wherever git allows.
3. **Work on main outside any branch** (`f-4blxce`): detects code edited on main for a
   track that has no branch. It offers **Branch now**, and shows what it guessed, unticked,
   in the Delete dialog.

## Design decisions

### Planning on main, implementation in the worktree

- **Planning artifacts live on main.** PROJECT.md lines and `project/*.md` specs are
  what a planning session writes, and Delete removes them completely: lines, the track
  heading and the spec rule. A planning session can therefore run in the main checkout
  and create tracks however it likes, including by hand-editing PROJECT.md. The board
  picks new tracks up from the file, as it does now.

- **Implementation happens in the track's worktree by default, not opt-in.** A track
  gets its branch the first time implementation starts, through any of these entry
  points:
  - **Open session** on the track heading;
  - the **new-session dialog**, when a track is chosen (below);
  - **dispatching a job** for one of its features.

  Planning-only tracks never get a branch, and never need one.

- **The new-session dialog asks for a track.** When the cwd resolves to a registered
  project with a PROJECT.md (`findWorkspaceProject`), the dialog under
  `session-cwd-input` (`session-manager.ts:446`) shows a track picker:
  - the project's tracks;
  - **New track…**;
  - **No track (planning or unrelated work)**, the default, so the dialog adds no
    friction for sessions that aren't implementation.

  Choosing a track opens the session in that track's worktree, creating it if needed.
  Other cwds see no change.

- **The agent is told to stop on main.** A rule in the user's global
  `~/.claude/CLAUDE.md`, next to the existing PROJECT.md section: *"Before editing code
  for a track's feature, check that the cwd is that track's worktree
  (`~/.claude-remote/worktrees/tracks/…`). If you are in the main checkout, stop and
  ask, so the work stays deletable. PROJECT.md and `project/*.md` are exempt."*
  - This is advisory, like prompt scoping in the pipeline. Detection (below) is what
    catches misses.
  - In the Usage visibility session it would have fired before `pricing.ts` was written.
  - The file lives outside this repo, so the change is made by hand and recorded in
    `docs/track-branches.md`.

### Track branches (`f-kzucpb`)

- **Lines on main, code in the worktree.** PROJECT.md in the main checkout stays the one
  source of truth for the board, dispatch and rebuild's ticks. The worktree's copy of
  PROJECT.md is not authoritative:
  - **On Land:** for this track's feature ids, any status that is further along in the
    worktree copy (a session ticking `[x]` there, as the global CLAUDE.md tells it to) is
    copied to main through `mutateProjectDoc`. Then the branch's PROJECT.md is reset to
    its merge-base version in a commit on the track branch, so the merge never touches
    PROJECT.md and cannot conflict on it.

- **Specs can live on either side.** A spec written during planning is on main. One
  written or revised in the worktree is on the track branch and lands with it. When a
  feature's track has a worktree and the spec exists there, the board's spec view
  (`routes.ts:74`, `readSpec`) reads the worktree copy; otherwise it reads main's. The
  containment check is the same as `resolveSpecPath`.

- **Mapping stored in SQLite, keyed by track name.** The new `track_branches` table holds
  `project_cwd`, `track_name`, `branch`, `worktree_path`, `base_branch`, `created_at`,
  `landed_at`, `merge_sha`, with `UNIQUE(project_cwd, track_name)`.
  - Tracks have no id in the PROJECT.md format, and adding one is a format change this
    feature doesn't need.
  - A rename through the board updates the row.
  - A rename by hand orphans the row. The board then shows the branch as "no matching
    track", offering **Delete**, rather than guessing.

- **Branch and worktree naming.** The branch is `track/<slug>-<id8>`, taken from the
  current branch. The worktree is `~/.claude-remote/worktrees/tracks/<row id>`. These
  follow `branchNameFor` and `worktreePathFor`. The id suffix keeps two projects' tracks
  with the same name apart.

- **Why claude-remote creates the worktree, not `claude -w`.** Claude Code's
  `--worktree` picks the name and location itself. claude-remote would then have no
  reliable record of which track owns it, and Delete depends on that record. Sessions
  are started through the existing `session.create` with `cwd` = the worktree, and the
  worktree is created with `createWorktree`.

- **Jobs in a track.** Dispatch creates the track branch if it's missing, then
  `createWorktree` bases the job on `track/<slug>`, so the job's recorded `baseBranch` is
  the track branch. Diff, review and integrate already use `baseBranch`, so they need no
  change. An ad-hoc job with no feature keeps today's flow. The merge stage changes:
  - **Where it merges:** it currently merges in `projectCwd` and refuses unless the
    project is on `baseBranch` (`merge.ts:48`). When `baseBranch` is a track branch, it
    merges inside the track worktree, which is where that branch is checked out.
  - **Clean tree:** the existing clean-tree check applies there. An open session with
    uncommitted edits blocks the merge with a message naming the track worktree. This is
    the same contract as main today.
  - **Push:** track branches are local and not pushed, so the merge stage skips its push
    for a track base.
  - **Rebuild:** unchanged. It ticks on main and commits PROJECT.md there.

- **Record every merge's sha.** A new `jobs.merge_sha` column is set to `rev-parse HEAD`
  right after the merge stage's `git merge --no-ff` succeeds. Land track sets
  `track_branches.merge_sha` the same way. Today the only link back is the message
  `Merge job: <title>`, which two jobs with the same title share. Delete needs an exact
  answer.

- **Land track** needs:
  - all of the track's jobs finished (not queued, running or parked);
  - a clean track worktree;
  - a clean main checkout on `base_branch`.

  It syncs ticks (see above), then runs `git merge --no-ff` with the message
  `Merge track: <name>` in the project, records `merge_sha`, and pushes when there is a
  remote, as the merge stage does. It then removes the worktree and the branch label.
  The row stays, with `landed_at` and `merge_sha`, because Delete needs them later.

### Work on main outside any branch (`f-4blxce`)

- **How work on main is attributed to a track.** The link is a set of sessions, and it
  comes from two sources:
  - the SESSION-LOG phase list: the `sessionIds` of the track's items
    (`session-log-format.ts:62`), which the generator fills per feature;
  - any session whose transcript writes one of the track's feature ids into PROJECT.md,
    which is how a planning session that created the track shows up.

  Sessions whose cwd is a track worktree are attributed by cwd and never need this.

- **What it looks for:**
  - **Files:** paths written by `Write`, `Edit`, `MultiEdit` or `NotebookEdit` in those
    transcripts, inside the project and outside PROJECT.md and `project/**`, that are
    **currently** modified or untracked in the main checkout. That last condition drops
    anything since reverted, such as the Usage visibility files after the rewind.
  - **Commits:** commits on main made during an attributed session's time window that
    touch an attributed file.
  - **Blind spot:** edits made through Bash (`cat >`, `sed -i`, scripts) are invisible to
    this and are listed as a known limitation.

- **The board warns you.** A track with no branch and a non-empty guessed set shows a
  badge: "*N* files edited on main by this track's sessions".

- **Branch now** creates the track branch from main's HEAD, then moves the ticked
  uncommitted files into the new worktree: it copies each file's content, then runs
  `git restore` on main (or deletes the file if untracked).
  - The file list is shown ticked but must be confirmed, because it's a guess.
  - Commits already on main are **not** moved, since that would rewrite main. They stay
    as guessed commits for Delete to offer.

- **Guesses are shown unticked, never applied by default.** The board's rule of
  degrading to no match, never a wrong one, applies here: a wrong guess reverted by
  default would destroy unrelated work.

### Delete track (`f-nk734f`)

- **Deletes a whole track, never part of one.** You plan in sessions, and the unit you
  drop is the track. The existing per-feature ✕ stays as "remove this line" for tracks
  without a branch. It is hidden on branched tracks, because removing one line from a
  track whose code sits on a branch would give a false sense that its code had gone
  too.

- **Two calls: a plan, then the delete.**
  - `GET /api/projects/track/delete-plan` returns everything the delete would do, and
    the dialog shows it before anything happens.
  - `DELETE /api/projects/track` carries the plan's `revision` and the parts you ticked,
    and returns **409** when PROJECT.md, the job set or the main HEAD changed since. This
    is the same staleness contract as every other workspace write.

- **What gets removed, and how:**

  | Part | Default | Action |
  |---|---|---|
  | Live jobs (`queued`/`running`/`parked`) | always | `cancelJob`, awaited: mark → abort → wait for the stage to stop → tear down |
  | Finished jobs | always | `discardJob`: worktree and branch go |
  | Track worktree and branch, not landed | always | terminate PTYs whose cwd is inside the worktree, then `removeWorktree --force` and `branch -D`. The dialog counts the uncommitted files this destroys |
  | Recorded merges on main | ticked | `git revert -m 1`, newest first (see below) |
  | Guessed files on main (`f-4blxce`) | **unticked** | `git restore`, or delete if untracked |
  | Guessed commits on main (`f-4blxce`) | **unticked** | `git revert`, newest first |
  | Specs on main | spec rule | the spec rule below |
  | Feature lines | always | removed, and so is the `## Track:` heading |
  | SESSION-LOG phase group | always | removed when its `source` is PROJECT.md and its `group` equals the track name, through `session-log-format.ts` |

- **Which merges are recorded:**
  - the track's `merge_sha` when it has landed;
  - the `merge_sha` of any job for these features that merged straight into main.

  Jobs that merged into the track branch are covered by the track's own merge. A job
  from before the `merge_sha` migration falls back to
  `git log --merges --format=%H --fixed-strings --grep "Merge job: <title>"`, used only
  when **exactly one** commit matches. Otherwise it's listed as "revert by hand".

- **The order makes a failure harmless:**
  1. **Preflight.** A revert needs a clean main checkout on the base branch, apart from
     the guessed files you ticked, so any other dirty file is refused up front, before
     anything is touched.
  2. **Cancel live jobs.** This is the only step taken before the revert can fail, and a
     cancelled job can still be discarded, so a failed delete loses nothing.
  3. **Revert** the ticked merges and commits with `--no-commit`. On any conflict,
     `git revert --abort`, then `git reset --hard <preflight HEAD>`, which is safe
     because step 1 left no untouched work. Stop and report the conflicting files.
  4. **Tear down** job and track worktrees and branches, and restore the ticked
     guessed files.
  5. **Edit** PROJECT.md, specs and the SESSION-LOG phase group.
  6. **Commit** only if step 3 reverted something: one commit, `Delete track: <name>`,
     holding the reverts together with the PROJECT.md and spec changes. It is **not
     pushed**, because a revert on a shared branch is yours to publish. With nothing
     reverted, the changes are left uncommitted.

- **Spec rule, for specs on main** (specs on a track branch go with the branch). The
  default depends on the spec's state:

  | Spec state | Track's lines in the last commit? | Default |
  |---|---|---|
  | Committed, clean | any | delete ("recoverable from git") |
  | Never committed | no: the whole plan is a draft | delete ("never committed; deleted permanently") |
  | Never committed | yes | keep; box offered unchecked |
  | Committed, with local edits | any | keep; box offered unchecked ("uncommitted edits would be lost") |

  Whether the lines were committed is checked by reading `git show HEAD:<doc>` through
  `project-doc-format.ts`. A spec is **kept, with the reason shown**, while anything
  outside the track still references it: another feature's line, `docs/`, CLAUDE.md,
  another spec, a SESSION-LOG group `source`, or a surviving job's spec path.

- **What Delete covers, by how the track was built:**

  | How the track was built | Delete removes |
  |---|---|
  | Planned on main, implemented in the worktree (the default) | everything: lines, specs, branch and uncommitted edits, with landed code reverted |
  | Planned on main, never implemented | everything: lines and specs |
  | Code edited on main anyway (missed rule, older tracks) | lines, specs and jobs. The guessed files and commits are shown unticked for you to confirm |

## Planned changes

**Track branches (`f-kzucpb`)**
- `src/server/db/schema.ts`: migration `014_track_branches` (the table) and
  `jobs.merge_sha`.
- `src/server/jobs/worktree.ts`: generalize the path and branch helpers beyond job ids,
  and add `createTrackWorktree` / `removeTrackWorktree`.
- `src/server/projects/track-branches.ts` (new): the table store, ensure-branch, the
  land-time tick sync, and Land.
- `src/server/jobs/runner.ts`: make sure the track branch exists at dispatch, and base
  the job on it.
- `src/server/jobs/stages/merge.ts`: merge in the track worktree for a track base, skip
  the push, record `merge_sha`.
- `src/server/projects/routes.ts`: `POST /api/projects/track/branch`,
  `POST /api/projects/track/land`, `GET /api/projects/tracks?cwd=` for the picker, and
  spec reads that prefer the worktree copy.
- `src/client/project-workspace.ts`: Open session and Land track on the track heading,
  plus a branch badge.
- `src/client/session-manager.ts`, `index.html`: the track picker in the new-session
  dialog.
- `docs/track-branches.md`, including the global CLAUDE.md rule text. Add a rule group
  in the repo's CLAUDE.md. Apply the global rule by hand.

**Work on main outside any branch (`f-4blxce`)**
- `src/server/projects/track-attribution.ts` (new): the attributed sessions from the
  phase list and transcripts, the transcript file scan intersected with
  `git status --porcelain`, and the commits in session windows.
- `src/server/projects/workspace.ts`: the badge count on the board.
- `src/server/projects/track-branches.ts`: Branch now, which moves the confirmed files.
- `src/client/project-workspace.ts`: the badge and the Branch now confirm list.

**Delete track (`f-nk734f`)**
- `src/server/projects/track-delete.ts` (new): `planTrackDelete` (pure, and tested
  against temp repos) and `executeTrackDelete` (the ordered steps above).
- `src/server/projects/project-doc-format.ts`: `removeTrack`.
- `src/server/sessions/session-log-format.ts`: remove a phase group by name.
- `src/server/projects/routes.ts`: the two endpoints.
- `src/client/project-workspace.ts`: Delete on the track heading. The dialog renders the
  plan with its tick boxes, never a bare `confirm()`.

## Verification

- `npm test`, `npm run build`, `npm run lint` (the `commands` driver in `project/QA.md`).
- **Delete** (unit tests on temp git repos):
  - a branched track that never landed: branch, worktree and uncommitted edits gone, main
    untouched;
  - a landed track: exactly one `Delete track:` commit whose tree equals main before the
    land, plus whatever landed later and didn't conflict;
  - a revert conflict: HEAD, index and working tree identical to preflight, and the
    conflicting files reported;
  - a legacy job with a duplicated `Merge job:` subject: reported, not reverted;
  - each of the four spec-rule rows, and a spec kept because another track references
    it;
  - a stale revision: 409, nothing changed.
- **Attribution** (fixture transcripts):
  - a session that appended a track to PROJECT.md and wrote two source files: both files
    guessed;
  - the same after the files were restored: nothing guessed;
  - a Bash-only edit: not guessed, as documented;
  - guessed items arrive unticked in the delete plan, and are untouched when left
    unticked.
- **Branch now:** the confirmed files move to the worktree and main is left clean for
  them. Files left unticked stay on main.
- **Merge stage:** a job in a track merges into the track worktree, doesn't push, and
  records `merge_sha`. A dirty track worktree blocks it with the worktree named.
- **Land:** ticks made in the worktree reach main's PROJECT.md, and the merge commit
  leaves PROJECT.md untouched.
- **Manual:**
  - Plan a scratch track in a main-checkout session, then pick it in the new-session
    dialog and commit a file in its worktree. Dispatch one job through merge, land, then
    delete. `git log` shows the land and one revert, and the board no longer shows the
    track.
  - Repeat with one file edited on main, and confirm it shows up as a guessed, unticked
    item.

## Out of scope

- Re-planning a feature. You plan in sessions; this feature only makes those sessions
  deletable.
- Stable track ids in the PROJECT.md format.
- Enforcing the stop-on-main rule with a hook. It stays advisory, backed by detection.
- Guessing edits made through Bash.
- Pushing the delete commit.
- Cross-project tracks.

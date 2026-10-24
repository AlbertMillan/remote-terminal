# A track's session can ask to Update it from main

Track: Track workflow polish

## Goal

When you tell the agent in a track's session "pull in main" or "update from main", it
should run the same Update the board's button runs (`f-yjegeg`). Today it can't, so it
either hands back to you or runs `git merge main` itself. A plain merge is the trap that
`updateTrackFromMain` exists to avoid: main holds the commit that took the track's section
and specs off it, so the merge deletes the track's plan (or conflicts on a revised spec).

## Depends on

- `f-s3w8qd` (token, `/api/agent/*` guard, `cr-session.mjs`, the skill) and `f-jd0ocw`
  (`/api/agent/land`, `landableTrack`). Both are done. This adds one route, one CLI
  subcommand and one skill section on top of them. No second auth path.

## Design decisions

1. **The track comes from the caller, as for Land.** With no name: the unlanded track
   whose worktree holds the caller's cwd, else 400 ("this session isn't in a track's
   worktree"). With `--track "<name>"`: the caller's own track, or one a session it
   started (`spawned_by`) works in, else 403. Reuse `landableTrack` (renamed to something
   neutral, like `callerTrack`) so the two routes can't drift apart on who may touch what.
2. **One phase, synchronous.** Update closes no session, so there's no `onResponse`
   phase and no `202`. The route answers `200 { track, mergeSha, detail }` with
   `updateTrackFromMain`'s result, or the refusal as an error. The agent sees the outcome
   directly.
3. **The same lock and the same refusals as the board.** It runs under the project try
   lock (`withProjectLock`), like `/api/projects/track/update`, so a busy lock is an
   immediate 409, never a wait. Live jobs, a running install, uncommitted code in the
   worktree and conflicts all refuse with `updateTrackFromMain`'s own messages (conflicts
   name the paths, and the merge is aborted). Share one helper between the two routes
   rather than calling `updateTrackFromMain` twice in different ways.
4. **The board learns about it.** After a successful Update, broadcast the same refresh
   the board uses after its own Update, so the heading's "N behind" clears without a
   reload. No notification toast: the agent is alive and reports the result itself.
5. **The skill steers away from the trap.** A short "Updating from main" section:
   - use it when the user asks this session to pull main in, or before a `land` that
     refused because the track is behind with conflicts;
   - **never run `git merge <base>` / `git pull` in a track worktree yourself**: it drops
     the track's plan;
   - commit first (staging files by name). Uncommitted code makes it refuse;
   - on a conflict refusal, report the named paths to the user. Don't resolve by hand
     merging main.
   The skill's frontmatter `description` gains "or update it from main", or it won't
   trigger.
6. **A child's track while the child is working.** `--track` lets an orchestrator update
   a child's worktree under it. The uncommitted-code refusal covers an agent mid-edit,
   but not one between commits that then sees files change. The skill says to update a
   child's track only when the user asks, as for `land --track`.

7. **An Update that changes the lockfile reinstalls, with nobody asking.** Today
   `needsInstall()` only checks that `node_modules` exists, so after main's lockfile comes
   in the worktree keeps the old packages and tests fail with "Cannot find module". After
   a successful merge, if the lockfile differs between the pre-merge HEAD and the merge
   commit, `updateTrackFromMain` runs `installDependencies(worktree)` (frozen install,
   one per folder, `isInstalling` guards Land/Delete meanwhile). The orchestrator or
   session never has to notice or run `npm ci` itself. This lives in
   `updateTrackFromMain`, so the board's button gets it too.
   - The reply waits for the install, and `detail` says what happened ("installed
     dependencies: the lockfile changed").
   - The merge stays committed if the install fails. `detail` then names the failure
     and the fix (`npm ci` in the worktree). On Windows the usual cause is a dev server
     or vitest in that worktree holding files (`EBUSY`), so the message says to stop it
     and retry.
   - `npm ci` deletes `node_modules` first, so a frozen install over an existing folder
     is a full reinstall. Accept the time; it only runs when the lockfile changed.

## Open questions

- **Other merges into a track branch** (a job merging in, `mergeCwd`) can change the
  lockfile too. Same check there, or a lockfile-hash stamp that `needsInstall()` compares
  (covers every path, but installs only at the next session/job open)? Follow-up.
- **Should `land` suggest it?** When Land's preflight refuses because the branch is behind
  with conflicts, its message could say "update from main first". Cheap, but Update would
  refuse on the same conflict, so it only helps when the conflict is resolvable on the
  track side.

## Planned changes

- `src/server/agent/sessions-api.ts`: `POST /api/agent/update` behind `authenticate()`;
  `landableTrack` generalised for both routes.
- `src/server/projects/track-branches.ts`: in `updateTrackFromMain`, the lockfile check
  and install after the merge commit (decision 7).
- `src/server/projects/routes.ts`: the lock + `updateTrackFromMain` + refresh as one helper
  that both routes call.
- `scripts/cr-session.mjs`: `update [--track "<name>"]`, printing `detail`.
- `skills/claude-remote-sessions/SKILL.md`: the section (decision 5) and the description.
- `docs/session-orchestration.md` and `docs/track-branches.md`: the route.

## Verification

- Unit, auth: no token → 401; non-loopback → 403; a session in main with no `--track` →
  400; `--track` naming a track no session of the caller's works in → 403; a started
  session in its own worktree → 200.
- Unit, behaviour (temp repo as in `tests/track-update.test.ts`): main ahead → 200 with a
  `mergeSha`, and the track's section and specs still in the worktree; up to date → 200,
  `mergeSha: null`; uncommitted code → 409 naming the files; a conflict → 409 naming the
  paths, the worktree unchanged; the lock held → 409 immediately.
- Unit, dependencies (fake `installDependencies`): main changed the lockfile → one
  install in the worktree after the merge, and `detail` says so; lockfile unchanged → no
  install; install fails → the merge stays, `detail` names the failure.
- CLI: `update` sends the token and prints `detail`; a 4xx prints the server's error and
  exits non-zero.
- Manual, isolated boot (`project/QA.md`, Flow 3): ask a track session to update from main
  and check that the board's "behind" count clears.

## Out of scope

- Updating from any branch other than the track's recorded `baseBranch`.
- Resolving conflicts on the agent's behalf.
- Update from a session in main with no `--track` (it has no track of its own).

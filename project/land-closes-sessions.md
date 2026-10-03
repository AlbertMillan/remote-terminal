# Land closes the track worktree's sessions itself

Track: Project Session Log

## Goal

Landing a track should be: commit, click **Land**. Today it is: commit, close the session,
wait for its session-log run, click Land. If any step is missed, Land refuses or tears down
under a running process.

Two problems:

- **Land refuses while a session is open in the worktree** (`landTrack`,
  `track-branches.ts`, the `liveSessionCwds` check), so you have to find and close it by
  hand first. Delete track already closes those sessions itself
  (`track-delete.ts`, `tearDown` → `deps.terminateSession`), so the two verbs disagree.
- **A session whose shell has exited still counts as open.** `handleSessionExit`
  (`sessions/manager.ts`) sets `status = 'terminated'` but leaves the session in
  `activeSessions`. The Land route builds `liveCwds` from `sessionManager.getAllSessions()`
  without checking status. Seen 2026-10-02: the terminal showed
  `[Process exited with code 1]`, and Land still refused.

## Design decisions

1. **Only running sessions count.** Land and Delete both read the sessions from one
   helper, which skips `status === 'terminated'`. A dead PTY holds no folder open, so it
   must not block or be "closed". Use one helper for both, or they drift again.
2. **Land closes the worktree's running sessions, after its preflight passes.** Every
   refusal that doesn't need the sessions gone runs first: live jobs, the install guard,
   wrong branch, staged files on main, uncommitted code in the worktree. Then Land closes
   the sessions and goes on. That way a Land that is going to refuse never kills a
   session for nothing. A session with uncommitted *code* in the worktree is never closed:
   the dirty-code refusal comes first.
3. **Await each close before teardown.** On Windows an open shell's cwd makes `git
   worktree remove` fail half-way, so `terminateSession` must have finished (PTY process
   tree gone) before the merge and teardown start. Delete track already does this; follow
   its order.
4. **The confirmation says what will close.** The board's Land confirm adds "N open
   session(s) in its worktree will be closed" when N > 0. Take N from the board's
   track data: add an `openSessions` count to the branched track, computed like Delete's
   `sessionsToClose`.
5. **Depends on `f-wycv03`.** Closing a session starts its session-log run. Until
   `f-wycv03`, that run uses the worktree as its cwd and is the `EBUSY` cause. Build
   `f-wycv03` first. With it, Land never has to wait for the log run.

## Planned changes

- `src/server/sessions/manager.ts`: a `getRunningSessions()` (or a filter used by the
  callers) that skips terminated sessions.
- `src/server/projects/routes.ts`: Land and Delete pass running sessions only. Land gets
  the session list and a `terminateSession` dependency, as Delete's `TrackDeleteDeps`
  already does.
- `src/server/projects/track-branches.ts` (`landTrack`): replace the "close it before
  landing" refusal with closing them after the other preflight checks. Report how many
  were closed in `detail`.
- `src/server/projects/workspace.ts`: `openSessions` on branched tracks.
- `src/client/project-workspace.ts`: the Land confirm text.
- `docs/track-branches.md` and the `CLAUDE.md` bullet ("Land refuses while a live
  session's cwd is inside the worktree") updated to the new behaviour.

## Verification

- A terminated session (its PTY exited) in the worktree: Land goes through and closes
  nothing. The same for Delete's `sessionsToClose` count.
- A running session in the worktree, clean tree: Land closes it, waits for it to finish,
  lands, and the worktree is removed on the first try (no background retry in the log).
- A running session plus uncommitted code in the worktree: Land refuses, naming the files,
  and the session is still running.
- A running session outside the worktree, in main or another track: untouched.
- Tests use the real `landTrack` with a fake session list and a fake `terminateSession`
  that records its calls and the order they ran in, relative to the merge.

## Out of scope

- Landing from inside the session itself (the agent asking to "commit and land"). That
  session would be closed by its own request. It stays a board action.
- The "behind main / would conflict" check on the track heading (a separate feature).

# A track's session can ask to Land it

Track: Track workflow polish

## Goal

When you tell the agent in a track's session "commit and land", it should be able to do
both. Today it commits, then has to hand back to you to click Land on the board.

Since `f-p1zm60`, Land closes the worktree's sessions itself. What's missing is a way for
the session to *trigger* it. The catch is that the Land closes the session that asked.

## Depends on

- **`f-s3w8qd` (Session orchestration), which must land first.** It adds what this needs:
  the per-PTY `CLAUDE_REMOTE_TOKEN` (in memory only, `Map<token, sessionId>`), the
  loopback-plus-token guard for `/api/agent/*`, the `CLAUDE_REMOTE_URL` /
  `CLAUDE_REMOTE_CLI` env, `scripts/cr-session.mjs` and the `claude-remote-sessions` skill.
  This feature adds one route, one CLI subcommand and one skill section on top of them.
  Don't build a second auth path.
- **Optional:** "Update from main" (`project/track-update-from-main.md`). If its
  `behindMain()` exists, the preflight below uses it to refuse a Land that would conflict.

## Design decisions

1. **The track comes from the caller, never from the request.** The server takes the
   session id from the token, then the session's cwd, then the unlanded track whose
   `worktreePath` contains it (`isInside`). The request body has no track or path. A
   session outside every track worktree gets 400 ("this session isn't in a track's
   worktree").
2. **Any session can Land its own track, started sessions included.** Since `f-s3w8qd`,
   a track session is usually one an orchestrating session started (`spawned_by` set), and
   that's the session you're talking to when you say "land it". Refusing started sessions
   would make the feature useless in that flow. What stays refused: landing a track other
   than the caller's own (decision 1), and an orchestrator landing on a child's behalf.
   The orchestrator's skill keeps "don't Land" in the prompts it writes, so a started
   session lands only when you ask it to directly.
3. **Two phases, so every refusal reaches a live agent.**
   - **Phase 1, in the request:** the whole Land preflight, except closing sessions. That
     covers live jobs, the install guard, base branch, staged files and uncommitted code on
     main, and uncommitted code in the worktree (worktree planning is committed, as Land
     does). It also checks for a conflicting merge (`behindMain()`, when available). Any
     refusal comes back as the CLI's error while the agent can still fix it.
   - **Phase 2, after replying `202 Accepted`:** once the reply has been sent, close the
     worktree's sessions (the caller included) through `f-p1zm60`'s path, then run the
     normal Land under the project try lock. The lock is taken in phase 2, never held
     across the reply.
   - Phase 2 repeats the preflight inside `landTrack` anyway. Phase 1 is there to give a
     good error early, not to guarantee anything.
4. **The outcome goes where you'll see it.** Phase 2's result, landed or refused, goes out
   as a `notification` WebSocket message to every client, with Land's `detail` text (the
   rebuild and restart hint included). It is also logged, and the board refreshes. If
   phase 2 fails (a race, or a merge failing after all), the track stays unlanded with its
   worktree intact, so you can reopen a session on it.
5. **Only when you ask, in that session.** The skill section says: use it only when the
   user asks this session to land; commit first, staging files by name; check that
   `git status` is clean; never Land on your own initiative or as "the next step". The
   CLI prints "Land accepted; this session will close" and exits 0. The agent's last
   output says so.
6. **The session log is not lost.** The closing session's entry is written to main's
   `SESSION-LOG.md` (`f-wycv03`), so the run doesn't hold the worktree.

## Planned changes

- `src/server/agent/sessions-api.ts`: `POST /api/agent/land`, reusing the existing guard.
- `src/server/projects/track-branches.ts`: split the session-independent preflight out of
  `landTrack` into `landPreflight(project, track)`, so phase 1 and Land run the same checks.
- `scripts/cr-session.mjs`: a `land` subcommand (no stdin, no arguments).
- `skills/claude-remote-sessions/SKILL.md`: the "Landing" section (decision 5).
- `docs/session-orchestration.md` and `docs/track-branches.md`: the route and the two phases.

## Verification

- Unit, auth: no token → 401; a non-loopback address → 403; a started session in its own track worktree → accepted;
  a session in main → 400.
- Phase 1: uncommitted code in the worktree → the request fails with the files named, and
  the caller is still running.
- Phase 2, with a fake session manager and a fake notifier: the reply goes out before any
  session is closed; sessions are closed before the merge; a successful Land sends one
  notification with Land's detail; a Land failing in phase 2 sends a notification with the
  reason, and leaves the track row unlanded and its worktree on disk.
- The CLI: `land` sends the token and prints the accepted message. A 4xx prints the
  server's error and exits non-zero.

## Out of scope

- Landing a *different* track than the caller's.
- Landing by the orchestrating session on a child's
  behalf.
- Delete track from a session.

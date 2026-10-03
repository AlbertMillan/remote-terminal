# Sessions that start sessions

A main session that has just planned tracks can start a session on each one and hand it
its prompt, instead of the user opening each and retyping it. The sessions it starts show
nested under it in the sidebar. Spec and decisions: `project/session-orchestration.md`.

## Pieces

| Piece | Where |
| --- | --- |
| CLI the agent runs | `scripts/cr-session.mjs` (`start`, `list`, `land`; JSON out, prompt on stdin) |
| Skill that tells the agent how | `skills/claude-remote-sessions/SKILL.md` (install below) |
| Routes | `src/server/agent/sessions-api.ts` — `POST`/`GET /api/agent/sessions`, `POST /api/agent/land` |
| Land's outcome | `notification` with `kind: 'land'` (`broadcastLandResult`), shown by `src/client/land-result.ts` |
| PTY env + token map | `src/server/sessions/session-env.ts` — `sessionEnv(id)` |
| Prompt files | `src/server/sessions/prompt-file.ts` — `<dataDir>/prompts/<sessionId>.md` |
| Typing the command | `injectCommand()` in `session-open.ts` (shared with resume/fork/revive) |
| Who started whom | `sessions.spawned_by`, `sessions.permission_mode` (migration 017) |
| Browsers learn of it | `session.added` broadcast (`broadcastSessionAdded`) — never attaches |
| Sidebar nesting | `groupStartedSessions()` + `renderSessionGroup()` in `session-list-view.ts` |

## The environment every PTY gets

`sessionEnv(id)` is the only source of a PTY's env, at every creation site (create, fork,
history open, revive):

- `CLAUDE_REMOTE_SESSION_ID` — as before, for the notification and session-id hooks.
- `CLAUDE_REMOTE_TOKEN` — 32 random bytes, hex. See below.
- `CLAUDE_REMOTE_URL` — the server's loopback base URL (`loopbackUrl()`), set at boot from
  the protocol actually in use, so the CLI never guesses the port. The status line script
  reads the same variable, so inside a terminal it points at this server.
- `CLAUDE_REMOTE_CLI` — the absolute path of `scripts/cr-session.mjs` in this install.

The server's own `process.env` has `CLAUDE_REMOTE_SESSION_ID` and `CLAUDE_REMOTE_TOKEN`
scrubbed at boot (`claude-env.ts`): a server restarted from inside a terminal would
otherwise pass that terminal's id and dead token to every headless `claude -p` run.
Headless runs get no token at all — a pipeline stage never starts sessions.

## Auth model

`/api/*` has no authentication and the server listens on `0.0.0.0`. These routes start a
shell and type into it, or land a track and close its sessions, so they — and only they —
require **both**, through one guard (`authenticate()`):

1. **Loopback.** `request.socket.remoteAddress` is `127.0.0.1`, `::1` or the IPv4-mapped
   `::ffff:127.0.0.1`. `X-Forwarded-For` is never read: it is whatever the client wrote.
2. **A live session's token**, as `Authorization: Bearer …`. Tokens live **only** in the
   in-memory map in `session-env.ts` — never the database, logs or scrollback. A token is
   issued when its PTY is created and revoked when the PTY exits, is terminated, is replaced
   (revive issues a new one and the old one dies), or the server shuts down. A restart
   therefore invalidates every token.

Loopback alone is not enough (any local process reaches it); a token alone is not enough
(it would work from the tailnet if it leaked). The token also tells the server *which*
session is calling, which is how `spawned_by` and the limit work.

Status codes: 403 not loopback · 401 missing/unknown/revoked token · 403 a started session
calling `start` · 429 `agentSessions.maxPerParent` reached (counting starts still
installing) or the global `sessions.maxSessions` · 409 the caller already has a live
session on that track, or a start on it still running · 400 bad body, `bypassPermissions`, or a
caller outside any workspace project · 404 a track not in the plan · 413 prompt over 100 KB.
`land`: 202 accepted · 400 the caller is in no track's worktree · 409 any Land refusal
(uncommitted code, a live job, a conflicting merge, the project busy) or a Land of the
track already under way.

## Start, step by step

1. Authenticate; refuse a started session; check the limit. "Live" means a PTY exists **and**
   its shell has not exited: an exited shell keeps its PTY entry (and stays `attachable` in
   the sidebar, to read its scrollback) until it is deleted, but no longer counts.
2. The caller's project: its DB cwd resolved through `trackBranchContaining()` (a track
   worktree maps to its project) and then the deepest registered or board project holding it.
   A project *above* the cwd counts only when it has a plan file: discovery lists every
   folder Claude ever ran in, the home folder included.
3. The track must be in `readProjectPlan()` — main's plan plus every branched track's.
   One live or in-flight session per caller and track (409 otherwise): an agent whose Bash
   call timed out leaves the start running here, and a retry would start a duplicate.
4. `ensureTrackBranch()`, then `installDependencies()` when `needsInstall()`. A failed
   install still starts the session; the response's `install` says so.
5. `createSession()` in the worktree with `spawnedBy` and `permissionMode`.
6. Write the prompt to `<dataDir>/prompts/<id>.md`. **Never inside the worktree**, or the
   next stage's `commitAll` sweeps it into the branch. It is deleted with the session row.
7. `injectCommand()` types `claude --permission-mode <mode> "Read <path> and follow it."`
   once the shell is ready. The path uses forward slashes so no shell reads an escape, and a
   path holding `"`, `%`, `$` or a backtick is refused (the session is removed) rather than
   typed into a command that would silently read another file.
8. Broadcast `session.added`; return `{ sessionId, name, worktreePath, install }`.

Why a file and a short command rather than the prompt itself: a newline in a typed command
sends it early, PowerShell/bash/cmd quote differently, and the terminal would echo the whole
prompt. Pasting into `claude` after it starts would need the server to detect Claude's input
box, and a guess made too early types the prompt into the shell, which runs it as commands.

## A session lands its own track

`node "$CLAUDE_REMOTE_CLI" land` → `POST /api/agent/land`, no body. Spec:
`project/session-requests-land.md`. The catch is that Land closes the session that asked.

- **The track comes from the caller, never the request.** Token → session id → the
  session's cwd → the unlanded track whose worktree holds it (`trackBranchContaining`). A
  session outside every track worktree gets 400. So a session lands only its own track,
  and an orchestrator in the main checkout can't land a child's. Started sessions can
  land: they are usually the one the user is talking to.
- **Phase 1, in the request:** Land's session-free checks (`landPreflight`: live jobs,
  install, base branch, code or staged files on main, code in the worktree, with worktree
  planning committed) plus a conflicting merge (`behindMain`). Under the project try lock,
  released before the reply. A refusal is the CLI's error while the agent can still act.
- **Phase 2, after the `202`:** a route-level `onResponse` hook starts it, so the reply has
  been sent before anything is closed. `landAndBuild()` (`track-land.ts`; the board's Land route runs
  too) takes the lock again, re-runs the preflight, closes the worktree's sessions (the
  caller included) before merging, lands and rebuilds.
- **The outcome** goes to every client as a `notification` with `kind: 'land'`, landed or
  failed, with Land's `detail` (build result and restart hint included). It is not
  filtered by notification preferences: it is the only report of that Land. The client
  shows a toast over every view until dismissed, a browser notification when the tab is
  in the background, and reloads the board. A phase-2 failure leaves the track unlanded
  with its worktree, so a session can be reopened on it.
- **The asking agent does not outlive the close.** Closing kills the shell, and node-pty's
  helper for the console's other processes logs `AttachConsole failed` here, but the agent
  dies anyway: closing the pseudo-console ends every process attached to it. Checked
  2026-10-03 with a stand-in agent (a node process with the worktree as cwd that ran
  `land` and kept running), on a server launched as production does (`WshShell.Run` of a
  `.bat`, hidden console) and from Git Bash (no console): both times the process was gone,
  the worktree removed and the branch deleted. An agent slow to exit is covered by
  `removeWorktree`'s background retry of a busy folder.
- The skill says: only when the user asks this session to land; commit first, staging by
  name; never on its own initiative. The CLI prints "Land accepted; this session will
  close."

## Sidebar

- Children render right after their parent, in the parent's category, in creation order,
  indented with a guide line. One level only: a child whose parent is missing from the list
  (deleted) or is itself a child renders top-level.
- The parent's row gets a collapse arrow — its own button, ≥32 px tap area, stops the event,
  so tapping it never opens the parent and tapping the row never collapses it. Collapsed
  parents are remembered per browser in `localStorage` (`claude-remote.collapsedSessionGroups`).
- The parent gets a summary line under its status, `N needs input · N done · N started`,
  visible collapsed; it wraps only between parts. The arrow takes the drag handle's slot (the
  whole row stays draggable), so the parent lines up with other rows and its children read as
  indented under it.
- A child whose `permissionMode` is not `default` shows a chip.
- Children are not draggable; a drop on one falls through to its category's list.

## Installing the skill

The skill is what makes an agent in **any** project's session know the CLI exists. Install
it into your user skills folder (`~/.claude/skills/`) once, and again whenever it changes:

```
npm run install-skill
```

`scripts/install-skill.mjs` copies every `skills/<name>/` that has a `SKILL.md`, and says
which were installed, refreshed (the installed copy differed) or already up to date. It is
plain Node, so it runs the same on Windows, Linux and macOS.

It costs only its one-line description per turn until it is used — the reason this is a
CLI plus a skill rather than an MCP server, whose tool definitions would be in every turn
of every session.

## Known limits

- With TLS on, `CLAUDE_REMOTE_URL` is `https://localhost:<port>`, and a Tailscale
  certificate names the machine, not `localhost`: the CLI's fetch fails certificate
  verification and says so. The default (TLS off) is unaffected.
- No "working" state: the server learns about a session only through the `Notification`
  and `Stop` hooks. `list` reports the last of those, which attaching clears.
- Behind `tailscale serve` (or any reverse proxy on this machine), every request reaches the
  server from 127.0.0.1, so the loopback check stops nothing and the token is the only
  guard. That is still sound: the token exists only in the PTY environments the server
  handed out. Just don't count on the loopback check in that setup.

# Sessions that start sessions

A main session that has just planned tracks can start a session on each one and hand it
its prompt, instead of the user opening each and retyping it. The sessions it starts show
nested under it in the sidebar. Spec and decisions: `project/session-orchestration.md`.

## Pieces

| Piece | Where |
| --- | --- |
| CLI the agent runs | `scripts/cr-session.mjs` (`start`, `list`, `land [--track]`; JSON out, prompt on stdin) |
| Skill that tells the agent how | `skills/claude-remote-sessions/SKILL.md` (install below) |
| Routes | `src/server/agent/sessions-api.ts` — `POST`/`GET /api/agent/sessions`, `POST /api/agent/land`, `POST /api/agent/update` |
| Land's outcome | `notification` with `kind: 'land'` (`broadcastLandResult`), shown by `src/client/land-result.ts` |
| Did the prompt arrive | `src/server/agent/prompt-delivery.ts`; `kind: 'prompt-missing'` (`broadcastPromptMissing`), same toast |
| PTY env + token map | `src/server/sessions/session-env.ts` — `sessionEnv(id)` |
| Prompt files | `src/server/sessions/prompt-file.ts` — `<dataDir>/prompts/<sessionId>/prompt.md` |
| Worktree's local settings | `src/server/projects/local-claude-settings.ts` — `ensureLocalClaudeSettings()` |
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
session on that track, or a start on it still running · 400 bad body, `bypassPermissions` or `dontAsk`, or a
caller outside any workspace project · 404 a track not in the plan · 413 prompt over 100 KB.
`land`: 202 accepted · 400 the caller is in no track's worktree (no `track`), or a blank
`track` · 403 a named track neither the caller's nor a started session's · 409 any Land refusal
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
5. `ensureLocalClaudeSettings()` (below), then `createSession()` in the worktree with
   `spawnedBy` and `permissionMode`.
6. Write the prompt to `<dataDir>/prompts/<id>/prompt.md`. **Never inside the worktree**, or
   the next stage's `commitAll` sweeps it into the branch. The folder is the session's own
   and is deleted with the session row.
7. `injectCommand()` types
   `claude [--permission-mode <mode>] --add-dir "<dir>" -- "Read <dir>/prompt.md and follow it."`
   once the shell is ready. `--add-dir` names that session's prompt folder only, so it reads
   its prompt without asking and can't read another session's. The `--` is required:
   `--add-dir` takes several directories, and without it the prompt is read as one more, so
   the session starts idle with no prompt and nothing says so (every start until 2026-10-04). The paths use forward slashes
   so no shell reads an escape, and a path holding `"`, `%`, `$` or a backtick is refused (the
   session is removed) rather than typed into a command that would silently read another file.
8. Broadcast `session.added`; return `{ sessionId, name, worktreePath, install }`.
9. Schedule one check `PROMPT_GRACE_MS` (90 s) later (`checkPromptArrived`), below.

## Did the prompt arrive

A session whose prompt never reached its agent sits idle and looks exactly like one that
is working: `active`, attachable, no notification. That happened to every start until the
`--` fix, so the server checks (`agent/prompt-delivery.ts`):

- **Evidence.** Claude writes no transcript until its first message, and our prompt names
  `<id>/prompt.md`. So a **user** line naming that file, in a transcript from the
  session's folder (`~/.claude/projects/<cwd with every non-alphanumeric as ->`, written
  since the session was created) or in the one its claude-session hook registered, means
  `received`. A later SendMessage or typed message never names the file, so it never counts.
- `pending` within the grace period, then `not-received`, with a `detail` naming whether
  Claude registered at all (no registration: it never started, or the hook isn't installed).
- `list` reports it per session as `prompt: { state, detail? }`, computed on each call.
- The scheduled check sends a `notification` with `kind: 'prompt-missing'` only for a
  session still live and `not-received`; deleted or exited ones are left alone. The client
  shows it in the land-result toast, never as a badge (an idle session badged reads as
  "needs input"), and as a browser notification that opens the session.
- Nothing retypes the prompt: by then Claude's input box or a dialog has the keyboard, and
  a blind retype could answer the dialog or run in the shell.

Why a file and a short command rather than the prompt itself: a newline in a typed command
sends it early, PowerShell/bash/cmd quote differently, and the terminal would echo the whole
prompt. Pasting into `claude` after it starts would need the server to detect Claude's input
box, and a guess made too early types the prompt into the shell, which runs it as commands.

## Permission modes

Allowed: `auto` (the default), `manual`, `acceptEdits`, `plan`. A started session exists to
run unattended, and `auto` still asks before risky actions; `manual` asks for every edit and
command. `bypassPermissions` is refused because the user would have to read the flags to
notice it, and `dontAsk` because it denies whatever isn't pre-allowed, so the session would
fail quietly instead of asking.

`default` is accepted as an alias and stored as `manual`: a skill copy installed before the
rename still sends it. For `manual` the typed command has **no** `--permission-mode` — Claude
Code lists `manual` and no longer `default`, and passing nothing gets the default under
either name. Rows stored as `default` read as `manual` in `list` and the sidebar.

## Worktrees get the main checkout's local settings

The main checkout's `.claude/settings.local.json` is gitignored, so a track worktree never
has it, and every session there would ask again for each MCP server (`~/.mcp.json` is found
above `~/.claude-remote/worktrees/`) and each allowlisted command.
`ensureLocalClaudeSettings(projectCwd, worktreePath)` copies it in from `ensureTrackBranch()`:
when it creates a worktree, and on every later call, which every track session (Track
picker, the board's Open session, Branch now, agent start) goes through first. Agent start
calls it again before creating the session.

- A **copy**, never a link: `git worktree remove` on Windows deletes through a link.
- Never overwrites a worktree's own copy; its sessions may have added approvals. Those are
  not carried back at Land and die with the worktree.
- Never committed: if `git check-ignore` says the path isn't ignored,
  `/.claude/settings.local.json` goes into the shared `info/exclude`
  (`git rev-parse --git-common-dir`) first, which ignores it in the main checkout too. If it
  still isn't ignored, there is no copy.
- No main-checkout file, no copy.

## A session lands its own track

`node "$CLAUDE_REMOTE_CLI" land` → `POST /api/agent/land`, no body. Spec:
`project/session-requests-land.md`. The catch is that Land closes the session that asked.

- **The track comes from the caller.** With no body: token → session id → the session's
  cwd → the unlanded track whose worktree holds it (`trackBranchContaining`). A session
  outside every track worktree gets 400. Started sessions can land: they are usually the
  one the user is talking to.
- **A parent can land its child's track** with `land --track "<name>"` (body
  `{ track }`). The server accepts the name only if it is the caller's own track or the
  track a session **the caller started** (`spawned_by`) works in, running or finished, in
  the caller's project. Anything else is 403, so a token can never reach a track outside its
  own family; a child can't land a sibling's. The parent sits in the main checkout, so the
  Land closes the child but not the parent: the `202` carries `closesCaller: false` and the
  CLI says "the track's sessions will close". The result is the same notification.
  Confirmation is the skill's job: the agent names the track, asks the user and lands only
  on an explicit yes. Nothing server-side waits for one.
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

## A session updates its track from main

`node "$CLAUDE_REMOTE_CLI" update [--track "<name>"]` → `POST /api/agent/update`. Spec:
`project/session-requests-update.md`. It runs the board's Update from main
(`updateAndInstall`, `docs/track-branches.md`), so an agent asked to "pull main in" never
runs a plain `git merge main`, which deletes the track's plan.

- **Which track: as for Land.** `resolveCallerTrack()` serves both routes: the caller's
  own track with no body, or with `{ track }` its own or one a session it started works in;
  anything else is 400 or 403.
- **One phase.** Nothing closes, so there is no `202`: the reply is `200 { track,
  mergeSha, install, detail }`, or the refusal (live job, install, uncommitted code,
  conflict, a busy project lock) as the CLI's error. The CLI prints `detail`.
- **Dependencies.** When the merge changed a lockfile, or the worktree's install is
  missing or incomplete, the reply waits for a reinstall, so neither the agent nor the user
  has to notice. The skill tells the agent to pass a 10-minute Bash timeout. The install
  has the same 10-minute limit, so a call can still time out first. The skill then has
  the agent run `update` again: 409 "still installing" while the install runs, and
  afterwards a retry of a failed install even with nothing to merge.
- **The board** refetches on the `projects.changed` broadcast. No toast: the agent is
  alive and reports the result itself.
- The skill says: never `git merge`/`pull` main in a track worktree; commit first; use it
  when the user asks, or after a `land` refused on a conflict that is now fixed;
  `--track` on a child only when the user asks.

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
- A child whose `permissionMode` is not `auto` shows a chip (`default` reads as `manual`).
- Children are not draggable; a drop on one falls through to its category's list.

## Names agents message each other by

Agents talk through Claude Code's own `ListAgents`/`SendMessage`, which list every running
Claude on the machine (any project) by **Claude's** name, not ours. A `claude` started without
a name gets one derived from its folder (`rimworldy-ae`, `8b4cd966-0a` for a track worktree),
so an agent asked to message "the planner" can't find it. Spec: `project/peer-session-names.md`.

- **Every `claude` the server types carries `--name "<session name>"`** (`claudeNameFlag()` in
  `session-open.ts`): agent start, revive, history resume and fork. A revive re-applies it, so
  the name survives a restart. A name holding `"`, `%`, `$`, a backtick, `!`, a backslash or a
  control character gets no flag (Claude falls back to its own name) rather than a broken
  quote that would run the rest of the line as shell.
- **The sidebar shows Claude's name** in the status line (`active · @rimworldy-ae`) when it
  differs from ours, which happens for a `claude` typed by hand. `sessions/claude-registry.ts`
  reads Claude's live registry, `~/.claude/sessions/<pid>.json` (`{ pid, sessionId, name,
  nameSource }`; `name` is exactly what `ListAgents` shows), matches `sessionId` to the
  session's `claudeSessionId` from the claude-session hook, and skips files whose `pid` is
  dead (a killed Claude leaves its file). It's Claude Code's internal format: every read
  degrades to no name, and nothing writes it.
- The client fetches the list only on connect, and Claude starts, exits and `/rename`s
  without telling us, so the server polls the registry every 5 s and broadcasts
  `session.claudeNames` (the full map) whenever it changes. `sessionToInfo` fills
  `claudeName` from the last poll.
- There is no claude-remote directory or mailbox. `SendMessage` already reaches every running
  session regardless of project, so a directory would gate nothing, and typing a message into
  another session's terminal could answer a dialog or run in the shell. A session with no
  Claude running can't be messaged until it is revived.
- Renaming a session doesn't rename a running Claude; the new name applies at the next typed
  `claude`, and the sidebar shows the mismatch meanwhile.

## Installing the skill

The skill is what makes an agent in **any** project's session know the CLI exists. It goes
in your user skills folder (`~/.claude/skills/`).

**The server installs it at every boot** (`installSkillsAtBoot()`,
`src/server/utils/skill-install.ts`), from the checkout it runs from, so a landed change to
the skill reaches you on the next restart. Installing used to be a manual step after every
change, and on 2026-10-03 the skill turned out never to have been installed: agents had no
way to learn about `start` or `land`. An isolated boot (`CLAUDE_REMOTE_CONFIG` set) skips
it, because it usually runs a worktree's build and would install a skill that hasn't
landed. A failed install is logged and never fails the boot.

To install without a restart:

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

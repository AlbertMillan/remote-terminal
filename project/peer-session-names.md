# Sessions are addressable by their claude-remote name

Track: Session orchestration

## Goal

Agents message each other with Claude Code's own `ListAgents`/`SendMessage`. Those list
every running Claude session on the machine by **Claude's** name, which it derives from the
folder plus a random suffix (`rimworldy-ae`, or `8b4cd966-0a` for a track worktree). The
claude-remote name (`planner`) never reaches Claude. When an agent asks "which one is the
planner?", neither it nor the user can answer: the sidebar shows `planner` and `ListAgents`
shows `rimworldy-ae`, with nothing linking the two.

Two changes close that gap:

1. Every `claude` command claude-remote types carries `--name "<session name>"`, so those
   sessions show in `ListAgents` under the name the sidebar uses.
2. The sidebar shows each session's Claude name when it differs, for sessions where the user
   typed `claude` themselves (no `--name`), so the user can answer the agent.

## Depends on

- `f-s3w8qd` (started sessions, `startCommand()` in `sessions-api.ts`) and the revive, resume
  and fork paths in `session-open.ts`, all of which type through `injectCommand()`.
- The `claude-session` hook, which records each session's `claudeSessionId`.

## Findings (checked 2026-10-24, Claude Code 2.1.310)

- `claude -n <name>` / `--name <name>` sets the session's display name. A session started
  with `-n cr-name-probe` showed in `ListAgents` as `cr-name-probe`, not
  `claude-remote-xx`.
- Claude keeps a live registry at `~/.claude/sessions/<pid>.json`, one file per running
  interactive session: `{ pid, sessionId, cwd, name, nameSource, status, … }`.
  `nameSource` is `derived` (folder-based) or `user` (`--name` or `/rename`). `name` is
  exactly what `ListAgents` shows, and `sessionId` is the id our hook records.
- The bracketed tag in `ListAgents` (`[c5a490]`) is **not** a session-id prefix, so showing
  an id prefix in the sidebar would not help.
- A `claude` launched with this session's `CLAUDE_CODE_*` markers in its env never
  registers. claude-remote PTYs already strip them (`utils/claude-env.ts`), so nothing to
  do. Just don't test this from inside an agent without stripping them.

## Design decisions

1. **`--name` on every typed `claude`.** One helper builds the flag from the session's
   name, used by `startCommand()` (agent start), `injectResumeCommand()` (revive, history
   resume) and fork. A revive gets it too, so a session keeps its name after a server
   restart even though its Claude process is new.
2. **An unsafe name gets no `--name`, never a refusal.** The quoting rule matches
   `startCommand()`'s: a name holding `"`, `%`, `$`, a backtick or a newline is left off the
   command (Claude falls back to its derived name), since a broken quote would run the rest
   as shell. Losing the name is harmless. Refusing would block a revive over a cosmetic.
3. **Renaming a session in claude-remote doesn't rename a running Claude.** There is no API
   to do it. The new name applies at the next typed `claude` (revive, resume). The sidebar
   (below) shows the mismatch meanwhile.
4. **The sidebar reads Claude's registry, read-only.** The server maps
   `claudeSessionId` → registry entry and sends `claudeName` with each session. The sidebar
   shows it in the status line, in the accent color, only when it differs from the
   claude-remote name (`active · @rimworldy-ae`; option B of the mockup), so named sessions
   look as they do today. No registry entry means no Claude running there: show nothing.
   The client only fetches the list on connect, so the server polls the registry every 5 s
   and pushes `session.claudeNames` (the full map) whenever it changes: Claude starts,
   exits and `/rename`s without telling us.
5. **The registry is Claude Code's internal format.** Parse defensively: unreadable or
   unexpected files are skipped, a missing folder means no names, and nothing throws. Skip
   entries whose `pid` isn't alive (a killed Claude leaves its file behind). Read it when
   the session list is built, with a short cache, never per keystroke. Never write it.
6. **No `peers` CLI command and no claude-remote mailbox.** Claude's `SendMessage` already
   delivers between any two running sessions on the machine, whatever their project, so a
   claude-remote directory would gate nothing. Typing a message into another session's
   terminal could answer a dialog or run in the shell (the reason
   `docs/session-orchestration.md` gives for never retyping a prompt).

## Planned changes

- `src/server/sessions/session-open.ts`: a `claudeNameFlag(name)` helper (or in a small
  shared module). Use it in `injectResumeCommand()` and fork.
- `src/server/agent/sessions-api.ts`: `startCommand()` takes the session name and adds the
  flag.
- `src/server/sessions/claude-registry.ts` (new): `claudeNamesBySessionId()`, which reads
  `~/.claude/sessions/*.json`, checks `pid` liveness and caches for a few seconds.
- Session list payload: add `claudeName: string | null`. Sidebar
  (`session-list-view.ts`): render it muted after the name when it differs.
- `skills/claude-remote-sessions/SKILL.md`: one line saying that sessions claude-remote
  starts appear in `ListAgents` under their claude-remote name.
- `docs/session-orchestration.md`: a short section on names and the registry.

## Verification

- Unit: `claudeNameFlag` quotes safe names and omits unsafe ones. `startCommand` includes it.
  The registry reader skips malformed files, dead pids and a missing folder.
- Isolated boot (`project/QA.md`, Flow 3): start a session via the CLI, then confirm that
  `ListAgents` from another session shows its claude-remote name. Revive it after a restart
  of the isolated server and confirm the name survives. Type `claude` by hand in another
  session and confirm the sidebar shows its derived name.

## Out of scope

- Messaging a session with no Claude running (it needs a revive first. An agent reviving
  other sessions is a bigger permission).
- Renaming a running Claude when the claude-remote name changes.

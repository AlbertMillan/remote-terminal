# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Claude Remote is a secure, self-hosted remote terminal system enabling web-based access to isolated terminal sessions over Tailscale. It provides a web-based xterm.js terminal with session persistence (tmux on Linux/macOS, scrollback buffer on Windows).

## Commands

```bash
npm run dev           # Development with hot reload (tsx watch)
npm run build         # Build both server and client
npm start             # Run production build
npm test              # Run tests (vitest)
npm run lint          # Lint with eslint
npm run format        # Format with prettier
```

## Architecture

**Server** (Fastify + WebSocket):
- `src/server/index.ts` - Entry point, starts Fastify server
- `src/server/app.ts` - Fastify configuration and route setup
- `src/server/sessions/manager.ts` - Session lifecycle (create/attach/terminate)
- `src/server/sessions/pty-handler.ts` - node-pty wrapper with ScrollbackBuffer
- `src/server/websocket/handler.ts` - WebSocket connection management
- `src/server/websocket/protocol.ts` - Message types and serialization
- `src/server/db/` - SQLite database (better-sqlite3) for session persistence
- `src/server/auth/tailscale.ts` - Tailscale identity verification via `tailscale whois`

**Client** (xterm.js):
- `src/client/terminal.ts` - xterm.js wrapper with FitAddon
- `src/client/session-manager.ts` - WebSocket client and session UI

**Data Storage**: `~/.claude-remote/` (sessions.db, config.json, logs/)

## Key Technical Details

- **Default port**: 4220
- **Module system**: ESM with path aliases (`@server/*`, `@client/*`)
- **Node version**: 20+
- **Platform differences**: Windows uses ConPTY with scrollback persistence to DB; Linux/macOS uses native PTY with optional tmux persistence
- **Build tooling**: esbuild for production, tsx for development

## WebSocket Protocol

Endpoint: `/ws`

Client messages: `session.create`, `session.attach`, `session.terminate`, `session.list`, `terminal.data`, `terminal.resize`, `ping`

Server messages: `session.created`, `session.attached`, `terminal.data`, `terminal.exit`, `pong`

## Windows Auto-Start

Scripts for running the server on Windows:

- `start-server.bat` - Batch file that runs `node dist/server/index.js`
- `start-server-hidden.vbs` - VBS wrapper to run without a visible console window

**Enable auto-start on login:**
Copy `start-server-hidden.vbs` to `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\`

**Manual start (hidden):**
```bash
wscript.exe start-server-hidden.vbs
```

**Remove auto-start:**
Delete the VBS file from `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\`

**Inherited session markers:** restarting from inside a claude-remote terminal means the
server inherits that conversation's `CLAUDE_CODE_CHILD_SESSION=1` and friends. The VBS
launcher detaches the process *tree*, not the *environment*. Left in place, every PTY
inherits the marker and every `claude` in it silently skips saving its transcript --
which breaks Fork, resume history, job take-over and SESSION-LOG all at once, with the
only symptom a one-line warning inside the terminal. `src/server/utils/claude-env.ts`
strips the markers at boot and again at the PTY chokepoint; it is a denylist of
session-scoped vars, never a `CLAUDE_*` wildcard, so the user's own settings survive.

## Notification System

The server supports webhook notifications to alert users when Claude Code needs input or completes tasks.

**HTTP Endpoint**: `POST /api/notify/:sessionId/:type`
- Types: `needs-input`, `completed`
- Sessions pass `CLAUDE_REMOTE_SESSION_ID` env var to PTY processes

**WebSocket Messages**:
- Server sends: `notification` (with sessionId, type, timestamp)
- Client sends: `notification.dismiss`, `notification.preferences.get`, `notification.preferences.set`

**Claude Code Hooks** (add to `~/.claude/settings.json`):
```json
{
  "hooks": {
    "Stop": [{
      "hooks": [{
        "type": "command",
        "command": "[ -n \"$CLAUDE_REMOTE_SESSION_ID\" ] && curl -s -X POST \"http://localhost:4220/api/notify/$CLAUDE_REMOTE_SESSION_ID/completed\""
      }]
    }],
    "Notification": [{
      "matcher": "permission_prompt|idle_prompt|elicitation_dialog",
      "hooks": [{
        "type": "command",
        "command": "[ -n \"$CLAUDE_REMOTE_SESSION_ID\" ] && curl -s -X POST \"http://localhost:4220/api/notify/$CLAUDE_REMOTE_SESSION_ID/needs-input\""
      }]
    }]
  }
}
```

Note: Claude Code runs hooks via bash (`/usr/bin/bash`) on Windows too, so use bash `$VAR` syntax. The `[ -n "$VAR" ]` guard ensures the hook is a no-op when not running inside a claude-remote session.

## Session Fork Feature

The fork button in the terminal header branches the current Claude Code conversation into an independent new session (copies the JSONL transcript to a new UUID, then runs `claude --resume <new-uuid>`). The fork is ephemeral — its transcript is deleted when the session is closed. Click **Keep** to make it permanent.

**Required hook** — add to `~/.claude/settings.json` so the server knows the Claude session ID:
```json
{
  "hooks": {
    "SessionStart": [{
      "hooks": [{
        "type": "command",
        "command": "[ -n \"$CLAUDE_REMOTE_SESSION_ID\" ] && curl -s -X POST \"http://localhost:4220/api/session/$CLAUDE_REMOTE_SESSION_ID/claude-session\" -H \"Content-Type: application/json\" -d \"{\\\"claudeSessionId\\\": \\\"$CLAUDE_CODE_SESSION_ID\\\"}\""
      }]
    }],
    "Stop": [{
      "hooks": [{
        "type": "command",
        "command": "[ -n \"$CLAUDE_REMOTE_SESSION_ID\" ] && curl -s -X POST \"http://localhost:4220/api/session/$CLAUDE_REMOTE_SESSION_ID/claude-session\" -H \"Content-Type: application/json\" -d \"{\\\"claudeSessionId\\\": \\\"$CLAUDE_CODE_SESSION_ID\\\"}\""
      }]
    }]
  }
}
```

`SessionStart` registers the ID immediately on launch (including `--resume`), so Fork is available without needing to send any message first. `Stop` keeps it updated in case the session ID changes.

## Deleting Session History Entries

Each entry under a project's **Session history** has a **Delete** button next to Resume/Fork.
It removes the entry from that project's `SESSION-LOG.md` and unlinks the backing Claude
transcript (`~/.claude/projects/<slug>/<claudeSessionId>.jsonl`).

`POST /api/project-logs/entry/delete` with `{ cwd, entryIndex, claudeSessionId, scope }`:

- `entryIndex` is the entry's position in `parseLogEntries()` order (newest first). The server
  re-reads and re-parses the log and returns **409** if `claudeSessionId` doesn't match what
  actually sits at that index — the board is a poll snapshot and the generator may have
  prepended an entry since, which would shift every index.
- `scope`: `'entry'` (default) removes just that entry; `'conversation'` removes every entry
  carrying the same `claudeSessionId`.
- The transcript is only unlinked once **no surviving entry references it**. The generator
  writes one entry per session close, so a long-running conversation has several entries backed
  by a single `.jsonl`. The response reports `transcriptKeptReason` when it was kept
  (`still-referenced`, `session-live`, `no-session-id`, `not-found`, `unsafe-id`, `failed`), and
  the UI offers a checkbox to widen the delete to the whole conversation when siblings exist.
- Transcripts are only unlinked when the marker's session id is a plain UUID resolving inside
  `~/.claude/projects` — marker text comes from a user-editable markdown file, so it is treated
  as untrusted input.

Server-side logic lives in `src/server/sessions/history-delete.ts`; the log rewrite itself is
`removeLogEntry()` in `session-log-format.ts`, which slices marker→next-marker so the file
header and the `claude-remote-phases` manifest are always preserved.

## Project Workspace & Job Pipeline

The **Projects** tab is a workspace over a canonical, per-project `PROJECT.md`, not a
view of `SESSION-LOG.md`. Server code lives in `src/server/projects/` and
`src/server/jobs/`; the client in `src/client/{project-workspace,job-board,rollup-view}.ts`.

**Canonical docs** (in each project, committed):

```
PROJECT.md              frontmatter (name/status/verify) + "## Track:" feature lines
project/<slug>.md       one feature's spec
project/QA.md           driver + commands + flows = what "verified" means here
project/reviews/        per-job review findings (gitignored)
```

Feature lines are `- [x] \`f-ab12cd\` P1 Title → project/slug.md`. Ids are
server-generated and **stable** — jobs and findings reference them.
`project-doc-format.ts` is the single source of truth for the format; parsing never
throws and unrecognized lines round-trip verbatim.

**Reads are deterministic parsing; writes are plain server writes.** An agent authors
`PROJECT.md` exactly once, at migration (`migrate.ts`), converting whatever plan docs a
project already has. Every UI write carries a content-hash `revision` and returns **409**
when the file changed underneath (same staleness contract as `history-delete.ts`).

**Registry**: `~/.claude-remote/projects.json` stores paths only — roll-up rules fold
nested dirs into a parent, `splitChildren` roots keep their children separate. Discovery
also recovers projects whose transcripts were deleted, by decoding the
`~/.claude/projects` slug against the filesystem (`slug-decode.ts`).

**Job pipeline** (`src/server/jobs/`): dispatching a feature runs it through
design → implement → integrate → review → fix → qa → merge → rebuild in its own git
worktree under `~/.claude-remote/worktrees/`. Three gates stop for approval: after
**design** (see the decisions before code), after **review** (tick which findings to fix),
and before **merge**. A stage that hits a real decision parks with the question rather
than guessing; **Take over** resumes that run's own Claude conversation in a terminal.

- `scheduler.ts` is a swappable `SchedulePolicy` — `OneRunningJobPerProject` ships.
- The merge gate is checked **before** its stage, so parked jobs keep `stage` on the last
  *completed* stage and approval is recorded in `approved_gate`. Changing this breaks the
  gate (see `tests/job-gates.test.ts`).
- **Cancel and Discard are split by status and neither accepts the other's.** Cancel stops a
  live job (`queued`/`running`/`parked`), aborting the stage mid-flight via an `AbortSignal`
  that `spawnClaude` turns into a `killTree()`. Discard cleans up a terminal job
  (`failed`/`done`/`cancelled`): worktree and branch removed, row deleted. Offering one verb
  for both is what once left `failed` jobs unremovable — the board rendered Cancel and the
  server answered 409.
- **Cancel's step order is load-bearing**: mark `cancelled` → abort → *await the stage
  unwinding* → tear down. The `catch` in `runNextStage` must keep its `stillLive()` guard, or
  the aborted run's rejection rewrites the cancellation as `failed`; awaiting the run before
  teardown is what stops `git worktree remove` racing a dying process's open file handles.
  Both are covered in `tests/job-runner.test.ts`.
- Discard restores the project exactly **only for a job that never merged** — the merge stage
  is the single thing a job does outside its worktree. A landed merge is reported
  (`mergeLanded`) and deliberately left in place; reverting it is manual.
- Stage runs use `jobs.stageTimeoutMs` (20 min), **not** `projectLog.timeoutMs` (180s, the
  session-log budget). Stages borrowed the latter and were being killed with finished work in
  hand.
- QA never reports unverified work as verified: precedence is failed > skipped > passed,
  so one trivial passing command cannot mask a driver that never ran.
- Token/cost accounting hangs off `RunOptions.onUsage` in `agent/claude-run.ts`, which
  fires **before** the error and denial checks **and on the failure paths** — a rejected
  run still spent its tokens, and so did a stage killed at the 20-minute timeout. Those
  rejections carry the parsed figure out on the error (`SpentOnFailure.spentUsage`); a run
  that died before printing an envelope reports nothing at all, because "we don't know" is
  not the same as "it cost nothing".
  `addStageUsage()` adds rather than replaces (qa and fix run several passes per stage),
  and totals are summed with `sumUsage()`, never stored. Read `modelUsage`, not the
  envelope's `usage` block: on a multi-turn run `usage` reports only the final turn.
  See `docs/token-usage-feature.md`.
- Non-git projects are `git init`ed and never pushed; Plastic workspaces are refused.

## Keyboard Shortcuts Display

All keyboard shortcuts are registered in a single source of truth: `src/client/shortcuts.ts` (`SHORTCUT_GROUPS`). Two surfaces render directly from this registry, so they never drift:
- The "Keyboard Shortcuts" modal — open it with the **?** key or the keyboard icon in the sidebar header (`#shortcuts-btn`).
- The welcome screen's shortcut hints (`#welcome-shortcut-group`).

**When adding a new shortcut**, register it in `SHORTCUT_GROUPS` (in addition to wiring up its handler) so it automatically appears in both displays. No HTML/CSS changes are needed.

## Logging & Debugging

Logs are written to `~/.claude-remote/logs/server.log` (JSON format, rotates every 3 days).

**View recent logs:**
```bash
cat ~/.claude-remote/logs/server.log | npx pino-pretty | tail -50
```

**Error handling:** The server has handlers for `uncaughtException` and `unhandledRejection` that log fatal errors before exiting. Check the log file to diagnose unexpected crashes.

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

## Reviving Stale Sessions

A session in the left panel renders `(stale)` when its DB row outlived its PTY — `attachable`
is purely "is there a live PTY in memory for this id" (`manager.ts`), so after every server
restart every row is stale. `shutdown()` parks sessions as `idle` rather than `terminated`
specifically so they can come back.

Stale rows carry a **play** button beside Delete. It sends `session.revive` and
`reviveSession()` brings the row back **in place**: same id, name, category, sort order and
scrollback, new PTY in the stored cwd. A new session row is deliberately *not* created — that
was the alternative (reusing `session.open`) and it leaves a dead row behind every time.

- With a `claude_session_id` on the row, `claude --resume` is injected through the same
  `_injectResumeCommand` the Fork and history-Resume paths use. Without one, reviving just
  respawns the shell — useful on its own, and the button's tooltip says which you get.
- `_initSessionPty()` installs a **fresh, empty** `ScrollbackBuffer` and `getScrollback()`
  prefers the in-memory one, so revive explicitly seeds it from `restoreScrollbackRaw(id)`.
  Without that seed the scrollback persisted at shutdown is silently dropped on first attach.
  It is empty after a hard kill, since `persistScrollback` only runs on graceful shutdown.
- **No `maxSessions` check.** A stale row is already `status != 'terminated'` and so counts
  toward `countActiveSessions()`. Re-checking the cap here would make every session
  unrevivable after a restart at the limit.
- Forks are refused: `cleanupOrphanedForkFiles()` unlinks their transcript at boot, so there
  would be nothing to resume. A missing cwd is reported by name rather than falling back to
  home, which would resume the conversation in the wrong place.
- The icon is `play`, not the circular arrow — that one is `#refresh-projects-btn` and means
  refresh/retry elsewhere in the app. It reveals on row hover exactly like the Delete button
  beside it. The row carries `cursor: not-allowed`, which the button overrides for itself.

Two review findings are worth not re-introducing:

- A rejected `session.attach` must clear the client's `attachingSessionId` (`handleSessionError`).
  It is otherwise only cleared on a successful attach or a socket close, and the reconnect path
  routinely attaches to a session that went stale during the restart. A pinned flag makes every
  later `attachToSession()` for that id early-return, so the revived session runs with no
  terminal attached and no way back short of a page reload.
- Terminal `cols`/`rows` from any message go through `websocket/validation.ts` before reaching
  a PTY. `session.create` and `terminal.resize` each used to carry their own copy of the bounds;
  `session.open` and `session.revive` carried none.

Covered by `tests/session-revive.test.ts` and `tests/ws-validation.test.ts`.

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

## Reading a Parked Job's Question

A stage that stops rather than guess writes free prose into `job.detail`: one bullet per
open question, each running the question, its context, the alternatives it weighed and its
recommendation together. The board used to print that verbatim in a `pre-wrap` block, so
the question you had to answer read exactly like the paragraph explaining it, and the
model's own hard wraps pinned the text into a ~500px column of a 1400px panel.

`src/client/decision-format.ts` parses it into `{ preamble, cards }` — question, context
paragraphs, `(a)/(b)/(c)` options, and what the run would do — and `renderDecision()` in
`job-board.ts` gives each part its own element.

- **It is a parser over prose, not a markdown renderer.** The client has never had one and
  does not need one here: `stripMarks()` drops backticks and `**`, and the structure
  carries what the emphasis was for. It deliberately leaves `_` alone — that appears far
  more often inside identifiers (`MAX_HISTORICAL_DAYS`) than as emphasis, and stripping it
  would corrupt the very strings that make a question answerable.
- **Every rule degrades to "no match", never to a wrong match.** A block with no question
  stays whole as a plain note; a detail with no question at all returns `null` and the
  caller shows the text as written. Options need two markers running in order from `a`, so
  a lone "(a)" in prose is not mistaken for a list. Nothing the model wrote is dropped —
  `tests/decision-format.test.ts` asserts that against the real text that prompted this.
- A recommendation ends at its **sentence**, not at the end of the block. The boundary
  needs whitespace and then something that can open a sentence, so `§3.2`, `e.g.` and
  `0.5` do not end one. Taking the rest of the block instead swallows the context.
- `Recommends (b)` loses its lead-in because the callout's label repeats it. `Assumed`
  keeps it: in "I have assumed stop" the lead-in *is* the decision.
- **One answer box per question**, joined into the single string the server takes, each
  labelled with its question — the stage re-runs from its own prompt, and "stop" alone does
  not say which of two questions it settles. All boxes must be filled: a partial answer
  restarts a stage still missing what it stopped for.
- `render()` replaces the board's HTML wholesale and *is* triggered mid-decision (opening a
  spec, ticking a finding), so `captureDrafts()` reads part-written answers back out of the
  DOM first. `act()` returns whether the request landed, so a draft is only dropped once
  the answer was actually accepted.
- The card grid's `minmax(min(460px, 100%), 1fr)` needs the `min()`: with a bare `460px`
  the track is wider than the panel on a phone and the cards run off the side.
- **The question has to be self-contained, and `buildDesignPrompt` says so.** The run reads
  the repo; the person answering sees one paragraph on a card. A real question this stage
  asked opened "Question 2 is unanswerable with `bizumIn === 0`" — where Question 2 was
  item 2 of a numbered list in `SPEC.md`, a document the reader had never opened and which
  the spec itself only ever *referenced*. The prompt now requires the cited line to be
  quoted into the question, files named by path, and any constant the answer turns on
  spelled out. Parsing cannot substitute for this: the same spec's own numbered list is a
  *steps* list whose item 2 is `npm run aspsps`, so resolving "Question 2" against numbered
  items would have answered confidently and wrongly.

## Reading a Job's Documents

A stage writes its spec — and may edit other docs under `project/` — inside the job's
**worktree**, commits them to the job branch, and then parks asking about what it wrote.
None of that is in the user's checkout, so a question citing `§3.2` used to be
unanswerable without **Take over**. Every job card now carries a document pane
(`/api/jobs/:id/docs`, `/api/jobs/:id/file`, server code in `src/server/jobs/docs.ts`).

- The list is **what the branch changed** (`git diff --numstat`, exact) **union the
  markdown in the worktree** (context a question only read). Changed rows are marked and
  lead; the unchanged tail folds after eight. `git ls-files` is called with `--cached
  --others --exclude-standard`, and the changed-set mirrors `diffAgainst()`'s fallback to
  `git diff HEAD` — without either, a doc a *running* stage just wrote is missing and a
  job before its first commit reports nothing changed, while the diff pane beside it shows
  content.
- **A parked design records its spec path** (`parkOnQuestion(job, 'design', q,
  result.specPath)`). What stops implement building off an unapproved spec is
  `specPathOf()`'s `status === 'passed'` check in `runner.ts` — that check is now the
  *only* thing standing there, not a side effect of the detail field holding a label.
- `routes.ts` resolves the diff base from **`job.baseBranch`**, not
  `currentBranch(projectCwd)`. The old fallback is what `baseBranchOf()` in the runner
  warns about: a job parked while the user switched branches was diffed — and its document
  list computed — against whatever branch they happened to be on.
- There is **one viewer**: `View spec` opens the spec's row in the pane rather than
  rendering the file a second way. Documents are read-only; an edit made here would be
  swept into the branch by the next stage's `commitAll` and land in the merge.
- `/api/jobs/:id/docs` marks the spec row itself (`isSpec`), so the client never needs its
  own copy of "which stage states mean the detail is a path". This replaced a separate
  `/api/jobs/:id/spec` route. `specPathOf()` falls back to `specSlugFor()` when the
  recorded detail is not a path — jobs parked *before* the path was recorded carry the old
  `"Needs a decision"` label, and those are exactly the ones waiting on an answer now.
- Browser-supplied paths are untrusted: `resolveInWorktree()` resolves symlinks *before*
  the containment check. A job with no worktree answers `{ docs: [] }`, never an error —
  the board still renders `done` and discarded rows.

### Folding the pane

The pane's head is a `<button class="jb-docs-head">` that folds the list away, and a pane
the board loaded on its own (`loadDocsForParked()`) **starts folded** — so a parked card
reads question → answer box → a one-line `Documents · N changed by this run`. Without it,
the longest pane on the board sat above the boxes you had to type into.

- **Folding is a class, not a delete.** `docsCollapsed` on `JobBoard` is presentational
  state beside the `docs` cache; nothing discards the list any more. `toggleDocs()` used
  to drop `docs`/`openDoc`/`docsExpanded`, which is exactly why a job parked on a question
  could not be offered a hide button at all — `linked()` and `specPathOf()` read
  `this.docs`, so dropping it unlinks every `§3.2` in the question. Now the button is
  offered on every job with a worktree, and its label reads `Hide documents` only when the
  list is loaded *and* unfolded.
- **Only the first fetch folds.** `loadDocsForParked()` selects parked jobs with
  `!this.docs.has(j.id)` and refetches live ones already cached, so the add to
  `docsCollapsed` happens once. Folding inside `fetchDocs()` instead would let a poll
  re-fold a pane the user had just opened.
- **Anything that opens a document unfolds the pane** — `toggleDoc()`'s opening path *and*
  the top of `openReference()`. `openReference()` needs its own: it early-returns with a
  bare `render()` when the referenced document is already open, and `applyPendingAnchor()`
  would then scroll to a heading inside a `display: none` container and silently do
  nothing. With parked panes starting folded, that is every reference click, not an edge.
- Folding goes through `render()` like every other board toggle, so `captureDrafts()` runs
  and a half-typed decision survives it. `renderDocs()` always emits the `.jb-docs` shell,
  even for an empty list — a loaded pane with no header has nothing to unfold it by.

Covered by `tests/job-board-docs-dom.test.ts`.

### Linking the references in a question

`findReferences()` / `resolveReference()` in `decision-format.ts` turn `§3.2` and
`project/QA.md` into buttons that open the pane at that heading.

- The ladder is **unique among the documents this job changed → unique among all of them →
  plain text**. Global uniqueness alone links almost nothing, because `3.2` is a common
  heading; guessing between two is worse than not linking. Identifiers
  (`MAX_HISTORICAL_DAYS`) are never matched — there is no target for them.
- Linking only ever **wraps**, and runs through one `linked()` helper in `job-board.ts`
  rather than at each of the ~8 `escapeHtml()` sites, or references would be clickable in
  the options and dead in the recommendation. The escape and the splice have to happen
  together: escaping first moves the offsets `findReferences` returned.
- `headingNumbers()` (server) and `renderDocText()` (client) must stay in step — the
  server decides what a reference *can* resolve to, the client renders what it scrolls to.
  A single-level number counts only under a `#`; `3 files changed` is not a heading.

Covered by `tests/job-docs.test.ts` (against a real git repo) and
`tests/decision-format.test.ts`.

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

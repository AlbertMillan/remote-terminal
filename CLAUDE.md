# CLAUDE.md

Guidance for Claude Code working in this repository.

This file is loaded into **every** agent run here and re-read on every turn, so it holds
rules, not reasoning. The reasoning — the bug each rule came from, the alternatives
weighed, the review findings — lives in `docs/`, linked from each group below. **Before
changing a subsystem, read its doc.**

## Project Overview

Claude Remote is a secure, self-hosted remote terminal: web-based xterm.js terminals over
Tailscale, with session persistence (tmux on Linux/macOS, a scrollback buffer on Windows),
a project workspace over `PROJECT.md`, and a job pipeline that runs features through
isolated git worktrees.

## Commands

```bash
npm run dev           # Development with hot reload (tsx watch)
npm run build         # Build both server and client
npm start             # Run production build
npm test              # Run tests (vitest)
npm run lint          # Lint with eslint
```

Do **not** run `npm run format` / prettier: there is no `.prettierrc`, so it reformats the
whole tree to double quotes against the house style. Match the surrounding style by hand.

## Architecture

**Server** (Fastify + WebSocket):

- `src/server/index.ts` — entry point · `app.ts` — Fastify config and routes
- `src/server/sessions/manager.ts` — session lifecycle · `pty-handler.ts` — node-pty + ScrollbackBuffer
- `src/server/websocket/handler.ts` — connections · `protocol.ts` — message types · `validation.ts` — bounds
- `src/server/db/` — SQLite (better-sqlite3), schema and migrations
- `src/server/auth/tailscale.ts` — identity via `tailscale whois`
- `src/server/projects/` — registry, `PROJECT.md` parsing, workspace board
- `src/server/jobs/` — pipeline: `runner.ts`, `store.ts`, `stages/`, `docs.ts`, `worktree.ts`
- `src/server/agent/claude-run.ts` — the one hardened path for headless `claude -p` runs

**Client**: `terminal.ts` (xterm.js) · `session-manager.ts` (WebSocket + session UI) ·
`project-workspace.ts` · `job-board.ts` · `job-overlay.ts` · `decision-format.ts`

**Data**: `~/.claude-remote/` (sessions.db, config.json, logs/, worktrees/)

## Key Technical Details

- Default port **4220**; ESM with `@server/*` / `@client/*` aliases; Node 20+
- Windows uses ConPTY with scrollback persisted to SQLite; Linux/macOS use a native PTY
- esbuild for production, tsx for development
- Logs: `~/.claude-remote/logs/server.log` (JSON, rotates every 3 days) —
  `cat ~/.claude-remote/logs/server.log | npx pino-pretty | tail -50`

## WebSocket Protocol

Endpoint `/ws`. Client: `session.create`, `session.attach`, `session.terminate`,
`session.list`, `session.open`, `session.revive`, `terminal.data`, `terminal.resize`,
`ping`. Server: `session.created`, `session.attached`, `terminal.data`, `terminal.exit`,
`notification`, `pong`.

- Terminal `cols`/`rows` from **any** message go through `websocket/validation.ts` before
  reaching a PTY — every message carrying them, not just the ones that happened to.
- `handleSessionCreate` must `detachFromSession()` before `attachToSession()`, or the
  previous session's data listener leaks and keystrokes arrive twice.

## Sessions → `docs/session-revive.md`, `docs/session-fork.md`, `docs/session-history-delete.md`

- `attachable` means "a live PTY exists in memory", so **every** row is stale after a
  restart. `shutdown()` parks sessions as `idle`, never `terminated`, so they can revive.
- Revive brings a row back **in place** (same id, name, category, order, scrollback) and
  seeds the buffer from `restoreScrollbackRaw(id)` — a fresh `ScrollbackBuffer` wins
  otherwise and the persisted scrollback is silently dropped. No `maxSessions` check here.
- A rejected `session.attach` must clear the client's `attachingSessionId`, or every later
  attach for that id early-returns and the session runs with no terminal.
- Deleting a history entry unlinks its transcript only when **no surviving entry
  references it**; the index is re-parsed server-side and mismatches return **409**.
  Transcript ids are untrusted: a plain UUID resolving inside `~/.claude/projects`, or no
  unlink.
- Fork and history-Resume both inject through `_injectResumeCommand`. Forks cannot be
  revived: their transcripts are unlinked at boot.
- `src/server/utils/claude-env.ts` strips inherited `CLAUDE_CODE_*` session markers at boot
  and at the PTY chokepoint. It is a **denylist of session-scoped vars, never a `CLAUDE_*`
  wildcard** — otherwise the user's own settings die with it. Without it every PTY silently
  skips saving its transcript, breaking Fork, resume, take-over and SESSION-LOG at once.

## Job pipeline → `docs/job-pipeline.md`

design → implement → integrate → review → fix → qa → merge → rebuild, each in the job's own
worktree under `~/.claude-remote/worktrees/`. Gates: after **design**, after **review**,
before **merge**.

- The merge gate is checked **before** its stage, so a parked job keeps `stage` on the last
  *completed* stage and approval lives in `approved_gate`. Changing that breaks the gate.
- **Cancel** takes `queued`/`running`/`parked`; **Discard** takes `failed`/`done`/
  `cancelled`. Neither accepts the other's statuses — one verb for both is what once left
  failed jobs unremovable.
- Cancel's order is load-bearing: mark `cancelled` → abort → **await the stage unwinding** →
  tear down. The `catch` in `runNextStage` keeps its `stillLive()` guard or the abort is
  rewritten as `failed`; awaiting first stops `git worktree remove` racing open file handles.
- Discard restores the project only for a job that **never merged**. A landed merge is
  reported (`mergeLanded`) and left in place.
- Stages use `jobs.stageTimeoutMs` (20 min), **not** `projectLog.timeoutMs` (180s).
- QA precedence is failed > skipped > passed: one passing command must never mask a driver
  that never ran.
- `onUsage` fires **before** the error and denial checks **and on failure paths** — a killed
  run still spent its tokens. `addStageUsage()` adds rather than replaces. Read
  `modelUsage`, not the envelope's `usage` (which reports only the final turn).
- Non-git projects are `git init`ed and never pushed; Plastic workspaces are refused.
- A job's diff base is its recorded `baseBranch`, never the project's current branch — a job
  parked across a branch switch would otherwise be measured against the wrong thing.

### Agent runs — `src/server/agent/claude-run.ts`

- Runs queue **per project lane**; runs with no lane (session-log, migration) share the
  default one. A global queue made one project's stage wait on another's.
- A stage stamps `spawned_at` when its process actually starts; `started_at` is when it was
  admitted. The gap is queue wait, and showing it as work makes a job look hung.
- Every run passes `--strict-mcp-config` and `--disable-slash-commands`: a stage can call
  neither an MCP tool nor a skill, and the two listings cost ~7.3k and ~2.4k tokens of
  **every turn**. `--allowedTools` changes no tokens; it is a safety measure only.
- An answered question **resumes the session that asked** (`--resume`). A failed resume
  falls back to the full pass; `RunAbortedError` is re-thrown so a cancel is never re-run.
- Prompt-level scoping is advisory; enforcement is the post-run revert of anything touched
  outside the allowed globs. Keep both.
- The design prompt carries a length budget and requires self-contained questions: quote
  what you cite, because the reader sees the question and nothing else.

### Project docs

`PROJECT.md` (tracks of feature lines) · `project/<slug>.md` (one spec) · `project/QA.md`
(what "verified" means) · `project/reviews/` (per-job, gitignored).

- Feature ids `f-xxxxxx` are server-generated and **stable**: never renumber, reuse or
  rewrite one — jobs, specs and findings reference them.
- `project-doc-format.ts` is the only source of truth for the format; parsing never throws
  and unrecognized lines round-trip verbatim.
- Every UI write carries a content-hash `revision` and returns **409** when the file changed
  underneath.

## Job board → `docs/job-decisions.md`, `docs/job-documents.md`

- `decision-format.ts` is a parser over prose, not a markdown renderer. **Every rule
  degrades to "no match", never to a wrong match**, and nothing the model wrote is dropped.
- It leaves `_` alone: it appears in identifiers (`MAX_HISTORICAL_DAYS`) far more than as
  emphasis.
- One answer box per question; all must be filled, since the stage re-runs from its own
  prompt.
- `render()` replaces the board wholesale and fires mid-decision, so every toggle goes
  through it and `captureDrafts()` keeps part-written answers. Never hand-patch the DOM.
- The document pane lists what the branch changed (`git diff --numstat`) union the markdown
  in the worktree (`git ls-files --cached --others --exclude-standard` — tracked-only would
  miss a doc a running stage just wrote). Documents are **read-only**: an edit here would be
  swept into the branch by the next stage's `commitAll`.
- References (`§3.2`, paths) resolve unique-among-changed → unique-among-all → plain text.
  Linking only ever **wraps**, through one escape-and-link helper, or refs go live in some
  parts of a card and dead in others.
- Browser-supplied paths are untrusted: `resolveInWorktree()` resolves symlinks *before* the
  containment check.

## Keyboard shortcuts

`SHORTCUT_GROUPS` in `src/client/shortcuts.ts` is the single source of truth; the modal and
the welcome hints both render from it. Register a new shortcut there and both surfaces pick
it up — no HTML or CSS needed.

## Setup that lives outside the code

Hook configuration for notifications, fork and session ids: `docs/notifications.md`,
`docs/session-fork.md`. Windows auto-start (`start-server.bat`, the hidden VBS launcher):
`docs/windows-auto-start.md`. Session-log generation: `docs/session-log-feature.md`.
Token accounting: `docs/token-usage-feature.md`.

# CLAUDE.md

Loaded into every agent run here, every turn: it holds **rules**. The reasoning (the bug
each came from, alternatives, measurements) is in the `docs/` file linked from each group.
**Before changing a subsystem, read its doc.**

Claude Remote: a self-hosted remote terminal (xterm.js over Tailscale) with session
persistence (tmux on Linux/macOS, a SQLite-persisted scrollback on Windows/ConPTY), a
project workspace over `PROJECT.md`, and a job pipeline running features in git worktrees.

## Commands and environment

`npm run dev` (tsx watch) · `npm run build` · `npm start` · `npm test` (vitest) · `npm run lint`

- No formatter. **Never run prettier**: with no `.prettierrc` it rewrites the tree to double
  quotes. Match the surrounding style by hand.
- Port **4220** is the user's live server. In a track or job worktree, **never ask for a
  restart to test your code**: 4220 runs main's `dist/`, so it loads none of it and closes
  every terminal. Use the isolated boot (`project/QA.md`, Flow 3).
- ESM, `@server/*`/`@client/*` aliases, Node 20+, esbuild for production. Data and the live
  log: `~/.claude-remote/` (`logs/server.log`, JSON; read with `npx pino-pretty`). Tests
  write no log; an isolated boot logs next to its `CLAUDE_REMOTE_CONFIG`.

## Map

- Server: `index.ts` · `app.ts` · `sessions/` (`manager.ts`, `session-open.ts`,
  `boot-sweep.ts`, `pty-handler.ts`, `session-env.ts`) · `websocket/` (`handler.ts`,
  `connections.ts`, `handlers/`, `protocol.ts`, `validation.ts`, `origin.ts`) · `db/` ·
  `auth/tailscale.ts` · `projects/` (registry, `PROJECT.md`, board, tracks) · `jobs/`
  (`pipeline.ts`, `lifecycle.ts`, `store.ts`, `stages/`, `worktree.ts`; `runner.ts` only
  re-exports) · `agent/claude-run.ts` (every headless `claude -p`) · `agent/sessions-api.ts`
  (agent routes; CLI `scripts/cr-session.mjs`, skill `skills/claude-remote-sessions/`).
- Client: `terminal.ts` · `session-manager.ts` (+ its `*-view.ts`/`*-modal.ts`) ·
  `project-workspace.ts` · `job-board*.ts` · `job-overlay.ts` · `decision-format.ts`.

## WebSocket (`/ws`; message types in `protocol.ts`)

- `cols`/`rows` from **any** message pass `websocket/validation.ts` before reaching a PTY.
- `handleSessionCreate` calls `detachFromSession()` before `attachToSession()`, or the old
  session's listener leaks and keystrokes arrive twice.

## Two authors of change → `docs/change-provenance.md`

- Anything that reads, moves, reverts or attributes changes handles **both** job-built
  edits (recorded) and session-built edits (inferred), or it breaks for one way of working.
- Act on records by default; show inferences as **unticked** guesses, or unrelated work
  is reverted or moved.

## Sessions → `docs/session-revive.md`, `session-fork.md`, `session-history-delete.md`, `session-orchestration.md`

- `attachable` = a live PTY in memory, so every row is stale after a restart. `shutdown()`
  parks sessions `idle`, never `terminated`, so they can revive.
- Revive is **in place** (same id, name, order) and seeds from `restoreScrollbackRaw(id)`,
  or the persisted scrollback is dropped. No `maxSessions` check there.
- A rejected `session.attach` clears the client's `attachingSessionId`, or that session
  never gets a terminal again.
- History delete unlinks a transcript only if **no surviving entry** references it (index
  re-parsed server-side, 409 on mismatch); a transcript id must be a plain UUID inside
  `~/.claude/projects`, or nothing is unlinked.
- Fork, Resume, revive and started sessions all type through `injectCommand()`.
- **Every PTY gets its env from `sessionEnv(id)`**, or its agent can't use the CLI.
- `/api/agent/*` needs loopback **and** a session token (`authenticate()`, the one guard);
  the rest of `/api/*` is unauthenticated on `0.0.0.0`, so dropping either lets the tailnet
  run commands. Tokens live only in `session-env.ts`'s Map, never the DB, logs or scrollback.
- Started sessions (`spawned_by`) can't start sessions. Prompt files live under
  `<dataDir>/prompts/<id>/`, never in a worktree, or `commitAll` commits them.
- Worktrees get a **copy** of `.claude/settings.local.json` (`ensureLocalClaudeSettings`),
  never a link, never over an existing copy, and only once git ignores the path.
- `POST /api/agent/land` takes the track from the **caller's** worktree, never the request,
  and lands from `onResponse`, after the `202`: it closes the caller, whose agent needs its
  answer first. Never hold the project lock across that reply.
- `utils/claude-env.ts` strips inherited `CLAUDE_CODE_*` session markers with a
  **denylist**, never a `CLAUDE_*` wildcard (that kills the user's settings). Without it no
  PTY saves its transcript, breaking Fork, resume and SESSION-LOG.
- The server installs `skills/` into `~/.claude/skills` at boot (`installSkillsAtBoot`),
  never on an isolated boot, which would install an unlanded skill.

## Job pipeline → `docs/job-pipeline.md`

design → implement → integrate → review → fix → qa → merge → rebuild, each in the job's
worktree. Gates after **design**, after **review**, before **merge**.

- The merge gate is checked **before** its stage: a parked job keeps `stage` on the last
  completed one and approval in `approved_gate`.
- **Cancel** takes `queued`/`running`/`parked`; **Discard** takes `failed`/`done`/`cancelled`.
  Never one verb for both.
- Cancel: mark `cancelled` → abort → **await the stage unwinding** → tear down. Keep the
  `stillLive()` guard in `runNextStage`'s `catch`, or an abort is recorded as `failed`.
- Discard restores the project only for a job that **never merged** (`mergeLanded`).
- Stages use `jobs.stageTimeoutMs`, not `projectLog.timeoutMs`.
- QA precedence: failed > skipped > passed; a pass never masks a driver that never ran.
- Usage comes only from the transcript ledger (`src/server/usage/`), keyed by `message.id`,
  never the `claude -p` envelope. Every `runClaude` passes a `tag`, recorded in
  `agent_runs` **before** the spawn. Discard never deletes ledger rows; writes outside
  `usage/` call `invalidateUsageCache()`. → `docs/token-usage-feature.md`
- Non-git projects are `git init`ed and never pushed; Plastic workspaces are refused.
- `removeWorktree`'s steps are **independent** (a busy folder must not skip `branch -D`);
  a failed `createWorktree` deletes only the branch it created; track folders use 8 id
  chars (git refuses paths past ~210 on Windows).
- **Never link `node_modules` (or anything) into a worktree**: `git worktree remove`
  deletes through a junction. Install with the lockfile (`project-deps.ts`).
  `removeWorktree` unlinks every link before git runs and skips git while one remains.
- A job's diff base is its recorded `baseBranch`, never the project's current branch.

### Agent runs — `agent/claude-run.ts`

- Runs queue **per project lane**; lane-less runs share the default lane.
- `spawned_at` = process start, `started_at` = admission; the gap is queue wait, not work.
- Every run passes `--tools` (from `builtinToolsFor()`), `--strict-mcp-config` and
  `--disable-slash-commands`. Enabling MCP for a stage: scope `--mcp-config` to one server
  or keep `ToolSearch` in `--tools`, or every MCP tool loads eagerly.
- An answer **resumes the session that asked**; a failed resume re-runs the pass, but
  `RunAbortedError` is re-thrown so a cancel never re-runs.
- Prompt scoping is advisory; the post-run revert outside the allowed globs enforces it.
  Keep both.
- Design questions must be self-contained (quote what you cite) and within its length budget.

### Project docs

`PROJECT.md` · `project/<slug>.md` (spec) · `project/QA.md` · `project/reviews/` (gitignored)

- Feature ids `f-xxxxxx` are server-generated and **stable**: never renumber, reuse or
  rewrite one.
- `project-doc-format.ts` owns the format; parsing never throws, unknown lines round-trip.
- Every UI write carries a content-hash `revision`; a stale one gets **409**.

### Track branches → `docs/track-branches.md`

- Main's `PROJECT.md` owns backlog and landed tracks; a branched track's **worktree** owns
  its section and specs. Read via `readProjectPlan()`, write via `planFileFor()`, or the
  board and dispatch miss branched tracks. Never write `## Track:` on main for one.
  Worktree-file writes take the project lock.
- A move deletes a spec from main only if the worktree holds main's exact content.
- Land copies the section back to main **before** merging and resets the branch's copy to
  its merge-base. Merging main into a track branch must restore the track's section and
  specs (`updateTrackFromMain`): main holds the commit that deleted them.
- Plan commits on main use a **temporary index** (`commitOnHead`), never `git add`, or the
  user's staged work rides along. Land refuses staged files and uncommitted code, naming them.
- A job based on a track branch merges **in the track worktree** (`mergeCwd`), never pushes.
- Every job merge and Land records `merge_sha`; job merges carry `Job-Id`/`Feature`
  trailers (`jobs/merge-trailers.ts`).
- `track_branches` is unique only among **unlanded** rows (partial index).
- Worktree sessions are session-logged into main (`worktreeOwner()`), run there too, or the
  entry dies with the folder and the run holds it open (`EBUSY`).
- Land closes the worktree's running sessions **after** every refusal, awaiting each.
  Land, Delete and the board read `getRunningSessions()` (an exited shell holds nothing).
- Delete track reverts only merges tied by sha, trailer, or a **unique** `Merge job:
  <title>` subject, reading `--first-parent` merges only. Its order: preflight → cancel →
  revert `--no-commit` (conflict: abort + `reset --hard`) → teardown → edits → one commit.
- Land, Delete, Branch now and merges into a track share a **try** lock
  (`project-lock.ts`); never make it wait, or Delete deadlocks against a merge.
- `track-attribution.ts` is a guess (unticked in Delete); match files with
  `gitStatusEntries(cwd, { allUntracked: true })`.

## Job board → `docs/job-decisions.md`, `docs/job-documents.md`

- `decision-format.ts` parses prose: every rule degrades to **no match**, never a wrong
  one, and drops nothing. It leaves `_` alone (identifiers).
- One answer box per question, all required.
- `render()` replaces the board wholesale; toggles go through it, `captureDrafts()` keeps
  drafts. Never hand-patch the DOM.
- Documents are **read-only** (the next `commitAll` would sweep an edit in). The pane
  lists `git diff --numstat` plus `git ls-files --cached --others --exclude-standard`.
- Reference linking only **wraps**, through one escape-and-link helper.
- `resolveInWorktree()` resolves symlinks before its containment check.
- Hiding the pane is the `docsCollapsed` class, never dropping `this.docs`; opening a
  document always unfolds it (`openReference()`'s early return included).

## Elsewhere

Shortcuts: register in `SHORTCUT_GROUPS` (`src/client/shortcuts.ts`) only. Hooks:
`docs/notifications.md`, `docs/session-fork.md`. Auto-start: `docs/windows-auto-start.md`.
Session logs: `docs/session-log-feature.md`. Plan usage chip: `docs/plan-usage.md`
(`scripts/statusline.mjs` prints first and never waits on the server).

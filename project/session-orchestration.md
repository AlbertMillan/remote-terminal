# Sessions that start sessions

Track: Session orchestration

## Goal

A main session that has just written tracks and specs can start a session on each track
and hand it its prompt, without the user opening each one and typing the prompt.

Today the user does this by hand for every track: New Session → Track picker → type the
prompt. The main session already knows the specs it wrote, so it can write a better prompt
for each track than the user retyping it.

The first version gives the main session two things:

- **Start** a session in a track's worktree, with a prompt and a permission mode.
- **List** the sessions it started, with each one's state.

The sidebar shows the started sessions nested under the session that started them.

## Design decisions

### How the main agent calls it

- **A Node CLI, `scripts/cr-session.mjs`, plus a skill.** No MCP server: its tool
  definitions would be in every turn of every session, and the skill costs only its
  one-line description until it is used.
  - `node "$CLAUDE_REMOTE_CLI" start --track "<name>" [--name <n>] [--mode default|acceptEdits|plan]`,
    with the prompt on stdin
  - `node "$CLAUDE_REMOTE_CLI" list`
  - It prints JSON, and has no dependencies beyond Node's `fetch`.
- **The prompt comes in on stdin, and only there.** The agent passes it inline with a
  quoted heredoc, so it never writes a file of its own:

  ```bash
  node "$CLAUDE_REMOTE_CLI" start --track "Split view" --mode acceptEdits <<'EOF'
  Implement f-xxxxxx per project/split-view.md. ...
  EOF
  ```

  - The quoted `'EOF'` stops the shell expanding `$`, backticks and quotes in the prompt.
  - The Bash tool on Windows is Git Bash, so this works there too.
  - The whole prompt is in the Bash call the user approves, so they see what each
    session will be told.
  - There is no `--prompt "…"` argument: it breaks on quotes in the prompt and on
    Windows' command-line length limit.
  - Empty stdin, or stdin still attached to a terminal, is an error before any request
    is sent.
- **The server tells each session where things are.** Every PTY gets `CLAUDE_REMOTE_URL`
  (the server's own base URL, so the CLI doesn't guess the port or protocol) and
  `CLAUDE_REMOTE_CLI` (the script's absolute path in this install), next to the existing
  `CLAUDE_REMOTE_SESSION_ID`. The skill works in any project's session, not just this repo.
- **The skill lives at `~/.claude/skills/claude-remote-sessions/SKILL.md`.** The repo
  keeps the source in `skills/claude-remote-sessions/SKILL.md`, and `docs/` says how to
  install it. It tells the agent:
  - Use it when the user asks to start work on tracks the agent planned. Never start
    sessions on its own initiative.
  - The track must already exist in `PROJECT.md`.
  - Write a self-contained prompt: the spec's path, what "done" means, tick the
    feature, and don't Land.
  - Use `--mode default` unless the user named a mode.

### Authentication

`/api/*` routes have no authentication today, and the server listens on `0.0.0.0`. An
endpoint that starts a shell and types into it would let anyone who can reach port 4220
run commands on this machine. So these routes, and only these, require both:

- **Loopback only.** `request.socket.remoteAddress` must be `127.0.0.1` or `::1`.
  `X-Forwarded-For` is never read.
- **A per-session token.** Each PTY gets `CLAUDE_REMOTE_TOKEN`: 32 random bytes,
  generated when the PTY is created and held **only in memory** (`Map<token, sessionId>`).
  The CLI sends it as `Authorization: Bearer …`.
  - The token tells the server which session is calling, so it can record who started
    each session and enforce the limit.
  - A revived session has a new PTY and so gets a new token. A token never outlives
    its PTY.
  - The token is never written to the database, logs or scrollback.
- **Every PTY creation site gets the env through one helper.** Today `manager.ts:134` and
  the three in `session-open.ts` each pass `CLAUDE_REMOTE_SESSION_ID`. A site missed is a
  session whose agent cannot use the CLI.
- **Headless `claude -p` runs (job stages, session-log) get no token.** A pipeline stage
  never starts sessions.

### Which sessions may start sessions

- **One level only.** A started session's token is refused by `start` (403). That keeps
  the sidebar to one level of nesting and stops a runaway chain.
- **Limit: `agentSessions.maxPerParent` in `config.json`, default 5.** It counts the
  caller's started sessions that are still live (attachable). It's checked before the
  global `sessions.maxSessions`, which still applies.

### Start: what the server does

`POST /api/agent/sessions` with `{ track, prompt, name?, permissionMode? }`:

1. **Authenticate**, refuse a started session (403), and check the limit (429).
2. **The project is the caller's.** Resolve the caller session's cwd to its workspace
   project. The cwd may be the main checkout or one of its track worktrees. No project,
   then 400.
3. **The track must exist in the plan** (`readProjectPlan()`), or 404. The agent can't
   invent a track name that nobody planned.
4. **Branch and install**, exactly as the Track picker does: `ensureTrackBranch()`, then
   `installDependencies()` when `needsInstall()`. The CLI waits, since an install can
   take minutes.
   - A failed install still starts the session, as for a track session the user opens.
     The response carries the install failure, so the main agent can pass it on.
5. **Write the prompt** to `~/.claude-remote/prompts/<sessionId>.md`, never inside the
   worktree, or the next `commitAll` sweeps it into the branch. Cap it at 100 KB.
   - The file is internal: the main agent and the user never handle it. It exists
     because the server can only type into the new session's shell, and a long,
     multi-line prompt on that command line breaks. A newline sends the command early,
     PowerShell and bash quote differently, cmd.exe can't take a multi-line argument,
     and the terminal echoes the whole prompt.
   - **Not by pasting into `claude` after it starts.** That would need the server to
     detect Claude's input box. A guess made too early types the prompt into the shell,
     which **runs it as commands**.
   - **Not through an environment variable.** The syntax differs per shell, every tool
     the session runs inherits the variable, and Windows caps the environment's size.
6. **Create the session** in the worktree: name `--name`, or the track name. Persist
   `spawned_by` and `permission_mode`.
7. **Type the command** once the shell is ready:
   `claude --permission-mode <mode> "Read <prompt path> and follow it."`
   - The path uses forward slashes, so neither PowerShell nor bash reads a backslash as
     an escape.
   - `injectResumeCommand` already does this readiness wait (first output, 100 ms
     debounce, 5 s fallback). Generalise it into `injectCommand(session, line)`, which
     resume, fork and this all call.
8. **Tell every open browser.** Today only the client that asked learns about a new
   session (`session.created`). A server-started session has no such client, so add a
   `session.added` broadcast carrying its `SessionInfo`. It never attaches anyone.
9. Return `{ sessionId, name, worktreePath, install }`.

**Permission modes allowed: `default`, `acceptEdits`, `plan`.** `bypassPermissions` is
refused (400). The user approves the main agent's Bash call, but would have to read the
flags to notice a bypass inside it.

### List: state of the started sessions

`GET /api/agent/sessions` returns the caller's started sessions: id, name, track,
`status`, `attachable`, `permissionMode`, and the last notification (`needs-input` or
`completed`, with its time) from `notificationService`.

There is **no "working" state**: claude-remote only learns about a session through the
`Notification` and `Stop` hooks. Detecting "working" is a separate feature that
`list`, and a later `wait`, would build on.

### Sidebar: nested under the main session

- **Children render under their parent**, in the parent's category, whatever their own
  `categoryId` is. They are indented, with a vertical guide line.
- **The parent's row gets a collapse arrow.** Collapsed or open is per browser
  (`localStorage`) and defaults to open.
- **The parent's status line summarises its children**: how many need input, how many
  have completed, and how many it started. It stays visible when collapsed, so a hidden
  child that needs the user still shows.
- **A permission-mode chip** appears on a child whose mode isn't `default`.
- **Children can't be dragged in v1.** They stay in creation order. Dragging a child to
  another category while it shows under its parent would look like it did nothing.
- **A deleted parent** leaves its children as ordinary sessions. `spawned_by` still
  points at the gone id, and the client renders any child whose parent isn't in the list
  as top-level. A terminated but undeleted parent keeps its group.
- **Phone.** The phone's session list is the same `session-list-view.ts`, shown as a
  drawer; `mobile-nav.ts` is only the key bar. So the grouping needs no separate
  rendering. The collapse arrow is its own button with a tap area of at least 32 px, and
  it stops the event, so tapping it never opens the parent and tapping the row never
  collapses it. Nothing in the group depends on hover.

### Provenance

A started session works in a track worktree, so its edits belong to that track by where
they happened, as for any track session (`docs/change-provenance.md`). `spawned_by` is a
record of who started it, not a guess about what it changed.

## Planned changes

- `src/server/db/`: a migration adding `spawned_by TEXT` and `permission_mode TEXT` to
  `sessions`. `SessionMetadata`, `SessionInfo` and `sessionToInfo()` carry both.
- `src/server/sessions/`: one `sessionEnv(id)` helper used by every `createPty` site; an
  in-memory token map with lookup and removal on PTY exit; `injectCommand()` replacing
  `injectResumeCommand()`; deleting the prompt file with its session row.
- `src/server/agent/sessions-api.ts` (new): the two routes and the loopback and token
  check, registered in `app.ts`.
- `src/server/config.ts`: `agentSessions.maxPerParent`.
- `src/server/websocket/`: `session.added` in `protocol.ts` and a broadcast in
  `connections.ts`.
- `src/client/session-list-view.ts` (+ `styles.css`): nesting, collapse, summary, chip.
  `session-manager.ts` handles `session.added`.
- `scripts/cr-session.mjs` (new), `skills/claude-remote-sessions/SKILL.md` (new).
- `docs/session-orchestration.md`: the auth model and install steps for the skill.
- `CLAUDE.md`, Sessions group:
  - Agent-session routes are loopback plus token, and the token lives only in memory.
  - Every PTY gets its env through `sessionEnv()`.
  - Started sessions can't start sessions.

## Verification

- **Unit, auth:** a non-loopback address → 403. A missing, wrong, or exited-PTY token →
  401. A started session's token on `start` → 403.
- **Unit, start:**
  - An unknown track → 404.
  - The limit reached → 429.
  - `bypassPermissions` → 400.
  - A prompt over 100 KB → 413.
  - The prompt file is written outside the worktree and removed when its session is
    deleted.
  - `spawned_by` and `permission_mode` are persisted.
- **Unit, CLI:** the prompt is read from stdin and sent unchanged, including quotes, `$`
  and newlines. Empty stdin, or stdin attached to a terminal, fails before any request.
- **Unit, `injectCommand`:** the typed line has forward slashes and the chosen mode.
  Resume and fork still type `claude --resume <id>`.
- **Unit, env:** every PTY creation path sets `CLAUDE_REMOTE_SESSION_ID`,
  `CLAUDE_REMOTE_TOKEN`, `CLAUDE_REMOTE_URL` and `CLAUDE_REMOTE_CLI`.
- **Manual, on the isolated boot from `project/QA.md` (Flow 3), never the server on
  4220:**
  - From a session, run `start` for a backlog track. The branch and install happen, a
    nested session appears in two open browsers, and `claude` starts in the chosen mode
    reading the prompt.
  - `list` shows `needs-input` once that session asks for a permission.
  - Collapse the group. The parent's summary still shows the needs-input count.
  - On a phone over Tailscale: the group shows in the drawer. Tapping the arrow
    collapses it without opening the parent. Tapping a child opens it, and its
    permission prompt can be answered there.
  - Run `start` from inside the started session → refused.
  - Restart the isolated server. The group is still nested, a revived child gets a new
    token, and its old token is refused.

## Out of scope

- `wait` (block until a started session needs input or finishes), and a "working" state.
- Sending a follow-up prompt to a session that is already running.
- Starting sessions outside a track, or for agents other than Claude Code.
- More than one level of nesting.
- A board button for the user to start a prompted session. The Track picker already
  opens a session in a track, and the user types their own prompt.

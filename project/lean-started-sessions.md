# Started sessions load no MCP servers unless asked

Track: Session orchestration

## Goal

A session started by a main session (`f-s3w8qd`) loads the user's whole MCP roster: every
user-scope server, the plugins and the claude.ai connectors. On this machine that is
**~21k tokens of every call's prompt** (a trivial `claude -p`: 54.5k with the roster, 33.3k
with `--strict-mcp-config`). Started sessions re-read that prefix on every turn, and they
never use it: across the 13 sessions the rimworldy planner started (1,764 API calls), not
one MCP tool was called.

Headless job runs already drop it (`claude-run.ts`, `--strict-mcp-config`). Started sessions
get the same default, with a way to ask for a server when a task needs one.

## Design decisions

### No MCP by default, opt-in by server name

- **The typed command adds `--strict-mcp-config`.** No server loads unless the start named it.
- **`start --mcp <name>`** (repeatable, or comma-separated) opts one server in. The server
  looks the name up in the user's Claude config, writes `{ "mcpServers": { <name>: … } }` to
  `<dataDir>/mcp/<sessionId>.json` and adds `--mcp-config "<that file>"`.
  - Lookup order is Claude Code's own precedence: local scope (`~/.claude.json`
    `projects[<project cwd>].mcpServers`), then the project's `.mcp.json`, then user scope
    (`~/.claude.json` `mcpServers`). Local scope is looked up for the main checkout and the
    worktree; `.mcp.json` up from both (the worktree's own folders nearest). The start
    checks before the worktree exists, and the worktree never gets a gitignored `.mcp.json`,
    so one chain alone would let a name pass the check and vanish at launch.
  - **A launch that gets fewer servers** (the config changed, or the file couldn't be
    written) still starts, like a failed install: the row keeps what it got and the
    response carries `mcp: { ok: false, servers, detail }`.
  - **A name that isn't found is refused (400)**, naming the servers that can be opted in.
    Plugin servers and claude.ai connectors aren't in those files and can't be scoped, so
    they're never available to a started session. Better to refuse than to start a session
    without the server the task needs.
  - The file goes in `<dataDir>/mcp/`, **never the worktree** (it can hold API keys, and
    `commitAll` would sweep it onto the branch) **nor the prompt folder** (`--add-dir` lets
    the session read that without asking). It is deleted with the session row.
- **Only the opted-in names are stored, never the config.** The file is rewritten from the
  user's current config at each launch, so a changed key or command takes effect, and a
  server removed from the config since is dropped with a log line rather than failing the
  launch.

### Skills stay

- No `--disable-slash-commands`. Skills cost ~3.8k per call, and a started session relies on
  `claude-remote-sessions` to `update` and `land`; the user's slash commands keep working
  when they take the session over.
- Built-in tools stay as they are (no `--tools`): trimming them saves ~5.6k and an
  interactive session can't predict which it'll need.

### The profile survives revive and history Resume

The profile is the permission mode plus the MCP opt-ins. Today both are lost when the
session's `claude` is launched again: revive types a bare `claude --resume <id>`, so a
revived `auto` session comes back in the default mode with the full roster. Reopening an
old child is the expensive case (its whole context is re-cached), so it should stay lean.

- **Stored on the row:** `sessions.mcp_servers`, a JSON array. `NULL` means "full profile"
  (every session the user opens); `[]` means no MCP. `permission_mode` already exists.
- **Migration** backfills `mcp_servers = '[]'` for rows with `spawned_by` set.
- **Revive** (`reviveSession`) and **history Resume** (`openClaudeSession`, `resume`) type
  the profile's flags after `--resume <id>`: `--permission-mode` (as `startCommand`),
  `--strict-mcp-config`, and `--mcp-config` when there are opt-ins.
- **History Resume finds the profile by transcript**: the row whose `claude_session_id` is
  the transcript being resumed and whose `mcp_servers` is set. The new row copies
  `mcp_servers` and `permission_mode`. It is **not** `spawned_by` the original parent: it's
  the user's session now, and must not count against the parent's limit or let it land.
  No such row (deleted, or never a started session) → today's full profile.
- **Fork stays full-profile.** A fork is a new conversation the user branches off.
- A `claude` the user types by hand in the shell is theirs; nothing changes there.

## Planned changes

- `src/server/db/schema.ts`: migration `018_session_mcp_servers` (column + backfill).
  `db/queries.ts`: read and write `mcpServers`.
- `src/server/sessions/launch-profile.ts` (new): resolve names against the config files,
  write `mcp.json`, and build the flag string shared by start, revive and resume. Paths use
  forward slashes and the same unsafe-character refusal as the prompt path.
- `src/server/agent/sessions-api.ts`: accept `mcpServers` in the body (validated, at most a
  handful of names); 400 for an unknown one; pass the flags into `startCommand`; store them.
- `src/server/sessions/session-open.ts`: `injectResumeCommand` takes the profile; revive and
  resume pass it; resume copies it to the new row.
- `scripts/cr-session.mjs`: `--mcp` on `start`; `list` shows `mcpServers`.
- `skills/claude-remote-sessions/SKILL.md`: started sessions have no MCP; pass `--mcp
  <server>` only when the task needs one (a browser for UI checks: `--mcp playwright`).
- `docs/session-orchestration.md`: the profile, where it's stored, and the measurement.
- `CLAUDE.md` (Sessions): one rule — a started session's `claude` is always launched with
  its stored profile, or a revive reloads the full MCP roster on every turn.

## Verification

- Unit: `startCommand`, revive and resume command lines with `[]`, one opt-in, and `NULL`;
  name lookup in each scope and the precedence between them; an unknown name refused with
  the available list; the file written in the prompt folder; the migration backfill.
- `tests/agent-sessions-api.test.ts`: `mcpServers` in the body stored and passed; a resumed
  started session's row copies the profile and has no `spawned_by`.
- Manual (isolated boot, `project/QA.md` Flow 3): start a session with no `--mcp` and check
  its first call's prompt is ~21k smaller than a hand-opened one in the same worktree; start
  one with `--mcp playwright` and check the tool is there; restart the isolated server,
  revive both, and check the typed lines.
- `npm test`, `npm run lint`, `npm run build` green.

## Out of scope

- Compacting started sessions earlier, or a smaller-context model for them (the larger
  cost in the analysis, but a separate decision).
- Scoping MCP for sessions the user opens by hand.
- Plugin servers and claude.ai connectors as opt-ins.

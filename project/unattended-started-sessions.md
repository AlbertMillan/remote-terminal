# Started sessions run without the user

Track: Session orchestration

## Goal

A session started by a main session (`f-s3w8qd`) works through its prompt without the
user approving each step. When the user tried it, the started session stopped three times
before doing any work:

1. **It asked to approve the `slack` MCP server.** `C:\Users\Albert\.mcp.json` defines
   `slack`. Track worktrees live under `~/.claude-remote/worktrees/`, inside the home
   folder, so Claude finds that file higher up and asks per new folder. The main checkout
   doesn't ask because its gitignored `.claude/settings.local.json` sets
   `enableAllProjectMcpServers: true`, and worktrees never get that file. Track sessions
   the user opens by hand ask too.
2. **It asked to read its prompt file.** The file is in `~/.claude-remote/prompts/`,
   outside every folder the session was started with.
3. **It asked for every edit.** The main agent used `default`, where every edit and every
   command asks. `acceptEdits` would still ask for each command.

## Design decisions

### Default permission mode: `auto`

- **`auto` is added to the allowed modes, and is the default** when the main agent names
  none. It is Claude Code's auto mode: it decides each action itself and still asks
  before risky ones. Started sessions exist to run unattended. To get prompts back, pass
  `--mode manual`.
- **Allowed: `auto`, `manual`, `acceptEdits`, `plan`.** `bypassPermissions` and `dontAsk`
  stay refused. `dontAsk` denies everything not pre-allowed, so a session would fail
  quietly instead of asking.
- **`default` is accepted as an alias for `manual`.** A skill copy already installed in
  `~/.claude/skills/` still sends it. It is stored as `manual`.
- **For `manual`, the typed command leaves out `--permission-mode`.** Claude Code 2.1.288
  lists `manual` among its choices and no longer lists `default`, so passing nothing is the
  safe way to get the default. Every other mode is passed explicitly.
- **The sidebar chip shows the mode when it isn't `auto`.** A `manual` chip is the one the
  user needs to see, because that session will wait for them. Existing rows stored as
  `default` read as `manual`.
- **The skill and the CLI** say `auto` is the default and drop `default` from their usage
  text. The skill tells the agent to pass `--mode manual` only when the user asks to
  approve steps themselves.

### The prompt file is readable without asking

- **Each session gets its own folder:** `<dataDir>/prompts/<sessionId>/prompt.md`.
- **The typed command adds `--add-dir` for that folder only**, so the session reads its
  own prompt without asking, and can't read any other session's:
  `claude [--permission-mode <mode>] --add-dir "<dir>" "Read <dir>/prompt.md and follow it."`
- Both paths use forward slashes and go through the existing `UNSAFE_IN_QUOTES` check.
- Deleting the session removes the whole folder.

### Worktrees get the main checkout's local Claude settings

- **When a track worktree is created** (`ensureTrackBranch`, `track-branches.ts:168`,
  and Branch now at `:303`), copy the main checkout's `.claude/settings.local.json` into
  the worktree's `.claude/`.
- **Also before any session opens in a track worktree** (the Track picker, the board's
  Open session, and agent start), when the worktree has no `settings.local.json`. That
  covers worktrees created before this change. One helper does both:
  `ensureLocalClaudeSettings(projectCwd, worktreePath)`.
- **A copy, never a link.** `git worktree remove` on Windows deletes through a link.
- **Never overwrite** a `settings.local.json` the worktree already has. Its sessions may
  have added their own approvals.
- **It must never be committed.** Before copying, run `git check-ignore` on the path in
  the worktree. If it isn't ignored, add `.claude/settings.local.json` to the repository's
  shared `info/exclude` (`git rev-parse --git-common-dir`) first. Otherwise the next
  `commitAll` puts it on the branch. That ignores the file in the main checkout too, which
  is what Claude Code intends for it anyway.
- **No main-checkout file, no copy.** Then the worktree behaves as today.
- **The copy carries the main checkout's permission allowlist as well** (`npm test`,
  `npm run build`, …). So a worktree session also asks less in `manual` mode.
- **Changes made in the worktree's copy are not carried back** to the main checkout at
  Land. They're lost with the worktree.

## Planned changes

- `src/server/agent/sessions-api.ts`: the mode list, the `auto` default, the `default` →
  `manual` alias, the command line with `--add-dir`, and calling
  `ensureLocalClaudeSettings` before the session is created.
- The prompt-file helper and session delete: a per-session folder.
- `src/server/projects/` (next to `project-deps.ts`): `ensureLocalClaudeSettings()`,
  called from both worktree-creation sites and the routes that open a track session.
- `src/client/session-list-view.ts`: the chip shows when the mode isn't `auto`, and
  `default` reads as `manual`.
- `scripts/cr-session.mjs` and `skills/claude-remote-sessions/SKILL.md`: modes and
  default. `docs/session-orchestration.md` says to reinstall the skill.
- `CLAUDE.md`, Sessions group: worktrees get a **copy** of `settings.local.json`, made only
  when the path is ignored.

## Verification

- **Unit, start:**
  - No mode → `auto`, and the command has `--permission-mode auto`.
  - `manual` and `default` → stored as `manual`, and the command has no
    `--permission-mode`.
  - `dontAsk` and `bypassPermissions` → 400.
  - The command has `--add-dir` set to the session's own prompt folder.
  - Deleting the session removes that folder.
- **Unit, `ensureLocalClaudeSettings` (real temp repo with a worktree):**
  - It copies the file when the worktree lacks it.
  - It leaves an existing one alone.
  - It does nothing when the main checkout has none.
  - It adds the exclude entry when the path isn't ignored, and the file then never shows
    in `git status`.
  - The worktree's file is a regular file, not a link.
- **Manual, on the isolated boot (`project/QA.md` Flow 3):**
  - From a session, start one on a track whose worktree doesn't exist yet.
  - The new session asks nothing about MCP or the prompt file.
  - In `auto` it edits and runs `npm test` without asking.
  - Open a second track session by hand in an existing worktree: no MCP prompt.

## Out of scope

- Moving secrets out of `~/.mcp.json`. That's the user's own config, not something
  claude-remote writes.
- Carrying approvals made in a worktree back to the main checkout.
- Job worktrees. Stages run `claude -p` with `--strict-mcp-config` and their own
  `--allowedTools`, so neither prompt happens there.

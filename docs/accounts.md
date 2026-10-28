# Claude accounts

Spec: `project/accounts.md`. Every session claude-remote runs is under a named **account**:
one Claude Code config folder (`CLAUDE_CONFIG_DIR`) and the login expected in it. Projects,
branches and worktrees stay account-neutral; transcripts, auto-memory, folder trust and
user-scope MCP servers are per account.

## Config

`~/.claude-remote/config.json`:

```json
"accounts": {
  "personal": { "configDir": "~/.claude-personal", "accountUuid": "<personal oauthAccount.accountUuid>" },
  "work":     { "configDir": "~/.claude",          "organizationUuid": "<org oauthAccount.organizationUuid>" }
},
"defaultAccount": "personal"
```

- `accounts` is taken as written (not merged with the defaults), so a deleted account is gone.
- Each account needs exactly one identity field. Problems are logged at boot
  (`accountConfigProblems`), never fatal: a bad account refuses only its own launches.
- Without `accounts` in the file the defaults are `personal` → `~/.claude-personal` and
  `work` → `~/.claude`, **with no expected identity**, so every launch is refused until the
  UUIDs are filled in. Read them from `<configDir>/.claude.json` → `oauthAccount`.

## Which account a session gets

`resolveStartAccount(requested, cwd)` (`src/server/accounts.ts`):

1. the account the start names (new-session dialog, `cr-session start --account`);
2. else its project's `account` in `projects.json` (most specific project containing the cwd);
3. else `defaultAccount`.

A named account that doesn't exist is refused, never swapped for another. The account is
stored on the row (`sessions.account`, migration `019_session_account`, which backfilled
every older row to `personal`). Revive, Fork and history Resume reuse the row's account
(`accountForTranscript` for a history entry): a transcript only resumes from the folder it
lives in.

## Paths

Every Claude Code path goes through `accounts.ts`; a hardcoded `~/.claude` reads the work
login's folder for a personal session.

- `configDir`, `projectsDir`, `sessionsDir`, `skillsDir`, `commandsDir`, `settingsPath`,
  `credentialsPath` — one account's. A session's own data (its transcript for Fork,
  Resume, prompt delivery, the session log) uses its account; an unknown account throws.
- `allProjectsDirs`, `allSessionsDirs` — every account's, each folder once. Scans
  (project discovery, recent paths, slug recovery, the usage ledger, track attribution,
  Claude's live session names) cover all of them.
- `findTranscript(cwd, id, preferred)` — the preferred account's folder first, then any
  other: a read (the session log, history delete) still finds a transcript that was never
  moved. A launch (Fork, Resume) uses only the account's own folder.
- `accountForTranscriptPath` — the account is inferable from a transcript's path, so
  `usage_files` has no account column.
- `claudeJsonPath(account)` — the global config file (login, trust, MCP servers). Inside a
  custom folder, but **`~/.claude.json` beside the default `~/.claude`**: an account on
  `~/.claude` is launched with `CLAUDE_CONFIG_DIR` removed, so Claude Code reads that file.
- Jobs and other headless runs with no session use `projectAccount(cwd)`: the project's
  default, else the configured one. The review stage reads that account's `/code-review`.

## Launch

Every `claude` claude-remote launches — a session's PTY (`createPty`, `account` required)
and a headless run (`spawnClaude`) — gets `accountEnv(env, account)`:

- `CLAUDE_CONFIG_DIR` = the account's folder, or **removed** for the default `~/.claude`;
- no `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`,
  `CLAUDE_CODE_ENABLE_TELEMETRY` or `OTEL_*` (case-insensitive): inherited, they override
  the folder's login and settings.

**Preflight** (`preflight(account)`) runs before every launch: create, Fork, history
Resume, revive, an agent start (before its branch and worktree), and every `runClaude`
(a job stage or session log runs under `projectAccount(cwd)`). It reads `oauthAccount`
from `claudeJsonPath(account)` and refuses (`AccountRefusedError`, 409):

| reason | when |
| --- | --- |
| `no-expected-identity` | the account has neither `accountUuid` nor `organizationUuid` |
| `no-login` | no `oauthAccount` in its `.claude.json` |
| `mismatch` | the logged-in uuid isn't the expected one |
| `org-settings` | an account expecting no organization has `remote-settings*.json` in its folder |

A refused WebSocket launch answers `session.error` with `refusal`; the client shows who is
logged in vs who is expected (`account-refusal-modal.ts`):

- **Log in** — `session.create { account, login: true }`: `claude` in `~` with the
  account's env and no preflight. The user runs `/login` and exits; the client then sends
  the refused launch again, and the server preflights it again.
- **Clean up** (accounts with no `organizationUuid`) — the same with `cleanup: true`,
  which first deletes `remote-settings*.json` there (`cleanupAccount`). Run `/logout`,
  then `/login` with the right account.

## A login that changes under a running session

`/login` inside a session swaps the login of its whole folder. `account-watch.ts` re-runs
preflight for every running session's account every 60s and whenever a claude-session hook
reports in. A session whose account fails is flagged: its row's account chip turns into a
warning (`session.accountWarnings`) and a toast/notification (`account-changed`) fires once.

## Before landing

- Fill in `accounts.*.accountUuid` / `organizationUuid` in `config.json`, or every launch
  is refused (`no-expected-identity`).
- Existing sessions are `personal`, but their transcripts are still in the work folder
  until `f-ilxxdj` moves them: reads fall back to other folders, but a revive or Resume of
  one runs `claude --resume` in `~/.claude-personal`, which doesn't have it.

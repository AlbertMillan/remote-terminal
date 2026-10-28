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
   a track or job worktree is looked up by its owner's checkout (`projectCwdFor`), since
   worktrees sit outside every project;
3. else `defaultAccount`.

The project's `account` is set from the project header's **Account** select
(`POST /api/projects/account`, `setProjectAccount`): it edits `projects.json` in place like a
favourite, adding an entry for a project without one (which makes it a roll-up anchor) and,
on clear, dropping only the key. The board carries `account: { own, effective, source }`;
an entry inherited from a containing project shows as "Inherited". The new-session dialog's
empty option names what it resolves to for the typed folder (`GET /api/accounts/resolve`),
and the dispatch button and job board say which account jobs run as: jobs can't override it.

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
- `usage_files` has no account column (a file's folder is still where it lives); the
  login that ran each message is `usage_messages.account`, set by the ledger
  (`docs/token-usage-feature.md`, "Which login ran it"). Not simply the folder: a
  transcript moved into an account's folder ran under the default folder's login.
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
  until they are moved: reads fall back to other folders, but a revive or Resume of one
  runs `claude --resume` in `~/.claude-personal`, which doesn't have it. Move them with
  `node scripts/move-session-transcripts.mjs [--also <claudeSessionId>]... [--dry-run]`
  (`f-ilxxdj`): it resumes one moved transcript first (forked) and moves it back on a
  refusal, then moves the rest with their `<id>/` folders and repoints `usage_files`.
  Only ids on session rows move (plus `--also`); a transcript a running `claude` holds
  open is reported, so rerun once it exits.

## Per-account setup

Each account's `claude` reads only its own folder, so claude-remote's setup goes into each:

- **Skills**: `installSkillsAtBoot` installs `skills/` into every account's `skills/`
  (`npm run install-skill` does the same from `config.json`; `--dest` overrides).
- **Hooks and status line**: the claude-session hook (Fork, Resume, the session log), the
  notification hooks (`docs/notifications.md`, `docs/session-fork.md`) and the plan-usage
  status line live in each account's `settings.json`. Copy them from an account that has
  them — only claude-remote's entries, never replacing the target's own status line,
  backing the target up to `settings.json.bak`:
  ```
  node scripts/install-account-setup.mjs --from ~/.claude/settings.json --to ~/.claude-personal/settings.json
  ```
  The server logs, at boot, every account whose settings lack any of them
  (`accountSetupMissing`); `GET /api/accounts` lists them as `setupMissing`. That route
  (`accountsSummary`) is unauthenticated, so it names no folder or login.
- **Plan usage** is kept per account: `statusline.mjs` sends its claude-remote session
  (`session_id`) and `CLAUDE_CONFIG_DIR` (`config_dir`, empty for `~/.claude`); the server
  files the reading under the session's account, else the folder's, and keeps it only once
  verified as that account's login — otherwise it is held back (`docs/plan-usage.md`). A
  `plan-usage.json` from before verification is restored held back.
- **The status line names the account** (`Opus 5.5 · [personal] · 5h 4%`): `statusline.mjs`
  maps its `CLAUDE_CONFIG_DIR` through `scripts/claude-accounts.mjs` (config.json only, so
  it still prints before any server call). A folder no account uses shows no name.

## SESSION-LOG records the account

Both accounts commit as the same git user, so the log is the only record of which login
made a change. The entry marker carries `account` beside `claudeSessionId`, the entry shows
`**Account:** <name>` under its heading, and the history view tags it. Backfills and
entries from before accounts have none. The generator runs under the session's account
(its transcript is there); history Resume / Fork pass the entry's account for a transcript
no session row ran, and history delete looks in that account's folder first. Track
attribution reads every account's transcripts for the project, the session's included.

## Usage ledger and moved transcripts

At the end of every ingest pass the ledger drops the `usage_files` rows of transcripts that
no longer exist (deleted, moved to another account's folder, a folder renamed). Only the
file bookkeeping goes — `usage_messages`, the spend, is never deleted — and a moved file is
read again under its new path without double counting (rows are keyed by message id). A
row whose file this pass didn't list is checked on disk first, and a parent's row stays
while one of its subagent files survives (their attribution is read from it).

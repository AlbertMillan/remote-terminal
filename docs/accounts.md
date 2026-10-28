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

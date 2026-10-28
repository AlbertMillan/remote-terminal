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

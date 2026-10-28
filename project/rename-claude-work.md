# Rename ~/.claude to ~/.claude-work

Track: Claude accounts

## Goal

With claude-remote account-aware (`project/accounts.md`), the work login's folder gets a name
that says what it is: `~/.claude` → `~/.claude-work`. Plain `claude`, the IDE extensions and
claude-remote keep working, and nothing silently recreates `~/.claude`.

Do it after the accounts features: before them, claude-remote hardcodes `~/.claude` and
breaks; after them, claude-remote only needs `accounts.work.configDir` changed.

## Design decisions

### Machine side

- **Stop everything first:** all Claude sessions, IDE extensions, the desktop app and
  claude-remote. A running session writes to the old path.
- **Back up** `~/.claude` and `~/.claude.json`.
- Rename the folder; move `~/.claude.json` to `~/.claude-work/.claude.json` (with a custom
  config folder Claude Code keeps it inside — confirm on first launch).
- Set `CLAUDE_CONFIG_DIR=%USERPROFILE%\.claude-work` as a **user-level** Windows environment
  variable, so plain `claude` and anything launched afterwards inherits it.
- **Apps that ignore it** (VS Code / JetBrains extension, desktop app — unverified) would
  recreate an empty `~/.claude` and ask to log in. claude-remote warns when `~/.claude`
  reappears.

### References inside the folder

- `settings.json`: 3 hooks at `$HOME/.claude/scripts/hooks/{observe,session-start,evaluate-session}.js`.
- Plugin registries with absolute paths (`plugins/installed_plugins.json`,
  `known_marketplaces.json`, `plugin-directory-cache-v2.json`): reinstall the plugins rather
  than edit the files.
- Files naming `~/.claude`: skills `feedback-aggregate`, `feedback-structure`,
  `producer-review`, `session-search`; commands `learn`, `evolve`, `instinct-status`; docs
  `linear-conventions.md`, `linear-everhour-workflow.md`; the global `CLAUDE.md`
  (`~/.claude/docs/…`).
- Auto-memory and transcripts move with the folder; no path changes.

### References outside the folder

- `~/AgentsAI` and `~/NodeProjects` (outside claude-remote) were not swept: the scans timed
  out on their size. The first task here is a scoped sweep of scripts and config
  (`*.{js,mjs,ts,py,ps1,cmd,bat,json,md}`, skipping `node_modules`, `.git`, game assets).

### claude-remote's database

- `usage_files.path` holds absolute transcript paths (423 rows at planning time). Left alone,
  the ledger re-reads every transcript once (no double count: `usage_messages` is keyed by
  `message_id`) and keeps the old rows forever. Instead, with claude-remote stopped:
  ```sql
  UPDATE usage_files
  SET path = 'C:\Users\Albert\.claude-work\' || substr(path, length('C:\Users\Albert\.claude\') + 1)
  WHERE path LIKE 'C:\Users\Albert\.claude\%';
  ```
  Shipped as a script (`scripts/rewrite-config-dir.mjs <from> <to>`), not hand-run SQL.
- **Ledger prunes missing files** (`f-psbdve`): rows whose path no longer exists are deleted
  at the end of a pass. Needed anyway once transcripts live in two folders and get moved.
- Nothing else in `sessions.db`, `config.json`, `projects.json` or `hooks/` references the
  folder (`scrollback` matched only terminal text).

## Planned changes

- `scripts/rewrite-config-dir.mjs` (new, cross-platform Node): rewrites `usage_files.path`
  prefixes; refuses while the server is running.
- `src/server/usage/ledger.ts`: prune rows for missing files after a pass.
- `src/server/app.ts` (boot): warn when `~/.claude` exists and no account points at it.
- `config.json`: `accounts.work.configDir` → `~/.claude-work`.
- `docs/accounts.md`: the rename checklist above.

## Verification

- Unit: rewrite script on a fixture DB (only matching prefixes change; refuses while running);
  ledger pruning.
- Manual: after the rename, `claude` in a fresh terminal starts logged in with history and
  `/resume` intact; hooks fire; plugins load; claude-remote's usage totals unchanged and no
  full re-read in the log; no `~/.claude` reappears after opening VS Code and the desktop app.

## Out of scope

- Renaming the personal folder or any other account.

# Claude accounts — a work and a personal login side by side

Track: Claude accounts

## Goal

The Claude Code org login (Digital Sun) pushes server-managed settings that turn on
OpenTelemetry to the org's collector (`~/.claude/remote-settings.json`: `CLAUDE_CODE_ENABLE_TELEMETRY`,
`OTEL_EXPORTER_OTLP_*`). Personal work should run on a separate personal Claude account so it
never reaches that collector.

Claude Code keeps one login per config folder (`CLAUDE_CONFIG_DIR`); the org's settings only
reach a folder logged into the org. claude-remote today assumes a single folder, `~/.claude`,
in about 14 places. This track makes it account-aware: every session runs under a named
account, claude-remote launches it with that account's folder and refuses to launch on the
wrong login.

Projects, branches and worktrees stay account-neutral (repos, `~/.claude-remote/worktrees`):
either account can work on any project. What is per account is Claude's own state —
transcripts, auto-memory, folder trust, user-scope MCP servers.

## Design decisions

### Accounts are defined once, sessions pick one

- `~/.claude-remote/config.json` gains:
  ```json
  "accounts": {
    "personal": { "configDir": "~/.claude-personal", "accountUuid": "<personal>" },
    "work":     { "configDir": "~/.claude",          "organizationUuid": "<Digital Sun>" }
  },
  "defaultAccount": "personal"
  ```
  `work.configDir` moves to `~/.claude-work` in `f-fhrnu3`; nothing else changes then.
- **The default account is `personal`.** A new session uses it unless the start (dialog,
  `cr-session start --account`, or the project's stored default) says otherwise.
- A project can store a default account. It's a shortcut only: any session can pick either.
- Each session row stores its account (`sessions.account`, not null after migration).
- Not tied to a project's path: an account is a login, and the same repo is worked on by both.

### Existing sessions become personal, and their transcripts move with them

- Migration sets `account = 'personal'` on every existing row.
- Those sessions were all run on the work login, so their transcripts sit in `~/.claude/projects`.
  A one-off move (`f-ilxxdj`) moves the transcripts of claude-remote's session rows
  (`claude_session_id`, plus their `<id>/` subagent folders) to `~/.claude-personal/projects/<slug>/`
  and repoints `usage_files.path`. Transcripts of sessions claude-remote never ran stay in
  the work folder. Per-project auto-memory (`projects/<slug>/memory/`) is **not** moved: it is
  shared by the work sessions in that project.
- **Canary first:** the move resumes one moved session under the personal login before moving
  the rest. A transcript is a local file, but earlier turns carry signed thinking blocks; if
  the API refuses them under another account, the move stops and the decision comes back.
- Already-reported telemetry is not undone by moving files; this only matters going forward.

### Launch: the right folder, a clean environment, a checked identity

- The spawned shell/`claude` gets `CLAUDE_CONFIG_DIR=<account configDir>`.
- It loses `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_ENABLE_TELEMETRY` and
  `OTEL_*` from the inherited environment, or they override the folder's login and settings.
- **Preflight** reads `oauthAccount` from `<configDir>/.claude.json` and compares
  `accountUuid` / `organizationUuid` with the account's expected identity. Mismatch or no login
  → the session doesn't start.
- For an account with no `organizationUuid` (personal), preflight also refuses when
  `<configDir>/remote-settings*.json` exists: an org login has happened in that folder.
- Revive, history Resume and Fork reuse the row's account; a transcript can only be resumed
  from the folder it lives in.

### Login and cleanup from claude-remote, no separate terminal

- A refused launch shows who is logged in vs who is expected, with **Log in**: an interactive
  session with the account's folder and clean environment, where the user runs `/login`.
  When it exits, preflight runs again and the original start proceeds if it now matches.
- For personal, a **Clean up** action deletes `remote-settings*.json` in that folder and opens
  the Log in session, where the user runs `/logout` then `/login` with the right account.
- A `/login` inside a running session can't be prevented: the session-start hook and a
  periodic check re-read the identity and flag the session (badge + notification) on a change.

### Per-account paths through one helper

`src/server/accounts.ts` (new) resolves `configDir(account)`, `projectsDir(account)`,
`sessionsDir(account)`, `skillsDir(account)`, `credentialsPath(account)`. Every hardcoded
`join(homedir(), '.claude', …)` goes through it:

- A session's own data uses its account: `prompt-delivery.ts:75`, `transcript.ts:35`,
  `history-delete.ts:142`, `track-attribution.ts:204`, `claude-registry.ts:19`.
- Scans cover every account: `project-discovery.ts:90`, `recent-paths.ts:65`,
  `workspace.ts:175`, `usage/ledger.ts:449`.
- `jobs/stages/review.ts:24` reads `code-review.md` from the job's account.
- The account is inferable from a transcript path (it starts with that account's
  `projectsDir`); `usage_files` needs no account column.

### Per-account setup

- Hooks (session id, notifications), `statusLine` and skills are installed into each account's
  `settings.json` / `skills/` (`skill-install.ts`, `scripts/install-skill.mjs`).
- Plan usage reads each account's credentials; the chip shows the session's account.
- UI/help text that names `~/.claude/settings.json` (`plan-usage-chip.ts:116`,
  `plan-routes.ts:25`, `session-open.ts:112`) names the account's folder.

### SESSION-LOG records the account

- The entry marker gains `account` next to `claudeSessionId`; the rendered entry shows it.
  Both accounts commit as the same git user, so this is the only record of which login made
  a change.
- Track attribution reads transcripts from the session's account folder.

### Seeing and choosing the account (`f-w6znvl`, `f-hrsrrl`, `f-8x96pp`, `f-tkaa6d`)

- **Project header**: an Account select — "Default (<configured>)" plus every account.
  `POST /api/projects/account { cwd, account | null }` sets or clears `account` on the
  project's own `projects.json` entry, editing the file in place like favourites (a
  malformed file is refused, never rewritten). A project with no entry gets one, which
  also makes it a roll-up anchor: its nested folders fold into it, as its account already
  covers them. The header shows an inherited default (a parent entry's) as such.
- **New-session dialog**: the empty option names what it resolves to for the chosen
  folder (`GET /api/accounts/resolve?cwd=` → `{ account, source: project | default }`),
  re-asked as the folder or track changes.
- **Job board**: "Jobs run as <account>" — stages use `projectAccount(cwd)` and nothing
  overrides it, so the header select is the way to change it.
- **Status line**: `statusline.mjs` maps its `CLAUDE_CONFIG_DIR` to an account name through
  `scripts/claude-accounts.mjs` (config.json only, no server call, so it still prints first)
  and shows it after the model. A folder no account uses shows nothing.

## Planned changes

- `src/server/config.ts`: `accounts`, `defaultAccount`, validation (configDir exists or is
  creatable; exactly one identity field per account).
- `src/server/accounts.ts` (new): path helpers, `readIdentity(account)`, `preflight(account)`.
- `src/server/db/schema.ts`: migration `019_session_account` (column, backfill `'personal'`);
  project default account in the projects registry. `db/queries.ts`: read/write.
- `src/server/agent/claude-run.ts`, session spawn/revive/resume (`session-open.ts`,
  `sessions-api.ts`): env and preflight; refusal carries identity found vs expected.
- Path call sites listed above.
- `src/client`: account picker on new session (default personal), account badge on rows,
  Log in / Clean up dialog.
- `scripts/cr-session.mjs`: `start --account`, `list` shows it.
- Session-log generator and `project-log-view.ts`: `account` in marker and entry.
- `docs/accounts.md` (new); README and hook docs name the account folder;
  `CLAUDE.md`: one rule — every `claude` claude-remote launches gets its account's
  `CLAUDE_CONFIG_DIR` and the stripped env, or it runs under whatever login `~/.claude` has.

## Verification

- Unit: path helpers per account; preflight match / mismatch / no login / remote-settings
  present; env stripping; migration backfill; account inferred from a transcript path.
- API: start with and without `--account`; a mismatch refused with found vs expected; revive
  and resume keep the row's account.
- Manual (isolated boot, `project/QA.md`): personal session in a work repo — no
  `remote-settings.json` appears in `~/.claude-personal`, `echo $env:CLAUDE_CODE_ENABLE_TELEMETRY`
  is empty; work session still reports; Log in flow from a refused start; SESSION-LOG entry
  shows the account.
- `npm test`, `npm run lint`, `npm run build` green.

## Out of scope

- The `~/.claude` → `~/.claude-work` rename (`project/rename-claude-work.md`).
- Per-account git identities.
- Moving claude.ai connectors or user-scope MCP servers between accounts.

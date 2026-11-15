# Sessions message each other across accounts

Track: Claude accounts

## Goal

Agents talk through Claude Code's own `ListAgents`/`SendMessage`. Each `claude` finds its
peers in its own config folder's live registry (`<CLAUDE_CONFIG_DIR>/sessions/<pid>.json`),
so since accounts (`f-pd3yag`) a personal session and a work session can't see or message
each other. With a setting on, they can.

## Findings (checked 2026-11-15, Claude Code 2.1.325)

- A registry entry is `<pid>.json` (`{ pid, sessionId, cwd, name, status,
  messagingSocketPath, … }`) plus `<pid>.<hash>.key`. The socket is a machine-local named
  pipe (`\\.\pipe\LOCAL\cc-msg-…`), reachable from any login on the machine.
- Copying one work session's two files into `~/.claude-personal/sessions` was enough: a
  headless `claude -p` on the personal login listed the work session in `ListAgents` and its
  `SendMessage` arrived in that session, marked as from the other login's session. Nothing
  checks the account.

## Design decisions

1. **Mirror the files, don't link the folders.** A junction would mean replacing a live
   `sessions` folder that running Claudes write to, and undoing it later. claude-remote
   already polls the registry every 5 s (`claude-registry.ts`); each poll copies every live
   entry's `.json` and `.key` into every other account's folder.
2. **Off by default, global, both ways** (`sessions.crossAccountMessaging`). The user chose
   global and both ways over one direction or per-session opt-in, knowing a message is
   processed and kept by the account that receives it: the work login's telemetry (events
   and metrics today, prompt text if the org turns on `OTEL_LOG_USER_PROMPTS`) and the
   personal login's data terms. Read on every poll, so a config change applies at the
   next one.
3. **Only ever touch our own copies.** A manifest (`<dataDir>/registry-mirrors.json`)
   records each copy's path, source and content hash. A copy is replaced or deleted only
   while it still holds what we wrote; a file we didn't write is never overwritten (a pid a
   Claude of that account reuses wins), and a copy someone rewrote is dropped from the
   manifest and left alone.
4. **Copies go when their source does**: the source file is gone or its pid is dead, the
   setting is off, or the server shuts down. A copy a crash left behind is removed at the
   next boot's first poll (the manifest survives it).
5. **claude-remote's own reads skip copies**, or a stale copy could name a session.
6. **Never on an isolated boot** (`CLAUDE_REMOTE_CONFIG`): it would write into the real
   config folders.

## Planned changes

- `src/server/sessions/registry-mirror.ts` — `syncRegistryMirrors()` (pure over its deps),
  manifest load/save (a pass with the setting off removes every copy).
- `claude-registry.ts` — the poll syncs before reading; `readClaudeNames` skips copies;
  `stopClaudeNameWatch` removes copies.
- `config.ts` — `sessions.crossAccountMessaging?: boolean`, a `FLAG_SETTINGS` entry; Settings → Sessions → "Cross-account messaging" (`session-limit-setting.ts`, `PUT /api/server/settings`).
- Docs: `docs/accounts.md` section, `docs/session-orchestration.md` note, a `CLAUDE.md` rule.

## Verification

1. Unit tests: copies made both ways; recopied on change; removed when the source goes, the
   pid dies or the setting is off; a foreign file is never overwritten; a rewritten copy is
   left alone; names skip copies.
2. Live (after landing, on a restart the user asks for): a personal session lists and
   messages a work session and back; turning the setting off removes every copy.

## Out of scope

- One-way or per-session mirroring.

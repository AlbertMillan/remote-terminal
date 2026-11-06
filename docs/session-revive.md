# Reviving stale sessions

A session in the left panel renders `(stale)` when its DB row outlived its PTY — `attachable`
is purely "is there a live PTY in memory for this id" (`manager.ts`), so after every server
restart every row is stale. `shutdown()` parks sessions as `idle` rather than `terminated`
specifically so they can come back.

Stale rows carry a **play** button beside Delete. It sends `session.revive` and
`reviveSession()` brings the row back **in place**: same id, name, category, sort order and
scrollback, new PTY in the stored cwd. A new session row is deliberately *not* created — that
was the alternative (reusing `session.open`) and it leaves a dead row behind every time.

- With a `claude_session_id` on the row, `claude --resume` is injected through the same
  `injectCommand()` (as `claude --resume <id>`) the Fork and history-Resume paths use. Without one, reviving just
  respawns the shell — useful on its own, and the button's tooltip says which you get.
- `_initSessionPty()` installs a **fresh, empty** `ScrollbackBuffer` and `getScrollback()`
  prefers the in-memory one, so revive explicitly seeds it from `restoreScrollbackRaw(id)`.
  Without that seed the scrollback persisted at shutdown is silently dropped on first attach.
  It is empty after a hard kill, since `persistScrollback` only runs on graceful shutdown.
- **No `maxSessions` check for a stale row.** A stale row is already `status != 'terminated'`
  and so counts toward `countActiveSessions()`. Re-checking the cap here would make every
  session unrevivable after a restart at the limit.
- **A `terminated` row with a `claude_session_id` is revivable too**, and takes a slot
  (`assertSessionSlot()`), since terminated rows aren't counted. `terminated` only means the
  shell exited while the server ran, and a Windows reboot does exactly that: it kills every
  shell (exit `0xC000013A`) before the server, which gets no `SIGTERM` there, can run
  `shutdown()` and park them `idle`. So the sessions in use at reboot were the ones locked
  out. Refused: a terminated plain shell (nothing to resume), and one whose transcript Claude
  Code has since deleted (`cleanupPeriodDays`) — terminated rows linger for months, and a
  revive would otherwise leave a slot-holding shell with a failed `claude --resume` in it.
  It keeps its struck-through look and no `(stale)` label; only the play button appears.
- **The rule lives in one place**, `reviveRefusal()` (`sessions/revivable.ts`): revive throws
  its reason, and `sessionToInfo()` sends `revivable` so the client never re-derives it.
  Only terminated rows cost a transcript lookup; live ones are refused before it.
- **A shell that exits while the server runs is replaced in place.** It stays in memory as
  `terminated` (its scrollback attachable), and revive swaps in the new PTY: it seeds from
  the exited buffer (only Windows persists one at exit), keeps `connectedClients`, and
  leaves the id's data/exit listeners alone, so attached browsers see the new shell.
  `onAnyExit` → `broadcastSessionRow()` sends every sidebar a `session.updated` row at
  exit, so the button appears without a reload; `session.terminated` would also close the
  watcher's terminal.
- Forks are refused: `cleanupOrphanedForkFiles()` unlinks their transcript at boot, so there
  would be nothing to resume. A missing cwd is reported by name rather than falling back to
  home, which would resume the conversation in the wrong place.
- The icon is `play`, not the circular arrow — that one is `#refresh-projects-btn` and means
  refresh/retry elsewhere in the app. It reveals on row hover exactly like the Delete button
  beside it. The row carries `cursor: not-allowed`, which the button overrides for itself.

Two review findings are worth not re-introducing:

- A rejected `session.attach` must clear the client's `attachingSessionId` (`handleSessionError`).
  It is otherwise only cleared on a successful attach or a socket close, and the reconnect path
  routinely attaches to a session that went stale during the restart. A pinned flag makes every
  later `attachToSession()` for that id early-return, so the revived session runs with no
  terminal attached and no way back short of a page reload.
- Terminal `cols`/`rows` from any message go through `websocket/validation.ts` before reaching
  a PTY. `session.create` and `terminal.resize` each used to carry their own copy of the bounds;
  `session.open` and `session.revive` carried none.

Covered by `tests/session-revive.test.ts` and `tests/ws-validation.test.ts`.

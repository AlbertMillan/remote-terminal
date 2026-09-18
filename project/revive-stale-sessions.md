# Revive stale sessions from the sidebar

## Goal

A stale session in the left panel is currently a dead end. `attachable` is
purely "does this id have a live PTY in memory" (`manager.ts:207`), so after
every server restart **every** row renders `(stale)`: greyed out,
`cursor: not-allowed`, click inert, Delete the only action.

Give each stale row a second icon button that brings it back to life in place —
same row, same cwd, and, when the session has a recorded `claude_session_id`,
the same Claude conversation resumed via `claude --resume`.

`shutdown()` already marks sessions `idle` rather than `terminated` and comments
"so we can reconnect on restart". This feature is the missing half of that.

## Design decisions

**Revive in place, not open-a-new-session.** The alternative was to reuse the
existing `session.open` path verbatim (zero new server code), but that creates a
second row named `Resume: abc12345` and leaves the stale one behind to delete by
hand. Reviving keeps the row's id, name, category, sort order and scrollback, so
the sidebar stays a stable list of "my sessions" across restarts.

**Every stale row gets the button, not just Claude ones.** With a
`claude_session_id` it resumes the conversation; without one it just respawns
the shell in the same cwd. A stale plain-shell row is otherwise unrecoverable,
and respawning in the right cwd has value on its own. Tooltip distinguishes the
two: `Resume conversation` vs `Restart shell`.

**Scrollback replays as-is.** `_initSessionPty()` installs a *fresh empty*
`ScrollbackBuffer`, so `getScrollback()` would return nothing and the persisted
DB scrollback would be silently dropped on the first attach. Revive therefore
seeds the new buffer from `restoreScrollback(id)` before the PTY starts writing.
The old output is followed directly by the new shell's prompt, with no separator
marker. Note this only has content after a *graceful* shutdown — `persistScrollback`
runs in `shutdown()`, so a hard kill leaves nothing to replay. That is a
degradation, not a failure.

**Icon is `play`, not `rotate-cw`.** The circular arrow is already
`#refresh-projects-btn` ("Refresh projects", `index.html:68`) and reads as
refresh/retry elsewhere in the app. `play` is unused and unambiguous on a row
already labelled `(stale)`.

**Trigger is the icon button only.** Clicking a stale row stays inert
(`session-manager.ts:1567`) so a mis-aimed click can't spawn a shell.

**The button reveals on row hover, like Delete.** The first cut kept it always visible, on the
argument that a row at `opacity: .5` with `cursor: not-allowed` makes a hover-only affordance
undiscoverable. Consistency with the delete button beside it won: two adjacent icon buttons
that appear under different conditions read as a glitch, and the `(stale)` label already tells
you the row is actionable. Both are hover-only on touch, where neither reveals — a pre-existing
limitation of the delete button that this inherits rather than introduces.

**No session-limit check.** A stale row is `status != 'terminated'`, so it
already counts toward `countActiveSessions()`. Re-checking `maxSessions` on
revive would make every session unrevivable after a restart at the cap.

**`session.created` is the response.** `handleSessionOpen` already sets the
precedent of answering a non-create action with `session.created`, and the
client's `handleSessionCreated` does exactly the right thing for an id it
already knows: `sessions.set()` updates the row in place, then auto-attaches.

## Planned changes

**Server**

- `manager.ts` — new `reviveSession(id, { cols, rows, ownerId })`:
  - Load metadata; refuse when the row is missing, `terminated`, already in
    `activeSessions`, or `isFork` (fork transcripts are unlinked at boot by
    `cleanupOrphanedForkFiles`, so a revived fork would resume nothing).
  - Spawn the PTY from the stored `shell`/`cwd`/`cols`/`rows` with
    `CLAUDE_REMOTE_SESSION_ID: id` — same id, so notification and SessionStart
    hooks keep pointing at this row. A missing cwd surfaces as a clear error
    rather than silently falling back to home, which would break `--resume`.
  - `_initSessionPty()`, then seed the buffer from `restoreScrollback(id)`.
  - `updateSession(id, { status: 'active', lastAccessedAt })`,
    `logSessionEvent(id, 'revived')`.
  - If `claudeSessionId` is set, `_injectResumeCommand(session, claudeSessionId)`.
- `protocol.ts` — `'session.revive'` client message + `SessionRevivePayload`;
  add `claudeSessionId: string | null` to `SessionInfo`.
- `handler.ts` — `handleSessionRevive`: validate, call the manager, reply
  `session.created`, detach-then-attach (the same order `handleSessionCreate`
  needs to avoid the duplicate-listener leak). `sessionToInfo` gains
  `claudeSessionId`, threaded from DB metadata at each call site.

**Client**

- `session-manager.ts` — `claudeSessionId` on `SessionInfo`; render the `play`
  button in `renderSessionItem` for stale non-fork rows, with tooltip switching
  on `claudeSessionId`; `stopPropagation` + `reviveSession(id)` sending
  `session.revive` with the terminal's current cols/rows.
- `styles.css` — `.session-revive-btn` beside `.session-delete-btn`, mirroring its
  hover reveal (`opacity: 0` → `.7` on row hover → `1` on button hover) with an accent
  rather than danger hover. The `cursor: not-allowed` on `.session-item.not-attachable`
  must be overridden on the button itself.

## Found in review

Four defects and one gap, all fixed before merge:

- **A stale attach left `attachingSessionId` pinned forever.** It is cleared only by a
  successful `session.attached` or a socket close -- never by `session.error`. The reconnect
  path hits this every time: on reconnect the client re-attaches to the previously attached
  session, which after a restart is stale, and the server answers "Session not found". The
  flag stayed set, so `handleSessionCreated`'s `attachToSession()` early-returned and the
  revived session was left running with no terminal attached and no way back short of a
  reload -- i.e. the feature silently did nothing in its single most common scenario.
  `handleSessionError` now releases the flag.
- **`cols`/`rows` reached `createPty` unvalidated**, in `session.revive` and (pre-existing) in
  `session.open`, while `session.create` and `terminal.resize` each carried their own copy of
  the bounds check. All four now share `websocket/validation.ts`.
- **A DB failure after the PTY was up orphaned it**: the caller was told the revive failed
  while the process kept running and stayed registered. Now mirrors `createSession`'s
  cleanup -- deregister, then kill, so the exit event finds no session.
- **The scrollback seed split, re-joined and re-split** the stored blob. `restoreScrollbackRaw`
  hands it over whole, with a trailing newline so `ScrollbackBuffer` does not hold the final
  unterminated line back as `partialLine` and drop it.
- **Staleness was computed twice**, once with the fork exclusion and once without, so a row
  could in principle read `(stale)` with no button. One `isStale`, with `canRevive` derived.

## Verification

- `npm run build` and `npm test` clean; `npm run lint`.
- Unit (`tests/session-revive.test.ts`, 16): revive refuses a live session, a terminated row
  and a fork row; revive of a row with a `claude_session_id` injects `claude --resume <id>`;
  revive of a row without one injects nothing; the revived buffer is seeded from persisted
  scrollback, including an unterminated final line; a DB failure kills the PTY.
- Unit (`tests/ws-validation.test.ts`, 10): the shared dimension bounds, including the
  non-finite values a bare `isNaN` check lets through.
- Manual: with a Claude conversation running, restart the server, reload the
  page, confirm the row reads `(stale)` with a play button, click it, and
  confirm the old scrollback appears, the shell respawns in the same cwd and the
  conversation resumes with its history intact.
- Manual: a stale plain-shell row revives to a bare shell in its cwd.

## Out of scope

- Auto-reviving every session at boot. Spawning N shells unasked, each running
  `claude --resume`, is a much larger behaviour change and belongs behind a
  config flag if it is ever wanted.
- Fork-from-stale. The Session history board already offers Fork for any
  recorded conversation.
- Reviving `terminated` rows — they are filtered out of the sidebar entirely
  (`queries.ts:218`).

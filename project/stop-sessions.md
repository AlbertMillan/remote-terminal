# Stop a session on demand

## Goal

Park a session whose work is done without losing it: kill its shell (and the `claude`
in it) to free memory and CPU, keep the row so it can be resumed later when a related
issue comes up. The result is exactly the state every session is in after a server
restart: an `idle` row with no PTY, shown in the Stopped drawer with a Play button.

## Design decisions

**No new status.** A stopped row is `idle`, like a row `shutdown()` parked. It still
counts toward `maxSessions` (`countActiveSessions()` counts every non-`terminated` row),
so stopping frees resources but not a slot. If the limit starts biting, add a `stopped`
status then (revive would need `assertSessionSlot()` for it, as for `terminated`).

**Revive is unchanged.** `reviveRefusal()` already accepts a non-`terminated` row with no
PTY; revive seeds from the persisted scrollback and resumes the conversation.

**Scrollback is persisted on every platform** at stop, as `shutdown()` does, so a revive
shows the old output.

**Forks are refused.** Their transcript is removed on restart, so a stopped fork could
not come back. The row shows no Stop button.

**Stopping a parent stops the sessions it started** (`spawned_by`), children first.
Running forks and exited children are left alone.

**Another viewer is asked about.** If a browser other than the requester's is attached to
any session being stopped, the server refuses with `code: 'viewers'`; the client confirms
and resends with `force: true`. No confirm otherwise: these are finished sessions.

**A session-log entry is written** (`maybeLogSession`), as terminate does. A stopped
session is normally finished work.

**Every viewer sees a Resume prompt.** The server detaches every connection from the
stopped sessions and broadcasts each row (`session.updated`, now `attachable: false`).
A browser whose current session goes non-attachable keeps the last output on screen,
stops sending input, and overlays "<name> was stopped" with a Resume button.

## Planned changes

- `sessions/manager.ts`: `stopSession(id)` returns the ids stopped.
- `websocket/protocol.ts`: client `session.stop` `{ sessionId, force? }`, server
  `session.stopped` `{ sessionIds }` (the requester's ack). Fixture and `Protocol.kt` too.
- `websocket/handlers/sessions.ts`: `handleSessionStop`; `connections.ts` detaches viewers.
- Client: a Stop button (filled square) between Copy and Delete on attachable, non-fork
  rows; Play takes its slot once stopped; the Resume overlay in the terminal pane.

## Verification

- `tests/session-stop.test.ts`: row ends `idle` with no PTY, scrollback persisted,
  children stopped, forks refused, revive brings it back.
- Isolated boot (QA Flow 3): stop a live Claude session, see it move to Stopped, resume it.

## Out of scope

A Stop button in the terminal header, "Stop all" on category headers, a shortcut.

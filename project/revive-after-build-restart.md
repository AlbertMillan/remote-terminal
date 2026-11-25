# Revive running sessions after Build & restart

Track: Core remote terminal

## Goal

Pressing **Build & restart** in Settings brings back every session that was running when
it was pressed: same row, scrollback and conversation (`claude --resume`), as if each had
been revived from the sidebar by hand. Today every session comes back stale and has to be
revived one by one.

## Design decisions

**Only Build & restart.** Not the plain Restart button, not a manual `restart-server.vbs`,
a crash, a reboot or a job's rebuild stage. The request body's `build: true` is the
trigger; nothing else writes the revive list. A narrow trigger needs no running-state
marker kept up to date on every PTY start, stop and exit: the old server knows exactly
which sessions are live at the moment the button is pressed.

**The old server records the list and parks the sessions itself.** After a successful
build and before launching `restart-server.vbs`, the route:

1. takes the running sessions (`isRunning()`: a live PTY, not `terminated`), minus forks
   (their transcript is deleted at boot, so they could not resume);
2. writes `<dataDir>/revive-on-boot.json` `{ bootId, writtenAt, sessionIds }`;
3. parks each one as `shutdown()` does — scrollback persisted, PTY killed, row `idle` —
   so the revived terminal shows its old output. Today the restart is a hard
   `Stop-Process -Force`: `shutdown()` never runs and scrollback is lost.
4. launches the script.

Parking happens in the delayed launch callback, after the `202` is sent, so the browser
gets its answer first. A failed build writes nothing and parks nothing (the server stays
up, as now).

**The new server consumes the list once at boot.** In `createApp()`, after
`configureSessionEnv()` (or the revived PTYs lack the server URL and CLI) and **before**
the server listens, so the reloading browser finds them live, it reads and **deletes** the
file, then revives each id through the existing `reviveSession()`. Deleted first, so a
crash mid-revive never revives the same list twice. No stagger: revive is synchronous and
the `claude --resume` commands are typed into shells that start in parallel anyway.

- Ignored when older than 10 minutes (`writtenAt`): a restart that never happened (the
  launcher failed and the server was restarted by hand days later) must not resurrect
  sessions the user has since stopped.
- Every per-session refusal is the existing one (`reviveRefusal()`: missing cwd,
  transcript gone, row deleted, account `preflight()` fails): that session is logged and
  stays stale with its Play button; the rest continue.
- Never on an isolated boot (`CLAUDE_REMOTE_CONFIG`), which has its own data dir anyway.

**If the restart doesn't happen**, the old server is still up with every session parked:
it revives the same list in-process, deletes the file and allows a retry. That is either
the launcher failing to spawn, or a watchdog (`RESTART_WATCHDOG_MS`, 60s) finding this
process still alive after the launch — the script ran but could not stop it.

**Plain shells are included.** A running session without a `claude_session_id` comes back
as a fresh shell in its cwd, as a manual revive does.

**Started sessions (`spawned_by`) are included**; each gets a new token from
`sessionEnv()` on revive, as today.

**No setting.** Build & restart is explicitly the user's action and the old sessions were
running; there is nothing to opt out of that Stop doesn't already cover.

**A turn in progress is lost.** `--resume` restores the conversation, not the work in
flight; the confirm text in Settings says so ("running sessions are resumed; a reply in
progress is interrupted").

## Planned changes

- `src/server/server-restart.ts`: on `build: true`, after the build, collect → write list →
  park → launch (`parkSessionsForRestart()`). Deps gain `sessions: RestartSessions`
  (`dataDir`, `targets`, `park`, `revive`) so tests stub them; `launch` gains an
  `onFailure` callback.
- `src/server/sessions/manager.ts`: `restartTargets()` (the non-fork running sessions) and
  `parkForRestart(ids)` (the existing `parkSession()` without a session-log entry — the
  conversation continues).
- `src/server/sessions/revive-on-boot.ts` (new): write/take/delete of the list file, age
  check, `reviveListed()`, and the boot entry `reviveSessionsFromRestart()`.
- `src/server/app.ts`: wires the deps and calls the boot revive, skipped on an isolated
  boot.
- `src/client/server-restart.ts`: confirm text for Build & restart.
- `docs/session-revive.md`: a short section; CLAUDE.md rule only if one emerges
  (e.g. "only Build & restart writes the revive list").

## Verification

- `tests/revive-on-boot.test.ts`: list written only for `build: true` and only after a
  successful build; forks and terminated sessions excluded; file consumed once; stale
  file ignored; a refused session doesn't stop the rest; launcher spawn failure revives
  in-process.
- Manual on the live server (it's the only one that can Build & restart): two Claude
  sessions and one plain shell running, one stopped session → Build & restart → the three
  come back attachable with their scrollback, the stopped one stays stopped.

## Out of scope

Plain Restart, reboots, crashes, the job pipeline's rebuild stage, Linux/macOS (tmux
sessions already survive), resuming an interrupted turn.

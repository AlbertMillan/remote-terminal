# Live job overlay

## Goal

A dispatched job runs for tens of minutes across eight stages, and today the
only place that says so is the Projects tab: `JobBoard` polls `/api/jobs?cwd=`
for **one** project, and only while that project's detail view is open. From a
terminal session you cannot tell that a job finished, failed, or parked three
stages ago waiting for you to answer a question.

Put a small, collapsible panel over the main area that lists every live job
across every project — project, title, where it is in the pipeline — updating
the instant a stage changes, with a click that takes you to that job. Toggle it
on or off (and choose where it sits) from the Settings modal.

## Design decisions

**Pushed, not polled.** `JobBoard`'s poll deliberately stops when nothing is
running, which is right for a board you are already looking at and wrong for an
always-on overlay: to notice a job *starting* it would have to poll forever,
several times a minute, whether or not anything exists to report. Instead a job
event fires on every write in `jobs/store.ts`, and the WebSocket handler
broadcasts a compact summary. Idle costs nothing and a stage change shows up
immediately. `notificationService` is the precedent — a singleton with
callbacks, subscribed by the handler — and this follows it rather than inventing
a second mechanism.

**The emitter sits in `jobs/`, and the handler subscribes to it.** The store
must not import the WebSocket layer; `jobs/events.ts` is a leaf module both
sides can depend on. Emitting from the store rather than the runner is what
makes the feed complete: `approveGate`, `answerQuestion`, `cancelJob` and
`discardJob` all reach the store, and a runner-only hook would silently miss
every one of them.

**The summary is built from `listJobs()` and the registry, never
`getWorkspaceBoard()`.** The roll-up endpoint's names come from the board, which
parses every project's `PROJECT.md` from disk — acceptable once per page view,
not on every stage transition. Display names are resolved exactly as
`workspace.ts` resolves them (registry override, else the directory basename),
so the card and the board cannot disagree.

**Placement is a setting, not a decision.** Two placements were mocked against
the real chrome and both are defensible, so both ship:

- `header` — the pill becomes a flex item in `#terminal-header`, left of the
  fork/PiP/rename/terminate buttons, and the card list hangs beneath it. Costs
  no terminal space at all when collapsed.
- `below` (default) — the panel floats at `top: 62px`, clear of the header.
  Identical in every view, at the cost of sitting over the top-right of the
  output.

`right: 14px` in both cases: `.terminal-scrollbar` is a 10px draggable strip
pinned to `right: 0`, and an overlay flush to the edge swallows its drags.
Bottom-right was rejected outright — Claude Code draws its input box and status
line at the bottom of the terminal, which is the one region you are reading
while a job runs, and `.mobile-nav-toggle` already owns that corner on a phone.

**In `header` placement the pill is reparented, not offset.** Positioning it
absolutely to the left of the controls means hard-coding their width, which
changes as the Keep button appears and disappears on forks. Moving the node into
the header lets flexbox do it. When the header is hidden there is nothing to
dock to, so the overlay falls back to floating where the header would have been
— and nothing collides there, because the buttons it was avoiding are gone too.

**Hidden on the Projects and Overview views.** Both put their own actions
(`Re-sync plan`, `Open session`) exactly where the panel sits, and both already
render these jobs in more detail directly below. Showing it there would collide
and duplicate at the same time.

**Live jobs, plus finished ones for a minute.** `queued`/`running`/`parked`
always; `done`/`failed`/`cancelled` linger 60s at reduced opacity, so a job that
finished while you were reading a terminal does not vanish unseen. The server
sends terminal-status jobs updated within the last two minutes and the client
decides when to drop them — the client owns "how long have I been showing
this", and a reconnect must not restart the clock on something an hour old.

**Parked sorts above running.** A running job is information; a parked one is
work stopped until you act. Within a rank, newest first. This is the same
argument `rollup.ts` makes with `KIND_RANK`, and deliberately the same order, so
the two surfaces never contradict each other.

**Per-device in `localStorage`, like `sidebarCollapsed`.** Enabled, placement
and collapsed-state are view preferences: a phone and a desktop reasonably want
different answers, and a DB migration plus a protocol change to sync them buys
nothing. Written on **Save** so Cancel genuinely cancels.

**A stage strip, not the board's icon row.** Eight 3px segments coloured by
stage status read as progress at a glance, where the board's `· ◐ ✓ ✕` row is
built to be read a stage at a time. The strip is only legible because the
pipeline is a fixed eight stages in a fixed order — `STAGE_ORDER` is the
contract it renders.

**Cost stays on the card.** It is already summed server-side per job
(`sumUsage`), and "this has been running 40 minutes and spent $4" is exactly the
kind of thing you want to catch without opening anything.

## Planned changes

**Server**

- `jobs/events.ts` (new) — `jobEvents` singleton: `onChange(cb): () => void`,
  `emitChange()`. Callback errors are caught and logged, never thrown back into
  a DB write.
- `jobs/summary.ts` (new) — `buildJobsSummary(): JobsSummary`. Live jobs plus
  terminal ones updated within `RECENT_TERMINAL_MS` (2 min); per job: id, cwd,
  project name, title, status, stage, gate, parkReason, truncated detail, the
  eight `{ name, status }` pairs, `costUsd`, `createdAt`, `updatedAt`.
- `jobs/store.ts` — `emitChange()` after every mutating statement
  (`createJob`, `updateJob`, `updateStage`, `startStage`, `finishStage`,
  `addStageUsage`, `deleteJob`).
- `websocket/protocol.ts` — `'jobs.summary'` server message +
  `JobsSummaryPayload`.
- `websocket/handler.ts` — subscribe once at registration; broadcast to every
  connection on change, and send one summary to a client right after auth so a
  fresh page is populated before anything moves.

**Client**

- `job-overlay.ts` (new) — the panel: state from `jobs.summary`, render, the
  60s expiry sweep for finished jobs, collapse/placement/enabled from
  `localStorage`, and `setPlacement()` doing the reparent.
- `session-manager.ts` — construct it, route `jobs.summary`, call
  `syncJobOverlay()` wherever the terminal header is shown or hidden and when
  the Projects/Overview views open or close, and on a card click switch to the
  Projects tab, load the board, open the project and focus the job.
- `job-board.ts` — `focusJob(jobId)`: expand that job and scroll it into view.
- `index.html` — the overlay markup, and a **Display** section in the Settings
  modal (checkbox + placement radios, radios disabled while unchecked).
- `styles.css` — `.job-overlay` and friends, both placements, and the
  `max-width: 640px` rule that spans it full width on a phone.

## Verification

- `npm run build`, `npm test`, `npm run lint` clean.
- Unit (`tests/job-summary.test.ts`): live jobs are always included; a job that
  finished 10 minutes ago is not; one that finished 30s ago is; detail is
  truncated; names come from the registry override when present and the
  basename otherwise; the payload carries all eight stages in `STAGE_ORDER`.
- Unit (`tests/job-overlay.test.ts`): parked sorts above failed above running
  above queued above done; finished jobs expire after 60s of display and live
  ones never do; counts in the pill match the cards.
- Manual: dispatch a job, watch the strip advance from a terminal session with
  the Projects tab closed; approve a gate from the board and see the overlay
  change without a reload; toggle both placements and the on/off switch in
  Settings; reload and confirm they stick; check a phone width.

## Out of scope

- Acting on a job from the overlay (approve, answer, cancel). The card is a
  status glance and a route to the board, which is where those live.
- Browser/system notifications for job transitions. That is the notification
  system's job and a separate decision about what deserves to interrupt you.
- Replacing `JobBoard`'s poll with the same push feed. Worth doing, but it is a
  change to a working board rather than part of this feature.

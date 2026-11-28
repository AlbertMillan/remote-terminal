# Factory page redesign (layout E)

## Goal

The Factory board (`src/client/factory-board.ts`) shows six equal columns and does every
decision in a drawer that slides over the board. What you need to see first, the units waiting
for you, is one card style among many, and on a phone the six columns don't fit.

Rebuild the page around approved layout E: decisions first, the pipeline one click away, and
a detail pane that sits beside the board instead of covering it. Desktop and phone (web) both.

Approved mockup (clickable, press Play): https://claude.ai/artifact/C9CXCLTFUYGjMjrYQg1Ju6,
artboards `#artboard-FlowDesktop` and `#artboard-FlowPhone`. The other artboards (A–D) are the
alternatives that were weighed.

## Design decisions

**Desktop: D's layout, B's lanes behind a toggle.** Top to bottom: header (seats, plan
usage, Board / Flow toggle, Add work), **Needs you**, then **Pipeline** in Board view or
**Flow** in Flow view. On the right a side panel (capacity, since you last looked, merge
queue) that the detail pane replaces while a unit is open.

**Needs you is hidden when empty.** No "nothing waits" placeholder. It lists units with
`needsYou` (escalated reviews, shaping questions, mockups, triage) as cards with their
decision inline: Approve / Open, the question's options, Build it / Open, Accept / Backlog /
Dismiss. Everything else about a unit stays in the detail pane.

**Pipeline is a stage picker, not columns.** Six stage tabs (the existing `FactoryColumn`s:
intake, ready, running, review, merging, done) with counts and a one-line note each; the
selected one lists its units as rows below. Default: Running. A stage holding a unit that
waits for you shows its count in amber. Loose merge entries (session Lands) list under
Merging / Done as today.

**Flow view = B's lanes.** One row per track (loose items share an Inbox row), stages as
columns, each unit drawn at its stage. Built from the same `/api/factory/board` data; no new
route. The toggle is remembered per browser (`localStorage`, like `LAST_OPENED_KEY`).

**The detail pane docks; it never overlays.** Clicking a card, a row or a lane tag opens the
unit in the right-hand column, which pushes the side panel out rather than covering the
board. It carries a row of stage dots showing where the unit is, and every view the drawer has
today: review (summary, diff, features; Approve, Request changes, Take over), shaping
questions, triage, mockup (frame stays unreloaded across pushes, as today), merge entry,
cancel confirmation, claimed-unit actions (`factory-claims.ts`). Add work stays a modal.

**Undo is a deferred send, client-side.** Approve, Answer, Build it, Send back and triage
actions apply to the page at once (the card resolves, the unit moves stage) and show a toast
with Undo for 5 s; the POST goes out when the toast expires. Undo drops it. A pending
decision is flushed immediately on `hide()`, `pagehide` and before a second decision on the
same unit. Chosen over a server-side reverse because a release starts runs (fix step,
merge) that can't be taken back cleanly; the only cost is a 5 s delay before the factory
acts. Pushed `factory.summary` reloads keep the optimistic state until the send lands.
Cancel track stays confirm-first, no Undo.

**Phone (≤640px): D's home with a three-tab bar.** Tabs **You · Flow · Done**.
- *You* (default): plan-usage, running and merging tiles; Needs you cards with
  44px buttons; a running preview that opens Flow at Running.
- *Flow*: B's stage view: scrollable stage buttons with counts (amber when one holds work
  for you), progress dots, the selected stage's cards. Running and Queue are merged here.
- *Done*: what merged today and since you last looked.
The detail pane becomes a bottom sheet with sticky actions (Approve, Request changes, Take
over). Take over asks first. Add work is full-screen. After a decision the toast says where
the unit went in Flow.

**Copy and look stay in the app's theme** (Tokyo Night variables in `styles.css`, Plus
Jakarta Sans). The mockup's colours are those variables.

## Planned changes

- `src/client/factory-board.ts`: split rendering into needs-you, pipeline (stage picker +
  rows), flow lanes, detail pane and side panel; `Drawer` becomes the selected unit of a
  docked pane; view and stage state; keep the draft/focus capture across renders. It is
  858 lines already: move the new parts into `factory-board-*.ts` modules beside it
  (`factory-board-pipeline.ts`, `factory-board-flow.ts`, `factory-board-pane.ts`,
  `factory-decisions.ts` for the deferred-send queue).
- `src/client/index.html`: `#factory-board-view` gets the toggle in its header, a body with
  main column + right column; `#factory-drawer` moves into the right column; phone tab bar.
- `src/client/styles.css`: `.fb-*` rules for the new parts; the `@media (max-width: 640px)`
  block for tabs, sheet and full-screen Add work.
- `src/client/factory-overlay.ts`: card clicks still open the board on a unit; reuse
  `cardStatus` / `progressStrip`.
- Server: no change for features 1–5. **Start now** (feature 6) needs
  `POST /api/factory/items/:featureId/start` in `factory/board-routes.ts`: claim a ready
  item for a free seat ahead of priority, refused (409) with no free seat, over the
  spending cap or while dispatch is paused.
- Tests: deferred-send queue (send on expiry, Undo drops, flush on hide/pagehide, second
  decision flushes the first); stage grouping of units and loose merges; lane grouping by
  track; Needs you hidden when empty.

## Verification

- `npm test`, `npm run lint`, `npm run build`.
- Isolated boot (`project/QA.md`, Flow 3) with a project that has factory items in several
  stages: escalated review, shaping question, mockup park, running track, merge entry.
  - Approve inline: card resolves, Review count drops, toast shows Undo; Undo restores it and
    no release reached the server (check the log); letting it expire releases it.
  - Answer, Build it, triage Accept the same way; Send back moves the unit to Running.
  - Click each stage tab; rows match the units in that column; Merging lists a session Land.
  - Needs you disappears after the last decision.
  - Flow toggle: lanes per track, units at the right stage; the choice survives a reload.
  - Detail pane opens beside the board from a card, a row and a lane tag, for every unit
    kind; the mockup frame doesn't reload on a push.
  - Phone width (DevTools 390×844): You / Flow / Done, bottom sheet, full-screen Add work.

## Out of scope

- The Android app's native `FactoryScreen.kt`: it keeps its current layout; porting E there is a
  follow-up.
- The Factory overlay over the terminal (`factory-overlay.ts`) keeps its look.
- New data on the board (per-unit cost charts, history view).

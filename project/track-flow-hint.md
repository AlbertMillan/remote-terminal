# Explain the track flow

Track: Track workflow polish

## Goal

The first time someone opens a session on a track, tell them what is about to happen and
what to do at the end. Then they don't have to ask an agent whether it's working as
intended.

On 2026-09-24, the first real use of track branches started with exactly that question:
"I now spawned new claude code session on a known track. It led me to a different path
(worktree path). I created a claude code instance there (requiring mcp setup
confirmation) and started prompting. Is this how it is supposed to work? How should I
perform the merge when ready?" All of it was expected behaviour, but none of it was said
anywhere in the UI. Today the picker's whole explanation is one line: "Opens in the
track's own worktree, creating its branch on first use."

## Design decisions

### What it says

One short card, with these points and nothing more:

1. **Where you'll be.** The session runs in the track's own folder,
   `~/.claude-remote/worktrees/tracks/<id>`, on branch `track/<slug>-<id8>`, not in the
   project folder.
2. **Claude Code will ask to trust the folder.** It keeps trust and MCP approvals per
   folder, so it asks once for each new track worktree. Accepting is expected.
3. **The plan is here too.** The track's `PROJECT.md` lines and specs now live in this
   worktree. Tick and add features here or on the board, not on main.
4. **Dependencies install on first open.** This point depends on `f-y7mxvl` and ships
   only with it.
5. **To finish:** commit as you go, close the session, then click **Land** on the track
   heading. Land merges into main, rebuilds, and removes the worktree. Don't merge from
   inside the session.

The text lives in one constant, `TRACK_FLOW_STEPS` in `src/client/track-flow.ts`. Both
places below render from it, following the pattern of `SHORTCUT_GROUPS`: write it once,
or the two copies drift.

### Where it shows

- **Once, automatically.** The first time Open session or the picker opens a track
  session in this browser, the card shows beside the new terminal, with **Got it**.
  "Seen" is a per-viewer setting in `localStorage` (`trackFlowHintSeen`). It's wrapped in
  try/catch, and an unreadable value counts as "not seen", so at worst the card shows
  again.
- **On demand, always.** A small **?** on every branched track's heading opens the same
  card. It's the only way back to the card once it's dismissed, and it suits someone
  coming back to the flow weeks later.
- **The picker's note** grows from one line to two: the existing line, plus "Claude Code
  will ask to trust the new folder once." The note is visible in the dialog before
  anything happens.

### What it doesn't do

- **No change to the agent's context.** The global `CLAUDE.md` already tells agents the
  track rules. The question on 2026-09-24 came from the person, not the agent.
- **No Land checklist.** Showing which of Land's checks are blocking right now is pain
  point 4 (close the session and land) and point 5 (behind main), which are separate
  work.

## Planned changes

- `src/client/track-flow.ts` (new): `TRACK_FLOW_STEPS`, and a `renderTrackFlowCard()`
  that builds the card's DOM from it.
- `src/client/project-workspace.ts`: show the card after `openTrackSession` succeeds,
  when it hasn't been seen, and add the **?** on branched track headings.
- `src/client/track-picker.ts`: the two-line note, and the same first-time card after a
  track session opens from the picker.
- `src/client/styles.css`: the card.

## Verification

- **Unit:** the card renders every step from `TRACK_FLOW_STEPS`. "Seen" in
  `localStorage` hides the automatic card but not the **?** one. A throwing
  `localStorage` still renders the page, and shows the card.
- **Manual (isolated boot):** open a track session from the board → the card shows; Got
  it → the card goes. Open another → no card. **?** on the heading → the card shows
  again. Repeat from the picker.
- **Phone width:** the card fits with no horizontal scroll.

## Out of scope

- Suppressing Claude Code's trust prompt. It's Claude Code's own per-folder safety
  check.
- Live Land preconditions on the track heading (pain points 4 and 5).

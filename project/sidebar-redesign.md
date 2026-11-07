# Session sidebar redesign

Track: UI Improvements · Features: `f-epu9bh` (compact rows), `f-p1i90s` (attention and clutter)

Mockup: https://claude.ai/artifact/PK3jsqeGTCVNvqVPSyk6jN (today vs proposed, real sessions)

## Goal

The Sessions tab gets cluttered as soon as sessions start sessions. Each row is two or
three lines (name, then account/read-only/mode chips, status, `@claudeName`, a child
summary), every child is expanded under its parent, stopped rows sit between live ones,
and the header takes about a quarter of the panel. With 22 sessions the list is roughly
three panels tall.

Goals:

- **G1** What needs input is visible without scrolling, wherever it sits in the tree.
- **G2** About twice the sessions in the same height: one line per row, detail only on
  the selected row.
- **G3** Started sessions don't flood the list: folded by default behind a status tally;
  a builder and its read-only critic read as one track row.
- **G4** Stopped rows stop competing with live ones.
- **G5** Any session can be found by typing.
- **G6** Nothing in use goes away: categories, drag to reorder, revive, delete, nesting.
- **G7** Every session's address (the `@name` agents message it by) is one click away.

## Assumptions

- Busy means 20–40 rows: 3–8 children under one or two parents, about half read-only.
- Only the states that exist today: needs input, done (notifications), live
  (`attachable`), stopped. No "working" state is invented.
- **Client-only.** Everything comes from `SessionInfo` and `sessionNotifications`. No
  `protocol.ts` change, so `messages.json` and `Protocol.kt` stay as they are.
- The Projects tab and the Android app are out of scope.

## Design decisions (agreed 2026-11-07)

1. **One-line rows, 28px.** Leading status glyph (needs input = filled amber, done =
   filled green, live = blue ring, stopped = dashed ring; a read-only peer's glyph is
   square), name, then an account dot in the `--account-N` colour the usage chip uses
   (position in `/api/accounts`), shown only when sessions span 2+ accounts. An account
   warning stays on the row as ⚠.
   Account, cwd, non-`auto` mode, read-only and "started by" move to a **detail line**
   under the selected row only.
2. **Hover actions:** `@` (copy), revive (only when `revivable`), delete. They replace the
   account dot while hovered. On touch (`(hover: none)`) they show on the selected row's
   detail line instead.
3. **`@name` is not printed on the row.** The `@` action copies `@<claudeName>` (shown
   for every row whose `claudeName` is set, matching name or not). Feedback for ~1.6 s:
   the icon becomes a green check, the row gets a green left edge, and a toast at the foot
   of the sidebar says `Copied @claude-remote-31`. Clipboard failure (no
   `navigator.clipboard`, or a rejection on plain HTTP over the tailnet) shows the toast
   with the text selected for manual copy, never a false "Copied".
4. **"Needs you" strip** at the top: every session with a `needs-input` notification,
   children included, with the parent's name as context. Hidden when empty. The row stays
   in place in the tree too (deliberate duplicate).
5. **Children folded by default.** A collapsed parent shows one dot per child track
   (worst state first: input, done, live, stopped) and the child count. Expanded children
   render under a tree line. The stored set flips meaning, so it moves to a **new key**
   (`claude-remote.expandedSessionGroups`) holding expanded ids; the old
   `collapsedSessionGroups` key is ignored, or every previously open group would read as
   closed-by-choice the other way round.
6. **Track rows: one builder and its read-only peers.** The one-critic rule was dropped
   (`builder-critic-pairs.md`, Superseded design); the server now allows one writer and up
   to `MAX_PEERS` (2) read-only peers per caller and track (`sessions-api.ts`). The row
   doesn't depend on that cap.
   Reuse `peersAfterBuilders()`, which already places **every** peer of a builder right
   after it: the builder and all its peers render as one row with the builder's name, the
   builder's glyph, then one square glyph per peer up to 3 and `+n` beyond, and a chip
   (`pair` for one peer, `1+n` for more). Each square opens that peer (tooltip: its name
   and state); the rest of the row opens the builder. The row has its own caret that
   unfolds it into its members by name, since squares alone don't tell reviewers apart.
   The parent's tally counts the track once, at its worst member's state. A waiting peer
   still appears in the "Needs you" strip by its own name. A peer with no builder renders
   alone.
7. **"Stopped" drawer.** Top-level rows that are not `attachable` leave their category and
   collect in one collapsed section at the bottom, each with its category as a chip. Only
   when **nothing in the group is live**: a stopped parent whose children still run stays
   in place, or they would vanish with it.
   Stopped **children** stay dimmed inside their parent. A setting ("Keep stopped
   sessions in their category", default off) restores the old placement.
8. **Filter**, focused with **Alt+K** (registered in `SHORTCUT_GROUPS`; the terminal
   forwards it like Alt+N), Esc clears. Not `/`: the terminal holds focus nearly always,
   and `/` starts every Claude slash command. Matches
   name, `@claudeName`, category, account, and `read-only`. A non-empty filter flattens
   the tree into matching rows with their parent or category as context, and hides the
   strip and drawer.
9. **One-line header:** connection dot, title, icon buttons for shortcuts and settings; the
   build chip wraps under them when shown. The plan-usage chip stays as it is below (one
   line per account; a meter would drop the second account). "Add Category" becomes an
   icon beside the tabs. An empty category is just its dimmed header: one line, still a
   drop target, still renamable (one combined "Empty: …" line would lose both).
10. **Category headers** show `n` and a tally (`2 waiting · 1 done`) instead of `(n)`;
    rename/delete stay on hover.

## Planned changes

- `src/client/session-list-view.ts`: new pure helpers, exported for tests:
  `trackRows(children)` (pairs from `peersAfterBuilders()` output, worst state),
  `needsYou(sessions, notifications)`, `matchesFilter(session, query, ctx)`,
  `rowState(session, notification)`. Rendering rewritten around them; drag and drop,
  `setupDropZone` and the reorder logic kept as they are. Collapsed-group storage moves
  to the expanded-ids key.
- `src/client/index.html`: header markup, filter input, toast element.
- `src/client/styles.css`: row, glyph, strip, drawer, tree, toast styles; drop the
  two-line row and chip rules that no longer render. `(hover: none)` variant.
- `src/client/shortcuts.ts`: Alt+K Filter sessions (`terminal.ts` forwards it).
- `src/client/settings-modal.ts`: the "keep stopped sessions in place" toggle
  (client-side, localStorage like the badge setting).
- Click on a row still closes the mobile overlay as today.

## Verification

- `npm test`: unit tests for `trackRows`, `needsYou`, `matchesFilter`, `rowState`;
  extend `tests/session-group-dom.test.ts` for folded-by-default, the pair row, the
  drawer, and the `@` copy (clipboard stubbed: success shows "Copied", rejection does not).
- `npm run build`, `npm run lint`.
- Manual, on the isolated boot (`project/QA.md` Flow 3), never port 4220: 25+ sessions
  with two parents, a needs-input child appears in the strip; drag between categories;
  revive from the drawer; `/` then Esc; phone width via the mobile overlay.

## Out of scope

- Collapsed-sidebar rail of attention glyphs (follow-up).
- "Send to…" that types `message @x about…` into the current session (follow-up).
- Projects tab, Android app, any server or protocol change.

# Move a session's conversation to another account

Track: Claude accounts

## Goal

A session runs under one account (`f-dfgnx2`) for life. To carry on a conversation under
another login (one plan is out of quota, or work moved to the other side), the user had to
run `scripts/move-session-transcripts.mjs` by hand. A chip in the session header moves it:
same row, same conversation, the other login. Mocked (option B):
https://claude.ai/artifact/6MjSnKgWFugPQddtBp2yUA

## Design decisions

1. **The header's account chip** (`● work ▾`, top right, before Fork) opens a dropdown:
   the current account checked, every other one as "Move to <name>" with whether it is
   logged in, then a confirm step. Only the open session can be moved; shown only with two
   or more accounts.
2. **A running session is stopped, moved and revived in place**: Stop's `parkSession`
   (scrollback saved, browsers detached, the exit awaited so Windows frees the transcript),
   then the move, then the client sends the usual `session.revive`, which types
   `claude --resume` under the new account. A turn in progress is cut off; the confirm says
   so. A stopped session is only moved.
3. **Checked before anything stops**: a fork (its transcript dies at restart), a session an
   agent started (it runs under its caller's account), a parent with running started
   sessions (one login would direct work on another), no conversation, an unknown or the
   same account, and the target's `preflight()` — refused with the existing Log in / Clean
   up dialog, the move retried after login.
4. **The move**: `<id>.jsonl` and its `<id>/` folder into the same project folder of the
   target's `projects/`; across volumes copy then delete. A failure puts back what moved
   and leaves the row's account; a session that was running is revived where it was. A
   transcript already in the target's folder only repoints the row.
5. **Usage**: no ledger write. The ledger drops a vanished path's file row and reads the
   new one without double counting (`docs/accounts.md`, "Usage ledger and moved transcripts").
6. **Protocol**: `session.changeAccount { sessionId, account, force? }` → the requester gets
   `session.accountChanged { sessionId, account, resume }`, every sidebar the row. Another
   browser viewing a running session: refused with `code: 'viewers'`, confirmed, resent with
   `force` (as Stop).

## Verification

1. Unit: the move (same volume, the subagent folder, a failure restores, already there);
   every refusal; a running session parked then moved, a failed move reverts the account.
2. Isolated boot: move a stopped session and a running one; the revived terminal resumes
   the conversation under the other login; the account chip, sidebar and status line agree.

## Out of scope

- Rotating accounts when quota runs out (DSAgents' "Seguir con otra cuenta").
- Moving from the sidebar (option A), and moving a project's auto-memory.

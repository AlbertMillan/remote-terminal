# Deleting session history entries

Each entry under a project's **Session history** has a **Delete** button next to Resume/Fork.
It removes the entry from that project's `SESSION-LOG.md` and unlinks the backing Claude
transcript (`~/.claude/projects/<slug>/<claudeSessionId>.jsonl`).

`POST /api/project-logs/entry/delete` with `{ cwd, entryIndex, claudeSessionId, scope }`:

- `entryIndex` is the entry's position in `parseLogEntries()` order (newest first). The server
  re-reads and re-parses the log and returns **409** if `claudeSessionId` doesn't match what
  actually sits at that index — the board is a poll snapshot and the generator may have
  prepended an entry since, which would shift every index.
- `scope`: `'entry'` (default) removes just that entry; `'conversation'` removes every entry
  carrying the same `claudeSessionId`.
- The transcript is only unlinked once **no surviving entry references it**. The generator
  writes one entry per session close, so a long-running conversation has several entries backed
  by a single `.jsonl`. The response reports `transcriptKeptReason` when it was kept
  (`still-referenced`, `session-live`, `no-session-id`, `not-found`, `unsafe-id`, `failed`), and
  the UI offers a checkbox to widen the delete to the whole conversation when siblings exist.
- Transcripts are only unlinked when the marker's session id is a plain UUID resolving inside
  `~/.claude/projects` — marker text comes from a user-editable markdown file, so it is treated
  as untrusted input.

Server-side logic lives in `src/server/sessions/history-delete.ts`; the log rewrite itself is
`removeLogEntry()` in `session-log-format.ts`, which slices marker→next-marker so the file
header and the `claude-remote-phases` manifest are always preserved.

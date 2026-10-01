# Session logs of worktree sessions go to the main checkout

Track: Project Session Log

## Goal

A session that ran in a track or job worktree should keep its `SESSION-LOG.md` entry after
the worktree is gone. Generating that entry should never hold the worktree open while Land
or Delete removes it.

Today the generator writes wherever the session's cwd is (`project-log.ts`:
`logPath = join(ctx.cwd, fileName)`, and `runClaude(ctx.cwd, …)`). For a session in a
worktree, that is the worktree. Two things break:

- **Entries are lost.** A worktree is its own checkout with its own copy of
  `SESSION-LOG.md`. In this repo the file is gitignored, so the copy never travels with the
  branch, and Land or Delete deletes it with the folder. Every session-log entry for a
  track's sessions is lost. The track's phase group, and the `sessionIds` in it, are lost
  too, and `track-attribution.ts` and Delete track read those from main's file.
- **Teardown fails.** A closing session starts the log run right away, and the run's
  `claude -p` process keeps the worktree as its cwd for 30 seconds to a few minutes. Land
  is only refused while a *session* is open, so it goes ahead. On Windows its `rmdir` then
  fails with `EBUSY`. From `~/.claude-remote/logs/server.log`:
  - UI Improvements, 2026-09-29: log run started 18:04:47, teardown `EBUSY` at 18:05:01,
    run ended 18:05:34 with "run completed but no entry was written".
  - Track branches & delete (first branch), 2026-09-25: log run started 11:25:56,
    teardown `EBUSY` at 11:26:10.
  - Job worktree `5724b4ee…`, 2026-09-20: teardown `EBUSY` at 00:03:12, then a log run at
    00:17:14 wrote a `SESSION-LOG.md` stub into the half-deleted folder.

  `f-rtcckq` stopped this from leaking branches and folders: teardown steps are now
  independent, busy folders are retried, and a boot sweep removes the stubs. The entry is
  still lost, and the folder is only removed once the run lets go of it.

## Design decisions

### Where the entry is written

A session whose cwd is inside an **unlanded track worktree** (a `track_branches` row) or a
**job worktree** (a `jobs.worktree_path`) is logged into the **project's** main checkout:
`join(projectCwd, fileName)`. Sessions anywhere else are unchanged.

- Resolve the project from the records (the row's `project_cwd`), never by guessing from the
  path. A worktree with no record is logged in place, as today.
- The entry marker should say where the work happened. Either the session's branch, which
  `branch` already holds (`track/…` or `job/…`), is enough, or add a `worktree` field. To
  decide.
- **Read from the worktree:** the transcript lookup (`tryGetTranscriptPath(…, ctx.cwd, …)`,
  since Claude Code files transcripts under the session's cwd) and the git evidence (status,
  `log --since`, diff, branch). That's where the work is.
- The phase manifest group for a track session lands in main's file, so attribution and
  Delete track see its `sessionIds`.

### Where the run runs

Running `claude -p` in the main checkout is what stops it holding the worktree. But
`runClaude`'s cwd also scopes two other things, and both need a decision:

1. **The post-run revert** (`claude-run.ts`, "revert any file the run touched outside
   `allowedGlobs`"). Run in main, it diffs main's status before and after the run. A file the
   user changes on main during that window would be reverted. The same exposure already
   exists for sessions on main, but a track's run would add more of them. Options: snapshot
   only the log file's path, or run with `allowedGlobs = [fileName]` only.
2. **Plan-file ticking** (`editPlanFiles` + `planGlobs`). A branched track's plan now lives
   in its worktree (`f-rtcckq`), so ticking plan files in main would tick the wrong copy, or
   nothing. Options:
   - turn off plan ticking for worktree sessions, since the board's PROJECT.md is
     authoritative and rebuild ticks features;
   - run twice, the log in main and plan ticks in the worktree, which brings back the hold
     for the second run;
   - pass the worktree's plan files to a main-cwd run by absolute path, which `allowedGlobs`
     can't express today.

   Leaning towards the first.

### Tracked `SESSION-LOG.md`

In a project where `SESSION-LOG.md` is **tracked**, writing it on main leaves main dirty. Land
then refuses: it only lets uncommitted *planning* files through on main
(`isPlanningPath` in `track-plan.ts`). Treat the configured `projectLog.fileName` at the repo
root as a planning file for that check. It is the same kind of file: written by
claude-remote, never code. Delete track's `ours` set already counts it.

### Ordering against Land

With the run in main, nothing holds the worktree, so Land no longer needs to wait. Land can
still fire while the run is reading the worktree's git state. That is harmless: the reads
finish in under a second at the start of the run, and the transcript is outside the worktree.

## Planned changes

- `src/server/sessions/project-log.ts`: resolve the log target (project cwd and file) from
  the session cwd through the track and job records. Read evidence from the session cwd and
  write to the target. Choose `runClaude`'s cwd and globs as decided above.
- A lookup helper, `worktreeOwner(cwd)` → `{ projectCwd, kind: 'track' | 'job', branch }`,
  next to `findActiveTrackBranchByName` (`track-branches.ts`) and the jobs store.
- `src/server/projects/track-plan.ts`: `isPlanningPath` accepts the session-log file name.
- `docs/session-log-feature.md`: a section on worktree sessions. Update §3's trigger table
  and §5's generator steps.

## Verification

- A session in a track worktree, with a gitignored `SESSION-LOG.md`, closes. The entry
  appears in main's file, the worktree has no `SESSION-LOG.md`, and Land then removes the
  folder on the first try (no `EBUSY`, no background retry in the log).
- The same with a tracked `SESSION-LOG.md`: main is left dirty only in that file, and Land
  goes through.
- The entry's evidence (files changed, commits) is the worktree's, not main's.
- The track's phase group in main's file holds the session id, and
  `guessTrackWork` / Delete track find it.
- A session in a worktree with no record is logged in place, as today.
- The startup sweep (`sweepUnloggedSessions`) logs a worktree session whose worktree is
  already gone. Its transcript still resolves, but the git reads fail, so it falls back to
  the non-git path. Decide whether that is acceptable or such sessions are skipped.

## Out of scope

- Recovering entries already lost from landed or deleted worktrees.
- Session-log generation for sessions on main, which is unchanged.
- The test logger writing into the real `server.log` (separate issue).

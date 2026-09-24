# Change provenance: job-built and session-built edits

A project here changes in two ways, and a user may do both in the same project on the
same day:

- **Job-built.** The pipeline runs a feature through its own worktree and branch, then
  merges it with `--no-ff`.
- **Session-built.** A person, or Claude in a terminal, edits whatever the session's cwd
  holds: the main checkout, a track worktree, or any other directory.

Any feature that reads, moves, reverts or attributes project changes has to handle both.
Designing it around one path gives a feature that works in the demo and then fails, or
does damage, for the user who works the other way.

## How the two differ

| | Job-built | Session-built |
|---|---|---|
| Where the work happens | `~/.claude-remote/worktrees/<job>`, on its own branch | The session's cwd: main, a track worktree, anywhere |
| What records it | Job row, `baseBranch`, `merge_sha`, the merge commit's `Job-Id`/`Feature` trailers | Transcripts, dirty files, commits made during the session's time window |
| Confidence | **Record**: exact | **Inference**: a guess |
| Who answers questions | Nobody. The job parks at a gate and resumes the session that asked | The person at the keyboard |
| Lifecycle | Cancel / Discard, the per-project lane queue, the project try-lock | A live PTY. On Windows its open cwd holds the directory |
| When it ends | At merge, and at discard the row and its `merge_sha` are deleted | Never, explicitly. The transcript and the edits just stay |

A job's database records can also disappear. Discarding a done job deletes its row and
its `merge_sha`, and that is the normal end of a job's life. That's why the merge commit
itself carries the job and feature ids as trailers (`jobs/merge-trailers.ts`): git keeps
them through a discard, a lost database or a re-clone. Only merges from before trailers
existed still fall back to the exact subject (see `track-branches.md`, *Finding a merge
by its trailers*).

## Where this has already come up

- **Delete track.** Job merges are reverted by `merge_sha`, or by a *unique*
  `Merge job: <title>` subject. Session work on main can only be guessed at
  (`track-attribution.ts`), so it is offered **unticked**. Ticking a guess by default
  would revert unrelated work.
- **The unbranched-work badge.** At first it counted guessed commits, which flagged every
  track with history from before track branches existed. It now counts only uncommitted
  files, the only kind of session work Branch now can act on.
- **Land.** Jobs never block `git worktree remove`, but a live session with its cwd in the
  worktree does, on Windows. So Land refuses while one is open, and Delete closes those
  sessions before teardown.
- **Track branches as a whole.** They exist because job-built work was always
  attributable and session-built work wasn't: the Usage visibility track (2026-09-19)
  had to be undone by hand.

## Rules for a new feature

1. **Name both paths in the spec.** Say what the feature does for a job's changes and
   for a session's changes, including "nothing" and why.
2. **Keep records and guesses apart, in code and in the UI.** A record may be acted on by
   default. A guess is shown, labelled as a guess, and needs confirming: unticked, or a
   confirmed list.
3. **Degrade to "not attributed", never to a wrong attribution.** An ambiguous match
   (two merges with one subject, a session in two tracks) is reported for the user to
   handle by hand, not resolved by picking one.
4. **Account for a live session in any directory you remove or rewrite.** Check for one
   or close it first. Never assume only jobs touch a worktree.
5. **Don't assume a job row still exists.** Discard deletes it, so fall back to what git
   records.
6. **Know the inference's blind spots.** Transcript attribution sees Write, Edit,
   MultiEdit and NotebookEdit, not shell edits (`sed -i`, `cat >`, scripts). A feature
   that relies on it must tolerate missing files.

## Open direction: record session provenance when it happens

Most of the session-side machinery (transcript scans, time windows, detecting
`cat >> PROJECT.md`) exists because a session records nothing about what it is working
on. Recording what it changes as it changes it would turn those guesses into records.

Just storing a session's track on its row was considered (2026-09-24) and dropped:
- a session in a track worktree is already tied to its track exactly, by its cwd;
- the guessed case is a session in the main checkout, which only the user can assign to
  a track;
- `sessions.claude_session_id` is overwritten on every resume, so a record has to be
  keyed by transcript id;
- even then it would only settle *which* sessions, not *what they changed*.

The likely shape is a `PostToolUse` hook that posts each Write/Edit/Bash call to the
server (PTYs already carry `CLAUDE_REMOTE_SESSION_ID`), with HEAD and `git status`
recorded around each Bash call. That covers shell edits and the commits a session
actually made. Open questions: the hook is optional user config, two sessions in one
checkout make before/after comparisons ambiguous, and it costs a `git status` per call.
It hasn't been designed yet. Before adding a new inference, check whether a small record
would do the job instead.

# Job abort & discard

Track: Project workspace & job pipeline

## Goal

Two things a user needs and currently cannot do:

1. **Abort a job mid-stage.** Dispatching the wrong feature is a normal mistake, and right
   now the pipeline gives you no way back: Cancel is refused while a stage is executing
   (`runner.ts:720`) and refused again once the job reaches a terminal status
   (`runner.ts:719`, because `isLive()` excludes `failed`). A job that dies in its first
   stage therefore has no window at all in which Cancel works.
2. **Discard a finished job**, returning the project to the state it was in before the job
   was dispatched, and taking the row off the board.

## Design decisions

- **Cancel and Discard are separate verbs, split by status.** Cancel acts on a live job
  (`queued`/`running`/`parked`) and means "stop this". Discard acts on a terminal job
  (`failed`/`done`/`cancelled`) and means "clean this up". Overloading one button for both
  is what produced the current bug, where the client offered Cancel for `failed`
  (`job-board.ts:508-514`) and the server rejected it with a 409.

- **Aborting mid-stage is safe, and mostly already implemented.** The comment on
  `cancelJob` cites two hazards that have both since been solved elsewhere:
  - *Killing a running `claude -p`* — `killTree()` (`claude-run.ts:85`) already does this,
    via `taskkill /pid N /T /F` on Windows, and the timeout path already calls it
    (`claude-run.ts:280`).
  - *The killed stage's terminal write resurrecting the job* — `stillLive()`
    (`runner.ts:612`) exists for exactly this and guards every terminal write in the runner
    (8 sites: 270, 346, 380, 404, 463, 498, 587; merge at 526 is deliberately exempt because
    a landed merge must always be recorded).

  The refusal predates those guards. What is genuinely missing is a handle on the child
  process, and one unguarded write (below).

- **The `catch` in `runNextStage` is the load-bearing fix.** It is the one terminal write
  with no `stillLive()` guard (`runner.ts:194-203`) and unconditionally sets
  `status: 'failed'`. Without a guard there, aborting a stage would flip the job the user
  just cancelled straight to `failed`. This guard must land with the abort, not after it.

- **Cancel orders its steps: mark → abort → await → tear down.** The job is marked
  `cancelled` *before* the child is killed, so the rejection arrives to find a non-live job
  and the new guard discards it. Teardown waits for the in-flight promise to settle, because
  on Windows `git worktree remove` fails against files a dying process still holds open.

- **Abort is an `AbortSignal`, not a child-process registry.** It composes with the existing
  timeout timer, and it also cancels a run still waiting in `runQueued()` that has not
  spawned anything yet — a registry of live children would miss that case.

- **Stage timeout moves off `projectLog.timeoutMs` onto its own key, defaulting to 20 min.**
  Every stage currently borrows the session-log generator's 180s budget (`design.ts:139`,
  `implement.ts:103`, `review.ts:161`, `fix.ts:96`, `qa.ts:168`). That is a session-log-sized
  budget applied to work that reads a repo and authors a spec. Observed directly: job
  `bf029012` was killed at 180s having *already written a complete 10.5KB spec* — the
  timeout discarded finished work.

- **Discard restores pre-job state, which for an unmerged job is exact.** A job touches the
  project outside its own worktree in exactly one place: the merge stage, which runs
  `git merge --no-ff` and `git push` in `projectCwd` (`merge.ts:56-92`). Everything else —
  the spec, the code, the review findings, the `.gitignore` rule (`review.ts:141`, scoped to
  the worktree) — lives inside the worktree. So for any job that never reached merge,
  removing the worktree and deleting the branch leaves the project byte-for-byte as it was.
  `removeWorktree(cwd, jobId, { deleteBranch })` (`worktree.ts:165`) already does both.

- **A job whose merge landed is the exception, and Discard will not silently unwind it.**
  See the open question below.

## Planned changes

| File | Change |
|---|---|
| `src/server/config.ts` | Add `jobs.stageTimeoutMs`, default `1_200_000` (20 min) |
| `src/server/agent/claude-run.ts` | `SpawnOptions.signal?: AbortSignal`; on abort `killTree(child)` and reject with `AbortedError`; check the signal on entry to `runQueued` |
| `src/server/jobs/stages/*.ts` (5) | `timeoutMs` reads `jobs.stageTimeoutMs`; thread `signal` through |
| `src/server/jobs/runner.ts` | `stillLive()` guard in the `runNextStage` catch; per-job `AbortController` + in-flight promise map; `cancelJob` drops the refusal and does mark→abort→await→teardown; new `discardJob()` for terminal statuses |
| `src/server/jobs/routes.ts` | `POST /api/jobs/:id/discard` |
| `src/client/job-board.ts` | Cancel rendered for live statuses only; Discard for terminal ones; wire the action + confirm |

## Verification

- `npm test` — extend `tests/job-gates.test.ts` and add `tests/job-cancel.test.ts`:
  - cancelling a running job leaves it `cancelled`, never `failed` (the guard)
  - an aborted stage's rejection does not overwrite the cancelled status
  - `discardJob` refuses a live job (409) and `cancelJob` refuses a terminal one (409)
  - discard removes worktree and branch
- `npm run build && npm run lint`
- Manual: dispatch a feature, hit Cancel ~30s into design, confirm the `claude` process is
  gone from the process table, the worktree directory and `job/*` branch are gone, and
  `git status` in the project is clean.

## Out of scope

- Reverting a merge that already landed (see the open question).
- Pausing/resuming a stage. Abort is a kill, not a suspend.
- Changing the three approval gates or the scheduler policy.

## Decided: a job whose merge already landed

Discard cleans up the worktree and branch and reports plainly that the merge is already in the
base branch. It never rewrites or reverts shared history.

Rationale: a job touches the project outside its worktree only via the merge stage, so for every
job that never merged, Discard restores the prior state exactly. Once a merge has landed it may
also have been pushed, and silently unwinding a commit other people may have pulled is a
decision only the user can make. Discard therefore says what it did and what it left, rather
than guessing. Reverting (`git revert -m 1 <merge-commit>`) stays a manual step; resetting the
base branch was rejected outright.

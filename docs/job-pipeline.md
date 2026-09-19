# Project workspace and the job pipeline

The **Projects** tab is a workspace over a canonical, per-project `PROJECT.md`, not a
view of `SESSION-LOG.md`. Server code lives in `src/server/projects/` and
`src/server/jobs/`; the client in `src/client/{project-workspace,job-board,rollup-view}.ts`.

**Canonical docs** (in each project, committed):

```
PROJECT.md              frontmatter (name/status/verify) + "## Track:" feature lines
project/<slug>.md       one feature's spec
project/QA.md           driver + commands + flows = what "verified" means here
project/reviews/        per-job review findings (gitignored)
```

Feature lines are `- [x] \`f-ab12cd\` P1 Title → project/slug.md`. Ids are
server-generated and **stable** — jobs and findings reference them.
`project-doc-format.ts` is the single source of truth for the format; parsing never
throws and unrecognized lines round-trip verbatim.

**Reads are deterministic parsing; writes are plain server writes.** An agent authors
`PROJECT.md` exactly once, at migration (`migrate.ts`), converting whatever plan docs a
project already has. Every UI write carries a content-hash `revision` and returns **409**
when the file changed underneath (same staleness contract as `history-delete.ts`).

**Registry**: `~/.claude-remote/projects.json` stores paths only — roll-up rules fold
nested dirs into a parent, `splitChildren` roots keep their children separate. Discovery
also recovers projects whose transcripts were deleted, by decoding the
`~/.claude/projects` slug against the filesystem (`slug-decode.ts`).

**Job pipeline** (`src/server/jobs/`): dispatching a feature runs it through
design → implement → integrate → review → fix → qa → merge → rebuild in its own git
worktree under `~/.claude-remote/worktrees/`. Three gates stop for approval: after
**design** (see the decisions before code), after **review** (tick which findings to fix),
and before **merge**. A stage that hits a real decision parks with the question rather
than guessing; **Take over** resumes that run's own Claude conversation in a terminal.

- `scheduler.ts` is a swappable `SchedulePolicy` — `OneRunningJobPerProject` ships.
- The merge gate is checked **before** its stage, so parked jobs keep `stage` on the last
  *completed* stage and approval is recorded in `approved_gate`. Changing this breaks the
  gate (see `tests/job-gates.test.ts`).
- **Cancel and Discard are split by status and neither accepts the other's.** Cancel stops a
  live job (`queued`/`running`/`parked`), aborting the stage mid-flight via an `AbortSignal`
  that `spawnClaude` turns into a `killTree()`. Discard cleans up a terminal job
  (`failed`/`done`/`cancelled`): worktree and branch removed, row deleted. Offering one verb
  for both is what once left `failed` jobs unremovable — the board rendered Cancel and the
  server answered 409.
- **Cancel's step order is load-bearing**: mark `cancelled` → abort → *await the stage
  unwinding* → tear down. The `catch` in `runNextStage` must keep its `stillLive()` guard, or
  the aborted run's rejection rewrites the cancellation as `failed`; awaiting the run before
  teardown is what stops `git worktree remove` racing a dying process's open file handles.
  Both are covered in `tests/job-runner.test.ts`.
- Discard restores the project exactly **only for a job that never merged** — the merge stage
  is the single thing a job does outside its worktree. A landed merge is reported
  (`mergeLanded`) and deliberately left in place; reverting it is manual.
- Stage runs use `jobs.stageTimeoutMs` (20 min), **not** `projectLog.timeoutMs` (180s, the
  session-log budget). Stages borrowed the latter and were being killed with finished work in
  hand.
- QA never reports unverified work as verified: precedence is failed > skipped > passed,
  so one trivial passing command cannot mask a driver that never ran.
- Token/cost accounting hangs off `RunOptions.onUsage` in `agent/claude-run.ts`, which
  fires **before** the error and denial checks **and on the failure paths** — a rejected
  run still spent its tokens, and so did a stage killed at the 20-minute timeout. Those
  rejections carry the parsed figure out on the error (`SpentOnFailure.spentUsage`); a run
  that died before printing an envelope reports nothing at all, because "we don't know" is
  not the same as "it cost nothing".
  `addStageUsage()` adds rather than replaces (qa and fix run several passes per stage),
  and totals are summed with `sumUsage()`, never stored. Read `modelUsage`, not the
  envelope's `usage` block: on a multi-turn run `usage` reports only the final turn.
  See `docs/token-usage-feature.md`.
- Non-git projects are `git init`ed and never pushed; Plastic workspaces are refused.
- **Agent runs queue per PROJECT, not globally** (`runQueued(task, laneKey)` in
  `agent/claude-run.ts`, lane supplied by `runLane()` in `runner.ts`). One global queue made
  the scheduler's promise untrue below the job level: it admits one job per project, then
  every stage of every project serialised behind a single slot, so a stage in project A sat
  for minutes while project B held it. Runs with no lane — the session-log generator, the
  PROJECT.md migration — share the default lane on purpose, being background work that
  should not multiply. Per-lane depth is still `projectLog.maxConcurrent`.
- **A stage records `spawned_at` as well as `started_at`.** `started_at` is when the stage was
  admitted; `spawned_at` is when its process actually began. Everything between the two is
  queue wait, and reporting it as execution is what made a job behind another one look hung —
  the board reads them apart via `isQueued()` and shows `queued · implement · 5m`. The stage
  timeout is armed at spawn, so queue time has never counted against a stage's 20-minute
  budget. `startStage()` clears `spawned_at`, or a re-run (an answered question, a retry)
  would inherit the previous run's spawn time.
- **Headless runs pass `--strict-mcp-config`.** Every stage's allowlist is file tools only, so
  no MCP tool is callable from one — but without the flag each run still started every MCP
  server configured on the machine and carried all of their tool definitions in its prompt.
  Measured at ~7.3k tokens per run, on every run of every stage.
- **An answered question RESUMES the session that asked it** (`--resume`, wired in
  `design.ts` and `implement.ts`). A fresh pass rediscovers the repository to apply a
  one-line answer — measured at 23 turns and 1.45M cache-read tokens on a one-file
  feature. A failed resume falls back to the full pass, so the worst case is the old
  behaviour; a `RunAbortedError` is re-thrown, or cancelling would be re-run at full cost.
  `implement` also now *reads* `pendingAnswer`: it was recorded and consumed by nobody, so
  answering an implement question re-ran the identical prompt into the same wall.
- Runs pass `--disable-slash-commands` as well as `--strict-mcp-config`: a stage can invoke
  neither a skill nor an MCP tool, and the two listings are ~2.4k and ~7.3k tokens of every
  prompt — which the run re-reads on every turn.
- The design prompt carries a **length budget** (~40 lines for a one or two file change,
  120 hard ceiling, five decision bullets). Without one it produced a 154-line spec for a
  fold/unfold button, and `implement` then pastes that spec into all of its turns.
- Measured decomposition of a stage run's prompt in this repo: 29.3k harness (system prompt,
  tool definitions, global CLAUDE.md) + 9.7k **this file** + 1.4k git/env. `--allowedTools`
  changes none of it — the definitions are always present. Every token here is re-read on
  every turn, so this file's size is a per-turn tax on every job.
- Covered by `tests/run-queue.test.ts` and `tests/stage-resume.test.ts`.

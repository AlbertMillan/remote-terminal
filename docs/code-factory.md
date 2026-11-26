# Project workspace and the code factory

The **Projects** tab is a workspace over a canonical, per-project `PROJECT.md`, not a
view of `SESSION-LOG.md`. The factory executes planned work in git worktrees while
planning stays in sessions. The spec, with the design decisions, defaults and planned
changes, is `project/code-factory.md`; this doc holds the reasoning behind the rules
`CLAUDE.md` states and the gotchas found building them.

Code: `src/server/projects/` (registry, `PROJECT.md`, board, tracks),
`src/server/factory/` (store, dispatcher, runner, steps, review, merge queue, cancel,
takeover, board routes), `src/server/worktrees/` (worktree and path resolution),
`src/server/qa/`. Client: `project-workspace.ts`, `factory-board.ts`, `rollup-view.ts`.

## Canonical docs

In each project, committed:

```
PROJECT.md              frontmatter (name/status/verify) + "## Track:" feature lines
project/<slug>.md       one feature's spec
project/QA.md           driver + commands + flows = what "verified" means here
project/reviews/        per-run scratch (gitignored)
```

Feature lines are `- [x] \`f-ab12cd\` P1 Title → project/slug.md`. Ids are
server-generated and **stable**: factory state (SQLite, keyed by feature id), merge
trailers and old job history all reference them. `project-doc-format.ts` is the single
source of truth for the format; parsing never throws and unrecognized lines round-trip
verbatim.

**Reads are deterministic parsing; writes are plain server writes.** An agent authors
`PROJECT.md` exactly once, at migration (`migrate.ts`), converting whatever plan docs a
project already has (the factory's intake agent also files lines into the Inbox track,
through `planFileFor()`). Every UI write carries a content-hash `revision` and returns
**409** when the file changed underneath (the same staleness contract as
`history-delete.ts`).

**Registry**: `~/.claude-remote/projects.json` stores paths only. Roll-up rules fold
nested dirs into a parent, `splitChildren` roots keep their children separate. Discovery
also recovers projects whose transcripts were deleted, by decoding the
`~/.claude/projects` slug against the filesystem (`slug-decode.ts`). The roll-up
(`/api/projects/rollup`) is blocked features plus project summaries; factory state comes
from the factory board.

## Agent runs (`agent/claude-run.ts`)

Every headless `claude -p` (factory steps, intake, shaping, the merge resolver, the
session-log generator, the `PROJECT.md` migration) goes through `runClaude`. Measured
costs below are what the flags are for.

- **Runs queue per lane, not globally** (`runQueued(task, laneKey)`). One global queue
  made every step of every project serialise behind a single slot, so a step in project A
  sat for minutes while project B held it. The factory's lane is the project cwd; the
  merge resolver has its own (`merge:<project>`) because it must not wait behind the
  project's other runs while its entry holds the merge slot; intake has one too. Runs
  with no lane (session-log generator, migration) share the default lane on purpose:
  background work should not multiply. Per-lane depth is `projectLog.maxConcurrent`.
  Covered by `tests/run-queue.test.ts`.
- **`spawned_at` vs `started_at`.** `started_at` is admission; `spawned_at` is when the
  process actually began. The gap is queue wait, and reporting it as execution made work
  behind another run look hung. The step timeout is armed at spawn, so queue time never
  counts against it. A re-run must clear `spawned_at` or it inherits the previous run's.
- **`--strict-mcp-config`.** Without it each run started every MCP server on the machine
  and carried all their tool definitions in its prompt: ~7.3k tokens per run. Enabling MCP
  for a step means scoping `--mcp-config` to one server or keeping `ToolSearch` in
  `--tools`, or every MCP tool loads eagerly.
- **`--disable-slash-commands`**: the skill listing is ~2.4k tokens of every prompt, which
  the run re-reads on every turn.
- **`--tools`** (`builtinToolsFor()`): decides which built-in definitions exist at all.
  `--allowedTools` changes none of the prompt; the definitions are always present.
- **A pass that asked a question is resumed, not redone.** An answer goes back into the
  session that asked (`--resume`); a fresh pass rediscovers the repository to apply a
  one-line answer (measured 23 turns and 1.45M cache-read tokens on a one-file feature).
  A failed resume falls back to the full prompt, so the worst case is the old behaviour,
  but a `RunAbortedError` is re-thrown or a cancel would be re-run at full cost
  (`factory/runner.ts`, shaping, mockup comments).
- **Prompt scoping is advisory; the post-run revert outside the allowed globs enforces
  it.** A `read` step reverts every edit. Keep both.
- **Questions must be self-contained.** The agent reads the repo; the person answering
  sees one card. A real question cited "Question 2" of a `SPEC.md` the reader had never
  opened. Prompts require the cited line quoted, files named by path and any constant the
  answer turns on spelled out, within a length budget: unbounded, a design produced a
  154-line spec for a fold button, which a later step pastes into all of its turns.
  Questions are structured JSON (options and a default), never prose to be parsed: a
  prose parser degrades to a wrong match at best, and guessing which of two numbered
  lists a citation means answers confidently and wrongly.
- **Measured prompt decomposition** in this repo: ~29k harness (system prompt, tool
  definitions, global CLAUDE.md) + this repo's `CLAUDE.md` + ~1.4k git/env, re-read on
  every turn. `CLAUDE.md`'s size is a per-turn tax on every run.
- **Timeouts.** Steps use `jobs.stageTimeoutMs` (20 min; the setting kept its name, read
  by `factory/deps.ts` `stepTimeoutMs` and the merge resolver), **not**
  `projectLog.timeoutMs` (180 s, the session-log budget): borrowed, it killed steps with
  finished work in hand.

## Usage accounting

Token and cost figures come only from Claude Code's own transcripts, into a ledger
(`src/server/usage/`), never from a run's `claude -p` envelope. Every `runClaude` passes a
`tag` (factory runs: `kind: 'factory'`, `jobId` = the unit's id, `stage` = the step),
written to `agent_runs` **before** the process spawns, so a run killed at its timeout
still counts. Envelope counters missed killed and failed runs and re-added a whole
session on every `--resume`. The runaway guard reads the ledger by unit id and counts
input, output and cache writes, not cache reads (those grow with conversation length, not
work). Cancel never deletes ledger rows; writes outside `usage/` call
`invalidateUsageCache()`. → `docs/token-usage-feature.md`.

## Worktrees and teardown (`worktrees/worktree.ts`)

- A loose item runs in `factory-<featureId>` under `~/.claude-remote/worktrees/`, branch
  `factory/<slug>-<featureId>`; an item of a branched track starts from and merges into
  that track's branch. A track runs in its track worktree.
- Non-git projects are `git init`ed (`ensureGitRepo`) and never pushed; Plastic
  workspaces are refused.
- Each worktree installs its own dependencies from its lockfile (checked on every run:
  a failed install leaves `needsInstall()` true, and a resume must not verify against
  half a folder). Never a `node_modules` link: `git worktree remove` deletes through a
  junction and empties the target. Details and measurements: `docs/track-branches.md`,
  Dependencies.
- `removeWorktree`'s steps are **independent**: a busy folder must not skip `branch -D`.
  It unlinks every link before git runs and skips git while one remains (it reports
  `linksLeft`; `describeLinksLeft()` words it). A failed `createWorktree` deletes only the
  branch it created. Track folders use 8 id chars (git refuses paths past ~210 chars on
  Windows).
- A unit's diff base is its recorded base branch, never the project's current branch: a
  unit parked while the user switched branches would otherwise be diffed against
  whatever they were on.

## Verification

The factory's verify step and the merge queue's re-verify run the project's declared
**commands** (QA.md `commands:` and `PROJECT.md` `verify:`), in order, and the first
failure is a failure: a red result never merges. The QA **flows** and the driver
availability check (`checkDriver()` in `qa/qa-doc.ts`) have no caller any more; the old
QA stage's precedence (failed > skipped > passed, so a trivial pass cannot mask a driver
that never ran) applies again only if a step starts running flows. Nothing declared is
not a failure.

## Reading files in a worktree

`resolveInWorktree()` (`worktrees/resolve.ts`) resolves a browser-supplied path inside a
checkout. The path is untrusted: absolute paths and NULs are refused, and symlinks are
resolved **before** the containment check, so a link inside the worktree cannot read the
rest of the disk. A path that does not exist yet is not a containment failure; the caller
reports it as missing. Callers: the project spec viewer (`project-store.ts`) and track
branches.

## Cancel (`factory/cancel.ts`)

Cancel stops a unit's work. Offered in every parked drawer (mockup revision cap
included) and on running units; not on claimed, triage, done or merging units. Surfaces:
board drawer "Cancel item/track" with a confirm view, `POST /api/factory/items/:id/cancel
{cwd}`, `cr factory cancel <id|track>` → `POST /api/agent/factory/cancel {target}`. A started
session (a builder or a read-only peer) is refused there (403), as for `take`: cancelling
deletes a loose item's worktree, so its parent or the board decides.

Order is load-bearing:

1. **Refusals first**, so a refused cancel changes nothing: a terminal session holds the
   unit (409 naming the session; Return to factory first), or its merge entry is
   `queued`/`holding`/`running` (409).
2. **Items marked `cancelled` first.** That clears their claims, so the run's heartbeat
   and owner-checked release touch nothing, dispatch never reclaims them, and a session
   can no longer take them. Marking after the abort lets the unwinding run write over the
   cancellation.
3. **Abort the run and await it unwinding.** On Windows `git worktree remove` fails
   against files a dying `claude` still holds open.
4. **A parked merge entry is deleted**, or Retry merge would land cancelled work.
5. **A loose item's worktree and branch are torn down** with `removeWorktree`. If a link
   is left, the run-state row is kept (parked `cancelled`) and the result says why, so the
   folder stays findable. A track's worktree stays: Land or Delete retires it. A
   cancelled track's progress is only marked; sending it again starts over.

`PROJECT.md` lines stay unticked (ticking is the merge's job). A track keeps every commit
on its branch; a loose item's work goes with its worktree and branch, which is why the
board asks first. Delete track cancels every live unit of the track
through the same function, checking every unit's `cancelRefusal()` before cancelling any.

## Old job history (`projects/job-history.ts`)

The retired job pipeline wrote `jobs` and `job_stages`; nothing writes them now and they
are **never dropped**. `listJobHistory(cwd)` reads them read-only for one reason: Delete
track must still recognise a merge an old job made, by the recorded `merge_sha`, the
`Job-Id` trailer, or a *unique* `Merge job: <title>` subject (see `track-branches.md`,
Delete track). Dropping the tables would leave those merges unrevertable by Delete. Old
job merges carry the same `Job-Id`/`Feature` trailers the factory's merges do
(`projects/merge-trailers.ts`), so `Feature:` finds both. Nothing else reads the tables:
no UI, no route, no discard.

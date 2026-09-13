# Token & cost accounting for jobs

Surface what each pipeline job cost — per stage, per job, and summed per
project — using the usage numbers the headless runs already report and that we
currently discard.

Status: **implemented**.

---

## 1. Where the data comes from

Every pipeline stage runs through `runClaude` → `spawnClaude` in
`src/server/agent/claude-run.ts`, which already invokes
`claude -p --output-format json`. That envelope carries, alongside the fields we
keep today:

```json
"usage": { "input_tokens": 9, "cache_creation_input_tokens": 13004,
           "cache_read_input_tokens": 18004, "output_tokens": 176 },
"total_cost_usd": 0.0287,
"modelUsage": { "claude-haiku-4-5-…": { "inputTokens": …, "costUSD": … } },
"num_turns": 1
```

Nothing new has to be spawned, measured, or scraped — the numbers arrive on
every run we already make. `parseClaudeResult()` now keeps them alongside
`is_error`, `result`, `permission_denials` and `session_id`.

**Read `modelUsage`, not `usage`.** Measured on a real two-turn run: the
top-level `usage` block reported `input_tokens: 19` where `modelUsage` had 967
for the same run — `usage` carries the final turn, `modelUsage` accumulates the
whole thing. Every pipeline stage is multi-turn, so reading the obvious field
would under-report input by an order of magnitude. Tokens are summed across
`modelUsage`'s per-model entries; `usage` survives only as the fallback for an
envelope that lacks `modelUsage`, and `total_cost_usd` (which equals the sum of
the per-model `costUSD`) is the cost.

## 2. Scope decisions

**Project total = sum of that project's jobs.** Not a scan of
`~/.claude/projects/<slug>/*.jsonl`. The transcript route would also capture
interactive terminal sessions and forks, but it needs message-id dedupe, mtime
caching, and worktree-slug → project folding, and it answers a different
question ("what has this project cost me overall") than the one the board is
for ("what did the pipeline spend on this feature"). Revisit if the overall
figure turns out to be the one wanted.

Consequence to state in the UI: **Take over** continues a parked job's
conversation in a terminal, and that spend is not in any envelope, so a taken-
over job under-reports.

**Headline is cost; tokens are the breakdown.** A raw token total is dominated
by cache traffic — the sample run above is ~31k tokens of which 31k is cache
read/write and 185 is new input/output. So:

- headline: `$0.029` (or `—` when a stage made no run),
- breakdown beside/under it: `in 9 · out 176 · cached 18.0k`.

**`total_cost_usd` is a list-price estimate, not money spent.** These runs are
billed against the Pro/Max subscription (see `docs/session-log-feature.md` §1),
so the envelope's figure is what the same tokens would cost at API list price.
Label it as such — "est. $0.029 at list price" in the tooltip — rather than
implying a charge.

## 3. Server changes

**Migration `012_add_stage_token_usage`** (`src/server/db/schema.ts`, same shape as
`011`): add to `job_stages`

```
input_tokens INTEGER NOT NULL DEFAULT 0
output_tokens INTEGER NOT NULL DEFAULT 0
cache_read_tokens INTEGER NOT NULL DEFAULT 0
cache_creation_tokens INTEGER NOT NULL DEFAULT 0
cost_usd REAL NOT NULL DEFAULT 0
run_count INTEGER NOT NULL DEFAULT 0
```

Defaults of 0 mean existing rows read as "no recorded usage" without a
backfill; `run_count` distinguishes *no run* from *a run that reported nothing*.

**`ClaudeRunResult`** gains a `usage: RunUsage` field (`inputTokens`,
`outputTokens`, `cacheReadTokens`, `cacheCreationTokens`, `costUsd`), parsed
tolerantly like the rest of `parseClaudeResult` — any missing or non-numeric
field reads as 0, never throws. A future CLI that renames these keys degrades to
zeros rather than breaking the pipeline.

**Accumulate, don't overwrite.** `qa` loops over its checks and `fix` can run
more than once per stage, so the store API is
`addStageUsage(jobId, stage, usage)` doing `SET x = x + ?`, called once per
completed run. Retrying a stage (`jb-retry`) adds to the existing total, which
is the honest reading — the retry really did cost that.

**Rollups** are computed, not stored: `sumUsage()` in `types.ts` folds stage
rows into a job total and job totals into a project total, including `done`,
`failed` and `cancelled` jobs, since abandoned work still cost something. They
ride on the existing payloads — `JobWithStages.usage`, and `usage` alongside
`jobs` on `GET /api/jobs` — rather than a new endpoint. `listJobs()` already
loads every stage row in one query, so the sums cost nothing extra.

## 4. Client changes

- **Stage chips** (`job-board.ts:243`) already carry a `title` tooltip built
  from `name: status — detail`; append `· est. $X · in/out/cached` when
  `run_count > 0`.
- **Job header**: the job's total as a chip on the collapsed row.
- **Project total**: beside the **Jobs** heading, with the job count in its
  tooltip.
- Tokens carry a `k`/`M` suffix; a stage or job with no runs shows no chip at
  all rather than `$0.00`, so "free" and "didn't run" stay distinguishable.

The project total sits beside the **Jobs** heading rather than in the project
header, where §2 first put it. That is its actual scope: it counts pipeline
jobs and not the terminal sessions in the same project, and a figure sitting in
the project header would be read as if it counted everything. Its tooltip says
so explicitly.

## 5. Subagents: cannot arise

The open question was whether subagent tokens roll into the envelope. It does
not apply here: no stage's `allowedTools` includes a Task/Agent tool — design
gets `Read, Glob, Grep, Write, Edit`; implement and fix add `Bash`; review is
read-plus-`Write`; qa is read-plus-`Bash` — so a stage run cannot spawn a
subagent in the first place. If a stage is ever granted one, re-open this: the
figures would become a floor rather than a total, and the labels should say so.

## 6. Out of scope

- Interactive terminal session usage (the transcript scan, §2).
- Budgets, caps, or alerts on spend.
- Per-model attribution — `modelUsage` is recorded in aggregate only.

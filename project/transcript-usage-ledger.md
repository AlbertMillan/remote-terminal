# Transcript usage ledger

Track: Token & cost accounting for jobs

## Goal

Count every model call Claude Code makes in a workspace project — pipeline stages, killed
runs, Take over, terminal sessions, subagents and the background session-log/migration/
QA-generate runs — from the transcripts Claude Code already writes, and make that ledger the
single source for every usage figure the UI shows.

Today's accounting (`docs/token-usage-feature.md`) reads the `claude -p` result envelope into
`job_stages` counters, which leaves these gaps:

1. **Killed runs record nothing.** The envelope is printed only on completion, so a run
   killed at the timeout or by Cancel has empty stdout and `withSpent()` recovers nothing
   (`claude-run.ts:456-470`) — the most expensive runs read as free, and their chip vanishes.
2. **Discard erases spend.** `deleteJob` cascades to `job_stages`, the only place usage lives,
   so the project total shrinks as the board is tidied.
3. **Non-job headless runs are uncounted:** session-log (`project-log.ts:341,472,518`),
   migration (`migrate.ts:152`), QA-generate (`qa-generate.ts:94`) pass no `onUsage`.
4. **Take over** and **terminal sessions** are out of scope by design, so the project total
   covers only a fraction of what the project costs.
5. **No time dimension or per-model split**: stage rows hold one running total each.

## Facts this design rests on

Verified against real transcripts on this machine (2026-09-24):

- Every assistant line carries `message.id`, `message.model`, `message.usage` (input, output,
  cache read, cache creation split into `ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens`),
  `timestamp`, `sessionId` and `cwd`.
- **One response is written once per content block**, byte-identical usage. Largest transcript:
  890 usage lines, 472 unique `message.id`s, 0 ids with differing usage. Summing lines roughly
  doubles every figure (also measured in session `d135a5a0-1d88-487e-9089-5126293ecc38`).
- Output tokens are final, not streaming snapshots (2 of 472 messages had a null `stop_reason`).
- Subagents write to `<project-folder>/<sessionId>/subagents/agent-*.jsonl` (+ `.meta.json`),
  **not** the parent file.
- Headless `claude -p` runs persist transcripts: every job and track worktree has its own
  folder (`…-worktrees-<jobId>`, `…-worktrees-tracks-<trackId>`).
- `claude --session-id <uuid>` exists, so a run's transcript can be named before it starts.

## Design decisions

- **Scope: projects with a `PROJECT.md` only.** A transcript belongs to a workspace project if
  any of these hold — records first, per `docs/change-provenance.md`:
  1. its `cwd` is the project root, or a subdirectory of it (`dsnews\api`,
     `rent-seeker\spike` fold into their parent by path prefix);
  2. its folder is a job or track worktree whose row names the project;
  3. its session id is in `agent_runs` (below);
  4. it is a subagent file under a session that belongs;
  5. its `cwd` is a Claude scratchpad whose path embeds a parent session id that belongs.

  Everything else is skipped, but its file is remembered (see ingest), so a project that
  later gains a `PROJECT.md` can be imported without rescanning the world.

- **Dedupe by `message.id` as the primary key.** Never count lines. A rescan, an overlapping
  read, or the same response seen twice is a no-op by construction.

- **The ledger replaces the `job_stages` counters — no fallback.** A run that leaves no
  transcript died before its first response and spent nothing worth recording. Removing the
  envelope path deletes: migration `012`'s six columns (new migration drops them), `addStageUsage`,
  `onUsage`/`UsageSink` through the five stages, `parseUsage`, `SpentOnFailure`/`withSpent`,
  and the `onUsage` rules in `CLAUDE.md` and `docs/job-pipeline.md`. `parseClaudeResult` keeps
  `isError`, `result`, `permissionDenials`, `sessionId`.

- **Every `runClaude` spawn names its session.** `runClaude` generates a UUID, passes
  `--session-id`, and writes `agent_runs(session_id, project_cwd, kind, job_id, stage,
  started_at)` *before* spawning, so even a run killed a second later is attributed.
  `kind` ∈ `stage | session-log | migrate | qa-generate`. A resumed run (`--resume`) keeps the
  session it resumes, which is already registered to the same stage. Take over resumes the
  job's recorded session, so its spend lands on that job without extra plumbing.

- **Our own price table.** Transcripts carry tokens, not dollars. `src/server/usage/prices.ts`
  maps model id → per-million rates for input, output, cache read, 5m cache write and 1h cache
  write, sourced from Anthropic's published pricing at implementation time. The 5m/1h split
  is priced separately — sessions here write mostly 1h cache. An unknown model shows its
  tokens with cost `—`, never `$0`. Label stays "est. at API list price".

- **Stored raw, priced on read.** Rows hold tokens only; cost is computed in the query layer.
  Correcting a rate re-prices history instead of needing a backfill.

## Planned changes

**Schema** (`src/server/db/schema.ts`, new migration):

```
usage_messages(message_id TEXT PRIMARY KEY, session_id, parent_session_id, project_cwd,
               model, ts, input_tokens, output_tokens, cache_read_tokens,
               cache_write_5m_tokens, cache_write_1h_tokens)
usage_files(path TEXT PRIMARY KEY, size, mtime_ms, offset, project_cwd NULL)
agent_runs(session_id TEXT PRIMARY KEY, project_cwd, kind, job_id NULL, stage NULL, started_at)
```

Indexes on `usage_messages(project_cwd, ts)` and `(session_id)`. None of these rows is
deleted by Discard, Delete track or history Delete — that is what fixes gap 2.

**Ingest** (`src/server/usage/ledger.ts`):

- Walk `~/.claude/projects/*/*.jsonl` and `*/*/subagents/*.jsonl`. For each file compare
  `size`/`mtime` with `usage_files`; read only bytes past `offset`, and only up to the last
  newline (a line mid-write is picked up next pass). A file that shrank is re-read from 0.
- Resolve a file's project once, from its first line's `cwd` + the rules above; store
  `project_cwd` (NULL = skipped) on `usage_files`.
- Triggers: after every `runClaude` settles, on the session-end notification hook, and a
  5-minute timer as backstop. Passes are serialised; ingest never throws into its caller.
- **Import on doc appearance**: when discovery sees a project gain a `PROJECT.md`, reset
  `offset` to 0 for files under it with `project_cwd` NULL. First boot imports all history.

**Queries** (`src/server/usage/queries.ts`), all derived:

- per job and per stage: `usage_messages ⋈ agent_runs` on session id;
- per project: split into *pipeline* (kind `stage`), *background* (other kinds), *sessions*
  (no `agent_runs` row);
- per model and per day, for the tooltip breakdown.

They ride on the existing payloads (`JobWithStages.usage`, `GET /api/jobs`), so the client
chip code keeps its shape; `run_count` becomes the count of distinct sessions.

**Client** (`job-board.ts`): stage and job chips unchanged in form. The project total moves
from beside **Jobs** to the project header, since it now counts everything, with the
pipeline / background / sessions split in its tooltip.

## Verification

- Unit: duplicate lines count once; a truncated last line is deferred, then counted; a
  shrunk file re-reads; subagent files attribute to the parent's project; scratchpad cwd
  folds to its parent session; a file outside every doc project is skipped and later imported
  when the project gains a doc.
- Unit: prices — 5m vs 1h cache writes priced apart; unknown model → cost null.
- **Price-table cross-check before the envelope path is deleted**: run a few real stages and
  compare the ledger's cost per session with the envelope's `total_cost_usd`; they should agree
  within rounding. This is a one-off check, not permanent code.
- Kill a stage mid-run (Cancel); its chip shows the tokens spent up to the kill.
- Discard a job; the project total does not drop.
- `npm test`, `npm run lint`, `npm run build`.

## Out of scope

- Budgets, caps, alerts.
- Real billing or Pro/Max plan-limit percentages — not in transcripts.
- Projects without a `PROJECT.md`, other machines, runs with `--no-session-persistence`.
- Spend-over-time charts and a rollup-overview column — the data supports both; add later.

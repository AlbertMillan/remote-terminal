# Token & cost accounting — the usage ledger

What every model call in a workspace project cost: pipeline stages (killed runs included),
Take over, interactive sessions, subagents, and the background session-log, migration and
QA-generation runs. Shown per stage, per job, and per project.

Status: **implemented** (spec: `project/transcript-usage-ledger.md`, feature `f-mpon58`).
Code: `src/server/usage/` — `ledger.ts` (ingest), `store.ts` (runs + queries),
`prices.ts`, `types.ts`.

---

## 1. Why transcripts, not the `claude -p` envelope

The first version (migration `012`) summed each run's `--output-format json` envelope into
counters on `job_stages`. Three defects, all measured, made it unfixable in place:

1. **A killed run prints no envelope.** The envelope is written only on completion, so a
   stage killed at the 20-minute timeout or by Cancel recorded nothing — the most
   expensive runs read as free. The "report usage on the failure path" code never had a
   figure to report.
2. **On `--resume` the envelope is cumulative for the whole session.** Measured
   2026-09-24: a two-run Haiku session reported $0.017542 for run 1 and $0.018795 for run 2,
   where run 2 alone cost $0.001253. Every answered question re-added everything the stage
   had already spent.
3. **Discard deleted the history.** Usage lived in the job's stage rows, which Discard
   cascades away, so the project total shrank as the board was tidied.

And it could never see Take over, terminal sessions or background runs at all.

Checked against three real jobs (2026-09-24), the ledger agreed with the old counters to
the token wherever the counters had seen a run, and found what they missed: a Take over
worth ~3.8M cache-read tokens, a failed review run that printed no envelope, and runs from
before the counters existed — $23.93 against the counters' $16.90 on the two affected jobs.

## 2. What the transcripts contain

Claude Code writes `~/.claude/projects/<slug>/<sessionId>.jsonl` for every session,
interactive or headless. Every assistant line carries `message.id`, `message.model`,
`message.usage` (input, output, cache read, and cache creation split into
`ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens`), `timestamp`, `sessionId`, `cwd`.

- **One response is written once per content block** with byte-identical usage (largest
  transcript here: 890 usage lines, 472 unique ids, 0 ids with differing usage). Summing
  lines roughly doubles every figure, so `message.id` is the primary key.
- **Subagents write to `<slug>/<sessionId>/subagents/agent-*.jsonl`**, not the parent file.
  Their rows are filed under the *parent's* session id, so they fall inside the parent's
  run windows and land on that run's stage.
- `model: "<synthetic>"` lines are client-side placeholders with zero usage; skipped.
- `--resume` keeps the resumed session's id and file (measured). `--session-id <uuid>`
  names a new session up front.

## 3. Scope and attribution

Only projects with a `PROJECT.md` are counted. A transcript belongs to one when (records
first, per `docs/change-provenance.md`):

1. it is a **subagent** file → its parent session's attribution;
2. its session is in **`agent_runs`** (a run we tagged) → that run's project and job;
3. its cwd is a **job worktree** (`<dataDir>/worktrees/<jobId>`) → that job — via the job
   row, or `agent_runs` when Discard has deleted the row;
4. its cwd is a **track worktree** (`worktrees/tracks/<trackId>`) → the track's project;
5. its cwd is a **Claude scratchpad** (`…\claude\<slug>\<sessionId>\scratchpad`) → the
   session that created it;
6. its cwd is **inside a project** — root or any subdirectory, longest match wins.

A file that resolves to nothing is remembered and re-resolved on every pass, which is how a
project's history is imported the first time it gains a `PROJECT.md`: its files start again
from byte 0. Attribution of a resolved file never changes.

**Stages come from run windows.** `runClaude` writes `agent_runs(session_id, project_cwd,
kind, job_id, stage, started_at)` *before* spawning, and sets `ended_at` when the process
settles — success, rejection, crash or cancel. A message belongs to the run whose
`[started_at, ended_at]` holds its timestamp. Outside every window (a Take over, or history
from before runs were recorded) it counts toward the job with no stage. `kind` is `stage`,
`session-log`, `migrate` or `qa-generate`; the project split is *pipeline* (has a job),
*background* (tagged, no job) and *sessions* (untagged).

## 4. Ingest

- Walks top-level `*.jsonl` and `*/subagents/*.jsonl`; `usage_files` keeps
  `(path, size, mtime, offset)`, so a pass reads only appended bytes, and only up to the last
  newline — a line mid-write waits for the next pass. Byte offsets are computed on raw
  buffers, never decoded text, so a multi-byte character split across reads cannot skew
  them. A file that shrank is re-read from 0; the primary key dedupes.
- Reads go 1 MB at a time with a `setImmediate` yield between steps, so a first import never
  holds the event loop (and every terminal on the server) for long. Not `setTimeout(0)`:
  on Windows it rounds up to ~15 ms, and measured 6.5 s against 0.8 s for the same import.
- A file's `cwd` is its first **top-level** `cwd`, however far in — a session opening with
  a huge paste has none in any fixed head, and a tool input can carry a nested one earlier on
  the same line, so lines are parsed rather than pattern-matched.
- **A response already stored moves only to a tagged run.** A Fork copies history into a new
  file under the same message ids; whichever file a pass read first would otherwise own the
  row, and a stage run's messages would lose their run window. The upsert re-homes a row
  from an untagged session to a tagged one, and never the other way.
- Order within a pass: ordinary sessions, then scratchpads, then subagents — each later
  rule looks up an earlier file's attribution.
- Triggers: every `runClaude` settling (`agent/run-events.ts` — claude-run announces, the
  ledger listens, so neither imports the other), every `completed` notification (a finished
  turn), and a 5-minute backstop. Passes are serialised and never throw. The ledger is **off until
  `startUsageLedger()`** (server boot), so tests and scripts never scan the real transcripts.
- Measured on this machine: first import of 187 files (106 MB) in 0.8 s; a steady-state
  pass in ~20 ms.

## 5. Pricing

`prices.ts` maps model id → $/MTok, dated snapshots matched by prefix, longest first (so
`claude-opus-5-5` is never priced as `claude-opus-5`). Cache writes: 1.25× input for 5
minutes, 2× for 1 hour — Claude Code writes mostly 1-hour cache, so collapsing the two would
under-price nearly everything. Cache reads: 0.1× input unless the model publishes a rate
(Fable 5.1 $0.25, Opus 5.5 $0.20). `speed: "fast"` applies the model's premium.

Rows store tokens only; cost is computed on read, so correcting a rate re-prices history.
An unknown model's tokens are shown with `unpriced` set, never priced as $0. Verified: the
ledger's cost for a Haiku session matched the envelope's `total_cost_usd` to the last digit.

**It is an estimate at API list price**, not money spent — these runs bill against the
Pro/Max subscription. The UI says "est. … at API list price".

## 6. Surfaces

Both reads aggregate the whole ledger and sit on poll paths (the board, the overlay after
every job write, the project list), so they are cached against a generation counter that
`recordRunStart`/`recordRunEnd` and any ingest pass that stores rows bump. Anything that
writes ledger tables directly — a test, a migration — must call `invalidateUsageCache()`.

- **Stage chip tooltip / job chip** — `usageByJob()`; the job total includes Take over, so
  it can exceed the sum of its stages. A job with tokens but no runs reads "outside any
  agent run". `runCount` is the number of recorded runs.
- **Project header chip** — `usageByProject()` on `GET /api/projects`, with the pipeline /
  sessions / background split in its tooltip. It moved out of the Jobs heading because it
  now counts everything.

## 7. Known limits

- **Old jobs have job totals but no per-stage split**: their runs predate `agent_runs`.
  Stage windows could be inferred from `job_stages` timestamps, but a retry overwrites
  those, so it would be a guess and is not done.
- The envelope reports ~1.5k more input tokens per run than the transcript (a side call
  the CLI does not write out). Worth about $0.01 per run at Opus rates.
- Not counted: projects without a `PROJECT.md`, other machines, runs with
  `--no-session-persistence`. Budgets, alerts and spend-over-time charts are out of scope;
  the per-message timestamp already stored in `usage_messages` supports the last.

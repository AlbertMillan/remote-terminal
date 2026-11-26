# Code factory

## Goal

Replace the job pipeline with a factory that **executes** planned work with little
supervision, while planning stays where it already happens: in sessions.

Today a job is one feature carried through a hard-coded eight-stage list, one job
per project at a time, started by hand, parking on prose questions and three
gates. Nothing models dependencies or ready work, agents cannot file new work,
a crash re-runs a whole stage, and headless jobs and started sessions are two
engines with separate state (attribution is inferred, Land and job merges refuse
each other on the try-lock).

The factory has **two ways in and one engine**:

- **A planned track** — planned and specced in a session. Sent from that session
  (`cr factory send`) or with ▶ on the track in Workspace (▶ always means "the
  factory, with my Settings defaults"). No planner, spec or mockup step: the spec
  is the input.
- **Loose work** — free-form text (a sentence, bullets, several asks mixed)
  added from a session (`cr factory add`) or the board. An intake agent decides
  what is a feature and what is a requirement of one, files the features into
  the Inbox track of `PROJECT.md`, and a shaping pass writes each a short spec.

Both then share the same engine: ready queue → run → reviewer agent → merge
queue → done, watched from the Factory overlay (the Jobs overlay, reworked) and
a board view.

Mock-up of the whole flow inside the real page: `project/code-factory-mockup.html`
(open it in a browser).

## Design decisions

**Planning stays in sessions.** The factory never plans a track. A session that
planned a track sends it with its own overrides (review granularity, model per
feature). Shaping exists only for loose work and is as small as it can be.

**`PROJECT.md` stays the source of truth for features.** Inbox items are real
feature lines with server-generated ids in an `## Track: Inbox` section. Factory
execution state (claims, leases, heartbeats, workflow step, dependencies the
intake inferred) lives in SQLite, keyed by feature id; `PROJECT.md` only carries
what it carries today (status checkbox, priority, spec link). Ticking stays the
merge's job.

**Native, beads-shaped, not beads.** Borrowed from beads
(github.com/gastownhall/beads): typed dependency edges (`blocks`, `parent-child`,
non-blocking `discovered-from`), a ready queue computed as "no open blocker,
by priority", atomic claim with a lease kept alive by heartbeat, agents filing
discovered work through a CLI, a single merge slot per project. Not adopted:
`bd` itself or Dolt — beads needs distributed merge because many processes
write; here the server is the only writer, so it would cost a pinned Dolt
version, fragile worktree discovery and a second store for nothing.

**The unit of work is "one agent run + one review"; split only for a gain.** A
track sent to the factory defaults to **one agent working its features in order
in the track worktree**, one commit per feature. The factory proposes a split
only for independent features worth running in parallel, a feature needing a
different model tier, or a gate in between (mockup); handoffs re-read context
and add reviews, so splitting is never automatic.

**Workflows are templates, not `STAGE_ORDER`.** A template lists steps with
`needs` (shape → implement → verify → self-review/fix loop → summary → review →
merge), so loops and skips are data. A small item skips steps; "mockup first"
inserts a mockup step that parks for approval.

**The review gate is an agent by default, configurable.** Settings → Factory:
*reviewer agent decides* / *agent, escalate to me when risky* (default) / *me*.
Escalation rules: auth/access-gate/accounts/migrations touched, diff over N
lines, two failed fix loops, assumptions made instead of asking, new dependency.
Review granularity: per track (default) or per feature; a session or track spec
overrides it. The reviewer checks spec, fit with the codebase (reuse, no new
deps) and QA, not only tests.

**Every item ends with a summary page, questions are structured.** The agent
writes what changed, checks, per-feature sections and the assumptions it made
instead of asking; that is what the reviewer (or you) reads. Shaping asks only
when blocked, each question with options and its default, as JSON — no prose
parsing (`decision-format.ts` retires with the old board).

**Merges go through one queue per project.** Rebase, re-verify, merge with the
existing `Job-Id`/`Feature` trailers, tick `PROJECT.md`, rebuild. A rebase
conflict goes to a resolver agent; only a failed resolution comes back to you.
A session's Land enters the same queue instead of being refused. The queue
holds (never merges under you) while the main checkout has uncommitted changes.

**Dependencies live in SQLite only.** Inferred ones (intake's file-overlap
ordering) are scheduling hints that vanish when the blocker merges; they show as
a "waits for" chip on the card and are removed from the item drawer.
`PROJECT.md` carries no dependency syntax: within a track one agent runs the
features in order anyway. If declared cross-track dependencies turn out to
matter, add an optional `needs f-xxxxxx` suffix later (the parser already
round-trips unknown text).

**Parallelism is capped by review capacity and plan usage, not CPU.** Lease
expiry puts a dead agent's item back in the queue and it resumes from its last
commit and session, not from scratch. Defaults (Settings → Factory, all
editable; revisit after a week of ledger data):

| Setting | Default |
|---|---|
| Seats | 3 across all projects, at most 2 per project (they share one plan's limits) |
| Pause dispatch when items wait for me | 3 (with the reviewer agent only escalations and mockups count) |
| Escalate when the diff exceeds | 600 changed lines, excluding tests, lockfiles and generated files |
| Fix loops before escalating | 2 |
| Spending cap | No new items once the 5-hour window passes 80% or the weekly 90% (plan-usage readings); running items finish |
| Runaway guard | Park an item and notify once it passes 3M tokens |
| Lease | Renewed every 60s, expires after 5 min without a heartbeat |
| Stall alert | A ready item unclaimed for 30 min while a seat is free |

**Sessions and the factory share one model of work (phase 2).** A session can
claim an item (Take over, or spawned on a track); liveness is the open terminal,
never a heartbeat, so thinking time never loses the claim. Its edits are then
recorded against the item and Done goes through review and the merge queue.
Phase 1 leaves sessions as they are except Land joining the merge queue.

**Keep:** usage ledger and `agent_runs` tagging, per-project run lanes in
`claude-run.ts`, merge trailers, worktree code and its teardown rules, the
`SchedulePolicy` seam. **Retire:** the stage `switch` and step-back retry, the
one-job-per-project scheduler, prose question parsing, separate design/review/
merge gates.

## Planned changes

Phase 1 (factory on items):

1. Item store — `factory_items` (feature id, track, workflow, step, status,
   claim, lease, heartbeat, tier), `factory_deps`; ready-queue query; atomic
   claim; lease reclaim.
2. Engine — dispatcher under seats, review budget and the plan-usage cap
   (readings from the plan usage chip's source); workflow templates;
   track-as-one-agent runner with per-feature commits; resume from last commit.
3. Intake and shaping — `cr factory add` (free-form → features + requirements,
   overlap check, Inbox lines via `planFileFor()`), shaping pass with blocking
   questions and assumptions; agents file `discovered-from` items into triage.
4. Reviewer agent and escalation rules; Settings → Factory panel.
5. Merge queue with resolver agent; Land routed through it.
6. `cr factory send|add|status` (session token, like `cr-session.mjs`); ▶ on
   tracks in Workspace.
7. Factory overlay replacing the Jobs overlay, board view, item drawer, summary
   page, morning report (stalls, tokens per item from the ledger).
8. Mockup-first step served from the item's prompt folder.
9. Protocol: new `/ws` payloads in `shared/protocol.ts`, the protocol fixture and
   the Android app's `Protocol.kt`.

Phase 2: sessions claim items (Take over / Return to factory, recorded
attribution); retire the old pipeline code and `decision-format.ts`.

## Verification

- Unit: ready-queue ordering and blocking, claim races (first wins), lease
  expiry and reclaim, template step transitions incl. fix loop cap, escalation
  rule matching, intake parsing fixtures (bullets as requirements, mixed asks).
- Integration on an isolated boot (`project/QA.md`, Flow 3), never port 4220:
  send a two-feature track from a session and see it merge; add free-form work
  and see Inbox lines appear; force a rebase conflict and see the resolver; kill
  the agent mid-run and see the lease reclaim resume from the last commit;
  Land from a session while a factory merge is queued.
- `npm test`, `npm run lint`, `npm run android:test` (protocol fixture).

## Out of scope

- A factory-side planner for tracks (planning stays in sessions).
- Cross-project scheduling and cross-repo dependencies.
- Adopting beads/Dolt or syncing work items across machines.
- Non-LLM classifiers for triage (worth revisiting once intake volume is real).

## Sources

- beads — github.com/gastownhall/beads (data model, ready/claim, merge slot).
- Steve Yegge, "Software Factories: Escape from Trash Mountain" (AI Engineer,
  youtube.com/watch?v=SRhXgeNluIk) — the plumbing is easy; work tracking, fuel,
  context rot and human gates are the constraint; keep the orchestrator thin.
- Armin Ronacher, "Build the Workshop Before the Software Factory"
  (youtube.com/watch?v=JNexz3Tbiu8) — human attention is the budget; summary
  before verification; durable, resumable agents.

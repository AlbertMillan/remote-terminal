# Self-improving agent runs

Track: Self-improving agent runs

Proposal page (approved 2026-11-26): https://claude.ai/artifact/PFMUkohWe9mMptstCemBdX
Source: Ben Holmes (Warp), "Your AI Agent Is Hiding Its Mistakes From You", AI Engineer,
https://www.youtube.com/watch?v=pz74r-4dGfQ (loop 02:40, rubrics 07:52–10:41, daily agent
12:51, trends 16:14).

## Goal

Grade every agent run against short rubrics, chart the grades over time, and turn recurring
failures into proposed fixes to skills, `CLAUDE.md` and `project/QA.md` that the user accepts
or dismisses.

Headless agents work around stale instructions without saying so: they probe, retry and
then report success. Today the usage ledger tells us exactly what a run cost and nothing about
whether the cost was wasted. A stage that spends half its tool calls fighting a broken
instruction looks the same as a healthy one.

## Design decisions (approved)

1. **Scoring runs in the background after a unit is done**, never as a pipeline/factory step.
   It must not delay, fail or park work. Triggers: a factory item reaching `done`
   (`factory/store.ts` `updateItem`), and a legacy job reaching `done` (`jobs/pipeline.ts`
   `runNextStage`) while the old pipeline still exists (`f-n0d6ik`).
2. **Both authors of change** (`docs/change-provenance.md`): interactive sessions are scored
   too, sampled, from `maybeLogSession()` (`sessions/manager.ts`). Phase 5, `f-ldneip`.
3. **Rubrics live in the Knowledge Centre** (`rubrics/agent-runs/`, existing rubric format:
   id, version, status, criteria, changelog), overridable per project in
   `project/rubrics/<rubric-id>.md`. Each score records the rubric id **and version**, so a
   rubric edit shows as a break in the trend rather than a fake improvement.
4. **Judge model: Haiku-class**, with a stronger model re-grading a sample (default 1 in 10)
   for calibration. Disagreements are stored, not hidden.
5. **Improver: daily per project**, skipped when fewer than a configured number of new failing
   scores exist (default 5).
6. **Proposals go to factory triage** for files in the repo (existing `discovered` →
   Inbox line + `triage` item path, `factory/triage.ts`); targets outside the repo
   (`~/.claude/skills`, Knowledge Centre rubrics) become Knowledge Centre `fb-` feedback on the
   narrowest definition. **Nothing auto-merges.** Proposals are guesses, shown unticked.
7. **Daily spend cap per project** for `score` and `improve` runs, set after Phase 2 measures
   real cost. Until then, scoring is jobs/factory only.
8. **Hard signals before judgement.** Deterministic counts from the transcript (failed tool
   calls, identical commands repeated, total calls, wall time, ledger cost) are computed
   without a model, shown on their own, and handed to the judge as evidence.
9. **Stage agents never see scores or rubrics**, or they optimise for the rubric.

## Planned changes

### Phase 1 — Hard signals (`f-8rsuyv`)

- `src/server/scoring/trace.ts`: build a compact trace digest for a run from its transcript(s),
  located through `agent_runs` (session id + `[started_at, ended_at]`) and `usage_files`
  (subagent transcripts included). Digest = ordered tool calls (name, short input, ok/error),
  error outputs truncated, and the counts in decision 8. Never throws; a missing transcript
  yields an empty digest marked `incomplete`.
- Store per-run signals (new migration, `run_signals`: `agent_run_id`, counts, `computed_at`).
  Never deleted by Discard / Delete track, like the ledger.
- Show the counts on the factory item drawer and job card (one line, e.g. "41 calls, 9 failed,
  6 repeated").
- Ingest alongside the ledger's existing read pass, so transcripts are read once.

### Phase 2 — Judge and rubrics (`f-hy10xn`)

- `RunKind` gains `'score'` (`usage/store.ts`); every judge run is tagged, so its spend shows
  in the ledger.
- `src/server/scoring/judge.ts`: for a done unit, one `runClaude` per unit (not per rubric):
  input = digest(s) + signals + diff at `merge_sha` (or the unit's commits) + the resolved
  rubrics; read-only tools (`builtinToolsFor(['Read','Grep','Glob'])`), `--strict-mcp-config`,
  `accountEnv()` + `preflight()` like every run. Output contract: JSON array of
  `{rubricId, score 0..1, pass, note ≤ 400 chars, evidence: [{session, line}]}`, validated;
  invalid output is recorded as a failed judge run, never as a failing score.
- `src/server/scoring/rubrics.ts`: load rubrics from the Knowledge Centre path (config
  `scoring.rubricsDir`) and `project/rubrics/` overrides; parsing never throws.
- Migration: `run_scores` (`id`, `project_cwd`, `unit_kind` job|factory|session, `unit_id`,
  `rubric_id`, `rubric_version`, `score`, `pass`, `note`, `evidence_json`, `model`,
  `calibration_of` nullable, `created_at`). Retained like the ledger.
- The four initial rubrics in the Knowledge Centre: efficiency, instruction adherence, test
  fit, verbosity (draft, v1, a few bullets each).
- Config block `scoring` (`enabled`, `judgeModel`, `calibrationModel`, `calibrationRate`,
  `rubricsDir`), off on isolated boots unless set in that boot's config.

### Phase 3 — Score trends (`f-5v56nr`)

- API: `GET /api/projects/:key/scores?from&to` → weekly pass rate per rubric, cost per unit,
  hard-signal medians, change markers.
- Change markers: merges on the project's main branch touching `.claude/skills/**`,
  `skills/**`, `CLAUDE.md`, `project/QA.md` or `project/rubrics/**`, plus rubric version bumps.
  Each marker carries before/after pass rate **and run counts**.
- Client: a Quality section on the factory summary page, beside tokens per item; failing runs
  link to their item/job and judge notes. New `/ws` payloads (if any) follow the Android rule:
  `shared/protocol.ts`, the fixture and `Protocol.kt`.

### Phase 4 — Improver (`f-me6cq9`)

- `RunKind` gains `'improve'`. Scheduler in the server (per project, daily, respects the
  daily cap and decision 5); never runs on an isolated boot or under vitest.
- Input: failing scores since its last pass with notes and evidence, the repo's skills,
  `CLAUDE.md`, `project/QA.md`, `docs/`. Read-only tools.
- Output contract: up to `MAX_DISCOVERED_PER_STEP` (5) proposals, each with target file,
  cause, proposed change, failing-run count and score ids. Filed through `factory/triage.ts`;
  the Inbox line links to the scores and **never quotes transcript text** (plan files are
  committed). Out-of-repo targets become Knowledge Centre feedback.
- Dedup: a proposal whose cause matches an open triage item adds its evidence there instead
  of filing a new one.

### Phase 5 — Session scoring (`f-ldneip`)

- From `maybeLogSession()`, score a sampled share of sessions (config rate) with the same
  judge; `unit_kind = 'session'`. Session-built change sets are inferred, so their scores are
  shown as inferred in the trends view.

## Verification

- Unit tests (vitest): trace digest on recorded transcript fixtures (failed call, repeated
  command, subagent file, killed run); rubric parsing never throws; judge output validation
  rejects malformed JSON without writing a score; improver dedup.
- Isolated boot (`project/QA.md`, Flow 3): run a factory item to `done`, confirm a `score`
  run appears in `agent_runs`, rows in `run_scores`, and its cost in the ledger.
- Phase 2 gate: 20 real runs graded by hand; the judge must agree on pass/fail for at least
  16 before Phase 4 starts.
- Phase 4: one improver pass on a project with seeded failing scores files ≤ 5 triage items,
  none of which run until accepted.

## Out of scope

- Ranking people or sessions against each other.
- Auto-applying or auto-merging any proposal.
- Scoring other machines' or teammates' transcripts (single-player first).
- Replacing the reviewer agent: it reviews code; this grades how the run got there.

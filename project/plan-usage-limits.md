# Plan usage limits

Track: Plan usage limits

## Goal

Show how much of the Pro/Max plan is used — the rolling **5-hour** window and the **weekly**
window, each as a percentage with its reset time — in claude-remote, so a long job or session
is not started blind into a limit.

## Facts this design rests on

- Plan limits are **not computable locally.** They are weighted by model and their sizes are
  not published, so the usage ledger's token totals (`docs/token-usage-feature.md`) cannot be
  turned into a percentage. The figure has to come from Anthropic.
- **The status line is the only documented source** (code.claude.com/docs/en/statusline):
  Claude Code passes `rate_limits.five_hour` and `rate_limits.seven_day`, each
  `{ used_percentage: 0–100, resets_at: <unix seconds> }`, on the status line command's stdin.
  Present only on claude.ai plans, and only after a session's first API response.
- Not exposed by hooks, the `claude -p` envelope, OTel, the Agent SDK, or any CLI command;
  `/usage` is interactive only.
- The undocumented `GET https://api.anthropic.com/api/oauth/usage` (what `/usage` calls,
  probed in session `d135a5a0-1d88-487e-9089-5126293ecc38`) is richer — per-model limits,
  `severity`, extra-usage spend — but needs the OAuth token from `~/.claude/.credentials.json`
  and can change without notice. **Out of scope here**; a possible later opt-in.
- `~/.claude/settings.json` has no `statusLine` today. claude-remote's hooks are installed by
  hand from a snippet (`docs/notifications.md`); the app never writes that file.

## Design decisions

- **Relay through a status line command.** A small Node script, shipped in the repo as
  `scripts/statusline.mjs`, reads the status line JSON from stdin, prints a one-line status
  (`5h 55% · wk 22%`, or the model name before the first response) and POSTs the JSON to
  `http://localhost:4220/api/plan-usage`. It runs in **every** Claude Code session, inside
  claude-remote or not — the limits are account-wide, so every session is a fresh reading.
- **The script never delays or breaks the status line.** POST with a ~300 ms timeout,
  swallow every error, print the line regardless. A stopped server costs a refused
  connection, nothing more.
- **Account-wide, latest wins.** The server keeps one snapshot: the reading with the newest
  observation time. Readings from several sessions at once agree; an older one arriving late
  never replaces a newer one.
- **Honest about staleness.** The status line only fires while an interactive session is
  rendering, so a reading ages when you are idle, and job runs (headless) never produce one.
  The chip shows the reading's age once it is over 10 minutes old, and after a window's
  `resets_at` has passed it says the window has reset rather than showing the old
  percentage.
- **Persisted.** The last snapshot is written to `<dataDir>/plan-usage.json`, so a restart
  does not blank the chip.
- **Strict input.** The endpoint is reachable over the tailnet like `/api/notify`, so it
  validates: percentages finite and within 0–100, `resets_at` a plausible future-ish epoch,
  body size capped. Anything else is a 400 and never replaces the snapshot.
- **Global chip in the sidebar**, beside "Connected" — limits belong to the account, not a
  project. Amber from 80 %, red from 95 % (the status line gives no severity of its own).
  Popover: both windows with percentage, a bar, "resets in 2 h 14 m", and "as of 14:02".
- **Polled, not pushed.** The client fetches `GET /api/plan-usage` every 60 s and on window
  focus; reset countdowns tick client-side from `resets_at`. A readings stream is not worth a
  new WebSocket message type for a figure that changes on the order of minutes.

- **Installed by hand, like the hooks** (decided 2026-09-25). A documented snippet in
  `docs/plan-usage.md` for `~/.claude/settings.json`
  (`"statusLine": { "type": "command", "command": "node \"<repo>/scripts/statusline.mjs\"" }`),
  and a chip that says "not set up" with that instruction when no reading has ever arrived.
  Rejected: a Settings button that writes the entry — it would be the first time the app
  edits `~/.claude/settings.json`, and would have to guard against overwriting a status line
  configured later.

## Planned changes

- `scripts/statusline.mjs` — stdin → one printed line + fire-and-forget POST. Node built-ins
  only (runs on Windows via Claude Code's bash; no `jq`, no `curl` parsing).
- `src/server/usage/plan-limits.ts` — validate a reading, keep the newest snapshot, load and
  save `plan-usage.json`.
- `src/server/app.ts` — `POST /api/plan-usage` (the relay) and `GET /api/plan-usage`
  (`{ fiveHour, sevenDay, observedAt } | { none: true }`).
- `src/client/plan-usage-chip.ts` + sidebar markup/CSS — chip, popover, polling, countdowns.
- `docs/plan-usage.md` — setup snippet and the staleness rules.

## Verification

- Unit: a valid reading is stored; an older reading never replaces a newer one; out-of-range
  or malformed bodies are rejected and leave the snapshot untouched; the snapshot survives a
  reload from `plan-usage.json`.
- Unit: `statusline.mjs` fed a sample payload prints `5h 55% · wk 22%`, prints the model when
  `rate_limits` is absent, and exits promptly with the server down.
- DOM: chip thresholds (79 → plain, 80 → amber, 95 → red), "as of" after 10 minutes, "reset"
  after `resets_at`, "not set up" with no reading.
- Real: with the snippet installed, an interactive session's reading reaches the chip.
- `npm test`, `npm run lint`, `npm run build`; server boot per `project/QA.md` flow 3.

## Out of scope

- The OAuth usage endpoint, per-model (Opus) weekly limits, extra-usage spend.
- Alerts or blocking a job dispatch near a limit (the data would support a later warning).
- Converting ledger tokens into plan percentages — not possible, see above.

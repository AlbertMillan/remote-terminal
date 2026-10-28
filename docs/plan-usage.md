# Plan usage chip

The sidebar chip under the connection status shows how much of the Pro/Max plan is used:
the rolling **5-hour** window and the **weekly** window, each with its reset time. Spec:
`project/plan-usage-limits.md` (feature `f-jmqczy`).

## Setup

Add a status line to each Claude account's `settings.json` (`~/.claude/settings.json` for
the default folder; `scripts/install-account-setup.mjs` copies it between accounts, see
`docs/accounts.md`). The chip, while no reading has arrived, shows this exact snippet with
the real path and the attached session's account's file:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node \"C:/Users/<you>/NodeProjects/claude-remote/scripts/statusline.mjs\""
  }
}
```

Use forward slashes: Claude Code runs the command through bash on Windows too. If the
server is not on `http://localhost:4220`, set `CLAUDE_REMOTE_URL` in the environment Claude
Code runs in. If you already have a status line of your own, keep it and have it pipe the
same stdin to this script, or call its relay (`POST /api/plan-usage` with the payload).

## Where the numbers come from

Claude Code passes `rate_limits.five_hour` and `rate_limits.seven_day`
(`used_percentage` 0–100, `resets_at` in unix seconds) to the status line command — the
only documented source (code.claude.com/docs/en/statusline). They are **not** derivable
from the usage ledger's tokens: the limits are weighted by model and their sizes are not
published. Not exposed by hooks, the `claude -p` envelope, OTel or any CLI command.

`scripts/statusline.mjs` prints `Opus 5 · 5h 55% · wk 22%` and POSTs
`{ rate_limits, config_dir, session_id }` — the limits plus two identifiers: its
`CLAUDE_CONFIG_DIR` and `CLAUDE_REMOTE_SESSION_ID` (set by `sessionEnv()` in every
claude-remote PTY, absent outside one). Never the payload's cwd, transcript path, Claude's
own session id or cost. It prints first and gives the POST 300 ms, swallowing every
failure — it runs on every render of every session's status line, so it must never slow
one down. It posts even when there are no limits yet (`{ "rate_limits": null }`): that
contact is how the chip tells "set up, waiting" from "not set up".

## Whose reading it is — verification (`f-jzpmyk`)

Filing a reading by config folder alone was wrong (diagnosed 2026-10-28,
`project/per-account-usage.md`): a `claude` started before a `/login` swap in its folder
keeps the old login in memory and reports that login's limits, and one misfiled reading
with a later reset pinned the window until it expired. So `classifyRelayPost`
(`plan-routes.ts`) decides:

- **Account**: the session row's `account` when `session_id` names a claude-remote session,
  else `accountForConfigDir(config_dir)`. An id naming no session counts as absent — the
  endpoint is unauthenticated on the tailnet, so nothing in the body is trusted, and an id
  only picks which account is then verified.
- **Verified**: that account's folder holds its expected login now (`accountLogin()` in
  `account-watch.ts`: preflight cached per account for 60 s and refreshed by every watch
  tick — never a preflight per post) **and**, for a session, account-watch has not flagged
  it. Each stored window records the `loginUuid` it was verified for; a verified reading for
  another `loginUuid` replaces the window outright, whatever its reset.
- **Held back**, not merged, otherwise — reason `login-mismatch`, `session-flagged`,
  `no-login` (nobody logged in, or no expected identity), `unknown-folder`. Kept in memory
  per account (one entry per window, reason and reset; at most 10), listed by
  `GET /api/plan-usage/held` for the usage page, dropped with
  `POST /api/plan-usage/held/discard` (`{ id }` or `{ account }`). They never feed the chip.
  Relay contact (`relaySeenAt`) still counts for a held reading's account.
- **Upgrade**: a window restored from disk without `loginUuid` (any file written before
  this) comes back held back as `unverified-legacy` — exactly the data that was wrong. The
  chip says "waiting" until the next verified reading, seconds away for any open session.

## How readings combine — `src/server/usage/plan-limits.ts`

- One snapshot per account, of verified readings only. Every open session reports, and an
  **idle session can re-render its status line with limits it cached long ago**, so arrival
  order means nothing. Per window: a later `resets_at` is a newer window and wins outright;
  within the same window the higher percentage wins, since usage only rises. A stale
  reading can re-confirm a value (refreshing "as of") but never lower it. These rules hold
  for one login's stream — hence a new `loginUuid` replacing outright.
- Every field is validated — percentage within 0–100, `resets_at` between a day ago and
  eight days out, body ≤ 64 KB — because the endpoint is reachable over the tailnet like
  `/api/notify`. A bad reading is dropped without touching the snapshot.
- The snapshot is saved to `<dataDir>/plan-usage.json` (temp file + rename) and re-validated
  when read back at boot. It is written only when a percentage or reset time changes, and
  relay contact (`relaySeenAt`) at most hourly — posts arrive on every render of every
  session, and a synchronous write per post churns the disk and, on Windows, fails whenever
  an indexer or antivirus holds the file. A fresher "as of" alone is not written.

## Every account on the chip (`f-dnapj1`)

`GET /api/plan-usage` returns **every** configured account (`planUsageSummary`):
`{ attached?, accounts: [{ account, plan, verified, snapshot, relaySeenAt, held, running,
tokens: { fiveHour, sevenDay } | null, jobs, setup }] }`, plus the attached (else default)
account's `account`/`snapshot`/`relaySeenAt`/`setup` at the top level so a tab from before
still renders (and the client reads such an answer as a one-account list).

- `?account=` marks the attached session's account; `?cwd=` its folder, so `jobs` marks the
  account `projectAccount(cwd)` gives (whose login that project's jobs run under).
- `plan`: a label ("Max 5x", "Team") from the credentials file's
  `claudeAiOauth.subscriptionType` / `rateLimitTier` (`planLabel()`) — the only two fields
  read; no token is returned, logged or cached. The route is unauthenticated, so windows are
  served **without** `loginUuid`, and no login identity appears.
- `running`: running claude-remote sessions on the account. `tokens`: `usageByAccount()`
  from each open window's start (`resetsAt − 5h` / `− 7d`, or the login's creation when it is
  younger, `sinceLogin`); null for a closed window or without a snapshot.
- The chip: one summary line per account — name in the account's colour (`--account-N` by
  position in the config), `5h n% · wk n%`, an "attached" tag. A window with no verified
  reading shows `?` in amber; an account never heard from says "not set up". The popover
  has one section per account (plan, verified state, both bars, this 5h window's tokens,
  "As of … · n running sessions", "jobs run here", held-back count) and "Per-account
  breakdown →", which opens the usage page.

## The account usage page (`f-7y1fcz`)

`src/client/account-usage-modal.ts`, structure static in `index.html`
(`#account-usage-modal`), opened by the chip's "Per-account breakdown →" with the chip's
last answer. One card per account: plan, verified/attached/"jobs run here" tags, both
windows large, the token table (this 5h window; this week — "Since login" when the login
is younger than the week — messages, input, output, cache read/write, est. cost,
sessions, job runs), how many of the week's messages sit in another account's folder
(moved transcripts), and running sessions. Below, **Readings held back**
(`GET /api/plan-usage/held`): arrived, filed under, window → reset, value, the reason in
plain words, and Discard (`POST /api/plan-usage/held/discard`, then the chip refreshes);
hidden when empty. Everything goes through `escapeHtml`; cards stack and tables scroll in
a box at phone width.

## What the chip can and cannot tell you

- Readings arrive only while an interactive Claude Code session renders its status line,
  and only after that session's first response. Headless job runs never send one. So:
  - a reading older than 10 minutes shows its age ("as of 14:02 (37m ago)"); the chip dims
    once every account's readings are that old;
  - once a window's `resets_at` passes, the chip says "reset" rather than the old figure.
- With no verified reading, an account's section says the relay **is set up** if it has
  ever reported (limits come after a session's first response, on Pro/Max only) and shows
  the exact snippet for that account's settings file if it never has — plus a hint about
  `CLAUDE_REMOTE_URL` for a relay that is installed but cannot reach the server.
- Amber from 80 %, red from 95 %, per window; the chip's border takes the worst open window
  of any account.
- The client polls `GET /api/plan-usage` every 60 s — skipped while the tab is hidden —
  and on focus or when the tab is shown again; countdowns tick locally.
- Not shown: per-model (Opus) weekly limits and extra-usage spend. Those exist only in the
  undocumented OAuth endpoint behind `/usage`, deliberately not used here.

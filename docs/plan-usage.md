# Plan usage chip

The sidebar chip under the connection status shows how much of the Pro/Max plan is used:
the rolling **5-hour** window and the **weekly** window, each with its reset time. Spec:
`project/plan-usage-limits.md` (feature `f-jmqczy`).

## Setup

Add a status line to `~/.claude/settings.json` (the chip, while no reading has arrived,
shows this exact snippet with the real path):

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

`scripts/statusline.mjs` prints `Opus 5 · 5h 55% · wk 22%` and POSTs `{ rate_limits }` —
only the limits, never the payload's cwd, transcript path, session id or cost — to
`/api/plan-usage`. It prints first and gives the POST 300 ms, swallowing every failure — it
runs on every render of every session's status line, so it must never slow one down. It
posts even when there are no limits yet (`{ "rate_limits": null }`): that contact is how the
chip tells "set up, waiting" from "not set up".

## How readings combine — `src/server/usage/plan-limits.ts`

- One account-wide snapshot. Every open session reports, and an **idle session can
  re-render its status line with limits it cached long ago**, so arrival order means
  nothing. Per window: a later `resets_at` is a newer window and wins outright; within the
  same window the higher percentage wins, since usage only rises. A stale reading can
  re-confirm a value (refreshing "as of") but never lower it.
- Every field is validated — percentage within 0–100, `resets_at` between a day ago and
  eight days out, body ≤ 64 KB — because the endpoint is reachable over the tailnet like
  `/api/notify`. A bad reading is dropped without touching the snapshot.
- The snapshot is saved to `<dataDir>/plan-usage.json` (temp file + rename) and re-validated
  when read back at boot. It is written only when a percentage or reset time changes, and
  relay contact (`relaySeenAt`) at most hourly — posts arrive on every render of every
  session, and a synchronous write per post churns the disk and, on Windows, fails whenever
  an indexer or antivirus holds the file. A fresher "as of" alone is not written.

## What the chip can and cannot tell you

- Readings arrive only while an interactive Claude Code session renders its status line,
  and only after that session's first response. Headless job runs never send one. So:
  - a reading older than 10 minutes shows its age ("as of 14:02 (37m ago)") and dims;
  - once a window's `resets_at` passes, the chip says "reset" rather than the old figure.
- With no reading, the chip says **"waiting"** if the relay has ever reported (it is
  installed; limits come after a session's first response, on Pro/Max only) and **"not set
  up"** with the exact snippet if it never has — plus a hint about `CLAUDE_REMOTE_URL` for
  a relay that is installed but cannot reach the server.
- Amber from 80 %, red from 95 %, coloured by the worst window still open.
- The client polls `GET /api/plan-usage` every 60 s — skipped while the tab is hidden —
  and on focus or when the tab is shown again; countdowns tick locally.
- Not shown: per-model (Opus) weekly limits and extra-usage spend. Those exist only in the
  undocumented OAuth endpoint behind `/usage`, deliberately not used here.

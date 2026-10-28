# Per-account usage — trustworthy limits and tokens for each login

Track: Per-account usage

Mockup (approved): https://claude.ai/artifact/M8H8SHLMAAgHWXVC6JENCa — artboard "Sidebar chip,
open" (`f-dnapj1`) and "Account usage page" (`f-7y1fcz`).

## Goal

Since the accounts track landed, the plan-usage chip's numbers have been off. Diagnosed on
2026-10-28 against the live data:

1. **Readings are filed by config folder, not by login.** `POST /api/plan-usage` maps the
   relay's `config_dir` to an account (`accountForConfigDir`) and trusts it. A process that
   was started before a `/login` swap in its folder, or a session outside claude-remote,
   reports another login's limits under the folder's account.
   Evidence: `~/.claude-remote/plan-usage.json` held identical `resetsAt` (to the second)
   for `work` and `personal` in both windows (5h → 00:10Z, weekly → Sun 1 Nov 05:00Z),
   though the logins differ (work = Team, personal = Max 5x). Work's weekly cycle per
   Claude Code's own cache (`~/.claude.json` → `cachedUsageUtilization`) resets Saturdays
   03:00Z, so the work "weekly 0%, resets Sun 05:00" reading is not work's.
2. **A misfiled reading pins.** `merge()` in `src/server/usage/plan-limits.ts`: a later
   `resetsAt` wins outright and, within a window, only a higher percentage. Correct for one
   login's stream; a foreign reading with a later reset blocks every true one until it
   expires (work's weekly was stuck until Sun 05:00Z).
3. **The ledger attributes by folder.** `f-ilxxdj` moved pre-accounts transcripts into
   `~/.claude-personal`, and migration `019_session_account` labelled every older row
   `personal`. The personal login was created 2026-10-28T16:20:46Z, yet this week 819 of
   1,043 messages (121M cache reads) that ran under the **work** login now sit in the
   personal folder; work's folder holds 3.
4. **The chip shows one account** (the attached session's, else `defaultAccount`), with
   the name buried in the popover, so one login's numbers are read as the other's.

## Design decisions

### Readings are verified against the login that produced them (`f-jzpmyk`)

- `scripts/statusline.mjs` also sends `session_id` = `CLAUDE_REMOTE_SESSION_ID` (set by
  `sessionEnv()` in every claude-remote PTY; absent outside claude-remote). Still only the
  limits plus these two identifiers — never the payload's cwd, transcript path or cost — and
  it still prints before any network call.
- The server picks the account: the session row's `account` when `session_id` names a known
  session, else `accountForConfigDir(config_dir)` as today. A `session_id` that names no
  session is treated as absent (the endpoint is unauthenticated on the tailnet: nothing in
  the body is trusted, and an id is not a credential).
- **Verified** = that account's folder currently holds its expected login (`preflight()`
  ok) **and**, for a session, `account-watch` has not flagged it (a `claude` process started
  before a `/login` swap keeps the old login in memory). Cache the preflight result per
  account (reuse account-watch's 60 s cycle; never run preflight on every post — posts
  arrive on every render of every session).
- Each stored window records the login it was verified for (`loginUuid`: the found
  `accountUuid`). A verified reading for a different `loginUuid` than the held one replaces
  it outright (the login changed; the old windows are not this login's).
- **Unverified readings are held back, not merged**: kept per account in a small bounded
  list (latest per window, at most ~10 entries per account) with arrival time, window,
  value, reset and the reason (`login-mismatch`, `session-flagged`, `no-login`,
  `unknown-folder`). Shown on the usage page (`f-7y1fcz`); `POST /api/plan-usage/held/discard`
  drops one (or all for an account). They never feed the chip.
- **Upgrade**: a snapshot restored from a file without `loginUuid` (today's file) is
  restored as **held back** (`reason: 'unverified-legacy'`), not shown — it is exactly the
  data that is wrong now. The chip then shows "waiting" until a verified reading arrives,
  which is seconds for any open session.
- Keep: the same-window "higher percentage wins" rule and the write-throttling in `save()`
  (both still right for a single verified login's stream), all field validation, the 64 KB
  body limit.

### The ledger attributes usage to the login that ran it (`f-7oap94`)

- Add `usage_messages.account` (new migration; nullable). Set at ingest: the account whose
  `projectsDir` holds the transcript — **except** a message older than that account's
  login's `oauthAccount.accountCreatedAt` (read via `claudeJsonPath()`): before an account
  existed, its folder can only hold transcripts moved in from the default folder, so the
  message belongs to the account on the default folder (`accountForConfigDir(null)`), the
  only login there was. Unknown → null (shown as "unattributed", never guessed).
- Backfill existing rows in the migration step that runs at boot (or the first ingest after
  it), using the same rule, keyed by `usage_files.path`. Re-ingest must not flip it back.
- `usageByAccount(account, sinceIso)` in `src/server/usage/store.ts`: messages, input,
  output, cache read, cache write, session count, job-run count. Respect the existing
  usage cache and `invalidateUsageCache()`.
- `usage_files` keeps no account column (a file's folder is still where it lives); the
  attribution lives on the message.
- Update `docs/accounts.md` ("`usage_files` has no account column …") and
  `docs/token-usage-feature.md` with the rule.

### The chip shows every account (`f-dnapj1`)

- `GET /api/plan-usage` returns **all** configured accounts:
  `{ attached?: string, accounts: [{ account, plan, verified, snapshot, relaySeenAt,
  held: number, running: number, tokens: { fiveHour, sevenDay } | null, setup }] }`.
  Keep `?account=` working (it marks which one is `attached`) so an older client tab
  still renders.
- `plan`: a label from the account's credentials file (`credentialsPath()` →
  `claudeAiOauth.subscriptionType` / `rateLimitTier`, e.g. "Max 5x", "Team"). Read only
  those two fields; never return, log or cache any token. Missing → no label.
- `running`: `getRunningSessions()` filtered by account. `tokens`: `usageByAccount()` since
  each window's start (`resetsAt − 5h`, `resetsAt − 7d`), only for windows that are open.
- Chip summary: one line per account — name (account colour), `5h n% · wk n%`, an
  "attached" tag on the attached session's account. A window with no verified reading shows
  `?` in amber. Severity colours as today, per window.
- Popover: one section per account, as in the mockup: plan, verified state, both bars with
  resets, the tokens line for the current 5h window, "As of … · n running session(s)",
  "jobs run here" on the account `projectAccount()` gives the current project. "Per-account
  breakdown →" opens the usage page.
- Keep: `<details>` element, poll every 60 s skipped while hidden, render only the
  contents, never the element (an open popover stays open).

### The account usage page (`f-7y1fcz`)

- Opened from the chip's link; a modal/overlay in the existing client style (no new
  framework or dependency; see `prefer-targeted-client-structure` — structure in
  HTML/CSS).
- One card per account: both windows large, the token table (this 5h window; this week =
  since the weekly window's start, or "since login" when the login is younger than the
  window), sessions and job-run counts, and how many messages of it live in another
  account's folder (moved transcripts).
- "Readings held back" table: arrived, filed under, window → reset, value, reason in plain
  words; a Discard button per row (`POST /api/plan-usage/held/discard`). Hidden when empty.
- All text through `escapeHtml`; works at phone width (cards stack, tables scroll in a box).

## Planned changes

- `scripts/statusline.mjs` — send `session_id`.
- `src/server/usage/plan-limits.ts` — verification, `loginUuid`, held-back list, legacy
  restore as held, discard.
- `src/server/usage/plan-routes.ts` — all-accounts GET, discard POST.
- `src/server/sessions/account-watch.ts` — expose the cached per-account preflight result
  and per-session flag for the relay to read.
- `src/server/db/schema.ts` — migration adding `usage_messages.account` (+ index).
- `src/server/usage/ledger.ts`, `store.ts` — attribution at ingest, backfill,
  `usageByAccount()`.
- `src/client/plan-usage-chip.ts`, `styles.css`, `index.html` — multi-account chip; a new
  `src/client/account-usage-modal.ts` for the page.
- Docs: `docs/plan-usage.md` (verification, held back, multi-account chip),
  `docs/accounts.md`, `docs/token-usage-feature.md`.

## Verification

- Unit tests (vitest), at least:
  - a reading from a session flagged by account-watch, or from a folder whose login
    mismatches, is held back and does not change the snapshot;
  - a verified reading for a new `loginUuid` replaces a held window with a later reset
    (the pinning bug);
  - a legacy `plan-usage.json` (no `loginUuid`) restores as held back, chip data shows no
    snapshot; discard removes it;
  - `session_id` naming no session falls back to `config_dir`; the body's other fields are
    still validated and the body limit holds;
  - ledger: a message older than its folder's login's `accountCreatedAt` is attributed to
    the default folder's account; a newer one to the folder's account; unknown → null;
    backfill is idempotent and re-ingest keeps it;
  - `usageByAccount()` sums per window;
  - `renderPlanUsage` renders one line per account, `?` for an unverified window, the
    attached tag, and escapes account names;
  - the GET never contains a token field from the credentials file.
- `npm test`, `npm run build`, `npm run lint` green.
- QA Flow 3 (isolated boot): migration applies on a fresh DB; `GET /api/plan-usage`
  returns every configured account; a POST with a bad `session_id` is accepted and filed by
  folder. Never on port 4220.

## Out of scope

- The undocumented OAuth usage endpoint behind `/usage` (per-model weekly limits, extra
  usage). Still deliberately unused.
- Changing `sessions.account` of pre-accounts rows (revive/resume need the folder the
  transcript now lives in).
- `f-fhrnu3` (renaming `~/.claude`).

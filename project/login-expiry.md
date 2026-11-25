# Warn before a Claude login ends

Track: Claude accounts

## Goal

A claude.ai login ends on a fixed date, about a month after `/login`, and using Claude
doesn't extend it. When it ends, every session and job under that account stops reaching
Claude, and nothing in claude-remote says so: `preflight()` only checks *who* is logged in
(`oauthAccount` in `.claude.json`), never whether the login still works. A folder whose
credentials are gone still passes. Show each account's login state where plan usage
already lives, warn once before it ends, and make renewing it one click. Mocked (option A):
https://claude.ai/artifact/88DwjKXPLnek8DUuZftjdA

A long-lived token (`claude setup-token`) was ruled out: it can't fetch claude.ai
connectors, can belong to another organization, and preflight couldn't tell whose it is.

## Design decisions

1. **Source**: `claude auth status` (JSON) run under each account's `accountEnv()`, giving
   `loggedIn` and `loginExpiresAt`. The server caches it per account, refreshes it every
   15 minutes and right after a Log in session exits. A failed run keeps the last result
   (never reported as logged out).
2. **Served with plan usage**: `AccountPlanUsage` gains
   `login: { state: 'ok' | 'ending' | 'ends-today' | 'logged-out' | 'unknown', endsAt }`.
   The chip already polls that route every 60 s, so no new polling.
3. **States**: `ok` more than 7 days left; `ending` 7 days or less (amber); `ends-today` under
   24 h (red); `logged-out` (red). Only the plan-usage chip changes. Nothing is added to
   the session header, session rows or the terminal, where Claude already prints its own
   login error.
4. **Chip summary line**: a tag after the account's figures (`login 3d`, `login 5h`,
   `logged out`), coloured as above. The chip's border follows the worst level, as for
   usage.
5. **Popover section**: a Login row per account with the state (`not logged in` / `ends
   Sat 5 Dec · 10d`) and a muted line ending in a small text link: `Log in →` when logged
   out, `Renew now` otherwise. No filled buttons in the chip.
6. **Toast and browser notification, once**: 3 days before `endsAt`, once per account per
   login (keyed by `endsAt`, so a renewed login gets its own). "work login ends in 3 days
   (Sat 5 Dec). Using Claude won't extend it." with `Dismiss` and `Log in →`. Uses the
   existing notification path (`session-notifications.ts` / `browser-notifier.ts`).
7. **Log in**: every link opens a confirm dialog with the steps, then the existing flow from
   the refusal modal (`session.create { account, login: true }`): `claude` in `~` with
   that account's env, the user runs `/login` (its Edge profile opens via `BROWSER`) and
   `/exit`. The server then refreshes that account's status. A login as the wrong account
   still ends in the existing mismatch refusal.

## Verification

1. Unit: state from `loggedIn`/`loginExpiresAt` at each threshold; a failed status run keeps
   the cached state; the notification fires once per `endsAt` and again after a renewal.
2. Isolated boot: an account folder with no credentials shows `logged out` and its Log in
   link opens the login session; after `/login` the tag clears within one refresh.

## Out of scope

- Long-lived tokens or any auth that bypasses the folder's login.
- Login state in the session header's account menu (option B).
- Warning from jobs or the status line.

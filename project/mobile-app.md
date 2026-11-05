# Mobile app

## Goal

Use claude-remote from an Android or iOS phone as a smooth, installed app: launched from the
home screen, full screen, with every feature (terminal, sessions, Projects, job gates), push
notifications when something needs you, quick recovery after the phone sleeps, and links that
open a specific session or job.

## Starting point

- **Web client.** It already works on touch screens: `mobile-nav.ts` plus about ten `@media`
  breakpoints in `styles.css`. It has no manifest, service worker, icons or iOS meta tags, so it
  can't be installed.
- **`android/` "Termlink".** A native Kotlin/Compose app covering sessions only, with no
  Projects, jobs, history, accounts or tracks. `android/` is a gitignored **git worktree** of this
  repo on the local branch `android`. That branch has 3 commits, the last on 2026-02-15, and was
  never pushed.
- **HTTPS.** The server runs plain HTTP on `0.0.0.0:4220`. `config.tls` exists, and with no
  certificate paths `app.ts` already gets one from `tailscale cert`, but turning it on makes the
  **only** listener HTTPS.
- **Identity.** It comes from `tailscale whois <socket IP>` (`auth/tailscale.ts`). No proxy
  headers are trusted.

## What we can reuse from the Claude Code app

Claude Code's **Remote Control** (`claude --remote-control "<name>"`) puts a session in the
official Claude app, with its chat UI, permission prompts and native push
(code.claude.com/docs/en/remote-control.md). **Decided: not used.** It only covers Claude
conversations (no shells, Projects or job gates). It needs a claude.ai login, and on Team and
Enterprise plans an Owner must turn it on. Transcripts are stored on Anthropic servers while
connected. We take its ideas instead: a native-feeling full-screen app, a push when action is
needed, and tapping the push opens the exact place that needs you.

## Design decisions (confirmed 2026-11-06)

1. **PWA, not native.** It's one codebase with every feature, and it works on Android and iOS.
   **Termlink is removed.** The `android/` worktree was removed on 2026-11-06 with
   `git worktree remove android`; the `android` branch keeps its 3 commits. What's left for
   the track is dropping the `android/` line from `.gitignore`.
2. **HTTPS through a second listener, not `tailscale serve`.** Behind `tailscale serve` every
   request arrives from `127.0.0.1`, so `whois` can't identify the phone. Fixing that means
   trusting `Tailscale-User-Login` headers on loopback, which any local process could forge.
   Instead, add an HTTPS listener (proposed port **4221**) using the `tailscale cert`
   certificate, with the same `whois` identity check and same-origin WebSocket check.
   `http://localhost:4220` stays as it is, so the notification hooks, `statusline.mjs`,
   `cr-session` and `/api/agent/*` keep working. The certificate is refreshed at boot and by a
   daily timer, because `tailscale cert` renews only when the certificate is close to expiring.
3. **Web Push using the `web-push` package.** It covers session needs-input/completed (the
   same `/api/notify` events the hooks already send), job gates (design, review, merge) and
   Land results. VAPID keys are stored in `<dataDir>`; subscriptions go in a new SQLite table.
   On iOS, push only works once the app is added to the Home Screen (iOS 16.4 or later).
4. **The service worker caches only the app shell** (HTML, CSS, JS, icons). `/api/*` and
   `/ws` always go to the network, so the app never shows stale sessions, board data or
   decisions.
5. **Deep links are URL routes** handled by the client (`/?session=<id>`, `/?job=<id>`,
   `/?project=<slug>`), used by notification clicks and links you share. **Share-to** uses the
   manifest's `share_target`, which only Android supports (iOS has no equivalent). It opens a
   picker for sending the shared text into a session.

## Planned changes (proposed features)

| P | Feature | Notes |
|---|---------|-------|
| P1 | HTTPS tailnet listener | Second Fastify listener on 4221 with the `tailscale cert` certificate and daily refresh; same identity and origin checks; loopback HTTP unchanged |
| P1 | Installable PWA | `manifest.webmanifest`, icons (192/512/maskable plus `apple-touch-icon`), shell-only service worker, iOS meta tags, standalone display, safe-area insets, `visualViewport` resizing so the on-screen keyboard doesn't cover the terminal; `copy-client-assets.mjs` copies the new files |
| P1 | Special-keys bar | Esc, Tab, Shift+Tab, Ctrl (sticky), arrows, `/`, Ctrl+C; shown only on touch devices while the terminal has focus |
| P1 | Reconnect UX | Re-attach on `visibilitychange`/`online`; "Reconnecting…" banner; keeps the attached session and scroll position |
| P2 | Web Push | VAPID keys, subscription table, subscribe button in Settings, sends on needs-input/completed, job gates and Land |
| P2 | Deep links and share-to | Route handling on load and on notification click; Android `share_target` |
| P3 | Remove Termlink | Worktree already removed; drop the `android/` line from `.gitignore` |

## Verification

- `npm test` and `npm run lint`. Unit tests cover the listener config, push subscription
  storage, which events send a push, and route parsing.
- Isolated boot (`project/QA.md` Flow 3) with HTTPS on a spare port. **Never restart 4220** to
  test this.
- On real phones over the tailnet: install on Android Chrome and on iOS Safari (Add to Home
  Screen); check full screen, that the keyboard doesn't cover the terminal, the keys bar,
  re-attach after the screen locks, a push arriving while the app is closed and that tapping it
  opens the right job, and share-to on Android.

## Out of scope

- App-store publishing, and wrapping the PWA in Capacitor or a TWA. These can be revisited if
  the PWA's push or feel turns out not to be good enough.
- Running the server on the phone, and access from outside the tailnet.
- Claude Code Remote Control (decided against, see above).

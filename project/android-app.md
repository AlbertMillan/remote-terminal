# Android app

## Goal

A native Android app for claude-remote that feels smooth: native terminal scrolling and fling,
an instant session drawer, a proper keyboard with a keys bar, and quick recovery after the phone
sleeps. It has push notifications like the Claude app, the Projects board with job gates, and
session history, share-to and links. This replaces the plan to use the web client as an
installed app (the deleted "Mobile app" track). The complaints that started it were slow,
unreliable touch scrolling in the terminal and the left panel, and a slow-opening left panel.

## Starting point

- `android` branch: Termlink, from February 2026. It forked from main and deleted all server
  code, so it is out of reach of tracks. It is checked out as the `android/` worktree, and main
  ignores `android/`.
- Termlink's `terminal-emulator` and `terminal-view` are Termux's terminal modules, forked to
  run without a local PTY. They are Apache-2.0 (SPDX headers in each file).
- Toolchain on this PC: the Android SDK, emulator and system images are under
  `%LOCALAPPDATA%\Android\Sdk`. Android Studio's JDK is at
  `C:\Program Files\Android\Android Studio\jbr`. The `java` on PATH is 1.8, too old for
  Gradle, so builds must use the Android Studio JDK.

## Design decisions (confirmed 2026-11-06)

1. **The code lives in main as `android/`.** Tracks, children and jobs can then work on it, and
   protocol changes land in the same commit as the server. Drop `android/` from `.gitignore`;
   ignore `android/local.properties`, `build/`, `.gradle/` and `.idea/` instead. The `android`
   branch stays as history. **Before this track lands, remove the `android/` worktree**
   (`git worktree remove android`, which keeps the branch), or main's `android/` folder clashes
   with it.
2. **Fresh rewrite.** Only the two Termux modules come over, with their license headers and a
   NOTICE file. The app itself is new: Kotlin, Jetpack Compose, one activity. It is Android
   only, sideloaded, and built and signed on this PC, with no Play Store.
3. **Plain `http://` and `ws://` over the tailnet.** The user enters the server's MagicDNS name or
   tailnet IP once. Identity stays `tailscale whois` on the server, which is unchanged. There's
   no HTTPS, so the machine name never goes into public certificate logs.
4. **The server is the source of truth.** The app speaks the existing WebSocket protocol
   (`src/server/websocket/protocol.ts`) and `/api` routes. The Kotlin message types mirror
   `protocol.ts`, and a server test fails when the two drift apart (for example, a JSON fixture
   of every message type that both test suites read).
5. **Push works like the Claude app, through Firebase Cloud Messaging (FCM).**
   - While the app is in the foreground it is live on the WebSocket, and the server sends it no
     push. That's the Claude app's "skip push while you're active".
   - In the background, the server sends an FCM message on needs-input/completed, a job
     parked at a gate, and Land results. Tapping it opens that session or job.
   - The server registers device tokens (a new SQLite table) and sends through FCM HTTP v1,
     signing the service-account JWT with `node:crypto` (no `firebase-admin` dependency).
   - **Manual setup by the user:** create a Firebase project, put `google-services.json` in
     `android/app/` (gitignored) and the service-account key in `<dataDir>` (never the repo).
     Without them the app builds, runs and simply has no push. The server logs that push is
     off and never fails.
   - The server needs outbound internet to reach FCM; it already has it.
6. **Builds are Windows-native.** `scripts/android.mjs` (Node) finds the Android Studio JDK and
   the SDK, writes `local.properties`, and runs `gradlew.bat` (build, test, install). It is
   exposed as `npm run android:*`.

## Planned changes (proposed features)

| P | Feature | Notes |
|---|---------|-------|
| P1 | Project scaffold in main | `android/` Gradle project, Termux modules plus NOTICE, `.gitignore` changes, `scripts/android.mjs`, an empty app that builds and runs on the emulator |
| P1 | Protocol and connection | Kotlin client for `/ws` and `/api` mirroring `protocol.ts`, a shared fixture test, connect screen, reconnect on resume and network change |
| P1 | Sessions and terminal | Session drawer (instant open, smooth scroll), create, attach, rename, categories, revive; native terminal with fling scrolling and scrollback; keys bar (Esc, Tab, Shift+Tab, sticky Ctrl, arrows, `/`, Ctrl+C) |
| P1 | Push notifications | Server: token table, FCM HTTP v1 sender, no push while the app is in the foreground. App: FCM, notification channels, tapping opens the session or job. Optional when unconfigured |
| P2 | Projects and job gates | Projects board, job list and detail, answering design, review and merge gates |
| P2 | History, share and links | Session history with Resume and Fork, Android share-to into a session, `claude-remote://` links to a session, job or project |

## Verification

- Server: `npm test` and `npm run lint`, including the protocol fixture test and the FCM sender
  (signing and payload) with a fake transport.
- App: `npm run android:test` (JVM unit tests) and `npm run android:build` (debug APK).
  Smoke test on the installed emulator via `adb` against an **isolated boot** (`project/QA.md`
  Flow 3). Never restart 4220.
- By the user, on their phone over the tailnet: install the APK; scroll and fling in the
  terminal and drawer; the keyboard and keys bar; re-attach after the screen locks; a push
  with the app in the background and tapping it; share-to; the gate answer.

## Out of scope

- iOS, the Play Store, and HTTPS.
- Changing how the web client behaves on phones.
- Running the server on the phone.

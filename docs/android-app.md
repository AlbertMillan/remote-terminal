# Android app

A native Android client for claude-remote, in `android/`. It replaced the plan to install
the web client as an app: touch scrolling in xterm.js and the sidebar was slow and
unreliable, and the left panel was slow to open. The spec and its confirmed design
decisions are in `project/android-app.md`.

## Layout

| Path | What |
|------|------|
| `android/terminal-emulator`, `android/terminal-view` | Termux's terminal modules (Apache-2.0, `android/NOTICE`), as forked by Termlink to run without a local PTY, then changed here (below) |
| `android/app` | The app: Kotlin, Jetpack Compose, one activity, package `com.clauderemote.app` |
| `scripts/android.mjs` | Windows-native build driver behind `npm run android:*` |
| `tests/fixtures/protocol/messages.json` | One example of every `/ws` message, read by both test suites |
| `src/server/push/` | FCM sender, device registry and what gets pushed |

Inside the app: `protocol/` mirrors `protocol.ts`; `net/` is the socket (`Connection`), the
REST client (`Api`) and address parsing; `sessions/` the session list and the open
terminal; `jobs/` the job and project routes and the live job feed; `push/` Firebase and
notifications; `links/` the `claude-remote://` scheme; `ui/` the screens.

## Building

`npm run android:build` (debug APK), `android:test` (JVM unit tests),
`android:install` (debug onto the connected device), `android:release` (minified APK).
`scripts/android.mjs` exists because the `java` on this PC's PATH is 1.8, which Gradle
refuses: it finds Android Studio's bundled JBR, finds the SDK under
`%LOCALAPPDATA%\Android\Sdk` (or `ANDROID_HOME`), writes `android/local.properties`, and runs
`gradlew.bat` through `cmd.exe` with a full path. Node will not spawn a `.bat` directly
(CVE-2024-27980), and Claude Code sets `NoDefaultCurrentDirectoryInExePath`, so `cmd` will not
find `gradlew.bat` in the current folder by name.

Judge smoothness on the **release** APK. Compose in a debuggable build runs far slower than
minified, so a debug build makes the scrolling look worse than it is. The release build is
signed with this PC's debug key, like everything sideloaded here.

`android/.gitattributes` keeps `gradlew.bat` CRLF; `cmd` misreads a batch file with LF
endings.

## The protocol, and how drift is caught

The server stays the source of truth, and the app speaks the existing protocol.
`protocol.ts` now exports `CLIENT_MESSAGE_TYPES` and `SERVER_MESSAGE_TYPES` as values, so a
test can read them. `tests/protocol-fixture.test.ts` fails when the fixture lacks a type,
or lacks a field the server really sends on a session, category or job summary. It compares
against `sessionToInfo()`, `categoryToInfo()` and `buildJobsSummary()` output, not against a
hand-kept list. The app's `ProtocolFixtureTest` then decodes every fixture message with
**strict** JSON (unknown keys fail) through `Protocol.clientPayloads`/`serverPayloads`. A new
type or field therefore fails `npm test` until the fixture has it, and `android:test` until
the Kotlin types do. On the wire the app decodes tolerantly, so an older app survives a newer
server.

The app adds one message of its own, `app.state {foreground}`, and names itself on the
socket with `/ws?device=<install id>` (`deviceIdFromUrl`, `websocket/validation.ts`). Both
exist for push.

The REST side (`JobsApi`, history) is decoded tolerantly and is not under the fixture.
`JobsApiTest` pins the shapes that once broke: a feature's `priority` is a number.

## Connection and recovery

`Connection` delivers every message on the main thread, in order. The terminal emulator and
Compose state are main-thread only, and terminal output must never be reordered or dropped.
That is why the socket uses a listener on the main dispatcher rather than a lossy flow.

Recovery is the point of the design. A dropped socket retries for ever, backing off from
0.5 s to 15 s. A new network (`ConnectivityManager` callback) or the app returning to the
foreground retries at once. Returning to the foreground with a socket that *looks* open
sends a ping first, and replaces the socket if no pong arrives within 3 s. After the screen
was off the tailnet path can be gone while OkHttp still holds the socket, and OkHttp's own
20 s ping is too slow to notice. In the background the socket is kept for 60 s (a quick app
switch) and then closed; push covers the time away.

`SessionStore` re-attaches the open session on every connect. The server answers with its
scrollback, which replaces the terminal, so the screen after a wake shows what happened
while away, with nothing doubled.

After a server restart the open session is parked, not in memory, and the re-attach is
refused (`Session not found`). The store then stops that terminal (its keys would only draw
"Not attached" errors), keeps its screen, and shows the server's fresh row: a revivable one
gets a Revive bar in place of the keys bar. It is never revived automatically, since that
relaunches `claude`. Revive answers `session.created` with no scrollback, so the same
terminal carries on below what it showed. `SessionStoreTest` covers this path.

## Terminal

The terminal is Termux's `View` inside an `AndroidView`, so scrolling and fling are the View
system's (`OverScroller`), not Compose's, and output redraws never recompose anything.
Changes made to the fork here:

- **Pixel scrolling.** The scroll position is in pixels. The renderer draws the
  partially scrolled top row and one extra row, so a drag follows the finger. Termlink's
  version jumped a whole line per step and its fling was a single coarse jump.
- **Anchored history.** `TerminalBuffer.getScrollCounter()` counts lines pushed into the
  scrollback. A view scrolled into history moves by that count, so text being read does
  not slide while Claude is writing.
- **Resize keeps scrollback.** The fork dropped all scrollback on resize, and a phone
  resizes on every keyboard show and hide. Rows are not reflowed: narrower truncates, wider
  pads. When the cursor would fall below the new screen, the top rows move into the history.
- **Colours.** `TextStyle` stores palette index + 1, and the fork's renderer read it as the
  raw index, so every colour was one entry off. 24-bit colour arrives mapped to the nearest
  palette entry (the emulator's own limit).
- **Alternate screen.** It was never drawn: the renderer always drew the main buffer.
- **Run drawing.** Same-style cells whose glyphs are exactly one cell wide are drawn in one
  `drawText`. Box drawing and symbols from fallback fonts are drawn cell by cell, so a run
  never drifts off the grid.
- `onDraw` clips to the view first: `drawColor` fills the canvas clip, which inside a Compose
  `AndroidView` is not the view's bounds, and painted over the app bar.

The keys bar sends Esc, Tab and the arrows through the view's key handling, so the arrows
follow cursor-key mode and the sticky Ctrl applies. Ctrl stays on for exactly one key.
Paste, the Paste key and share-to included, is bracketed when the program enabled
bracketed paste (Claude Code does). Without it a multi-line paste submits at every line.
ESC is stripped from pasted text, so a paste cannot end its own bracket.

## The drawer

The drawer is a `LazyColumn` with stable keys, which gives native fling, and a change to one
row recomposes only that row. It is composed once and only translated (`Modifier.offset`
plus a `graphicsLayer` scrim, both read in the layout and draw phases). Opening it is a
160 ms slide that composes nothing. That cost is exactly what made the web sidebar slow.
Pages (Projects, a job, History) stack *over* the main screen, which stays composed, so the
terminal and the drawer are untouched on the way back.

## Push

It works like the Claude app. While the app is on screen it is live on the socket and has
said `app.state {foreground: true}`, and the server sends that device no push
(`isDeviceForeground`). That also needs the socket heard from in the last 45 s (a message,
or OkHttp's 20 s ping frame): the server never pings, so a phone that dropped off the
tailnet while on screen would otherwise look foreground until TCP gives up, and get no push.
Otherwise the server pushes a session that needs input or finished,
a job newly parked at a gate, and a Land's result. Gate pushes go out once per wait: the
parked set is diffed on job writes and seeded at boot, so a restart does not re-announce old
waits.

Messages are **data-only** FCM. The app builds the notification itself, on one channel per
kind (needs input, finished, job gates, land results), so each can be muted in Android
settings. It uses one notification per session, job or track, so "finished" replaces "needs
input" instead of stacking. A tap opens the notification's `claude-remote://` link.

`src/server/push/fcm.ts` signs the service-account JWT with `node:crypto` (RS256), trades it
for an access token, caches that until a minute before expiry, refreshes once on a 401, and
treats 404 or `UNREGISTERED` as a dead token (the device row is deleted). Every request
goes through an injected transport, so `tests/push.test.ts` covers signing, payload, caching
and errors with no network. No `firebase-admin` dependency.

**Optional on both ends.** Without `<dataDir>/firebase-service-account.json` the server logs
`push: off` once, and every send is a no-op. Without `android/app/google-services.json` the
Google Services plugin is not applied (`app/build.gradle.kts`), Firebase never initialises,
and the app runs without push. A send never throws into the session, job or Land that
caused it. Both files are the user's own: `google-services.json` is gitignored, and the key
lives in the data dir, never the repo.

### One-time Firebase setup (the user's)

1. Create a project at console.firebase.google.com (Analytics not needed).
2. Add an Android app with package name `com.clauderemote.app`. Download
   `google-services.json` into `android/app/`.
3. Project settings → Service accounts → Generate new private key. Save the file as
   `%USERPROFILE%\.claude-remote\firebase-service-account.json`.
4. Rebuild and reinstall the app (`npm run android:release`), and restart the server once
   this has landed. The log then says `push: on`.
5. Open the app and allow notifications. `GET /api/push` lists the registered device.

## Projects and job gates

The live job list comes from `jobs.summary`, the same feed the web overlay uses. A job
screen reloads on every job write. A parked question is shown as the web board shows it:
`GET /api/jobs/:id/decision` serves `src/client/decision-format.ts`'s parse, which is pure,
so there is one parser and no Kotlin copy to drift. There is one answer box per question,
all required, joined exactly as `job-board.ts` joins them (`JobsApi.joinAnswers`). The review
gate ticks findings through `/findings/select`; design and merge approval show the spec,
documents and diff first.

## History, share and links

History reads `/api/project-logs`: every SESSION-LOG entry that names a conversation, with
Resume and Fork through `session.open`. Share-to (Android's share sheet, `text/plain`) asks
which running session to use, the open one first, and pastes into its prompt. It never
presses Enter. Links are `claude-remote://session/<id>`, `job/<id>` and
`project?cwd=<encoded>` (`links/Link.kt`). Anything else parses to nothing, and the app
just opens.

## Testing on the emulator

Never use 4220. Boot the worktree's `dist/` on a spare port (`project/QA.md`, Flow 3) with
`auth.enabled: false`. The emulator reaches the host as `10.0.2.2` from loopback, which
`tailscale whois` cannot resolve. Copy `accounts` and `defaultAccount` from the live config,
or every session launch is refused by the account preflight. Start the AVD with
`-memory 4096`: at its stock 2 GB it swaps, and a first debug launch takes a minute and ANRs.
The emulator's frame times are no measure of a phone's. Judge smoothness on the device.

## Limits

- Terminal rows are not reflowed on resize. 24-bit colour is mapped to 256.
- The emulator has no mouse reporting, so a full-screen program that wants the wheel gets
  no scroll in the alternate screen.
- Landing this track: remove the old `android/` worktree in the main checkout first
  (`git worktree remove android`, which keeps the branch), or it clashes with main's
  `android/` folder.

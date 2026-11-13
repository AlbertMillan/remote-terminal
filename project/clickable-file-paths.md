# Click a file path in the terminal to open it

## Goal

Claude Code names files in its replies (`NUANCES.md`, `refs/brief/Reinhardt.png`), and shell
output does too (`ls`, `git status`, build errors). Make those names clickable in the web
terminal: a click opens the file in a new browser tab, served from the server's disk. The
browser shows what it can show itself (images, PDF, video, audio, text). Anything else downloads,
and the viewer's device opens it with its own default app. There is no viewer of our own.

## Findings (2026-11-13)

- Claude Code sends **no** OSC 8 links in our PTYs. Its "blue" paths are inline-code colour
  (`\e[38;2;153;204;255m`), not links: 0 OSC 8 sequences in all persisted scrollback.
- `FORCE_HYPERLINK=1` (tested on 2.1.323 in a ConPTY) links **markdown links only**. Backticked
  paths stay plain coloured text. So the paths must be detected in the text, as VS Code does.
- `supports-hyperlinks` answers false on `win32` unless `FORCE_HYPERLINK` or `WT_SESSION` is
  set, which explains the first finding.
- Reference implementation: VS Code's `terminalContrib/links` (`terminalLocalLinkDetector.ts`,
  `terminalLinkParsing.ts`, `terminalLinkResolver.ts`). It joins wrapped rows, parses
  `path:line:col`, resolves against the cwd and shows a link only when the file stat succeeds,
  caching misses.

## Design decisions (confirmed 2026-11-13)

1. **Open = serve the file, let the browser handle it** (option 1). There's no in-app viewer and
   the server never launches a desktop app.
2. **Files are read in place.** Nothing is copied or stored. The click always gets the current
   bytes, and a deleted or moved file stops being a link.
3. **Only real files are underlined.** The client proposes candidates. The server answers which
   exist inside the allowed roots, and only those are underlined. Results are cached per session
   (a hit for 60 s, a miss until the next prompt line), so scrolling never floods the server.
4. **Allowed roots:** the session's cwd and its uploads folder (`<dataDir>/uploads/<id>/`, so
   pasted and dropped files open too). An absolute path outside those roots is not a link. A
   relative path resolves against the cwd only, and `..` that escapes the cwd is refused.
   Containment is checked lexically **before any filesystem call**, and UNC/device paths are
   refused outright: a printed `\\host\share\x.png` reaching `realpath` would make Windows
   offer the user's NTLM credentials to that host just because the line was hovered
   (code review, 2026-11-13).
5. **Inline vs download:**
   - inline (in the tab): images (except SVG), PDF, video, audio, and text-like files (`.md`,
     `.txt`, `.json`, `.log`, code) as `text/plain; charset=utf-8`.
   - download (`Content-Disposition: attachment`): everything else, including **`.html` and
     `.svg`**. Served inline from our origin, they could run script that calls `/api/*`.
   - Every response sends `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox`.
6. **Auth:** the route runs `verifyTailscaleConnection()`, as the restart route does, so it asks
   for the same identity as the terminal WebSocket. Today `/api/*` is open on `0.0.0.0`, and a
   file-reading route must not be. The answer is cached 60 s per IP, so a hover doesn't spawn
   `tailscale whois`. Every `/api/*` and `/ws` request also passes the app-wide Host check
   (`host-check.ts`), which stops DNS rebinding, something an IP-based identity can't.
7. **Click gesture:** a plain click (or tap), the same as the existing web links. A drag still
   selects text.
8. **Markdown links stay as they are for now:** `FORCE_HYPERLINK=1` and an xterm `linkHandler`
   are a separate, later change.

## Planned changes

### Server — new `src/server/sessions/session-files.ts`

- `resolveSessionFile(sessionId, raw)` returns `{ abs } | null`:
  - strip a `:line[:col]` or `(line,col)` suffix, surrounding quotes and brackets, and trailing
    `.,;:`;
  - expand nothing (no `~`, no env vars);
  - resolve relative paths against the session's cwd;
  - `realpath` the result (symlinks and junctions resolved), then require it to be inside a
    realpath'd allowed root (same rule as `resolveInWorktree()`);
  - the result must be a regular file.
- `POST /api/sessions/:id/files/check` takes `{ paths: string[] }` (at most 50, each at most
  1024 chars) and returns `{ found: string[] }`. Unknown session: 404.
- `GET /api/sessions/:id/files/open?path=<raw>`: streams the file with its type and the headers
  from decision 5. Not found or outside the roots: 404, with the same body either way.
- Both routes are guarded by `verifyTailscaleConnection(extractIpFromRequest(request))`, which
  answers 403 when it fails.

### Web client — new `src/client/file-links.ts`, wired in `terminal.ts`

- `registerLinkProvider` next to the web-links addon. For a buffer line:
  - join it with its wrapped neighbours (`isWrapped`) and run a path regex. A path must contain
    a `.ext` from an allowlist, or a `/` or `\`, and must not be a URL;
  - map string offsets back to buffer cells (wide characters included);
  - send unknown candidates to `/files/check` (debounced, batched, cached) and return links only
    for `found`.
- `activate` opens `/api/sessions/<id>/files/open?path=…` with `window.open(…, '_blank',
  'noopener')`.
- The provider reads the active session id from `terminal.ts` and is a no-op without one.
- PiP terminal (`pip-manager.ts`): the same provider is registered there too.

### Tests

- `resolveSessionFile`: relative, absolute inside, absolute outside, `..` escape, a symlink or
  junction that points outside, `file:12:3` suffix, trailing punctuation, a folder (refused),
  the uploads root.
- Routes: auth refused gives 403, check batch caps, inline vs attachment headers per type, and
  the `.html` and `.svg` downloads.
- Client regex: the cases in the issue screenshot (`NUANCES.md`, `refs/brief/Reinhardt.png`,
  `docs/ai-gamedev-pipeline.md`), a wrapped path, a URL that must not match, and `e.g.` or
  version numbers that must not match.

## Verification

- `npm test`, `npm run lint`.
- Isolated boot (`project/QA.md`, Flow 3): in a session, `echo` a relative and an absolute path
  to a PNG, an `.md` and a `.zip`, plus a path that doesn't exist.
  - The PNG opens in a tab, the `.md` shows as text and the `.zip` downloads.
  - The missing path is not underlined.
  - Repeat with a path wrapped across two rows.
- From a phone over Tailscale: tap a PNG path, and it opens in the phone's browser.

## Out of scope

- An in-app viewer or rendered markdown.
- "Open on this PC" (launching a Windows app on the server).
- Copying files to keep them after their folder is deleted.
- `FORCE_HYPERLINK` / OSC 8 `linkHandler` (a later change).
- Android app: it renders its own terminal, so it needs its own link detection. That is a
  follow-up, and it reuses both routes.
- Tracking the shell's current folder after `cd`. Relative paths resolve against the session's
  starting cwd only.

# Windows auto-start

Scripts for running the server on Windows:

- `start-server.bat` - Batch file that runs `node dist/server/index.js`
- `start-server-hidden.vbs` - VBS wrapper to run without a visible console window

**Enable auto-start on login:**
Copy `start-server-hidden.vbs` to `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\`

**Manual start (hidden):**
```bash
wscript.exe start-server-hidden.vbs
```

**Remove auto-start:**
Delete the VBS file from `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\`

**Inherited session markers:** restarting from inside a claude-remote terminal means the
server inherits that conversation's `CLAUDE_CODE_CHILD_SESSION=1` and friends. The VBS
launcher detaches the process *tree*, not the *environment*. Left in place, every PTY
inherits the marker and every `claude` in it silently skips saving its transcript --
which breaks Fork, resume history, job take-over and SESSION-LOG all at once, with the
only symptom a one-line warning inside the terminal. `src/server/utils/claude-env.ts`
strips the markers at boot and again at the PTY chokepoint; it is a denylist of
session-scoped vars, never a `CLAUDE_*` wildcard, so the user's own settings survive.

**Restart from the UI:** Settings → Server has *Restart* and *Build & restart*
(`src/server/server-restart.ts`, `src/client/server-restart.ts`). Both spawn
`restart-server.vbs` detached, the same launcher used by hand, so the restart outlives the
server's own process tree. *Build & restart* runs `npm run build` first and leaves the server
up if it fails. The route refuses (409) unless the server runs from `dist/` on port 4220 —
`restart-server.ps1` stops every `dist/server/index.js` and starts 4220, so a second instance
(an isolated QA boot, `npm run dev`) would otherwise kill or duplicate the live one. It also
requires a same-origin request and a Tailscale identity. The client waits for a *different*
`bootId` from `GET /api/server/status` before reloading, since the old server keeps answering
for a moment after the 202. Sessions come back stale and revive from the sidebar.

**When a restart is needed:** `npm run build` ends with `scripts/write-build-info.mjs`, which
stamps `dist/build-info.json` with the commit built (`sha`) and `builtAt`. The server reads
it once at boot (the build it runs) and again for each `GET /api/server/status` (the build
on disk), whose `build.state` is `restart` when the two differ and `rebuild` when a build input
(`src/`, `package.json`, `package-lock.json`, `tsconfig*.json`,
`scripts/copy-client-assets.mjs`) changed in a commit after the on-disk `sha`. Rebuild wins;
docs-only and uncommitted changes never count. Either shows a chip beside "Connected" that
opens Settings → Server — never a one-click restart, since that ends every terminal. A Land of
this project re-checks and says which is needed. A `dist/` from before stamps, dev mode, or no
git shows nothing (`unknown`). Spec: `project/server-behind-build.md`.

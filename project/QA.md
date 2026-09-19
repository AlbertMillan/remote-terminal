---
driver: commands
commands:
  - npm test
  - npm run build
  - npm run lint
---

# QA — claude-remote

## Preconditions

- **Never start a server on the default port (4220), and never run `npm start` or
  `npm run dev` with the default config.** The user runs this app on 4220 against
  `~/.claude-remote/sessions.db`, and a second instance would bind the same port and open
  the same live database. A job that needs a running server must use the isolated boot in
  Flow 3.
- `npm ci` / `npm install` only if `node_modules` is missing — the worktree normally
  inherits it.
- No browser is available to this stage. Anything that can only be seen in the UI is out
  of scope here; say so rather than guessing (see "Not covered" below).

## Flows

1. **The declared commands pass.** `npm test`, `npm run build` and `npm run lint` are run
   for you before these flows, and their results are reported separately. Read them before
   going further: if the build failed, flows 2 and 3 cannot mean anything.
   expect: all three green. `npm run lint` reports 0 errors; warnings are pre-existing
   (`no-explicit-any`) and are not a failure.

2. **The change is actually in the built client.** Server and client are bundled by
   esbuild, and a client-only mistake (a bad import, a name that does not exist) surfaces
   at bundle time rather than in the type-check.
   expect: `dist/client/session-manager.js` and `dist/server/index.js` exist and are newer
   than the sources this job changed. If the job touched client code, grep the bundle for a
   distinctive new identifier and find it.

3. **The server boots against a throwaway config, applies its migrations, and answers.**
   This is the only sanctioned way to run the server here, and it is what catches a broken
   DB migration — which no unit test covers.
   - Write a temp config, e.g. `{"server":{"port":4399,"host":"127.0.0.1"},
     "persistence":{"dataDir":"<a temp dir>"}}`.
   - Start it with `CLAUDE_REMOTE_CONFIG=<that file> node dist/server/index.js`, in the
     background, logging to a file.
   - `curl --retry-connrefused --retry 12 --retry-delay 1 http://127.0.0.1:4399/api/jobs`
   - **Always stop it again**, by the PID listening on 4399, and confirm 4220 still
     answers. Leaving it running is a failure of this flow even if everything else passed.
   expect: `/api/jobs` returns 200, a fresh `sessions.db` appears in the temp dir, the boot
   log has no `uncaughtException`/`unhandledRejection`, and the live server on 4220 is
   still up afterwards.

4. **Tests exist for what this job changed.** A stage that reports success without having
   run anything is worse than one that reports failure, and the same is true of a change
   with no test.
   expect: the job's diff adds or updates tests under `tests/` for the behaviour it
   changed, and those specific files pass. If the change is genuinely untestable
   (styling, a comment pass), say so explicitly rather than treating it as covered.

## Not covered

These need a driver this project does not declare yet. Report them as SKIP with this
reason rather than as passed:

- Anything in the browser UI: the job board, the document pane, terminal rendering, the
  PiP overlay, keyboard shortcuts.
- WebSocket behaviour end to end (attach, resize, scrollback replay).
- Tailscale identity verification, which needs a real tailnet.

When a browser driver is added (`driver: playwright`, or an agent driving Chrome), move
the first two bullets into Flows and keep the commands above as the deterministic layer —
`checkDriver()` in `src/server/jobs/qa-doc.ts` decides availability, and an unavailable
driver must still SKIP rather than pass.

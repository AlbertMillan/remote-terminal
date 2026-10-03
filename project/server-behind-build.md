# Server behind the build

Track: Track workflow polish

## Goal

When a change has landed but the running server doesn't have it yet, say so on screen,
with the one action that fixes it.

On 2026-09-25 a track had landed the night before and the client looked unchanged, so
the user assumed the merge had failed. It had landed. `dist/` was older than the merge,
and the server had restarted that morning on the old build. Since then:

- Land runs `npm run build` (`project-build.ts`), so `dist/` is usually up to date.
- Settings → Server has **Restart** and **Build & restart** (`f-t188v6`,
  `server-restart.ts`).

Nothing yet says *when* either is needed. After a Land the server still runs the old code
until someone restarts it, and a failed Land build leaves `dist/` behind the source.
Neither shows anywhere.

## Design decisions

### Three states, from a build stamp

The build writes `dist/build-info.json`:

```json
{ "sha": "<git HEAD at build time>", "builtAt": "<ISO time>" }
```

It's written by a new `scripts/write-build-info.mjs`, appended to the `build` script. It
must be a Node script, not shell, so it runs on Windows. The server reads the file once at
boot, which gives the build it is **running**. It reads it again on demand, which gives
the build **on disk**.

| State | Condition | Shown |
|---|---|---|
| `current` | running = on disk, and no build input changed since | nothing |
| `restart` | on disk is newer than running (another `sha` or `builtAt`) | "Restart to load the new build" |
| `rebuild` | a build input changed between the on-disk `sha` and `HEAD` | "Build & restart to load …" |
| `unknown` | no stamp (a `dist/` built before this change), not a git repo, or dev mode | nothing |

- **`rebuild` wins over `restart`.** If both are true, a plain restart would load a stale
  build.
- **Build inputs** are one constant next to the check: `src/`, `package.json`,
  `package-lock.json`, `tsconfig*.json`, `scripts/copy-client-assets.mjs`. A
  docs-only commit, such as a planning commit or a Land's tick commit, must not flag a
  rebuild.
- **Only committed changes count.** An uncommitted edit on main says nothing about what
  landed, and flagging it would keep the indicator lit during ordinary work.
- **Stamp, not mtimes.** Directory mtimes in `dist/` don't change when files inside are
  overwritten (`dist/client` still shows 2026-09-18). File mtimes can't say which commit
  was built.

### Where it shows

- **`GET /api/server/status`** gains `build: { state, running, onDisk, reason }`. The
  `git diff --quiet <onDisk.sha> HEAD -- <inputs>` result is cached for 30 s, and the
  cache is dropped after a Land, a build and a restart request.
- **A chip next to "Connected"**, beside the plan usage chip, shown only for `restart` and
  `rebuild`. Clicking it opens Settings → Server.
  - The chip never restarts on one click. A restart ends every terminal (they revive
    from the sidebar), so the confirm stays in Settings, where `ServerRestartControl`
    already has it.
  - When `canRestart` is false (dev mode, or a port other than 4220), the chip still
    shows. Its tooltip gives `reason` and the manual step instead.
- **The client re-checks** every 60 s, on window focus, and right after a Land returns.
- **Land's message** says so when the landed project is this server's own root, e.g.
  "Landed into main — build passed — restart to load it". Today it ends at "build
  passed", and that reads like nothing more is needed.

### Scope

This covers this server's own project root only. Land also builds other projects, but
claude-remote doesn't run them, so there's nothing for it to restart.

## Planned changes

- `scripts/write-build-info.mjs` (new), and `package.json` → `build` runs it last.
- `src/server/server-restart.ts`: read the running stamp at boot, add a `buildState()`
  check with its cache, add `build` to `/api/server/status`, and drop the cache on a
  restart request.
- `src/server/projects/routes.ts`: after a Land of the server's own root, drop the cache
  and add the restart hint to `detail`.
- `src/client/server-restart.ts`: the chip, the polling, and opening Settings → Server.
  `src/client/index.html` / `styles.css`: the chip's markup and styles.
- `docs/windows-auto-start.md`: one paragraph on the indicator.

## Verification

- **Unit (`tests/server-restart.test.ts`):**
  - Same stamp and no input change → `current`.
  - A newer on-disk stamp → `restart`.
  - A `src/` commit after the on-disk `sha` → `rebuild`.
  - A docs-only commit → `current`.
  - A missing stamp → `unknown`.
  - Both conditions true → `rebuild`.
- **Script:** `npm run build` writes `dist/build-info.json` on Windows with the right
  `sha`.
- **Manual (the isolated boot in `project/QA.md`, never 4220):**
  - Boot, commit a `src/` change → the chip says Build & restart.
  - Build → it says Restart.
  - Boot again → no chip.

## Out of scope

- Restarting automatically after a Land. It kills every terminal, so the user decides
  when.
- Any project other than this server's own.
- Hot-reloading the client without a server restart.

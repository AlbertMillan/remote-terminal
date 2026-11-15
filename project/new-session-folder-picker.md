# Pick or create a project folder in New Session

## Goal

Starting a session in a new project today means leaving the folder empty, landing in the
server's own folder (claude-remote) and `mkdir`/`cd`-ing by hand. The Working Directory
field should instead find existing projects as you type, complete paths with Tab, and
create a folder that doesn't exist yet, all from the dialog.

Mockup (six states): https://claude.ai/artifact/D2zTS9PXM1wQwKP6CxvWW9

## Design decisions

**A default folder, not the server's cwd.** `sessions.defaultCwd` (default
`~/NodeProjects`) is where an empty field opens a session and what Tab fills on an empty
field (`~/NodeProjects/`, shown as the placeholder with a Tab hint). `manager.ts` falls back
to it instead of `process.cwd()`; a missing default folder falls back to `os.homedir()`.

**The user folder is the boundary for creating; an existing folder opens anywhere.** Any
path under `os.homedir()` may be completed or created, at any depth. A folder that already
exists opens wherever it is, as before this feature: track worktrees live under
`~/.claude-remote`, and people work in `~/.claude` or on other drives. Anyone who can reach
the server can already open a shell, so the rules guard against mistakes and path tricks
rather than add a lock: Host check (`app.ts`) stops a DNS-rebound page as for every
`/api/*` route. A path passes in this order:

1. **Its text, before any filesystem call** (`checkPathText`, the `session-files.ts`
   rule): `~` expanded (`expandHome`), relative paths under the default folder, no `..`
   segment, no `\\`/`//` (UNC or device) prefix. A UNC path reaching `stat`/`realpath`
   sends the user's NTLM hash to that host. This applies to every path, existing or not.
2. **An existing folder is `exists`**, and opens. A file is refused.
3. **To create or list: inside the user folder, no tool config** (`checkLexically`):
   `isInside(homedir, path)`, and no segment below the home folder that starts with `.`
   or is `AppData`. Those hold tool config (`.ssh`, `.claude`, `.claude-remote`), not
   projects. Completion lists a folder's contents only under these rules too.
4. **Links resolved**: `realpath` of the deepest existing ancestor must still be inside the
   real home folder, or a junction under `~` pointing at `D:\` would put the new folder
   there.
5. **Only adds**: `mkdir` of the missing levels (`recursive: true` only after steps 1–4
   passed for the full path). Never overwrites, deletes or modifies an existing folder. A
   folder that appeared between check and Create just opens.

**Two completion modes in one endpoint.** `GET /api/paths/complete?q=…`:
- **Path mode** (`q` contains `/` or `\`, or starts with `~`): the folders inside the typed
  parent whose names start with the last segment (case-insensitive), each with `git` and
  `PROJECT.md` flags. Hidden/AppData folders are never listed. At most 50 entries.
- **Search mode** (no separator): known projects whose name contains `q`, from the same
  discovery the workspace uses (`discoverProjects()` + registry), newest use first, then
  the default folder's other folders by name (a project no session has run in yet, like
  `steam-agent`, is otherwise invisible), plus a last row "New folder `<defaultCwd>/<q>`"
  when `q` is a valid folder name that doesn't exist.
- Recent paths (`getRecentPaths()`) rank first in both modes. This **replaces** the
  recent-paths dropdown (`/api/recent-paths` stays for anything else that reads it).
- The response also carries the check verdict for `q` itself: `exists` (with the project
  name if any) · `creatable` (with the levels to create) · `refused` (with the reason),
  which drives the hint under the field.

**Keyboard.** The top match's remainder shows as grey ghost text after the cursor; Tab
accepts it (a folder gets a trailing `/`, so the next Tab lists its children, like a
shell). ↑/↓ pick, Enter on a highlighted row picks it, Enter otherwise creates. Escape
closes the list. Queries fire after ~150 ms of no typing; an older answer never overwrites
a newer one (sequence counter, as `refreshDefaultAccount()` does).

**Creating.** State "creatable" shows a box: "Creates N new folders", the new part
highlighted, and two checkboxes, both ticked: *Initialize git* (`ensureGitRepo()`, leaf
folder only, skipped if already a repo) and *Add a starter `PROJECT.md`* (frontmatter
`name: <leaf>`, `status: active`, written through `project-doc-format.ts`). The button
reads **Create folder & session**. The Track picker is hidden (no branches yet).
State "refused" shows the reason in amber and disables Create.

**Creation is server-side and re-checked.** `session.create` gains `createCwd?: { git:
boolean; projectDoc: boolean }`. The handler checks its shape and passes it to
`createSession`, which creates the folder only after the session limit and the account
preflight have passed (a refused launch leaves no folder), re-running steps 1–5 itself
(the client's check is advisory), then starts the PTY there. A new client field goes into
`tests/fixtures/protocol/messages.json` and `android/…/Protocol.kt`. Create sends the
verdict for exactly the text it sends, never the last one shown.

**Small conveniences.** An empty Name defaults to the folder's leaf (shown as its
placeholder). `\` and `/` both accepted. A pasted `C:\Users\Albert\…` is shown as `~/…`.

## Planned changes

- `config.ts`: `sessions.defaultCwd` (default `~/NodeProjects`), set in config.json. Not in
  the Settings form: that form only edits numeric limits (`LIMIT_SETTINGS`).
- New `src/server/sessions/folder-picker.ts`: `checkFolder(q)` (steps 1–3 → verdict),
  `completeFolder(q)` (both modes), `createFolder(path, opts)` (steps 1–4 + git/doc).
- `app.ts`: `GET /api/paths/complete`.
- `sessions/manager.ts`: empty cwd → `defaultCwd`; `handlers/sessions.ts`: `createCwd`.
- `protocol.ts` + fixture + `Protocol.kt`: `createCwd` on `session.create`.
- Client: `new-session-modal.ts` replaces the recent-paths list with the combobox (ghost
  text, groups, key hints, verdict box); `index.html` + `styles.css` for the markup.

## Verification

- `tests/folder-picker.test.ts`: UNC, `..`, other drive, `.ssh/x`, `AppData/x` refused
  before any fs call (spy on `fs`); a junction under a temp home pointing outside refused;
  multi-level create; existing folder untouched; search ranks recents first; prefix
  matching ignores case.
- Handler test: `createCwd` with a refused path never creates and never spawns a PTY.
- Isolated boot (QA Flow 3): Tab on empty → `~/NodeProjects/`; `~/NodeProjects/ma` lists
  the market-analyzer folders; `steam` finds both steam projects; create
  `~/NodeProjects/tmp-a/tmp-b` with git + PROJECT.md, session opens there; `D:\x` refused.

## Out of scope

A separate "New project" screen in the workspace, cloning a repo into the new folder,
project templates beyond the starter `PROJECT.md`, creating folders outside the user folder.

# Dependencies in worktrees

Track: Track workflow polish

## Goal

Every worktree that needs to run the project's tests or build has its own dependencies,
and removing a worktree can never delete anything outside it.

Today no worktree gets `node_modules`. No parent folder has one either, so Node's lookup
finds nothing. Two consequences:

- **Agents link main's copy in by hand.** It happened on 2026-09-25 (Land rebuild) and on
  2026-09-29 (favourites browser test), with a junction from the worktree to the main
  checkout's `node_modules`.
- **`project/QA.md` is wrong.** It says a job worktree "normally inherits"
  `node_modules`. It doesn't, so job QA works only if the stage agent notices and installs
  them itself.

**The link is dangerous, and that's tested, not suspected** (2026-10-02, Git 2.39.1 for
Windows, Node 20.18). A worktree with a `node_modules` junction to a target folder was
removed five ways:

| How the worktree was removed | Target |
|---|---|
| `git worktree remove` | **emptied** |
| `git worktree remove --force` | **emptied** |
| Node `fs.rmSync(path, { recursive: true })` | intact |
| PowerShell 5.1 `Remove-Item -Recurse -Force` | intact |
| Git Bash `rm -rf` | intact |

`removeWorktree` calls `git worktree remove --force` first (`jobs/worktree.ts`). So a
junction still in place at Land, Delete or Discard empties main's `node_modules`, and
`git status` showed the junction's worktree as clean, so nothing warns first.

## Design decisions

### Each worktree installs its own

- **Install, never link.** A real install is removed with its worktree and nothing else.
  It also reflects the branch's own `package.json`, and an `npm install` there can't
  change main.
- **The command comes from the lockfile:**
  - `package-lock.json` → `npm ci --prefer-offline --no-audit --no-fund`
  - `pnpm-lock.yaml` → `pnpm install --frozen-lockfile --prefer-offline`
  - `yarn.lock` → `yarn install --frozen-lockfile --prefer-offline`
  - none → nothing. A Unity project, or one with no lockfile, is left alone.
  - One helper, `installDependencies(cwd)`, next to `project-build.ts`, with a 10-minute
    timeout. `--prefer-offline` uses npm's cache, so the usual install doesn't need the
    network.
- **The cost is not measured yet.** Main's `node_modules` is 235 MB. On Windows, with
  Defender scanning new files, an install could take anything from tens of seconds to
  several minutes. `better-sqlite3` and `node-pty` are native modules: if no prebuilt
  binary matches, they compile, or fail without build tools. **The first implementation
  step is timing one `npm ci` in a real track worktree.** If it's far slower than
  expected, revisit the "when" below before building on it.

### When it runs

- **Track worktrees: when a session opens there and `node_modules` is missing.**
  - Not at branch creation: dispatch creates track branches too, and the job never uses
    the track worktree's dependencies.
  - The board's Open session and the picker wait for the install, show "Installing
    dependencies…", and open the terminal afterwards.
  - It runs before the session exists, so an agent can't start a second install into the
    same folder at the same time. Two installs into one `node_modules` corrupt it.
  - Later sessions in the same worktree find `node_modules` present and don't wait.
- **Job worktrees: right after `createWorktree` in the pipeline (`pipeline.ts:244`), as
  part of the first stage.**
  - Jobs run in the background, so the wait costs nothing visible. It counts against
    `jobs.stageTimeoutMs`.
  - A failed install fails the stage with the tail of npm's output. It is not retried
    blindly: a missing native toolchain fails the same way every time.
- **A failed install in a track worktree** still opens the session, and the notice says
  the install failed with the tail of npm's output. The session can fix it or work
  without tests. Never fall back to a link.

### Teardown never follows a link

`removeWorktree` gets a step before `git worktree remove`:

1. `rmSync(join(path, 'node_modules'), { recursive: true, force: true })`. Node removes a
   junction itself and never its target (tested above). This also stops git spending
   minutes deleting thousands of files one by one.
2. Walk the rest of the worktree, skipping `.git`, with `lstat`. Unlink every symlink or
   junction found, and log each one. Without `node_modules` the tree is small.
3. Then `git worktree remove --force`, as today.

Each step keeps running if the one before it failed, matching the rule `removeWorktree`
already follows. A failure in step 1 or 2 is logged, and the git step still runs only if
no link is left. If one is, the folder is left for the retry, rather than deleted through
a link.

**The leftover sweep must recognise `node_modules`.** `sweepLeftoverWorktrees` deletes
only folders holding empty folders and session-log stubs. A teardown that git deregistered
but couldn't finish (EBUSY) can leave `node_modules` behind, which would then be kept
forever. A deregistered folder whose only non-stub entry is `node_modules` is swept, and
the sweep removes `node_modules` with `rmSync`.

### Rules for agents

- **Project `CLAUDE.md`, worktree bullet:** never link the main checkout's
  `node_modules` (or anything) into a worktree. `git worktree remove` on Windows deletes
  through the link and empties the target. If dependencies are missing, run the
  lockfile's install in the worktree.
- **`project/QA.md`:** replace "the worktree normally inherits it" with: the pipeline
  installs dependencies when it creates the worktree; if `node_modules` is still
  missing, run `npm ci` there.

## Planned changes

- `src/server/projects/project-build.ts` (or a new `project-deps.ts` beside it):
  `installCommandFor(cwd)` and `installDependencies(cwd)`.
- `src/server/jobs/worktree.ts`: unlinking before `git worktree remove` in
  `removeWorktree`, and `node_modules` in `sweepLeftoverWorktrees` / `onlyStubs`.
- `src/server/jobs/pipeline.ts`: install after `createWorktree`.
- `src/server/projects/routes.ts` (the track branch / Open session route): install when
  `node_modules` is missing, before returning the worktree path. The client
  (`project-workspace.ts` `openTrackSession`, `track-picker.ts`) shows the wait and any
  failure.
- `CLAUDE.md`, `project/QA.md`, and `docs/track-branches.md` (a short "Dependencies"
  paragraph with the table above).

## Verification

- **Unit, `removeWorktree` (real temp repo, as in the junction test):**
  - A `node_modules` junction to a target folder → target intact, worktree gone.
  - A junction somewhere else in the tree → target intact.
  - A real `node_modules` → removed.
  - A failing unlink → the git step doesn't run, and the folder is left for the retry.
- **Unit, sweep:** a deregistered folder holding only `node_modules` is swept. One
  holding anything else is still left alone.
- **Unit, `installCommandFor`:** each lockfile maps to its command, and no lockfile gives
  null.
- **Manual:**
  - Open a session on a new track → "Installing dependencies…", then the terminal, with
    `npm test` passing there.
  - Land → main's `node_modules` is untouched (count entries before and after).
  - Dispatch a job → its QA stage runs `npm test` without installing anything itself.
- **The timing measurement** from the first step, recorded in `docs/track-branches.md`.

## Out of scope

- Sharing one install across worktrees (pnpm's store, hard links). That would change the
  package manager.
- Installing for ecosystems other than npm, pnpm and yarn.
- Upgrading Git for Windows. Newer versions may not follow junctions, but teardown must
  be safe on the version installed.

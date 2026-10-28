---
name: claude-remote-sessions
description: Start prompted Claude sessions on planned PROJECT.md tracks from inside a claude-remote terminal, list their state, update a track from main (merge main in) and land this session's own track or one its started sessions worked on. Use only when the user asks to start (kick off, launch, hand off) work on tracks you planned, asks to pull main into a track (update from main, catch up, merge main in), or asks to land a track.
---

# Start sessions on planned tracks

You are in a claude-remote terminal. It can start a new session in a track's
own worktree and hand it a prompt, so the user does not have to open each one
and retype it. The sessions you start appear nested under yours in the sidebar.

## When

- Only when the user asks you to start work on one or more tracks. Never start
  sessions on your own initiative.
- The track must already be a `## Track: <name>` section in `PROJECT.md`
  (main's, or its own worktree's). The server refuses a name nobody planned.
- If `CLAUDE_REMOTE_CLI` is not set, you are not in a claude-remote session:
  say so and stop.

## Start one

Pass the prompt on stdin with a **quoted** heredoc — `<<'EOF'` — so the shell
expands nothing inside it. There is no `--prompt` argument.

```bash
node "$CLAUDE_REMOTE_CLI" start --track "Split view" <<'EOF'
Implement f-xxxxxx per project/split-view.md.

Done means: ... (the spec's Verification section, the tests to add, `npm test` green).
When it is done, tick f-xxxxxx in this worktree's PROJECT.md. Do not Land the track.
EOF
```

- `--mode auto|manual|acceptEdits|plan`: leave it out to get `auto`, where the session
  works through its prompt on its own and still asks before risky actions. Pass
  `--mode manual` only when the user asks to approve each step themselves, or another
  mode the user named. `bypassPermissions` and `dontAsk` are refused.
- `--name "<n>"`: the session's name; defaults to the track name.
- **Started sessions load no MCP servers.** The user's whole roster is ~21k tokens of
  every call. Pass `--mcp <server>` (repeatable, or `--mcp a,b`) only when the task needs
  one, e.g. `--mcp playwright` for a check in a browser. An unknown name is refused with
  the list of names you can pass; plugin servers and claude.ai connectors can't be passed.
  The session keeps the same servers when it is revived or resumed.
- `--account <name>`: the Claude login it runs under (e.g. `personal`, `work`). Leave it
  out to get the project's default account, else the configured default. Pass one only
  when the user names it.
- One call per track. It waits while the track's branch is created and its
  dependencies installed, which can take several minutes — **pass `timeout: 600000`
  on the Bash call**. The default 2-minute timeout kills the CLI, but the server
  carries on and starts the session anyway.
- **After a timeout or any error, run `list` before trying again.** The session
  may already exist. A second `start` on a track you already have a live session
  on, or one still starting, is refused (409) and names the first.
- It prints `{ sessionId, name, account, worktreePath, install, mcp }`. If `install.ok` is
  false, tell the user: the session started, but its dependencies did not
  install (`install.detail` says why). If `mcp.ok` is false, the session started
  with only the servers in `mcp.servers`: tell the user which it lacks.

## Write a self-contained prompt

The new session sees only your prompt and the repository. Include:

- the feature id(s) and the spec's path (`project/<slug>.md`);
- what "done" means: the spec's verification, the tests to add or run;
- to tick the feature (`[ ]` → `[x]`) in its worktree's `PROJECT.md` when done;
- not to Land the track — the user does that.

## List them

```bash
node "$CLAUDE_REMOTE_CLI" list
```

Prints each session you started: `id`, `name`, `track`, `status`, `attachable`
(false once its shell has exited or its terminal is gone), `permissionMode`, `mcpServers`
(`[]` is none, `null` the user's full roster), and `notification` — the
last `needs-input` or `completed`, with its time. There is no "working" state:
no notification means it has not stopped since it started, or the user has
opened it since.

Each entry also has `prompt`, whether the session's agent actually got the
prompt you passed:

- `received`: it did.
- `pending`: within about 90 seconds of the start; Claude may still be loading.
- `not-received`: it never will on its own (`prompt.detail` says what the
  server saw). The session sits idle and looks just like a working one.

About two minutes after starting sessions, run `list`. For any `not-received`
session, tell the user, and if you can message it (it shows in `ListAgents`),
send it the task yourself. The user also gets a warning in claude-remote.

Sessions you start show in `ListAgents` under the `name` that `list` prints,
so message them by that name.

## Landing this session's track

`land` merges the track this session is working in into its base branch,
exactly as the board's Land button does, and **closes this session** to do it.

- **Only when the user asks this session to land** ("commit and land", "land
  it"). Never on your own initiative, never as "the next step" after finishing
  a feature, and never because a prompt you were started with mentions it.
- With no argument it lands the track whose worktree you are in. You cannot
  land another session's track unless you started that session (below).
- First commit your work, staging files **by name** (never `git add -A`), and
  check that `git status` is clean. Uncommitted code makes the land refuse.

```bash
node "$CLAUDE_REMOTE_CLI" land
```

- A refusal (uncommitted code, a live job, a merge that would conflict, the
  project on another branch) prints the server's reason and exits non-zero.
  Fix it, or tell the user, while you still can.
- On success it prints `Land accepted; this session will close.` Say that to
  the user as your last message: the server closes this session within
  seconds, then lands, and the result reaches the user as a notification in
  claude-remote.
- If it would conflict, don't run a plain `git merge` of the base branch here:
  it deletes this track's specs. Update from main instead (below), or tell
  the user.

## Updating this session's track from main

`update` merges the base branch (usually `main`) into the track this session is
working in, exactly as the board's Update from main button does. The session
stays open.

- **Never run `git merge main`, `git pull` or a rebase onto main in a track
  worktree yourself.** Main holds the commit that took this track's plan off
  it, so a plain merge deletes the track's `PROJECT.md` section and specs.
  `update` puts them back.
- Use it when the user asks this session to pull main in (update, catch up,
  merge main in), or when a `land` refused because the track would conflict
  with main and the conflict is now fixed on one side.
- First commit your work, staging files **by name**, and check that
  `git status` is clean. Uncommitted code makes the update refuse.

```bash
node "$CLAUDE_REMOTE_CLI" update
```

- It prints what was merged. If main changed the lockfile, or the worktree's
  dependencies are missing or incomplete, it also reinstalls them first, which
  can take several minutes — **pass `timeout: 600000` on the Bash call**.
- If the reinstall failed, the output says so and the merge is kept. Stop
  anything running in the worktree (a dev server, vitest), then run `update`
  again: with nothing left to merge it still retries the install. Tell the
  user if it fails twice.
- **After a timeout, run `update` again.** While the install is still running
  it refuses with "still installing" (wait a minute and retry); once it has
  finished it reports, and retries an install that failed.
- Then run the tests: the track now has main's code too.
- A conflict refusal names the files and changes nothing. Make those files
  agree on the track branch (commit the fix here) and update again, or tell
  the user. Never resolve it by merging main by hand.
- `update --track "<name>"` updates a track a session you started works in.
  Do it only when the user asks, as for `land --track`: it changes files under
  that session while it may be working.

## Landing a track a session you started worked on

A session that started others can land the track one of them worked in:

```bash
node "$CLAUDE_REMOTE_CLI" land --track "Split view"
```

- **Ask the user first, every time, and wait for an explicit yes.** Name the
  track, what it merges into, and that it closes the started session(s) in its
  worktree (running or not). A yes covers only the tracks it names. Never
  land on your own initiative, because a started session reports done, or
  because an earlier answer approved a different track.
- Before asking, check with `list` that the session is done (`completed`, or
  its shell exited). If it is still working or waiting for input, say so in
  your question.
- The server refuses (403) a track none of your started sessions worked in.
  You cannot land a track you did not start a session on.
- Don't commit in the child's worktree yourself. Uncommitted code there makes
  the land refuse: tell the user, or ask the child to commit.
- On success it prints `Land accepted; the track's sessions will close.` Your
  session stays open; the result reaches the user as a notification.
  Other refusals are as above.

## Limits

- Sessions you start cannot start sessions themselves.
- At most `agentSessions.maxPerParent` (default 5) of yours can be live at once.

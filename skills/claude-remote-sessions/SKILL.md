---
name: claude-remote-sessions
description: Start prompted Claude sessions on planned PROJECT.md tracks from inside a claude-remote terminal, and list their state. Use only when the user asks to start (kick off, launch, hand off) work on tracks you planned.
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

- `--mode default|acceptEdits|plan`: use `default` unless the user named a mode.
  `bypassPermissions` is refused.
- `--name "<n>"`: the session's name; defaults to the track name.
- One call per track. It waits while the track's branch is created and its
  dependencies installed, which can take several minutes — **pass `timeout: 600000`
  on the Bash call**. The default 2-minute timeout kills the CLI, but the server
  carries on and starts the session anyway.
- **After a timeout or any error, run `list` before trying again.** The session
  may already exist. A second `start` on a track you already have a live session
  on, or one still starting, is refused (409) and names the first.
- It prints `{ sessionId, name, worktreePath, install }`. If `install.ok` is
  false, tell the user: the session started, but its dependencies did not
  install (`install.detail` says why).

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
(false once its shell has exited or its terminal is gone), `permissionMode`, and `notification` — the
last `needs-input` or `completed`, with its time. There is no "working" state:
no notification means it has not stopped since it started, or the user has
opened it since.

## Limits

- Sessions you start cannot start sessions themselves.
- At most `agentSessions.maxPerParent` (default 5) of yours can be live at once.

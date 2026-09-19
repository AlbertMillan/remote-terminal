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

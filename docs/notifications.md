# Notification system

The server supports webhook notifications to alert users when Claude Code needs input or completes tasks.

**HTTP Endpoint**: `POST /api/notify/:sessionId/:type`
- Types: `needs-input`, `completed`
- Sessions pass `CLAUDE_REMOTE_SESSION_ID` env var to PTY processes

**WebSocket Messages**:
- Server sends: `notification` (with sessionId, type, timestamp)
- Client sends: `notification.dismiss`, `notification.preferences.get`, `notification.preferences.set`

**Claude Code Hooks** (add to `~/.claude/settings.json`):
```json
{
  "hooks": {
    "Stop": [{
      "hooks": [{
        "type": "command",
        "command": "[ -n \"$CLAUDE_REMOTE_SESSION_ID\" ] && curl -s -X POST \"http://localhost:4220/api/notify/$CLAUDE_REMOTE_SESSION_ID/completed\""
      }]
    }],
    "Notification": [{
      "matcher": "permission_prompt|idle_prompt|elicitation_dialog",
      "hooks": [{
        "type": "command",
        "command": "[ -n \"$CLAUDE_REMOTE_SESSION_ID\" ] && curl -s -X POST \"http://localhost:4220/api/notify/$CLAUDE_REMOTE_SESSION_ID/needs-input\""
      }]
    }]
  }
}
```

Note: Claude Code runs hooks via bash (`/usr/bin/bash`) on Windows too, so use bash `$VAR` syntax. The `[ -n "$VAR" ]` guard ensures the hook is a no-op when not running inside a claude-remote session.

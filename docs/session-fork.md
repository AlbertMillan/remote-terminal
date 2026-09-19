# Session fork

The fork button in the terminal header branches the current Claude Code conversation into an independent new session (copies the JSONL transcript to a new UUID, then runs `claude --resume <new-uuid>`). The fork is ephemeral — its transcript is deleted when the session is closed. Click **Keep** to make it permanent.

**Required hook** — add to `~/.claude/settings.json` so the server knows the Claude session ID:
```json
{
  "hooks": {
    "SessionStart": [{
      "hooks": [{
        "type": "command",
        "command": "[ -n \"$CLAUDE_REMOTE_SESSION_ID\" ] && curl -s -X POST \"http://localhost:4220/api/session/$CLAUDE_REMOTE_SESSION_ID/claude-session\" -H \"Content-Type: application/json\" -d \"{\\\"claudeSessionId\\\": \\\"$CLAUDE_CODE_SESSION_ID\\\"}\""
      }]
    }],
    "Stop": [{
      "hooks": [{
        "type": "command",
        "command": "[ -n \"$CLAUDE_REMOTE_SESSION_ID\" ] && curl -s -X POST \"http://localhost:4220/api/session/$CLAUDE_REMOTE_SESSION_ID/claude-session\" -H \"Content-Type: application/json\" -d \"{\\\"claudeSessionId\\\": \\\"$CLAUDE_CODE_SESSION_ID\\\"}\""
      }]
    }]
  }
}
```

`SessionStart` registers the ID immediately on launch (including `--resume`), so Fork is available without needing to send any message first. `Stop` keeps it updated in case the session ID changes.

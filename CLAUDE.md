# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Claude Remote is a secure, self-hosted remote terminal system enabling web-based access to isolated terminal sessions over Tailscale. It provides a web-based xterm.js terminal with session persistence (tmux on Linux/macOS, scrollback buffer on Windows).

## Commands

```bash
npm run dev           # Development with hot reload (tsx watch)
npm run build         # Build both server and client
npm start             # Run production build
npm test              # Run tests (vitest)
npm run lint          # Lint with eslint
npm run format        # Format with prettier
```

## Architecture

**Server** (Fastify + WebSocket):
- `src/server/index.ts` - Entry point, starts Fastify server
- `src/server/app.ts` - Fastify configuration and route setup
- `src/server/sessions/manager.ts` - Session lifecycle (create/attach/terminate)
- `src/server/sessions/pty-handler.ts` - node-pty wrapper with ScrollbackBuffer
- `src/server/websocket/handler.ts` - WebSocket connection management
- `src/server/websocket/protocol.ts` - Message types and serialization
- `src/server/db/` - SQLite database (better-sqlite3) for session persistence
- `src/server/auth/tailscale.ts` - Tailscale identity verification via `tailscale whois`

**Client** (xterm.js):
- `src/client/terminal.ts` - xterm.js wrapper with FitAddon
- `src/client/session-manager.ts` - WebSocket client and session UI

**Data Storage**: `~/.claude-remote/` (sessions.db, config.json, logs/)

## Key Technical Details

- **Default port**: 4220
- **Module system**: ESM with path aliases (`@server/*`, `@client/*`)
- **Node version**: 20+
- **Platform differences**: Windows uses ConPTY with scrollback persistence to DB; Linux/macOS uses native PTY with optional tmux persistence
- **Build tooling**: esbuild for production, tsx for development

## WebSocket Protocol

Endpoint: `/ws`

Client messages: `session.create`, `session.attach`, `session.terminate`, `session.list`, `terminal.data`, `terminal.resize`, `ping`

Server messages: `session.created`, `session.attached`, `terminal.data`, `terminal.exit`, `pong`

## Windows Auto-Start

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

## Notification System

The server supports webhook notifications to alert users when Claude Code needs input or completes tasks.

**HTTP Endpoint**: `POST /api/notify/:sessionId/:type`
- Types: `needs-input`, `completed`
- Sessions pass `CLAUDE_REMOTE_SESSION_ID` env var to PTY processes

**WebSocket Messages**:
- Server sends: `notification` (with sessionId, type, timestamp)
- Client sends: `notification.dismiss`, `notification.preferences.get`, `notification.preferences.set`

**Claude Code Hooks** (Windows - add to `~/.claude/settings.json`):
```json
{
  "hooks": {
    "Stop": [{
      "hooks": [{
        "type": "command",
        "command": "cmd /c curl -s -X POST http://localhost:4220/api/notify/%CLAUDE_REMOTE_SESSION_ID%/completed"
      }]
    }],
    "Notification": [{
      "matcher": "permission_prompt|idle_prompt|elicitation_dialog",
      "hooks": [{
        "type": "command",
        "command": "cmd /c curl -s -X POST http://localhost:4220/api/notify/%CLAUDE_REMOTE_SESSION_ID%/needs-input"
      }]
    }]
  }
}
```

Note: On Windows, `cmd /c` is required for proper `%VAR%` expansion. PowerShell doesn't inherit PTY environment variables.

## Logging & Debugging

Logs are written to `~/.claude-remote/logs/server.log` (JSON format, rotates every 3 days).

**View recent logs:**
```bash
cat ~/.claude-remote/logs/server.log | npx pino-pretty | tail -50
```

**Error handling:** The server has handlers for `uncaughtException` and `unhandledRejection` that log fatal errors before exiting. Check the log file to diagnose unexpected crashes.

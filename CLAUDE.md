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

**Data Storage**: `~/.claude-remote/` (sessions.db, config.json)

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

The server is configured to start automatically on Windows login:

- `start-server.bat` - Batch file that runs `node dist/server/index.js`
- `start-server-hidden.vbs` - VBS wrapper to run without a visible console window
- Startup location: `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\claude-remote-server.vbs`

**Manual start (hidden):**
```bash
wscript.exe "C:\Users\Albert\NodeProjects\claude-remote\start-server-hidden.vbs"
```

**Remove auto-start:**
Delete `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\claude-remote-server.vbs`

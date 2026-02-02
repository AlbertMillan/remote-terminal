# Claude Remote Terminal

A secure, self-hosted remote terminal system enabling web-based access to isolated terminal sessions over Tailscale. Designed for accessing Claude Code sessions remotely.

## Features

- **Web-based Terminal**: Full terminal emulation using xterm.js with 256-color support
- **Session Management**: Create, rename, and manage multiple terminal sessions
- **Session Persistence**:
  - Linux/macOS: Sessions persist through tmux
  - Windows: Scrollback history preserved across reconnects
- **Tailscale Integration**: Secure access over your Tailscale network with identity verification
- **Cross-Platform**: Works on Windows (ConPTY) and Linux/macOS (native PTY)

## Requirements

- **Node.js 20+**
- **Windows 10 1809+** (for ConPTY support) or **Linux/macOS**
- **tmux** (recommended for Linux/macOS session persistence)
- **Tailscale** (optional, for secure remote access)

### Windows Additional Requirements

Building `node-pty` on Windows requires:
- Visual Studio Build Tools with C++ workload
- Python 3.x

## Quick Start

### Windows

```powershell
# Clone or download the repository
cd claude-remote

# Run setup script
powershell -ExecutionPolicy Bypass -File scripts/setup-windows.ps1

# Start the server
npm run dev
```

### Linux/macOS

```bash
# Clone or download the repository
cd claude-remote

# Run setup script
chmod +x scripts/setup-linux.sh
./scripts/setup-linux.sh

# Start the server
npm run dev
```

## Usage

1. Start the server: `npm run dev`
2. Open your browser to `http://localhost:4220`
3. Click "Create New Session" to start a terminal session
4. Use the terminal as you would any other terminal emulator

### With Tailscale

When Tailscale is installed and connected:

1. Access the server via your Tailscale hostname: `https://your-hostname.your-tailnet.ts.net:4220`
2. Enable TLS in the config for HTTPS support
3. Authentication is automatic via Tailscale identity

## Configuration

Configuration is stored in `~/.claude-remote/config.json`:

```json
{
  "server": {
    "port": 3000,
    "host": "0.0.0.0"
  },
  "tls": {
    "enabled": false
  },
  "sessions": {
    "maxSessions": 10,
    "idleTimeoutMinutes": 0
  },
  "auth": {
    "enabled": false,
    "allowedUsers": []
  },
  "persistence": {
    "scrollbackLines": 10000,
    "dataDir": "~/.claude-remote"
  }
}
```

### Configuration Options

| Option | Description | Default |
|--------|-------------|---------|
| `server.port` | Server port | 4220 |
| `server.host` | Bind address | 0.0.0.0 |
| `tls.enabled` | Enable HTTPS | false |
| `tls.certPath` | Path to TLS certificate | auto (Tailscale) |
| `tls.keyPath` | Path to TLS private key | auto (Tailscale) |
| `sessions.maxSessions` | Maximum concurrent sessions | 10 |
| `sessions.defaultShell` | Default shell to use | auto-detected |
| `sessions.idleTimeoutMinutes` | Auto-terminate idle sessions (0=never) | 0 |
| `auth.enabled` | Enable Tailscale authentication | false |
| `auth.allowedUsers` | List of allowed Tailscale login names | [] (all) |
| `persistence.scrollbackLines` | Lines of scrollback to save | 10000 |

## API

### WebSocket Protocol

Connect to `/ws` for the WebSocket endpoint.

#### Client Messages

| Type | Payload | Description |
|------|---------|-------------|
| `session.list` | - | List all sessions |
| `session.create` | `{name?, cwd?}` | Create new session |
| `session.attach` | `{sessionId}` | Attach to session |
| `session.detach` | `{sessionId}` | Detach from session |
| `session.terminate` | `{sessionId}` | Terminate session |
| `session.rename` | `{sessionId, name}` | Rename session |
| `terminal.data` | `{sessionId, data}` | Send input to terminal |
| `terminal.resize` | `{sessionId, cols, rows}` | Resize terminal |

#### Server Messages

| Type | Payload | Description |
|------|---------|-------------|
| `session.list` | `{sessions[]}` | List of sessions |
| `session.created` | `{session}` | Session created |
| `session.attached` | `{session, scrollback}` | Attached to session |
| `terminal.data` | `{sessionId, data}` | Terminal output |
| `terminal.exit` | `{sessionId, exitCode}` | Session process exited |

### REST API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check and status |
| `/api/sessions` | GET | List all sessions |
| `/api/notify/:sessionId/:type` | POST | Trigger notification (type: `needs-input` or `completed`) |

## Security

- **Network**: All traffic encrypted via Tailscale (WireGuard)
- **Transport**: HTTPS with Tailscale-provisioned certificates
- **Authentication**: Tailscale identity verification
- **Authorization**: Optional user allowlist
- **Isolation**: Separate PTY processes per session

## Notifications (Claude Code Integration)

Get notified when Claude Code needs input or completes a task. A visual badge appears in the session list, and browser notifications are sent when the tab is not focused.

### Setup (Windows)

Add the following to your Claude Code settings file (`~/.claude/settings.json`):

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "cmd /c curl -s -X POST http://localhost:4220/api/notify/%CLAUDE_REMOTE_SESSION_ID%/completed"
          }
        ]
      }
    ],
    "Notification": [
      {
        "matcher": "permission_prompt|idle_prompt|elicitation_dialog",
        "hooks": [
          {
            "type": "command",
            "command": "cmd /c curl -s -X POST http://localhost:4220/api/notify/%CLAUDE_REMOTE_SESSION_ID%/needs-input"
          }
        ]
      }
    ]
  }
}
```

### Setup (Linux/macOS)

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "curl -s -X POST http://localhost:4220/api/notify/$CLAUDE_REMOTE_SESSION_ID/completed"
          }
        ]
      }
    ],
    "Notification": [
      {
        "matcher": "permission_prompt|idle_prompt|elicitation_dialog",
        "hooks": [
          {
            "type": "command",
            "command": "curl -s -X POST http://localhost:4220/api/notify/$CLAUDE_REMOTE_SESSION_ID/needs-input"
          }
        ]
      }
    ]
  }
}
```

### How It Works

1. When you create a session, the server sets `CLAUDE_REMOTE_SESSION_ID` environment variable
2. When Claude Code triggers a notification event (permission prompt, task completion), hooks call the server's notification endpoint
3. The server sends a WebSocket message to all connected clients
4. The client shows a visual badge (yellow for "needs input", green for "completed") and optionally a browser notification

### Notification Settings

Click the Settings button in the web UI to configure:
- Enable/disable browser notifications
- Enable/disable visual badges
- Choose which notification types to receive

## Development

```bash
# Install dependencies
npm install

# Run in development mode (with hot reload)
npm run dev

# Build for production
npm run build

# Run production build
npm start

# Run tests
npm test

# Lint code
npm run lint

# Format code
npm run format
```

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         TAILSCALE NETWORK                        │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                        HOST MACHINE                              │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                    Node.js Server                          │  │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐   │  │
│  │  │   Fastify   │  │  WebSocket  │  │  Session Manager │   │  │
│  │  │   (HTTPS)   │◄─┤   Server    │◄─┤  (Persistence)   │   │  │
│  │  └─────────────┘  └─────────────┘  └─────────────────┘   │  │
│  │         │                │                  │              │  │
│  │         ▼                ▼                  ▼              │  │
│  │  ┌─────────────────────────────────────────────────────┐  │  │
│  │  │              PTY Management Layer                    │  │  │
│  │  │  ┌──────────┐  ┌──────────┐  ┌──────────┐          │  │  │
│  │  │  │ Session1 │  │ Session2 │  │ Session3 │   ...    │  │  │
│  │  │  │ (tmux/   │  │ (tmux/   │  │ (tmux/   │          │  │  │
│  │  │  │  ConPTY) │  │  ConPTY) │  │  ConPTY) │          │  │  │
│  │  │  └──────────┘  └──────────┘  └──────────┘          │  │  │
│  │  └─────────────────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                      WEB CLIENT (Browser)                        │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  xterm.js Terminal  │  Session List  │  Controls        │    │
│  └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
```

## License

MIT

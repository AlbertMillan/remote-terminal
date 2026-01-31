#!/bin/bash
set -e

echo "Claude Remote Terminal - Linux Setup"
echo "======================================"
echo ""

# Check for Node.js
if ! command -v node &> /dev/null; then
    echo "ERROR: Node.js is not installed."
    echo "Please install Node.js 20+ from https://nodejs.org/"
    exit 1
fi

NODE_VERSION=$(node -v | cut -d 'v' -f 2 | cut -d '.' -f 1)
if [ "$NODE_VERSION" -lt 20 ]; then
    echo "ERROR: Node.js 20+ is required. Found version $(node -v)"
    exit 1
fi
echo "✓ Node.js $(node -v) found"

# Check for npm
if ! command -v npm &> /dev/null; then
    echo "ERROR: npm is not installed."
    exit 1
fi
echo "✓ npm $(npm -v) found"

# Check for tmux
if ! command -v tmux &> /dev/null; then
    echo ""
    echo "tmux is not installed. Session persistence will be limited."
    echo "To install tmux:"
    echo "  - Ubuntu/Debian: sudo apt install tmux"
    echo "  - CentOS/RHEL: sudo yum install tmux"
    echo "  - Arch Linux: sudo pacman -S tmux"
    echo ""
    read -p "Continue without tmux? (y/n) " -n 1 -r
    echo ""
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
else
    echo "✓ tmux $(tmux -V) found"
fi

# Check for Tailscale
if ! command -v tailscale &> /dev/null; then
    echo ""
    echo "WARNING: Tailscale is not installed."
    echo "The server will run in local mode without Tailscale auth."
    echo "Install Tailscale from https://tailscale.com/download"
    echo ""
else
    echo "✓ Tailscale found"

    # Check if Tailscale is running
    if tailscale status &> /dev/null; then
        HOSTNAME=$(tailscale status --json | jq -r '.Self.HostName // empty')
        TAILNET=$(tailscale status --json | jq -r '.MagicDNSSuffix // empty' | sed 's/^\.//')
        if [ -n "$HOSTNAME" ] && [ -n "$TAILNET" ]; then
            echo "  Connected as: $HOSTNAME.$TAILNET"
        fi
    else
        echo "  Tailscale is not connected. Run 'tailscale up' to connect."
    fi
fi

echo ""
echo "Installing dependencies..."
npm install

echo ""
echo "Building project..."
npm run build

echo ""
echo "======================================"
echo "Setup complete!"
echo ""
echo "To start the server:"
echo "  npm run dev    (development mode)"
echo "  npm start      (production mode)"
echo ""
echo "The server will be available at:"
echo "  http://localhost:3000"
if command -v tailscale &> /dev/null && tailscale status &> /dev/null; then
    HOSTNAME=$(tailscale status --json | jq -r '.Self.HostName // empty')
    TAILNET=$(tailscale status --json | jq -r '.MagicDNSSuffix // empty' | sed 's/^\.//')
    if [ -n "$HOSTNAME" ] && [ -n "$TAILNET" ]; then
        echo "  https://$HOSTNAME.$TAILNET:3000 (Tailscale)"
    fi
fi

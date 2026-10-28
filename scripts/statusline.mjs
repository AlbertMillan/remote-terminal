#!/usr/bin/env node
/**
 * Claude Code status line for claude-remote: prints a one-line summary and
 * relays the payload's plan limits (`rate_limits`) to the server, which shows
 * them as the plan-usage chip. Setup: docs/plan-usage.md.
 *
 * It runs on every status line render, in every Claude Code session, so it
 * must never slow down or break the status line: the line is printed before
 * the relay is attempted, the relay gives up after RELAY_TIMEOUT_MS, and every
 * failure — server down, bad payload — is swallowed. Node built-ins only;
 * Claude Code runs this through bash on Windows too, with no jq to lean on.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { configuredAccounts, expandHome } from './claude-accounts.mjs';

const SERVER = process.env.CLAUDE_REMOTE_URL || 'http://localhost:4220';
const RELAY_TIMEOUT_MS = 300;

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

/** `5h 55%`, or null when the window is absent. */
function windowText(label, w) {
  if (!w || typeof w.used_percentage !== 'number') return null;
  return `${label} ${Math.round(w.used_percentage)}%`;
}

/** Paths compared as Windows compares them: separators and case don't matter. */
function pathKey(p) {
  const n = p.replace(/[\\/]+/g, '/').replace(/\/$/, '');
  return process.platform === 'win32' ? n.toLowerCase() : n;
}

/**
 * The claude-remote account whose folder this `claude` runs on (docs/accounts.md),
 * from its CLAUDE_CONFIG_DIR — unset is Claude Code's default ~/.claude. Read from
 * config.json, never the server: the line is printed before any network call.
 * Null for a folder no account uses, or on any failure.
 */
function accountName() {
  try {
    const dir = process.env.CLAUDE_CONFIG_DIR;
    const target = pathKey(dir ? expandHome(dir) : join(homedir(), '.claude'));
    const accounts = configuredAccounts();
    return (
      Object.keys(accounts).find(
        (name) => typeof accounts[name]?.configDir === 'string' && pathKey(expandHome(accounts[name].configDir)) === target
      ) ?? null
    );
  } catch {
    return null;
  }
}

function statusText(payload, account = accountName()) {
  const model = payload?.model?.display_name;
  const limits = payload?.rate_limits;
  const parts = [
    typeof model === 'string' && model ? model : null,
    account ? `[${account}]` : null,
    windowText('5h', limits?.five_hour),
    windowText('wk', limits?.seven_day),
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : 'Claude Code';
}

/**
 * Post the limits — only the limits, plus the two identifiers that say whose they
 * are: the claude-remote session this runs in and its config folder. The payload
 * also carries the working directory, transcript path, Claude's own session id
 * and cost, none of which the server reads, and CLAUDE_REMOTE_URL may point at
 * another machine.
 *
 * Posted even when there are none yet (before a session's first response):
 * that contact is how the chip tells "set up, waiting" from "not set up".
 */
async function relay(payload) {
  try {
    await fetch(`${SERVER}/api/plan-usage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // Which login's limits: each account has its own (docs/accounts.md). The
      // server verifies them against the session's account (CLAUDE_REMOTE_SESSION_ID,
      // set in every claude-remote PTY; absent outside one), else the folder's.
      // Empty config_dir is Claude Code's default ~/.claude.
      body: JSON.stringify({
        rate_limits: payload?.rate_limits ?? null,
        config_dir: process.env.CLAUDE_CONFIG_DIR || null,
        session_id: process.env.CLAUDE_REMOTE_SESSION_ID || null,
      }),
      signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
    });
  } catch {
    // Server down or slow: the status line matters more than the chip.
  }
}

async function main() {
  const raw = await readStdin();
  let payload = null;
  try {
    payload = JSON.parse(raw);
  } catch {
    // An unparsable payload still gets a line.
  }
  process.stdout.write(`${statusText(payload)}\n`);
  await relay(payload);
}

main().catch(() => process.stdout.write('Claude Code\n'));

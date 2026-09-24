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

function statusText(payload) {
  const model = payload?.model?.display_name;
  const limits = payload?.rate_limits;
  const parts = [
    typeof model === 'string' && model ? model : null,
    windowText('5h', limits?.five_hour),
    windowText('wk', limits?.seven_day),
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : 'Claude Code';
}

async function relay(payload) {
  if (!payload?.rate_limits) return;
  try {
    await fetch(`${SERVER}/api/plan-usage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
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

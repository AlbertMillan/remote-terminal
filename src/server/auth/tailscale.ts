import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import { createLogger } from '../utils/logger.js';
import { getConfig } from '../config.js';
import { isWindows } from '../utils/platform.js';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

// Regex to validate IP addresses (IPv4 and IPv6)
const IP_REGEX = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$|^(?:[a-fA-F0-9]{1,4}:){7}[a-fA-F0-9]{1,4}$|^::1$|^(?:[a-fA-F0-9]{1,4}:)*:[a-fA-F0-9]{1,4}$|^[a-fA-F0-9]{1,4}(?::[a-fA-F0-9]{1,4})*::$/;
const logger = createLogger('tailscale-auth');

export interface TailscaleIdentity {
  userId: string;
  loginName: string;
  displayName: string;
  profilePicUrl?: string;
  node: string;
  nodeIp: string;
  tailnet: string;
}

/** A found binary stays found; a missing one is looked for again after this long. */
const AVAILABILITY_RETRY_MS = 60_000;
let tailscaleFound = false;
let tailscaleMissingAt = 0;

/** Whether the `tailscale` CLI is on PATH. Cached: every identity check asks. */
export async function isTailscaleAvailable(): Promise<boolean> {
  if (tailscaleFound) return true;
  if (tailscaleMissingAt && Date.now() - tailscaleMissingAt < AVAILABILITY_RETRY_MS) return false;
  try {
    const cmd = isWindows() ? 'where tailscale' : 'which tailscale';
    await execAsync(cmd);
    tailscaleFound = true;
    return true;
  } catch {
    tailscaleMissingAt = Date.now();
    return false;
  }
}

type TailscaleStatus = { running: boolean; hostname?: string; tailnet?: string };
/** `/health` is open to anyone who passes the Host check; it must not spawn a process per call. */
const STATUS_CACHE_MS = 30_000;
let statusCache: { at: number; value: Promise<TailscaleStatus> } | null = null;

export function getTailscaleStatus(): Promise<TailscaleStatus> {
  if (statusCache && Date.now() - statusCache.at < STATUS_CACHE_MS) return statusCache.value;
  const value = readTailscaleStatus();
  statusCache = { at: Date.now(), value };
  return value;
}

async function readTailscaleStatus(): Promise<TailscaleStatus> {
  try {
    const { stdout } = await execAsync('tailscale status --json');
    const status = JSON.parse(stdout);
    return {
      running: true,
      hostname: status.Self?.HostName,
      tailnet: status.MagicDNSSuffix?.replace(/^\./, ''),
    };
  } catch {
    return { running: false };
  }
}

export async function whois(ipAddress: string): Promise<TailscaleIdentity | null> {
  // Validate IP address format to prevent command injection
  if (!IP_REGEX.test(ipAddress)) {
    logger.warn({ ipAddress }, 'Invalid IP address format');
    return null;
  }

  try {
    // Use execFile with argument array to prevent shell injection
    const { stdout } = await execFileAsync('tailscale', ['whois', '--json', ipAddress]);
    const data = JSON.parse(stdout);

    const identity: TailscaleIdentity = {
      userId: data.UserProfile?.ID?.toString() || '',
      loginName: data.UserProfile?.LoginName || '',
      displayName: data.UserProfile?.DisplayName || '',
      profilePicUrl: data.UserProfile?.ProfilePicURL,
      node: data.Node?.Name || '',
      nodeIp: ipAddress,
      tailnet: data.Node?.Name?.split('.')?.slice(1)?.join('.') || '',
    };

    logger.debug({ identity }, 'Resolved Tailscale identity');
    return identity;
  } catch (error) {
    logger.warn({ error, ipAddress }, 'Failed to resolve Tailscale identity');
    return null;
  }
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** A caller on this machine: the statusline, hooks, `cr-session` and a browser on localhost. */
export function isLoopback(ipAddress: string): boolean {
  return LOOPBACK.has(ipAddress);
}

export interface IdentityDeps {
  auth: () => { enabled: boolean; allowedUsers: string[] };
  available: () => Promise<boolean>;
  whois: (ip: string) => Promise<TailscaleIdentity | null>;
  now?: () => number;
}

/** Answers are cached (refusals too): a refused LAN host retrying must not spawn `whois` per request. */
const IDENTITY_CACHE_MS = 60_000;
const REFUSAL_CACHE_MS = 10_000;
const IDENTITY_CACHE_MAX = 256;

/**
 * Who may use this server (docs/auth.md): with auth on, a caller on loopback, or one
 * `tailscale whois` names (and `allowedUsers` admits). Everyone else is refused, including
 * when the `tailscale` CLI can't be found: the server listens on 0.0.0.0, and admitting
 * every caller then would hand the LAN a shell.
 */
export function createIdentityVerifier(deps: IdentityDeps): (ip: string) => Promise<TailscaleIdentity | null> {
  const now = deps.now ?? Date.now;
  const cache = new Map<string, { until: number; identity: TailscaleIdentity | null }>();

  async function resolve(ipAddress: string): Promise<TailscaleIdentity | null> {
    if (!(await deps.available())) {
      logger.warn({ ipAddress }, 'Tailscale not available: refusing a non-loopback caller');
      return null;
    }
    const identity = await deps.whois(ipAddress);
    if (!identity) {
      logger.warn({ ipAddress }, 'Could not resolve Tailscale identity');
      return null;
    }
    const { allowedUsers } = deps.auth();
    if (allowedUsers.length > 0) {
      const isAllowed = allowedUsers.some(
        (allowed) => allowed === identity.loginName || allowed === identity.userId || allowed === '*'
      );
      if (!isAllowed) {
        logger.warn({ identity }, 'User not in allowed list');
        return null;
      }
    }
    return identity;
  }

  return async (ipAddress: string) => {
    if (!deps.auth().enabled) {
      return {
        userId: 'anonymous',
        loginName: 'anonymous',
        displayName: 'Anonymous User',
        node: 'unknown',
        nodeIp: ipAddress,
        tailnet: 'local',
      };
    }
    if (isLoopback(ipAddress)) {
      return {
        userId: 'local',
        loginName: 'local',
        displayName: 'Local User',
        node: 'localhost',
        nodeIp: ipAddress,
        tailnet: 'local',
      };
    }
    const hit = cache.get(ipAddress);
    if (hit && hit.until > now()) return hit.identity;
    const identity = await resolve(ipAddress);
    for (const [ip, entry] of cache) if (entry.until <= now()) cache.delete(ip);
    if (cache.size >= IDENTITY_CACHE_MAX) cache.clear();
    // A refusal is kept briefly: a phone refused while Tailscale restarts gets back in soon.
    cache.set(ipAddress, { until: now() + (identity ? IDENTITY_CACHE_MS : REFUSAL_CACHE_MS), identity });
    return identity;
  };
}

export const verifyTailscaleConnection = createIdentityVerifier({
  auth: () => getConfig().auth,
  available: isTailscaleAvailable,
  whois,
});

export async function getTailscaleCertPaths(): Promise<{ certPath: string; keyPath: string } | null> {
  const status = await getTailscaleStatus();
  if (!status.running || !status.hostname || !status.tailnet) {
    return null;
  }

  const hostname = `${status.hostname}.${status.tailnet}`;

  // Request certificate from Tailscale
  // Validate hostname format to prevent command injection
  const hostnameRegex = /^[a-zA-Z0-9][a-zA-Z0-9.-]*[a-zA-Z0-9]$/;
  if (!hostnameRegex.test(hostname)) {
    logger.warn({ hostname }, 'Invalid hostname format for certificate request');
    return null;
  }

  try {
    // Use execFile with argument array to prevent shell injection
    await execFileAsync('tailscale', ['cert', hostname]);

    // Tailscale places certs in different locations based on platform
    const certPath = isWindows()
      ? `C:\\ProgramData\\Tailscale\\certs\\${hostname}.crt`
      : `/var/lib/tailscale/certs/${hostname}.crt`;
    const keyPath = isWindows()
      ? `C:\\ProgramData\\Tailscale\\certs\\${hostname}.key`
      : `/var/lib/tailscale/certs/${hostname}.key`;

    return { certPath, keyPath };
  } catch (error) {
    logger.error({ error }, 'Failed to obtain Tailscale certificates');
    return null;
  }
}

export function extractIpFromRequest(request: { socket?: { remoteAddress?: string } }): string {
  // Only trust the socket's remote address to prevent IP spoofing via X-Forwarded-For.
  // This application is designed for direct Tailscale access, not reverse proxy deployments.
  // No address (a socket already gone) must never read as loopback, which is trusted.
  const remoteAddress = request.socket?.remoteAddress || '';

  // Remove IPv6 prefix if present (e.g., ::ffff:192.168.1.1 -> 192.168.1.1)
  if (remoteAddress.startsWith('::ffff:')) {
    return remoteAddress.slice(7);
  }

  return remoteAddress;
}

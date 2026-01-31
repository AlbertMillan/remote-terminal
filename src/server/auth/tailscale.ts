import { exec } from 'child_process';
import { promisify } from 'util';
import { createLogger } from '../utils/logger.js';
import { getConfig } from '../config.js';
import { isWindows } from '../utils/platform.js';

const execAsync = promisify(exec);
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

export async function isTailscaleAvailable(): Promise<boolean> {
  try {
    const cmd = isWindows() ? 'where tailscale' : 'which tailscale';
    await execAsync(cmd);
    return true;
  } catch {
    return false;
  }
}

export async function getTailscaleStatus(): Promise<{ running: boolean; hostname?: string; tailnet?: string }> {
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
  try {
    const { stdout } = await execAsync(`tailscale whois --json ${ipAddress}`);
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

export async function verifyTailscaleConnection(ipAddress: string): Promise<TailscaleIdentity | null> {
  const config = getConfig();

  // If auth is disabled, return a dummy identity
  if (!config.auth.enabled) {
    return {
      userId: 'anonymous',
      loginName: 'anonymous',
      displayName: 'Anonymous User',
      node: 'unknown',
      nodeIp: ipAddress,
      tailnet: 'local',
    };
  }

  // Check if Tailscale is available
  if (!(await isTailscaleAvailable())) {
    logger.warn('Tailscale not available, allowing connection without verification');
    return {
      userId: 'local',
      loginName: 'local',
      displayName: 'Local User',
      node: 'localhost',
      nodeIp: ipAddress,
      tailnet: 'local',
    };
  }

  // Get identity from Tailscale
  const identity = await whois(ipAddress);
  if (!identity) {
    logger.warn({ ipAddress }, 'Could not resolve Tailscale identity');
    return null;
  }

  // Check if user is in allowed list
  if (config.auth.allowedUsers.length > 0) {
    const isAllowed = config.auth.allowedUsers.some(
      (allowed) =>
        allowed === identity.loginName ||
        allowed === identity.userId ||
        allowed === '*'
    );

    if (!isAllowed) {
      logger.warn({ identity }, 'User not in allowed list');
      return null;
    }
  }

  return identity;
}

export async function getTailscaleCertPaths(): Promise<{ certPath: string; keyPath: string } | null> {
  const status = await getTailscaleStatus();
  if (!status.running || !status.hostname || !status.tailnet) {
    return null;
  }

  const hostname = `${status.hostname}.${status.tailnet}`;

  // Request certificate from Tailscale
  try {
    await execAsync(`tailscale cert ${hostname}`);

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

export function extractIpFromRequest(request: { socket?: { remoteAddress?: string }; headers?: Record<string, string | string[] | undefined> }): string {
  // Check X-Forwarded-For header first
  const forwarded = request.headers?.['x-forwarded-for'];
  if (forwarded) {
    const ip = Array.isArray(forwarded) ? forwarded[0] : forwarded.split(',')[0];
    return ip.trim();
  }

  // Fall back to socket remote address
  const remoteAddress = request.socket?.remoteAddress || '127.0.0.1';

  // Remove IPv6 prefix if present
  if (remoteAddress.startsWith('::ffff:')) {
    return remoteAddress.slice(7);
  }

  return remoteAddress;
}

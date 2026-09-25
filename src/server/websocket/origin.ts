import { URL } from 'url';

/**
 * Same-origin check for the WebSocket upgrade.
 *
 * Browsers do not apply CORS to WebSockets: any page the user visits can open a socket to
 * this server, and since identity comes from the source IP (`tailscale whois`), that socket
 * would authenticate as the user and could drive a shell. Browsers do always send `Origin`
 * on the upgrade, so we accept only a socket whose Origin names the same host the request
 * was sent to — the page this server served. Comparing against `Host` rather than a list
 * keeps every way of reaching the server working (MagicDNS name, short name, tailnet IP,
 * localhost) with nothing to configure.
 *
 * A missing Origin is allowed: only non-browser clients (wscat, scripts) omit it, and a
 * web page cannot make a browser do so.
 */
export function isAllowedWebSocketOrigin(
  origin: string | undefined,
  host: string | undefined
): boolean {
  if (origin === undefined) return true;
  if (!host) return false;

  let originHost: string;
  try {
    const url = new URL(origin);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    originHost = url.host;
  } catch {
    // Includes the literal `null` a sandboxed iframe or file:// page sends.
    return false;
  }

  return originHost.toLowerCase() === host.toLowerCase();
}

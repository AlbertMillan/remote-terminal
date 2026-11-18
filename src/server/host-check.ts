import { isIP } from 'net';

/**
 * DNS-rebinding guard for `/api/*` and `/ws`.
 *
 * Identity here is the caller's IP (`tailscale whois`), and the WebSocket origin check
 * compares Origin with Host. Neither stops a page on `evil.example` whose DNS is later
 * pointed at this server: the browser then calls us from the user's own (allowed) IP, with
 * `Host: evil.example` and a matching Origin, and the page can read every answer, files from
 * `…/files/open` included.
 *
 * A rebinding attacker controls a domain, never an IP literal or a name inside the user's own
 * resolvers. So these are allowed, which keeps every usual way of reaching the server working
 * with nothing to configure:
 * - IP literals (tailnet, LAN, loopback);
 * - `localhost` and `*.localhost`;
 * - single-label names (the machine's short name, MagicDNS short names);
 * - `*.ts.net` (MagicDNS and Tailscale Serve);
 * - `server.hostname`, plus anything in `server.allowedHosts` (e.g. a LAN name like `pc.home.lan`).
 */
export function isAllowedHost(hostHeader: string | undefined, extra: (string | undefined)[] = []): boolean {
  const name = hostName(hostHeader);
  if (!name) return false;
  if (isIP(name)) return true;
  if (name === 'localhost' || name.endsWith('.localhost')) return true;
  if (!name.includes('.')) return true;
  if (name.endsWith('.ts.net')) return true;
  return extra.some((h) => !!h && h.toLowerCase().replace(/\.$/, '') === name);
}

/** The host name from a Host header: port dropped, IPv6 brackets removed, lower-cased. */
export function hostName(hostHeader: string | undefined): string | null {
  const host = hostHeader?.trim().toLowerCase();
  if (!host) return null;
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    return end > 1 ? host.slice(1, end) : null;
  }
  const name = host.replace(/:\d+$/, '').replace(/\.$/, '');
  return name && !name.includes(':') ? name : null;
}

/** The paths the guard covers: everything that answers with data or a shell, not the static page. */
export function isGuardedPath(url: string): boolean {
  return url.startsWith('/api/') || url === '/ws' || url.startsWith('/ws?');
}

/**
 * Whether a request reaches a guarded route. Judged on the route the router **matched**
 * (`routePattern`) as well as the URL decoded, never on the raw URL alone: the router
 * percent-decodes before matching, so `/%61pi/jobs` runs `/api/jobs` and `/w%73` opens the
 * socket while the raw URL starts with neither. A path that doesn't decode is guarded.
 */
export function isGuardedRequest(rawUrl: string, routePattern: string | undefined): boolean {
  if (routePattern !== undefined && isGuardedPath(routePattern)) return true;
  const path = rawUrl.split('?')[0];
  try {
    return isGuardedPath(decodeURIComponent(path)) || isGuardedPath(rawUrl);
  } catch {
    return true;
  }
}

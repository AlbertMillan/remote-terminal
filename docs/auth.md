# Who may use the server

The server listens on `0.0.0.0:4220` and hands out shells, so every `/api/*` request and the
`/ws` upgrade pass one gate, `src/server/auth/access-gate.ts`, registered before any route.

## The three checks, in order

1. **Host** (`host-check.ts`). A page on `evil.example` whose DNS is later pointed at this
   server calls us from the user's own browser, so its IP is trusted, but its `Host` names
   the attacker's domain. Only IP literals, `localhost`, single-label names, `*.ts.net`,
   `server.hostname` and `server.allowedHosts` pass. An attacker controls a domain, never an
   IP literal or a name inside the user's resolvers.
2. **Origin, on a state-changing request** (anything but GET/HEAD/OPTIONS). Loopback is
   trusted, so without this any site the user visits could `POST http://127.0.0.1:4220/...`.
   A request with no `Origin` is not a page's (statusline, hooks, `cr-session`, the Android
   app's OkHttp) and passes. The `/ws` upgrade has the same check in its `preValidation`.
3. **Identity** (`createIdentityVerifier` in `auth/tailscale.ts`). With `auth.enabled` (the
   default) a caller is admitted if it is on loopback, or if `tailscale whois` names it and
   `auth.allowedUsers` (empty means everyone on the tailnet) admits it. Answers are cached
   per IP (60 s, refusals 10 s), so a hovering file link or a refused LAN host retrying
   doesn't spawn a process per request.

## Decisions

- **Judge the matched route, never the raw URL.** Fastify's router percent-decodes before
  it matches, so `/%61pi/jobs` runs `/api/jobs` and `/w%73` opens the socket while the raw
  URL starts with neither. Before this, a DNS-rebound page reached every route that way.
  `isGuardedRequest()` checks `request.routeOptions.url` and the decoded path; a path that
  doesn't decode counts as guarded.
- **A missing `tailscale` refuses.** It used to admit everyone as "Local User": an auto-start
  with a service `PATH`, or a Tailscale reinstall, turned auth off without a word. Loopback
  still works, so the machine's own browser is never locked out.
- **Auth defaults on.** With it off, and Windows Firewall allowing `node.exe` inbound on
  public networks, anyone on the same Wi-Fi could open `/ws` or queue a job, whose
  implement stage runs `claude -p` with `Bash`. Turn it off only on a machine whose port is
  unreachable from anything but the tailnet.
- **`extractIpFromRequest` never defaults to loopback.** A socket with no address reads as
  `''`, which nothing admits.
- **Identity admits; it doesn't partition data.** One person reaches the server as `local`
  on loopback, as their Tailscale login from the phone (or from this machine through its
  tailnet address), and as `anonymous` with auth off. Categories were once listed by
  `owner_id`, so turning auth on hid every category made before it, and the phone and the
  desktop each saw their own set. `getAllCategories()` now lists every row; `owner_id` stays
  only as a record of who created it. Sessions were never filtered. Notification preferences
  are still keyed per identity.
- Restart, Settings and the file routes keep their own identity checks: they predate the
  gate, cost nothing (cached), and each is the most dangerous thing in its module.

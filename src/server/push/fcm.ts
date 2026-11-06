import { createSign } from 'crypto';
import { URLSearchParams } from 'url';

/**
 * Firebase Cloud Messaging over its HTTP v1 API, with no `firebase-admin` dependency
 * (docs/android-app.md): the service account's OAuth token is a JWT this file signs
 * with node:crypto (RS256) and trades at Google's token endpoint.
 *
 * Every request goes through an injected transport, so tests drive the whole exchange
 * (token, send, an expired or unregistered token) with no network.
 */

export interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
  token_uri?: string;
}

export interface TransportResponse {
  status: number;
  body: string;
}

/** POST `body` to `url`; resolves with the status and text, rejects only on a network failure. */
export type Transport = (url: string, init: { headers: Record<string, string>; body: string }) => Promise<TransportResponse>;

export const fetchTransport: Transport = async (url, init) => {
  const res = await globalThis.fetch(url, { method: 'POST', headers: init.headers, body: init.body });
  return { status: res.status, body: await res.text() };
};

const TOKEN_URI = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

/** What `send` reports: `unregistered` means drop the device token, it will never work again. */
export type SendResult = { ok: true } | { ok: false; unregistered: boolean; status: number; detail: string };

/** A data-only message: the app builds the notification itself, so a tap knows where to go. */
export interface PushMessage {
  data: Record<string, string>;
  /** Collapses older undelivered messages with the same key (one per session or job). */
  collapseKey?: string;
}

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

export function parseServiceAccount(text: string): ServiceAccount | null {
  try {
    const json = JSON.parse(text) as Partial<ServiceAccount>;
    if (typeof json.project_id !== 'string' || typeof json.client_email !== 'string' || typeof json.private_key !== 'string') {
      return null;
    }
    return { project_id: json.project_id, client_email: json.client_email, private_key: json.private_key, token_uri: json.token_uri };
  } catch {
    return null;
  }
}

/** The signed assertion Google trades for an access token (RFC 7523). */
export function signJwt(account: ServiceAccount, nowSec: number): string {
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: account.client_email,
    scope: SCOPE,
    aud: account.token_uri ?? TOKEN_URI,
    iat: nowSec,
    exp: nowSec + 3600,
  };
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  return `${unsigned}.${base64url(signer.sign(account.private_key))}`;
}

export class FcmSender {
  private token: { value: string; expiresAtMs: number } | null = null;

  constructor(
    private readonly account: ServiceAccount,
    private readonly transport: Transport = fetchTransport,
    private readonly now: () => number = Date.now,
  ) {}

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAtMs - 60_000 > this.now()) return this.token.value;
    const assertion = signJwt(this.account, Math.floor(this.now() / 1000));
    const res = await this.transport(this.account.token_uri ?? TOKEN_URI, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
    });
    if (res.status !== 200) throw new Error(`FCM token exchange failed (${res.status}): ${res.body.slice(0, 200)}`);
    const json = JSON.parse(res.body) as { access_token?: string; expires_in?: number };
    if (!json.access_token) throw new Error('FCM token exchange returned no access_token');
    this.token = { value: json.access_token, expiresAtMs: this.now() + (json.expires_in ?? 3600) * 1000 };
    return json.access_token;
  }

  async send(deviceToken: string, message: PushMessage): Promise<SendResult> {
    const body = {
      message: {
        token: deviceToken,
        data: message.data,
        android: {
          priority: 'HIGH',
          ttl: '3600s',
          ...(message.collapseKey ? { collapse_key: message.collapseKey } : {}),
        },
      },
    };
    const url = `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(this.account.project_id)}/messages:send`;
    const post = async () =>
      this.transport(url, {
        headers: { Authorization: `Bearer ${await this.accessToken()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    let res = await post();
    if (res.status === 401) {
      // A token revoked early: fetch a fresh one once.
      this.token = null;
      res = await post();
    }
    if (res.status === 200) return { ok: true };
    return { ok: false, unregistered: isUnregistered(res), status: res.status, detail: res.body.slice(0, 300) };
  }
}

/** FCM's answer for a token that will never work again (app uninstalled, token rotated). */
function isUnregistered(res: TransportResponse): boolean {
  if (res.status === 404) return true;
  return res.status === 400 && /UNREGISTERED|registration token is not a valid/i.test(res.body);
}

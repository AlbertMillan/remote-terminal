/**
 * One way to call the server's JSON routes: fetch, read the body (an empty or
 * non-JSON body reads as `{}`), and never throw. A network failure comes back
 * as status 0 with the error's message, so every caller shows a failure the
 * same way through `failureMessage()`.
 */

export interface ApiResult<T> {
  ok: boolean;
  /** HTTP status; 0 when the request never got an answer. */
  status: number;
  /** Status 0 because the request's `signal` timed out (`AbortSignal.timeout`), not a dropped connection. */
  timedOut?: boolean;
  data: T & { error?: string };
}

export async function requestJson<T extends object = object>(
  url: string,
  init?: Parameters<typeof fetch>[1]
): Promise<ApiResult<T>> {
  try {
    const res = await fetch(url, init);
    const data = (await res.json().catch(() => ({}))) as (T & { error?: string }) | null;
    return { ok: res.ok, status: res.status, data: data ?? ({} as T) };
  } catch (error) {
    const message = error instanceof Error ? error.message : undefined;
    const timedOut = (error as { name?: unknown } | null)?.name === 'TimeoutError';
    return { ok: false, status: 0, ...(timedOut ? { timedOut } : {}), data: { error: message } as T & { error?: string } };
  }
}

/** The server's own reason, else `fallback (status)`; just `fallback` when there was no answer. */
export function failureMessage(result: ApiResult<object>, fallback: string): string {
  return result.data.error || (result.status ? `${fallback} (${result.status})` : fallback);
}

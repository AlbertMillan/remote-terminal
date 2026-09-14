import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { BODYLESS_POST, jsonPost } from '../src/client/job-board.js';

/**
 * The contract behind Retry, Approve, Cancel and Discard.
 *
 * All four POST to a route that takes no body and acts on the id in the path.
 * The client used to send `Content-Type: application/json` on them anyway, with
 * `body: undefined` — which Fastify rejects as 400 FST_ERR_CTP_EMPTY_JSON_BODY
 * BEFORE the route handler runs. Every one of those buttons answered "Bad
 * Request" and no handler ever saw the request.
 *
 * The unit tests over the handlers all passed throughout, because they call
 * retryJob()/approveGate() directly and never cross the wire. So this file
 * tests the wire: the shape the client sends, and the framework behaviour that
 * makes the shape matter.
 */
const ACTIONS = ['retry', 'approve', 'cancel', 'discard'] as const;

/** Translate a fetch init into inject args, so the test sends what the client sends. */
function asInject(init: { headers?: Record<string, string>; body?: string }): {
  headers?: Record<string, string>;
  payload?: string;
} {
  return {
    ...(init.headers ? { headers: init.headers } : {}),
    ...(init.body !== undefined ? { payload: init.body } : {}),
  };
}

describe('bodyless POST requests', () => {
  it('sends no Content-Type when there is no body', () => {
    expect(BODYLESS_POST.method).toBe('POST');
    // The whole bug in one assertion: declaring a body you do not send.
    expect(BODYLESS_POST).not.toHaveProperty('headers');
    expect(BODYLESS_POST).not.toHaveProperty('body');
  });

  it('still sends JSON headers when there is a body', () => {
    const init = jsonPost({ answer: 'yes' });
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.body).toBe('{"answer":"yes"}');
  });

  it('reaches the handler, rather than 400ing, for each bodyless action', async () => {
    const app = Fastify({ logger: false });
    const seen: string[] = [];
    for (const action of ACTIONS) {
      app.post(`/api/jobs/:id/${action}`, async () => {
        seen.push(action);
        return { ok: true };
      });
    }

    for (const action of ACTIONS) {
      // Send exactly what the client would send, headers and all.
      const res = await app.inject({
        method: 'POST',
        url: `/api/jobs/abc/${action}`,
        ...asInject(BODYLESS_POST),
      });
      expect(res.statusCode, `${action} should reach its handler`).toBe(200);
    }
    expect(seen).toEqual([...ACTIONS]);
    await app.close();
  });

  /**
   * Pins both the old client shape and the framework behaviour that punishes it,
   * so nobody "tidies" the header back in. If Fastify ever stops rejecting this,
   * the client is free to send it again — but deliberately, not by surprise.
   */
  it('would 400 again if the JSON header came back without a body', async () => {
    const app = Fastify({ logger: false });
    app.post('/api/jobs/:id/retry', async () => ({ ok: true }));

    // The exact init the client used to build. Kept here so the test fails loudly
    // if anyone reintroduces it, rather than only when a human clicks Retry.
    const regressed = { method: 'POST' as const, headers: { 'Content-Type': 'application/json' } };
    const res = await app.inject({
      method: 'POST',
      url: '/api/jobs/abc/retry',
      ...asInject(regressed),
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

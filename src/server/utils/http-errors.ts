/**
 * The tail every route error mapper ends in: an error type the route knows
 * answers with its own status and message; anything else is a logged 500.
 * Routes with richer payloads (a 409's `conflict` flag, a revert's conflicting
 * files) handle those first and fall through to this.
 */

export interface StatusError extends Error {
  status: number;
}

interface Reply {
  status: (code: number) => { send: (body: unknown) => unknown };
}

interface ErrorLogger {
  error: (obj: object, msg: string) => void;
}

export function replyWithError(
  reply: Reply,
  error: unknown,
  opts: { known: (error: unknown) => error is StatusError; logger: ErrorLogger; message: string }
): unknown {
  if (opts.known(error)) return reply.status(error.status).send({ error: error.message });
  opts.logger.error({ error }, opts.message);
  return reply.status(500).send({ error: error instanceof Error ? error.message : 'Request failed' });
}

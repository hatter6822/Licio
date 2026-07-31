// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The BFF's terminal error handler.
//
// Without one, Hono uses its built-in default, which is exactly two lines:
// `console.error(err); return c.text("Internal Server Error", 500)`.  Both
// halves break a stated guarantee of this codebase.
//
//   1. `console.error` is not pino.  CLAUDE.md makes pino the ONLY server
//      logging path precisely because redaction is worth the share of output
//      that passes through it, and an uncaught error carries the richest
//      payload the process ever prints: the message, the stack, and — for a
//      postgres.js or fetch rejection — the query, the parameters and the
//      request headers hanging off the error object.  That is the one place
//      `authorization`, `cookie`, `password` and `DATABASE_URL` most want to
//      leak, and it was the one place going around the redaction paths.
//   2. `c.text(...)` is not the API contract.  Every other error response in
//      the BFF is `apiErrorSchema` (`{ error: { code, message } }`), which the
//      web client's interceptor parses to build a typed `ErrorState`.  A
//      `text/plain` body makes that parse fail, so a 500 surfaced to the user
//      as an unrecognised-shape error rather than the generic failure state.
//
// The message the client receives is deliberately fixed and generic: a
// thrown error's own message routinely contains a SQL fragment, a file path
// or an upstream URL, and none of that belongs in a response body.  The
// detail goes to the log, keyed by the same `requestId` the response carries
// in `X-Request-ID`, so an operator can join the two.
import type { Context, Env, ErrorHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { AppEnv } from '../app.js';
import { createLogger } from '../lib/logger.js';

const logger = createLogger(process.env['LOG_LEVEL'] ?? 'info');

/**
 * Terminal error handler: log through pino, answer in the API error contract.
 *
 * An `HTTPException` is a DELIBERATE response (Hono raises one for a malformed
 * body or an oversized payload, and routes throw them for typed refusals), so
 * its status is honoured and it is logged at `warn` rather than `error` — an
 * expected outcome, not a fault.
 *
 * Its BODY, though, only speaks the contract when a route supplied one.  Hono's
 * own `getResponse()` for a bare `new HTTPException(413)` returns PLAIN TEXT, so
 * routing it through unchanged is how the deliberate refusal message reaches the
 * client as an untyped `http_413` with the bare status text — the exact
 * response-shape problem this terminal handler exists to eliminate, reintroduced
 * by the one branch that looked like it was already correct.  A custom `res` is
 * passed through verbatim (the route already chose its shape); a bare exception
 * is serialized into `apiErrorSchema`.
 */

/**
 * The error CODE for a bare `HTTPException`, from its status.
 *
 * These are the spellings the rest of the API already uses for the same
 * conditions, so a client `switch` on `error.code` sees one vocabulary whether
 * the refusal came from a route or from Hono itself.  Anything unmapped falls
 * back to `http_<status>`, which is what the client would have derived anyway —
 * honest rather than invented.
 */
const HTTP_EXCEPTION_CODES: Readonly<Record<number, string>> = {
  400: 'invalid_request',
  401: 'unauthenticated',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  // `payload_too_large`, NOT `oversized_request`.  The claim above — that these
  // are "the spellings the rest of the API already uses" — was false for 413:
  // `stories.ts` and `forum.ts` both answer an oversized upload with
  // `payload_too_large` (pinned in `stories.test.ts`), while
  // `oversized_request` exists only inside the LCAP/rendezvous
  // `{error: '<string>'}` envelope, which is not `apiErrorSchema` and so is not
  // an `error.code` any client can switch on.  Mapping 413 to it introduced a
  // SECOND spelling for the one condition the docstring cites as its example.
  413: 'payload_too_large',
  415: 'unsupported_media_type',
  422: 'unprocessable_entity',
  429: 'rate_limited',
};
export const errorHandler: ErrorHandler<AppEnv> = (err, c) => {
  const requestId = c.get('requestId');
  const base = { requestId, method: c.req.method, path: c.req.path };

  if (err instanceof HTTPException) {
    logger.warn({ ...base, status: err.status, err: err.message }, 'request refused');
    // A route that supplied its own response already speaks the contract.
    if (err.res) return err.res;
    return c.json(
      {
        error: {
          code: HTTP_EXCEPTION_CODES[err.status] ?? `http_${err.status}`,
          // Hono defaults `message` to the status text when none is given, so
          // this is never empty and never leaks anything the exception did not
          // already choose to say.
          message: err.message || 'Request refused.',
        },
      },
      err.status,
    );
  }

  // `err` is passed as a pino `err` field so its serializer records the
  // message, type and stack as structured fields under the redaction config,
  // rather than a `console.error` dump of the whole object graph.
  logger.error({ ...base, err }, 'unhandled request error');
  return c.json(
    { error: { code: 'internal_error', message: 'An unexpected error occurred.' } },
    500,
  );
};

/**
 * The terminal NOT-FOUND handler.
 *
 * Hono installs its own default — `c.text('404 Not Found', 404)` — and this app
 * registered nothing over it, so an unmatched path (or a wrong method on an
 * existing path) answered with PLAIN TEXT.  `normalizeError` on the client
 * safe-parses the body against `apiErrorSchema`, fails, and falls back to
 * `http_404` plus the bare status text: verbatim the failure mode this module's
 * own header says it exists to eliminate ("`c.text(...)` is not the API
 * contract").  The error handler above had repaired one half of Hono's two-line
 * default and left the other in place.
 *
 * Exported because THREE Hono instances need it: the production app, and the two
 * wrappers that mount it (the DEV simulator and the E2E harness).  A sub-app's
 * `notFound` does not cover the parent's unmatched paths — `route()` copies the
 * child's ROUTES up, so anything matching neither reaches the PARENT's handler —
 * which is why registering it once inside `createApp` would have left both
 * wrappers speaking plain text.
 */
// Generic over `Env` deliberately: it reads nothing from the context beyond
// `json`, and the two wrappers are plain `new Hono()` (BlankEnv) while the app is
// `Hono<AppEnv>` — pinning it to `AppEnv` made it unusable at exactly the two
// registration sites that needed it most.
export const notFoundHandler = <E extends Env>(c: Context<E>): Response =>
  c.json({ error: { code: 'not_found', message: 'Resource not found' } }, 404);

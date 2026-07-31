// SPDX-License-Identifier: AGPL-3.0-or-later
//
// `zValidator` with the project's own error contract attached.
//
// `apiErrorSchema` says "Every BFF error response is validated to this so the
// client renders a typed ErrorState rather than leaking a raw server payload",
// and carries a `details` field documented as "field-level details for form
// validation surfaces".  The 300-odd `@hono/zod-validator` call sites had no
// hook, so a request that failed validation returned that library's default —
// `{ success: false, error: <serialized ZodError> }` — which is precisely the
// raw payload the docstring promises never reaches a client.
//
// The consequence was concrete, not stylistic.  `normalizeError` in
// `apps/web/src/lib/api.ts` `safeParse`s the body against `apiErrorSchema` and
// falls back to `http_400` / the bare status text when it does not match, so
// EVERY validation failure across the API reached the UI as an untyped
// "Bad Request": no code a `case` could branch on, no message worth showing,
// and `details` — the one channel for "which field was wrong" — permanently
// empty on every form in the product.
//
// So this is not a wrapper for tidiness.  It is where the documented contract
// becomes true, and it is deliberately a DROP-IN: same name, same signature, so
// a route adopts it by changing an import line and no call site has to be
// rewritten (or, worse, remember to pass a hook).
import { zValidator as honoZValidator } from '@hono/zod-validator';

/**
 * Flatten a Zod issue list into `apiErrorSchema`'s `details` map.
 *
 * One entry per PATH, first issue wins: a form shows one message per field, and
 * later issues on the same path are refinements of the first.  An issue with an
 * empty path (a whole-object `refine`) is keyed `_` rather than dropped — those
 * are usually the cross-field rules a user most needs to be told about.
 *
 * Bounded at {@link MAX_DETAIL_FIELDS} entries and {@link MAX_DETAIL_LENGTH}
 * characters each: the body is attacker-influenced (a large enough object can
 * produce an issue per key), and an error response is not a place to hand back
 * unbounded echo.
 */
const MAX_DETAIL_FIELDS = 20;
const MAX_DETAIL_LENGTH = 200;

export function issuesToDetails(
  issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>,
): Record<string, string> {
  const details: Record<string, string> = {};
  for (const issue of issues) {
    if (Object.keys(details).length >= MAX_DETAIL_FIELDS) break;
    const key = issue.path.length > 0 ? issue.path.map(String).join('.') : '_';
    if (details[key] !== undefined) continue;
    details[key] = issue.message.slice(0, MAX_DETAIL_LENGTH);
  }
  return details;
}

/**
 * Validate a request target against `schema`, answering a failure in the shape
 * the client already knows how to read.
 *
 * The status is 400 for every target, which is what the un-hooked default also
 * returned — so adopting this changes the BODY of a rejection, never which
 * requests are rejected.
 *
 * Typed as `typeof honoZValidator` rather than with a hand-written signature.
 * That is load-bearing: the real signature carries seven type parameters whose
 * inference produces the `c.req.valid('json')` types every handler in the API
 * depends on, and restating it by hand collapsed them to `never` at 300 call
 * sites.  Borrowing the type means a `@hono/zod-validator` upgrade cannot leave
 * this wrapper describing an older shape.
 *
 * An explicitly-passed hook still wins, so a route with a genuinely different
 * error contract keeps its own.
 */
export const zValidator: typeof honoZValidator = ((
  target: Parameters<typeof honoZValidator>[0],
  schema: Parameters<typeof honoZValidator>[1],
  hook?: Parameters<typeof honoZValidator>[2],
  options?: Parameters<typeof honoZValidator>[3],
) =>
  honoZValidator(
    target,
    schema,
    hook ??
      ((result, c) => {
        if (result.success) return;
        return c.json(
          {
            error: {
              code: 'invalid_request',
              message: `Invalid request ${target}.`,
              details: issuesToDetails(result.error.issues),
            },
          },
          400,
        );
      }),
    options,
    // The cast is confined to this one expression: the implementation is a
    // pass-through, and the declared type above is the contract.
  )) as unknown as typeof honoZValidator;

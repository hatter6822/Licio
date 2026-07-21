// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The pure sign-up proof-of-work solve loop (WS-D bot-prevention layer 1).
// DELIBERATELY DEPENDENCY-FREE: this module is the Web Worker's only import,
// so the worker chunk stays a few hundred bytes instead of dragging the typed
// API client + schema graph into a duplicate bundle (the JS-total budget).
// The digest-input format below MUST match @licio/shared `powDigestInput`
// (`${salt}.${n}`) — pinned by a cross-check test in pow-captcha.test.ts, so
// the two can never drift silently.

/** Mirror of @licio/shared `powDigestInput` (cross-check-tested, never drifts). */
export function powSolveDigestInput(salt: string, n: number): string {
  return `${salt}.${n}`;
}

/** A validated solve request (the worker's untrusted-input trust boundary). */
export interface PowSolveRequest {
  salt: string;
  target: string;
  max_number: number;
}

// Mirrors of the @licio/shared `powChallengeSchema` field formats — hardcoded
// (never imported) so the worker chunk stays dependency-free, and pinned by a
// cross-check test in pow-captcha.test.ts so they can never drift silently.
const SALT_HEX_32 = /^[0-9a-f]{32}$/;
const TARGET_HEX_64 = /^[0-9a-f]{64}$/;
/** Mirror of @licio/shared `POW_CAPTCHA_MAX_NUMBER_CEILING` (cross-check-tested). */
export const POW_SOLVE_MAX_NUMBER_CEILING = 10_000_000;

/**
 * Validate an untrusted message before the brute-force loop runs.  Returns the
 * typed request, or `null` for any malformed / out-of-range payload.  Bounding
 * `max_number` at the server's own ceiling is load-bearing: it stops a
 * pathological value from spinning the worker on an unbounded SHA-256 loop.
 */
export function parseSolveRequest(data: unknown): PowSolveRequest | null {
  if (typeof data !== 'object' || data === null) return null;
  const { salt, target, max_number } = data as Record<string, unknown>;
  if (typeof salt !== 'string' || !SALT_HEX_32.test(salt)) return null;
  if (typeof target !== 'string' || !TARGET_HEX_64.test(target)) return null;
  if (
    typeof max_number !== 'number' ||
    !Number.isInteger(max_number) ||
    max_number < 0 ||
    max_number > POW_SOLVE_MAX_NUMBER_CEILING
  ) {
    return null;
  }
  return { salt, target, max_number };
}

/** Lower-case hex of an ArrayBuffer digest. */
export function toHex(buffer: ArrayBuffer): string {
  let out = '';
  for (const byte of new Uint8Array(buffer)) {
    out += byte.toString(16).padStart(2, '0');
  }
  return out;
}

/**
 * Brute-force the secret number for a challenge.  Pure WebCrypto; shared by
 * the worker and the main-thread fallback so both paths compute identically.
 * The main-thread path yields to the event loop periodically (`yieldEvery`)
 * so a slow device never janks the sign-up form.
 */
export async function solvePowNumber(
  input: { salt: string; target: string; max_number: number },
  options: { yieldEvery?: number } = {},
): Promise<number> {
  const yieldEvery = options.yieldEvery ?? 0;
  const encoder = new TextEncoder();
  for (let n = 0; n <= input.max_number; n += 1) {
    const digest = await crypto.subtle.digest(
      'SHA-256',
      encoder.encode(powSolveDigestInput(input.salt, n)),
    );
    if (toHex(digest) === input.target) return n;
    if (yieldEvery > 0 && n > 0 && n % yieldEvery === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  throw new Error('pow-captcha: no solution within max_number');
}

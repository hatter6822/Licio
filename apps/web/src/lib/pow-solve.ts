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
